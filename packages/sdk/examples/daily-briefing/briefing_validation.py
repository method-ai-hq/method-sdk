"""Check draft references and website links."""
import json
import sys
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit

from briefing_artifacts import digest, local
from briefing_times import explanation
from briefing_files import folder
from briefing_markdown import parse


def check_draft(draft, day, supporting=()):
    doc=parse(draft, day, supporting=supporting)
    records={p.stem for p in (folder('selected_day')/'records').glob('*.json')}
    supplements={s['id'] for s in doc['supplements']}
    if len(supplements)!=len(doc['supplements']):raise ValueError('Repeated supplement ID')
    if records & supplements:raise ValueError('A supplement uses a source record ID')
    allowed=records|supplements
    for citation in doc['citations']:
        if set(citation['citations'])-allowed:raise ValueError('Unknown citation')
    for photo in doc['photos']:
        if photo['id'] not in records:raise ValueError('Unknown photo record')
    for cid,ranges in doc.get('source_ranges',{}).items():
        text = (json.loads((folder('selected_day')/'records'/f'{cid}.json').read_text())['prepared']['text']
                if cid in records else next(s['text'] for s in doc['supplements'] if s['id']==cid))
        for first,last in ranges.values():
            if not 1<=first<=last<=len(text.splitlines()):raise ValueError('Passage lines are outside the saved text')
    return doc


class Links(HTMLParser):
    def __init__(self):super().__init__();self.ids=set();self.links=[];self.citations=[];self.entries=set()
    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        if 'id' in a:self.ids.add(a['id'])
        if 'data-entry' in a:self.entries.add(a['data-entry'])
        for name in ('href','src'):
            if name in a:self.links.append(a[name])
        if 'data-ids' in a:self.citations.extend(json.loads(a['data-ids']))


def check_website(root):
    pages={}
    for path in root.glob('*.html'):
        page=Links();page.feed(path.read_text());pages[path.resolve()]=page
    for path,page in pages.items():
        for link in page.links:
            url=urlsplit(link)
            if url.scheme or url.netloc:continue
            target=(path.parent/unquote(url.path)).resolve() if url.path else path
            if not target.is_relative_to(root.resolve()) or not target.is_file():raise ValueError('Broken local website link: '+link)
            if url.fragment and target in pages and unquote(url.fragment) not in pages[target].ids:raise ValueError('Missing passage anchor: '+link)
        if any(not (root/'data'/f'{cid}.json').is_file() for cid in page.citations):raise ValueError('A citation has no source view')
    groups=json.loads((root/'display-groups.json').read_text())
    if any(g['id'] not in pages[(root/'sessions.html').resolve()].ids for g in groups):raise ValueError('A browsing group is absent from the sessions page')
    sessions = folder('selected_day')/'sessions.json'
    expected={eid for session in (json.loads(sessions.read_text()) if sessions.exists() else []) for social in session['social'] for eid in social['event_ids']}
    shown={eid for group in groups for eid in group['full']}
    if expected-shown:raise ValueError('A saved social visit is absent from the website')
    entries=[row for name in ['timeline.jsonl','untimed.jsonl'] for row in map(json.loads,(folder('selected_day')/name).read_text().splitlines())]
    browser_ids={row['entry_id'] for row in entries if json.loads((folder('selected_day')/'records'/f"{row['source_record_ids'][0]}.json").read_text())['prepared']['source'] in ['browser','google_takeout']}
    if browser_ids and browser_ids-pages[(root/'browser.html').resolve()].entries:raise ValueError('A browser visit is absent from All browser visits')
    return len(groups)


def supporting_files(args):
    day = args['selected_day']
    supporting, files = [], {}
    for ref in args.get('supporting_files', []):
        path = local(ref['path'])
        if digest(path) != ref['sha256']:
            raise ValueError('A supporting file changed: ' + path.name)
        if path.suffix not in ('.json', '.md', '.txt') or path.name in ('briefing.md', 'briefing.json', 'website-result.json') or path.name in files:
            raise ValueError('Invalid supporting file: ' + path.name)
        text = path.read_text()
        if path.name == 'time-estimates.json':
            estimates = json.loads(text)
            if (estimates['day'], estimates['timezone']) != (day['day'], day['timezone']):
                raise ValueError('Calculated times do not match the selected date and timezone')
            text = explanation(estimates)
        elif path.suffix == '.json':
            text = '```json\n'+text+'\n```'
        files[path.name] = path
        supporting.append({'id': path.stem, 'title': path.stem.replace('-', ' ').capitalize(), 'text': text})
    return supporting, files


def check_written_briefing(args):
    try:
        values = {**args['inputs'], **args['outputs']}
        supporting, files = supporting_files(values)
        doc = check_draft(values['draft'], values['selected_day'], supporting)
        return {'status': 'pass', 'reason': 'Source links and supporting files are valid.',
                'evidence': [f"{len(doc['citations'])} citations checked.", f"{len(files)} supporting files checked."]}
    except (ValueError, KeyError, OSError) as error:
        return {'status': 'fail', 'reason': str(error), 'evidence': []}


if __name__ == '__main__':
    print(json.dumps(check_written_briefing(json.load(sys.stdin))))
