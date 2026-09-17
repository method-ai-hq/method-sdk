"""Check the prepared folder, approved example, date, and timezone."""
import datetime as dt
import json
import re
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

from briefing_artifacts import source_digest
from briefing_files import folder, local_path
from briefing_sessions import social_sessions


def inputs(a):
    date = dt.date.fromisoformat(a['day']).isoformat()
    zone = ZoneInfo(a['timezone'])
    example, prepared = folder('example'), folder('selected_day')
    if prepared != Path(a['prepared_day']).resolve():
        raise ValueError('Method folders do not match the runtime tool bindings')
    required = {
        'example': ['website/index.html', 'briefing.md'],
        'selected_day': ['README.md', 'timeline.jsonl', 'untimed.jsonl', 'records/',
                         'metadata/documents.json'],
    }
    for which, names in required.items():
        for name in names:
            try:
                path = local_path(which, name)
            except FileNotFoundError:
                raise ValueError(f'Missing required input: {which}/{name}') from None
            if not (path.is_dir() if name.endswith('/') else path.is_file()):
                raise ValueError(f'Expected a {"folder" if name.endswith("/") else "file"}: {which}/{name}')
    for name in ['timeline.jsonl', 'untimed.jsonl']:
        for row in map(json.loads, (prepared/name).read_text().splitlines()):
            if row['date'] != date:
                raise ValueError('Selected date does not match the prepared day')
            if row.get('time'):
                saved = dt.datetime.fromisoformat(row['time'])
                local = saved.astimezone(zone)
                if local.date().isoformat() != date or local.utcoffset() != saved.utcoffset():
                    raise ValueError('Selected timezone does not match the prepared times')
    report = (example/'briefing.md').read_text()
    report = re.sub(r'<!--(?: paragraph:| time:).*?-->', '', report, flags=re.S)
    report = re.sub(r'<!-- supplement: ([A-Za-z0-9_-]+) -->', r'\n## Supporting document: \1\n', report)
    return {'selected_day': {'source_digest': source_digest(), 'folder': str(prepared), 'day': date, 'timezone': a['timezone'], 'start': 'README.md'},
            'session_links': '\n'.join('['+g['platform']+' '+g['start']+'–'+g['end']+'](sessions.html#'+g['id']+')' for g in social_sessions(prepared)),
            'example': {'folder': str(example), 'website': 'index.html',
                                 'draft': 'briefing.md', 'report': report}}


if __name__ == '__main__':
    print(json.dumps(inputs(json.load(sys.stdin)), ensure_ascii=False))
