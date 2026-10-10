# Worked example: daily-briefing

Turns prepared records of one fictional day into a cited briefing website, using an approved writing example, a source check, and rendering scripts.

## TASK.md

```markdown
## Request recorded in the Method

Turn one prepared day folder into a complete, cited daily briefing. Follow the approved example for writing and layout, and save the briefing with its website.
```

## daily-briefing.method

```yaml
format: method/3.4
tools:
  calculate_activity_times:
    description: Calculate activity times and save time-plan.json and time-estimates.json in this run. Each successful call replaces both files, so supply the complete plan each time. Only the activities in the plan are calculated; choose the records for each. Before you count a message as work, check whether it is an automated prompt. Record in the plan why each record was selected or excluded. Gaps between records and media playback do not show continuous attention. Leave an activity unestimated when the records do not support an estimate.
    in:
      day:
        type: text
        description: Selected date in YYYY-MM-DD form.
      timezone:
        type: text
        description: Selected named timezone.
      plan:
        type: text
        description: "JSON with activities and not_estimated (short reasons for activities without an estimate). Each activity has id, label, reason, mode, and optional excluded: [{record_ids, reason}]. A field reference is {record_id, field}, where field is a dotted path in the prepared record, such as time.local, time.end, or attributes.msPlayed. Use points with points: [field references], gap_minutes, and optional compare_gaps. This counts first-to-last time in each group; a single point adds zero. Use intervals with intervals: [{start: field reference, end: field reference}]. Record connections between different endpoint records in the activity reason. Intervals are clipped to the day and overlaps count once. Use durations with durations: [field references] and unit: milliseconds, seconds, or minutes. Each selected duration counts once. Supply saved fields, not invented times or calculated totals."
    out:
      estimates:
        type: text
        description: Calculated durations and the records and assumptions used to calculate them.
      files:
        type: list
        description: Supporting file references to return with the draft.
        items:
          type: file
    run:
      kind: run
      runtime: python
      entrypoint: briefing_times.py
    effects: []
name: Write a daily briefing
goal: Turn one prepared day folder into a complete, cited daily briefing. Follow the approved example for writing and layout, and save the briefing with its website.
inputs:
  day:
    type: text
    description: Date of the prepared records, in YYYY-MM-DD form.
  timezone:
    type: text
    description: Timezone for those records, such as America/Chicago.
environment:
  prepared_day:
    type: files
    description: Folder of prepared records for that day. Read-only.
steps:
  open_inputs:
    name: Check the input folders
    in:
      day: inputs.day
      timezone: inputs.timezone
      prepared_day: environment.prepared_day
    do:
      kind: run
      runtime: python
      entrypoint: briefing_check_inputs.py
    out:
      selected_day:
        type: record
        description: Prepared records, date, timezone, and source hash.
        fields:
          folder:
            type: text
            description: Absolute path to the prepared records.
          day:
            type: text
            description: Selected date in YYYY-MM-DD form.
          timezone:
            type: text
            description: Named timezone used to interpret this day.
          start:
            type: text
            description: README path relative to the prepared folder.
          source_digest:
            type: text
            description: Hash of the prepared files at the start of this run.
      example:
        type: record
        description: The approved example and its complete text.
        fields:
          report:
            type: text
            description: Complete approved report.
      session_links:
        type: text
        description: Links to saved social sessions for this day. A link on its own line displays that session in the story.
    purpose: Checks the required record files, date, and timezone. Returns the prepared folder and its source hash, the complete approved report, and saved session links.
  write_briefing:
    name: Write the briefing
    in:
      selected_day: selected_day
      example: example
      session_links: session_links
    do:
      kind: agent
      model: default
      prompt: |
        Write the story of {{selected_day.day}} from the records in {{selected_day.folder}}.
        Follow the complete approved report in example.report for writing and detail.
        Return Markdown with source links: [label](source:record-id) or [label](source:record-id#L10-L20).
        Use calculate_activity_times for supported time estimates.
      tools:
        - calculate_activity_times
    out:
      draft:
        type: text
        description: The complete Markdown briefing.
      supporting_files:
        type: list
        items:
          type: file
        description: File references returned by the calculator, or an empty list when none were made.
    check:
      kind: run
      runtime: python
      entrypoint: briefing_validation.py
    reading:
      check_name: Check source links
      check: Checks source IDs, citation line ranges, and supporting file hashes, names, dates, and timezones. Returns pass when those references are valid.
  render_and_save:
    name: Render and save the briefing
    in:
      selected_day: selected_day
      draft: draft
      supporting_files: supporting_files
    do:
      kind: run
      runtime: python
      entrypoint: briefing_render.py
    out:
      saved_briefing:
        type: file
        description: Saved briefing receipt with its date, timezone, and file paths.
      published_website:
        type: file
        description: Briefing website with source pages and supporting files.
        format: method-website
    purpose: Builds the briefing website and checks its local links and source hash. Saves the website and supporting files under their content hash, reuses an identical saved output, and returns the receipt and website manifest.
result:
  briefing: saved_briefing
  website: published_website
run_prompt: Run Write a daily briefing for the requested prepared day folder. Read the date and timezone from its records. When finished, open the briefing website and give me the run link.
files:
  - briefing_files.py
  - briefing_times.py
  - briefing_sessions.py
  - briefing_check_inputs.py
  - briefing_artifacts.py
  - briefing_manifest.py
  - briefing_progress.py
  - briefing_validation.py
  - briefing_render.py
  - briefing_website.py
  - briefing_markdown.py
  - reader/reader.css
  - reader/reader.js
  - package.json
  - package-lock.json
  - pyproject.toml
  - uv.lock
  - vendor/marked.mjs
  - approved-report.md
```

## approved-report.md

```markdown
---
date: 2026-05-11
timezone: America/Chicago
title: May 11 — proposed briefing
---

# Monday, May 11

_A day in Millbrook_

## TL;DR



**You planned the Spring Glaze Workshop, fired a bisque load, and agreed to a demo night at the Millbrook Public Library.** In ChatGPT you set the four-week kiln schedule, chose a price of $195, and rewrote the class description until it was plain. You sent the announcement to your mailing list in the afternoon. Nine people had replied by the evening, one more than the class can hold. [Sources](source:chatgpt-0001,chatgpt-0013,gmail-0007,gmail-0012,gmail-0019)



Between these tasks, you drove to Fennimore Clay Supply for two bags of stoneware, browsed glaze recipes on Instagram, and ate dinner with Theo at the Orchard Street Diner. Your notes asked whether the studio should take commissions this summer or keep the time for classes. [Sources](source:google_timeline-0002,google_timeline-0004,instagram-0011,google_timeline-0007,apple_notes-0001)



**Time estimates:** about 3 h 40 min in the studio, 1 h 10 min of workshop planning in ChatGPT and email, 45 min on Instagram, 1 h 30 min at dinner, 50 min driving, and 1 h 5 min of Spotify playback. These periods overlap. [Sources](source:time-estimates)

## Morning



At 7:52, Fennimore Clay Supply emailed that your order of glaze materials was ready to pick up. At 8:05, your calendar showed “Bisque load — empty by Thursday.” [Sources](source:gmail-0002,calendar-0001)



Google Maps places you at the studio on Orchard Street from 8:20. You loaded the kiln and started the bisque firing at 8:41; the kiln controller’s email confirmed the start. A photo from 8:46 shows the full kiln before you closed the lid. [Sources](source:google_timeline-0001,gmail-0004,photos-0001)

![8:46 AM — the loaded kiln, two shelves of greenware.](source:photos-0001)



At 9:30, you were on Instagram. A post you saved said, “Test tiles are the cheapest lesson in the studio.” You opened two glaze-recipe posts after it and saved one for a celadon. [Sources](source:instagram-0004,instagram-0006,instagram-0011)

[Saved social session](sessions.html#social-2b6e41c09d1a)



At 10:05, Dana Ruiz at the library texted: “Would you do a free pottery demo here this spring? Our community room is open most Thursdays.” You answered, “Yes! Let me plan the class first and I’ll send dates.” [Sources](source:imessage-0003,imessage-0004)

## Planning the workshop



At 10:42, you asked ChatGPT how to plan a four-week evening glaze workshop for eight people with one kiln. It proposed one bisque firing after week 2 and one glaze firing after week 3. After you gave the kiln size and the 22 hours of firing and cooling, it fixed a Tuesday schedule with almost five days of margin. [Sources](source:chatgpt-0001,chatgpt-0003,chatgpt-0004,chatgpt-0005)



You asked about clay and price. ChatGPT estimated 32 lb of clay for eight people and a cost of $109 per person, including your time. It suggested a price from $185 to $220. You pointed out that the other studio in Millbrook charges $160 without the glaze firing, and asked whether $195 was too much. Its comparison showed that the other class comes to about $180 once two pieces are glaze-fired. You chose $195. [Sources](source:chatgpt-0007,chatgpt-0009,chatgpt-0010,chatgpt-0012,chatgpt-0013)



The first class description began “Discover the magic of glaze!” You called it “too salesy” and asked for a plain text that says why the class has only eight places. The second version said: “The class is limited to 8 people so that everyone's pieces fit in one kiln load.” [Sources](source:chatgpt-0015,chatgpt-0016,chatgpt-0017)



You asked for a supply list and a short email to your mailing list. At 11:12, you came back to the conversation with Dana’s invitation. ChatGPT wrote the text of a sign-up form, and at 11:27 confirmed that six demo bowls can go into the workshop’s glaze load if they are bisqued in time. [Sources](source:chatgpt-0019,chatgpt-0021,chatgpt-0022,chatgpt-0025,chatgpt-0028)

## Midday



At 12:10, Google Maps records a drive to Fennimore Clay Supply. You bought two 25 lb bags of mid-fire stoneware and a set of wooden ribs; the receipt arrived at 12:31. You were back at the studio at 12:58. [Sources](source:google_timeline-0002,gmail-0009,google_timeline-0003)



From 1:00 to 3:15, you were at the studio. Spotify played most of an album by The Quiet Kilns, then a podcast about running a craft business. At 2:40, you texted Theo a photo of a cracked test tile: “This is why we test.” [Sources](source:google_timeline-0003,spotify-0001,spotify-0009,imessage-0008,photos-0002)

![2:40 PM — a test tile with a crack through the glaze.](source:photos-0002)

## Afternoon



At 3:20, you sent the announcement to your mailing list with the subject “Spring Glaze Workshop — 8 places”. The text was the draft from the morning, with the dates added. [Sources](source:gmail-0012,chatgpt-0021)



Replies started at 3:34. By 6:00, seven people had asked for a place. One asked whether children could come: “My daughter is 12 and loves clay — is she too young?” You did not answer that email on May 11. [Sources](source:gmail-0013,gmail-0014,gmail-0016)



At 4:15, you texted Dana three possible Thursdays for the demo night. She chose Thursday, May 28, and said the library would put down a floor cover. [Sources](source:imessage-0011,imessage-0012)

[Saved social session](sessions.html#social-8f02cd5e7a44)

## Dinner with Theo



You left the studio at 6:20. Google Maps places you at the Orchard Street Diner from 6:31 to 8:02. Theo texted at 6:28, “Got us the booth by the window.” [Sources](source:google_timeline-0006,google_timeline-0007,imessage-0015)



At 7:40, two more replies arrived. The class now had nine requests for eight places. [Sources](source:gmail-0018,gmail-0019)

## Evening



You were home at 8:14. At 8:30, the kiln controller emailed that the bisque firing had finished and the kiln was cooling. [Sources](source:google_timeline-0008,gmail-0021)

## Your May 11 notes



In a note at 9:12, you wrote: “Nine people for eight places. Start a waiting list, or open a second Tuesday?” Further down: “Commissions pay more per hour, but classes fill the summer calendar and bring people back.” The note ends with a question that you did not answer: “What do I want the studio to be known for?” [Read passage](source:apple_notes-0001#L1-L6)

## Other records



Spotify saved 12 plays, including repeats and partial plays. [Show all](source:spotify-0001,spotify-0002,spotify-0003,spotify-0004,spotify-0005,spotify-0006,spotify-0007,spotify-0008,spotify-0009,spotify-0010,spotify-0011,spotify-0012)


## Supporting document: time-estimates

# May 11 time estimates

**Studio:** [8:20–10:00 AM and 1:00–3:15 PM](source:google_timeline-0001), from Google Maps, minus the time at Fennimore Clay Supply.

**Workshop planning:** First-to-last [ChatGPT messages](documents.html) and the email you sent, split at gaps over 15 minutes.

**Instagram:** First-to-last visits in each [session](sessions.html), split at gaps over five minutes.

**Dinner:** [6:31–8:02 PM](source:google_timeline-0007), from Google Maps.

**Driving:** About 34 minutes [to and from the supply store](source:google_timeline-0002) and 16 minutes [to dinner and home](source:google_timeline-0006), including stops.

**Spotify:** Sum of the [12 saved playback durations](source:spotify-0001), including partial plays.

Studio, planning, and browsing periods can include breaks and overlap. They do not measure continuous attention.
```

## briefing_check_inputs.py

```python
"""Check the prepared folder, approved example, date, and timezone."""
import datetime as dt
import json
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

from briefing_artifacts import source_digest
from briefing_files import folder, local_path
from briefing_sessions import social_sessions


def inputs(a):
    date = dt.date.fromisoformat(a['day']).isoformat()
    zone = ZoneInfo(a['timezone'])
    prepared = folder('selected_day')
    if prepared != Path(a['prepared_day']).resolve():
        raise ValueError('Method folders do not match the runtime tool bindings')
    required = {
        'selected_day': ['timeline.jsonl', 'untimed.jsonl', 'records/',
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
    report = (Path(__file__).parent/'approved-report.md').read_text()
    return {'selected_day': {'source_digest': source_digest(), 'folder': str(prepared), 'day': date, 'timezone': a['timezone'], 'start': 'timeline.jsonl'},
            'session_links': '\n'.join('['+g['platform']+' '+g['start']+'–'+g['end']+'](sessions.html#'+g['id']+')' for g in social_sessions(prepared)),
            'example': {'report': report}}


if __name__ == '__main__':
    print(json.dumps(inputs(json.load(sys.stdin)), ensure_ascii=False))
```

## briefing_files.py

```python
"""Read the example and selected day's files."""
import json
import os
import sys
from pathlib import Path

ROOTS = {'selected_day', 'run'}


def folder(which):
    if which not in ROOTS:
        raise ValueError('Choose selected_day or run')
    if which == 'run':
        return Path(os.environ['METHOD_OUTPUT_DIR']).resolve(strict=True)
    return Path(json.loads(os.environ['METHOD_ENVIRONMENT'])['prepared_day']).resolve(strict=True)


def local_path(which, name):
    root = folder(which)
    path = (root / name).resolve(strict=True)
    if not path.is_relative_to(root):
        raise ValueError('Path is outside the selected folder')
    return path


def page(text, offset):
    if not isinstance(offset, int) or not 0 <= offset <= len(text):
        raise ValueError('Invalid character offset')
    end = min(len(text), offset + 20000)
    return {'content': text[offset:end], 'next_offset': end if end < len(text) else -1,
            'total_chars': len(text)}
```

## briefing_artifacts.py

```python
"""Read and write the files produced by a briefing run."""
import hashlib
import json
import os
from pathlib import Path

from briefing_files import folder


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tree(root):
    return {str(p.relative_to(root)): digest(p) for p in sorted(root.rglob('*')) if p.is_file()}


def source_digest():
    return hashlib.sha256(json.dumps(tree(folder('selected_day')),sort_keys=True).encode()).hexdigest()


def local(name):
    root=Path(os.environ['METHOD_OUTPUT_DIR']).resolve()
    path=(root/name).resolve()
    if not path.is_relative_to(root):raise ValueError('Path leaves the run folder')
    return path


def put(path, data):
    path=local(path)
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n');path.chmod(0o600)
    return {'path':str(path.relative_to(local('.'))),'sha256':digest(path)}


def load(ref):
    path=local(ref['path'])
    if digest(path)!=ref['sha256']:raise ValueError('The saved file changed')
    return json.loads(path.read_text())
```

## briefing_times.py

```python
"""Calculate durations from explicit source selections. No model calls or prose writing."""
import datetime as dt
import itertools
import json
import math
import sys
from zoneinfo import ZoneInfo

from briefing_files import folder


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError('Expected a finite, nonnegative number')
    return value


def stamp(value):
    value = dt.datetime.fromisoformat(value)
    if value.utcoffset() is None:
        raise ValueError('An estimate needs a timestamp with a saved clock offset')
    return value.astimezone(dt.timezone.utc)


def union(ranges):
    merged = []
    for start, end in sorted(ranges):
        if end <= start:
            continue
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    return merged


def minutes(ranges):
    return sum((end-start).total_seconds()/60 for start, end in union(ranges))


def clusters(points, gap):
    groups = []
    for point in sorted(set(points)):
        if not groups or (point-groups[-1][-1]).total_seconds() > gap*60:
            groups.append([])
        groups[-1].append(point)
    return [(group[0], group[-1]) for group in groups]


def calculate(plan, prepared, day, timezone):
    zone = ZoneInfo(timezone)
    date = dt.date.fromisoformat(day)
    lower = dt.datetime.combine(date, dt.time(), zone).astimezone(dt.timezone.utc)
    upper = dt.datetime.combine(date+dt.timedelta(days=1), dt.time(), zone).astimezone(dt.timezone.utc)
    records = {}

    def record(cid):
        if not isinstance(cid, str) or not cid or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in cid):
            raise ValueError('Invalid record ID')
        path = (prepared/'records'/f'{cid}.json').resolve(strict=True)
        if not path.is_relative_to(prepared.resolve()):
            raise ValueError('Record is outside prepared folder')
        if cid not in records:
            records[cid] = json.loads(path.read_text())['prepared']
        return records[cid]

    def value(ref):
        obj = record(ref['record_id'])
        for key in ref['field'].split('.'):
            obj = obj[key]
        return obj

    def clipped(ranges):
        result = []
        for start, end in ranges:
            if end < start:
                raise ValueError('An interval ends before it starts')
            start, end = max(start, lower), min(end, upper)
            if end >= start:
                result.append((start, end))
        return union(result)

    results, all_ranges, ids = [], {}, set()
    for activity in plan['activities']:
        aid = activity['id']
        if aid in ids:
            raise ValueError('Repeated activity ID')
        ids.add(aid)
        mode = activity['mode']
        sources, ranges, extra = set(), [], {}
        # Reasons and exclusions are agent decisions. The script retains them unchanged.
        for exclusion in activity.get('excluded', []):
            for cid in exclusion['record_ids']:
                record(cid)
        if mode == 'points':
            gap = number(activity['gap_minutes'])
            points = []
            for ref in activity['points']:
                point = stamp(value(ref))
                if not lower <= point < upper:
                    raise ValueError('Point is outside the selected day')
                sources.add(ref['record_id']); points.append(point)
            ranges = clusters(points, gap)
            extra['gap_sensitivity_minutes'] = {str(g): minutes(clusters(points, number(g))) for g in activity.get('compare_gaps', [])}
        elif mode == 'intervals':
            for interval in activity['intervals']:
                ranges.append((stamp(value(interval['start'])), stamp(value(interval['end']))))
                sources.update([interval['start']['record_id'], interval['end']['record_id']])
        elif mode == 'durations':
            divisor = {'milliseconds': 60000, 'seconds': 60, 'minutes': 1}[activity['unit']]
            refs = activity['durations']
            keys = [(r['record_id'], r['field']) for r in refs]
            if len(set(keys)) != len(keys):
                raise ValueError('Repeated duration source')
            total = sum(number(value(ref)) for ref in refs)/divisor
            sources.update(ref['record_id'] for ref in refs)
        else:
            raise ValueError('Unknown calculation mode')
        ranges = clipped(ranges)
        if mode != 'durations':
            total = minutes(ranges)
            all_ranges[aid] = ranges
        results.append({'id': aid, 'label': activity['label'], 'minutes': total,
                        'ranges': [{'start': a.astimezone(zone).isoformat(), 'end': b.astimezone(zone).isoformat()} for a,b in ranges],
                        'source_record_ids': sorted(sources), 'reason': activity['reason'],
                        'excluded': activity.get('excluded', []), **extra})
    overlaps = [{'activities': [a,b], 'minutes': minutes([(max(x,u),min(y,v)) for x,y in all_ranges[a] for u,v in all_ranges[b] if max(x,u)<min(y,v)])}
                for a,b in itertools.combinations(all_ranges, 2)]
    return {'day': day, 'timezone': timezone, 'activities': results, 'overlaps': overlaps,
            'not_estimated': plan.get('not_estimated', [])}


def explanation(result):
    """Display the saved arithmetic and the writer's reasons without changing them."""
    lines=['# Time estimates', '', 'Session spans and recorded durations can overlap. They do not measure continuous attention.', '']
    for activity in result['activities']:
        lines += ['## '+activity['label'], '', f"{activity['minutes']:.1f} minutes. "+activity['reason'], '']
        sensitivity=activity.get('gap_sensitivity_minutes', {})
        if sensitivity:
            lines += ['Changing the session gap: '+', '.join(f'{gap} minutes → {value:.1f} minutes' for gap,value in sensitivity.items())+'.', '']
        for excluded in activity.get('excluded', []):
            lines += [excluded.get('reason', str(excluded)) if isinstance(excluded, dict) else str(excluded), '']
    if result.get('not_estimated'):
        lines += ['## Not estimated', '', *[(str(item.get('label') or item.get('id') or '')+': '+str(item.get('reason') or '')) if isinstance(item, dict) else str(item) for item in result['not_estimated']]]
    return '\n'.join(lines)


def calculate_activity_times(args):
    from briefing_artifacts import local, put
    plan = json.loads(args['plan'])
    result = calculate(plan, folder('selected_day'), args['day'], args['timezone'])
    # Calculate first so an invalid request leaves the last successful files intact.
    files = [put(local('time-plan.json'), plan), put(local('time-estimates.json'), result)]
    return {'estimates': json.dumps(result, ensure_ascii=False), 'files': files}


if __name__ == '__main__':
    print(json.dumps(calculate_activity_times(json.load(sys.stdin)), ensure_ascii=False))
```

## briefing_sessions.py

```python
"""Group saved social visits for the website. This is not a time estimate."""
import datetime as dt
import hashlib
import json


def stamp(value):return dt.datetime.fromisoformat(value)


DEFAULT_DISPLAY_GAP_SECONDS = 300

def social_sessions(prepared, gap_seconds=DEFAULT_DISPLAY_GAP_SECONDS):
    if gap_seconds <= 0: raise ValueError('The display gap must be positive')
    if not (prepared/'sessions.json').exists(): return []
    entries={r['entry_id']:r for r in map(json.loads,(prepared/'timeline.jsonl').read_text().splitlines())}
    groups=[];source_sessions=json.loads((prepared/'sessions.json').read_text())
    for session in source_sessions:
        for social in session['social']:
            segments=[]
            for eid in social['event_ids']:
                row=entries[eid]
                if not segments or (stamp(row['time'])-stamp(segments[-1][-1]['time'])).total_seconds()>gap_seconds:segments.append([])
                segments[-1].append(row)
            for segment in segments:
                sid='social-'+hashlib.sha256((session['session_id']+'|'+social['platform']+'|'+segment[0]['entry_id']).encode()).hexdigest()[:12]
                start,end=segment[0]['time'],segment[-1]['time']
                full=[entries[eid] for eid in session['event_ids'] if stamp(start)<=stamp(entries[eid]['time'])<=stamp(end)]
                groups.append({'id':sid,'parent':session['session_id'],'platform':social['platform'],'stream':session['stream'],'start':start,'end':end,'social':segment,'full':full})
    # Keep isolated uncertain Takeout records as separate rows in the overlapping view.
    attached=set()
    for g in groups:
        if not g['stream'].startswith('takeout:') or len(g['social'])!=1:continue
        candidates=[other for other in groups if other['stream'].startswith('browser:') and other['platform']==g['platform'] and stamp(other['start'])<=stamp(g['start'])<=stamp(other['end'])]
        if len(candidates)==1:
            candidates[0]['full']+=g['full'];attached.add(g['id'])
    groups=[g for g in groups if g['id'] not in attached]
    return sorted(groups,key=lambda g:(stamp(g["start"]),g["id"]))
```

## briefing_validation.py

````python
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
````

## briefing_render.py

```python
"""Render, check, and save a briefing once. Inputs remain read-only."""
import contextlib
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile

from briefing_artifacts import digest, local, put, source_digest, tree
from briefing_files import folder
from briefing_manifest import website_manifest
from briefing_validation import supporting_files, check_website
from briefing_markdown import parse
from briefing_website import build
from briefing_progress import progress


def render_and_save(args):
    day, draft = args['selected_day'], args['draft']
    supporting, files = supporting_files(args)
    proposal = parse(draft, day, supporting=supporting)
    progress('Rendering the briefing and its sources.')
    temporary = Path(tempfile.mkdtemp(prefix='briefing-', dir=local('.')))
    try:
        (temporary/'briefing.md').write_text(draft)
        for name, path in files.items(): shutil.copyfile(path, temporary/name)
        website = temporary/'website'
        with contextlib.redirect_stdout(sys.stderr):
            build(folder('selected_day'), temporary/'briefing.md', website,
                  Path(__file__).parent/'vendor/marked.mjs', day, proposal)
        for target in proposal['local_files']:
            relative = target['path']
            destination = (website/relative).resolve()
            if not destination.is_relative_to(website.resolve()):
                raise ValueError('File target leaves the website: ' + relative)
            if destination.is_file(): continue
            source = files.get(relative)
            if source is None:
                source = (folder('selected_day')/relative).resolve()
                if not source.is_relative_to(folder('selected_day').resolve()):
                    raise ValueError('File target leaves the prepared folder: ' + relative)
            if not source.is_file(): raise ValueError('Missing linked file: ' + relative)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
        check_website(website)
        if source_digest() != day['source_digest']:
            raise ValueError('Prepared sources changed during the run')
        inventory = tree(website)
        extras = ['briefing.md', *files]
        signature = hashlib.sha256(json.dumps({'website': inventory,
            'files': {name:digest(temporary/name) for name in extras}}, sort_keys=True).encode()).hexdigest()
        destination = local('saved/'+signature)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            if tree(destination/'website') != inventory or any(digest(destination/name) != digest(temporary/name) for name in extras):
                raise ValueError('Existing saved output changed')
        else:
            temporary.rename(destination)
        published = website_manifest(destination, inventory, 'Briefing for '+day['day'], extras)
        receipt = put(destination/'briefing.json', {'day':day['day'], 'timezone':day['timezone'],
            'website':str((destination/'website/index.html').relative_to(local('.'))),
            'source_digest':day['source_digest'], 'supporting_files':list(files)})
        progress('Briefing saved. Website links are valid.')
        return {'saved_briefing':receipt, 'published_website':published}
    finally:
        if temporary.exists(): shutil.rmtree(temporary)


if __name__ == '__main__':
    print(json.dumps(render_and_save(json.load(sys.stdin)), ensure_ascii=False))
```

## briefing_manifest.py

```python
"""Describe only the generated website and its explicit supporting outputs."""
import mimetypes
from pathlib import PurePosixPath
from briefing_artifacts import digest, local, put


def website_manifest(destination, inventory, title, extras):
    destination = local(destination)
    files = []
    for relative, expected in inventory.items():
        path = PurePosixPath(relative)
        if path.is_absolute() or '..' in path.parts:
            raise ValueError('Invalid website output path')
        files.append({'path': 'website/' + relative, 'sha256': expected,
                      'media_type': mimetypes.guess_type(relative)[0] or 'application/octet-stream'})
    for name in extras:
        if PurePosixPath(name).name != name:
            raise ValueError('Invalid supporting output path')
        files.append({'path': name, 'sha256': digest(destination / name),
                      'media_type': mimetypes.guess_type(name)[0] or 'application/octet-stream'})
    return put(destination / 'website-result.json', {
        'schema': 'method-website/1', 'title': title, 'entrypoint': 'website/index.html', 'files': files,
    })
```

## briefing_markdown.py

```python
"""Read ordinary Markdown and collect source links without prescribing prose."""
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
from zoneinfo import ZoneInfo


def parse(text, day, marked=None, supporting=()):
    date = dt.date.fromisoformat(day['day'])
    ZoneInfo(day['timezone'])
    supplements = list(supporting)
    module = Path(marked or os.environ.get('DAILY_BRIEFING_MARKED') or Path(__file__).parent/'vendor/marked.mjs').resolve()
    code = r'''
import {marked} from MARKED;
let chunks=[];for await(const c of process.stdin)chunks.push(c);
const text=Buffer.concat(chunks).toString();
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const citations=[],photos=[],local_files=[];
const target=(href,image=false)=>{
 if (/^(https?:|#)/.test(href)) return;
 if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) throw Error(`Unsupported file target: ${href}`);
 const path=decodeURIComponent(href.split(/[?#]/)[0]);
 if (path.split(/[\\/]/).some(x=>x==='..'||x==='.git'||x.startsWith('.env'))) throw Error(`Unsafe file target: ${href}`);
 if(path)local_files.push({path,image});
};
marked.use({renderer:{
 html(token){return token.text.startsWith('<!--')?'':escape(token.text)},
 link(token){
  const label=this.parser.parseInline(token.tokens), href=token.href;
  if(href.startsWith('source:')){const index=citations.length;citations.push({target:href.slice(7),label});return `<!--briefing-citation-${index}-->`}
  target(href); return `<a href="${escape(href)}" rel="noopener noreferrer">${label}</a>`;
 },
 image(token){
  if(token.href.startsWith('source:')){const index=photos.length;photos.push({id:token.href.slice(7),caption:token.text});return `<!--briefing-photo-${index}-->`}
  target(token.href,true); return `<img src="${escape(token.href)}" alt="${escape(token.text||'')}" loading="lazy">`;
 }
}});
const tokens=marked.lexer(text),blocks=[];
for(const token of tokens){
 if(token.type==='space')continue;
 const one=[token];one.links=tokens.links;
 const session=token.type==='paragraph' && token.tokens?.length===1 && token.tokens[0].type==='link' && /^sessions\.html#.+$/.test(token.tokens[0].href) ? token.tokens[0].href.split('#')[1] : undefined;
 blocks.push({type:token.type,depth:token.depth,text:token.text||'',html:marked.parser(one),...(session?{session}: {})});
}
process.stdout.write(JSON.stringify({blocks,citations,photos,local_files}));
'''.replace('MARKED', json.dumps(module.as_uri()))
    document = json.loads(subprocess.run(['node', '--input-type=module', '-e', code], input=text, text=True, capture_output=True, check=True).stdout)
    ranges = {}
    for citation in document['citations']:
        ids, sep, selection = citation.pop('target').partition('#L')
        citation['citations'] = ids.split(',')
        if not all(re.fullmatch(r'[A-Za-z0-9_-]+', cid) for cid in citation['citations']):
            raise ValueError('Invalid source record ID')
        if sep:
            match = re.fullmatch(r'(\d+)-L(\d+)', selection)
            if not match or len(citation['citations']) != 1:
                raise ValueError('A passage needs one source and #Lfirst-Llast')
            bounds = [int(match[1]), int(match[2])]
            key = 'lines-' + '-'.join(map(str, bounds))
            ranges.setdefault(ids, {})[key] = bounds
            citation['source_range'] = key
    heading = next((b['text'] for b in document['blocks'] if b['type']=='heading' and b.get('depth')==1), date.strftime('%A, %B %d').replace(' 0',' '))
    return {**document, 'day': date.isoformat(), 'timezone': day['timezone'], 'heading': heading,
            'title': heading, 'source_ranges': ranges, 'supplements': supplements}
```

## briefing_website.py

```python
#!/usr/bin/env python3
"""Build the complete website from the writer's selected content.

Reads accepted prepared data and an Markdown briefing. Never rewrites either.
"""
import argparse
import datetime as dt
import html
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit
from briefing_markdown import parse
from briefing_sessions import social_sessions
from briefing_progress import progress

TEMPLATES=Path(__file__).resolve().parent/'reader'


def load(path):return json.loads(path.read_text())
def optional(path):return load(path) if path.exists() else []
def h(value):return html.escape(str(value),quote=True)
def put(path,text):
    path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text);path.chmod(0o600)
def stamp(value):return dt.datetime.fromisoformat(value)
def clock(value):return stamp(value).strftime('%I:%M %p').lstrip('0')
def quotes(text):
    result=[];depth=0;start=0
    for i,char in enumerate(text):
        if char=='“':
            if depth==0:start=i+1
            depth+=1
        elif char=='”' and depth:
            depth-=1
            if depth==0:result.append(text[start:i])
    return result

def readable_time(e):
    time=e['time']
    return stamp(time['local']).strftime('%b %d · %I:%M %p').replace(' 0',' ') if time['local'] else time['day']
def host(url):return (urlsplit(url or '').hostname or '').removeprefix('www.').removeprefix('mobile.')
def safe_url(url):return url if urlsplit(url or '').scheme in ['http','https'] else ''

def render_markdown(texts,marked,source_urls=None):
    # Original HTML is shown as source text. Links open HTTP(S), anchors, or local website pages.
    code="""import {marked} from MARKED;
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
marked.use({renderer:{html(token){return escape(token.text)},link(token){let label=this.parser.parseInline(token.tokens);let href=token.href;if(href.startsWith('source:')){const ids=href.slice(7).split(',');return ids.map((id,i)=>{if(!Object.hasOwn(sources,id))throw Error('Unknown source record: '+id);return '<a target="_blank" rel="noopener noreferrer" href="'+escape(sources[id])+'">'+(i===0?label:'['+(i+1)+']')+'</a>'}).join(' ')}return /^(https?:|#|[a-zA-Z0-9_-]+[.]html(?:#|$))/.test(href)?'<a target="_blank" rel="noopener noreferrer" href="'+escape(href)+'">'+label+'</a>':label},image(token){return escape(token.text||'Image referenced in saved text')}}});
let chunks=[];for await(const c of process.stdin)chunks.push(c);const {texts:inputs,sources}=JSON.parse(Buffer.concat(chunks).toString());
process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(inputs).map(([key,value])=>[key,marked.parse(value)]))));
""".replace('MARKED',json.dumps(marked.resolve().as_uri()))
    return json.loads(subprocess.run(['node','--input-type=module','-e',code],input=json.dumps({'texts':texts,'sources':source_urls or {}}),text=True,capture_output=True,check=True).stdout)


def convert_photo(original,target):
    from PIL import Image, ImageOps
    from pillow_heif import register_heif_opener
    register_heif_opener()
    with Image.open(original) as source:
        preview=ImageOps.exif_transpose(source)
        preview.thumbnail((1600,1600))
        if preview.mode in ('RGBA','LA') or 'transparency' in preview.info:
            rgba=preview.convert('RGBA');background=Image.new('RGB',rgba.size,'white');background.paste(rgba,mask=rgba.getchannel('A'));preview=background
        preview.convert('RGB').save(target,format='JPEG',quality=85)


def build(prepared,briefing_file,out,marked,day=None,proposal=None):
    proposal=proposal or parse(briefing_file.read_text(),day,marked)
    dest=out
    dest.mkdir(parents=True,exist_ok=True)
    for name in ['reader.css','reader.js']:shutil.copyfile(TEMPLATES/name,dest/name)
    raw={f.stem:load(f) for f in (prepared/'records').glob('*.json')}
    records={cid:data['prepared'] for cid,data in raw.items()}
    entries={r['entry_id']:r for name in ['timeline.jsonl','untimed.jsonl'] for r in map(json.loads,(prepared/name).read_text().splitlines())}
    day=proposal['day']
    title=proposal['title']
    day_label=dt.date.fromisoformat(day).strftime('%b %d, %Y').replace(' 0',' ').upper()
    source_ids={cid:r['source_record_ids'] for r in entries.values() for cid in r['source_record_ids']}
    documents=load(prepared/'metadata/documents.json')
    doc_by_record={cid:d for d in documents for cid in d['record_ids']}
    source_ranges=proposal.get('source_ranges',{})
    texts={cid:e['text'] for cid,e in records.items()}
    for supplement in proposal.get('supplements',[]):texts[supplement['id']]=supplement['text']
    for cid,ranges in source_ranges.items():
        for name,(first,last) in ranges.items():texts[cid+':'+name]='\n'.join(texts[cid].splitlines()[first-1:last])
    contexts=optional(prepared/'context.json')
    for c in contexts:
        data=load(prepared/c['source_json'])
        for r in data['records']:texts['context-'+(r.get('message_id') or r['id'])]=r['text']
    def document_page(doc):
        return 'source-'+Path(doc['path']).stem+'.html'
    source_urls={cid:document_page(doc)+'#'+cid for cid,doc in doc_by_record.items()}
    source_urls.update({s['id']:s['id']+'.html' for s in proposal.get('supplements',[])})
    rendered=render_markdown(texts,marked,source_urls)
    media={}
    for asset in optional(prepared/'media.json'):
        original=prepared/asset['path'];name=Path(asset['path']).stem+'.jpg';target=dest/'media'/name;target.parent.mkdir(exist_ok=True)
        if not target.exists():
            convert_photo(original,target)
        original_target=dest/asset['path'];original_target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(original,original_target)
        for cid in asset['records']:media[cid]={'png':'media/'+name,'original':asset['path']}
    def photo(cid,caption):
        asset=media[cid]
        return f'<figure class="photo"><button data-photo="{h(asset["png"])}" aria-label="Enlarge photo"><img src="{h(asset["png"])}" alt="{h(caption)}" loading="lazy"></button><figcaption>{h(caption)} · <a href="{h(asset["original"])}">Original</a></figcaption></figure>'
    groups=social_sessions(prepared)
    browser_rows=[r for r in entries.values() if records[r['source_record_ids'][0]]['source'] in ['browser','google_takeout']]
    navigation=' · '.join((['<a href="sessions.html">X and Instagram sessions</a>'] if groups else [])+(['<a href="browser.html">All browser visits</a>'] if browser_rows else []))
    def page(title,body):
        return f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{h(title)}</title><link rel="stylesheet" href="reader.css"></head><body><nav><a href="index.html">{h(day_label)}</a><span>{navigation}</span></nav><main>{body}</main><dialog><button data-close-photo>Close</button><img alt=""></dialog><script src="reader.js"></script></body></html>'
    for supplement in proposal.get('supplements',[]):
        sid=supplement['id'];filename=sid+'.html'
        put(dest/filename,page(supplement['title'],'<h1>'+h(supplement['title'])+'</h1><div class="source-text">'+rendered[sid]+'</div>'))
        put(dest/'data'/f'{sid}.json',json.dumps({'id':sid,'html':rendered[sid],'time':'','date':'','speaker':'','basis':'','document':filename,'reading_label':'Full supporting document','ranges':{name:rendered[sid+':'+name] for name in source_ranges.get(sid,{})}},ensure_ascii=False))
    def speaker(e):
        role=e['actor_role']
        if e['source']=='imessage':return 'User' if role=='user_written' else e['attributes'].get('sender') or 'Not supplied'
        return {'user_written':'User','user':'User','assistant':'Assistant','other_person':'Other person'}.get(role,'')
    def record_html(cid):
        e=records[cid];meta=' · '.join(filter(None,[readable_time(e),speaker(e)]))
        return f'<article class="record" id="{h(cid)}"><div class="record-head">{h(meta)} <a href="records/{h(cid)}.json">Source JSON</a></div><div class="source-text">{rendered[cid]}</div>'+ (photo(cid,'Saved photo') if cid in media else '')+'</article>'
    for cid,e in records.items():
        doc=doc_by_record[cid];docname=document_page(doc)
        basis=('Saved with this activity' if e['text_basis']=='dated_google_activity_title' else 'Browser saved title') if e['source'] in ['browser','google_takeout'] else ''
        if e.get('post_text_partial'):basis+=' · partial saved title'
        data={'id':cid,'html':rendered[cid],'time':readable_time(e),'other_sources':[c for c in dict.fromkeys(source_ids.get(cid,[])) if c!=cid],'date':e['time']['day'],'speaker':speaker(e),'basis':basis,'document':docname+'#'+cid,'conversation':doc['kind']=='conversation','reading_label':'Read full conversation' if doc['kind']=='conversation' else 'Read full note' if e['source'] in ['roam','apple_notes'] else 'Read full document','ranges':{name:rendered[cid+':'+name] for name in source_ranges.get(cid,{})}}
        put(dest/'data'/f'{cid}.json',json.dumps(data,ensure_ascii=False))
        target=dest/'records'/f'{cid}.json';target.parent.mkdir(exist_ok=True);shutil.copyfile(prepared/'records'/f'{cid}.json',target)
    for doc in documents:
        body='<h1>'+h(doc['title'])+'</h1>'
        body+=''.join(record_html(cid) for cid in doc['record_ids'])
        put(dest/document_page(doc),page(doc['title'],body))
    for c in contexts:
        data=load(prepared/c['source_json']);body='<h1>'+h(c['title'])+'</h1><p class="small">Earlier conversation</p>'
        for r in data['records']:
            cid='context-'+(r.get('message_id') or r['id']);body+=f'<article id="{h(cid)}" class="record"><div class="record-head">{h(r.get("occurred_at") or r.get("day") or "Time not supplied")} · {h(r.get("role") or "")}</div><div class="source-text">{rendered[cid]}</div></article>'
        put(dest/('context-'+c['conversation_id']+'.html'),page(c['title'],body))
    def cite(ids,key,text='',label=None,range_name=None):
        return f'<button class="{("source-link" if label else "cite")}" data-ids="{h(json.dumps(ids))}" data-quotes="{h(json.dumps(quotes(text)))}" data-panel="{h(key)}"'+(f' data-range="{h(range_name)}"' if range_name else '')+f' aria-expanded="false" aria-label="{h(label or "Read supporting sources")}">{h(label or ("↗" if key.startswith("event-") else key))}</button>'
    def selected(row):
        sources=[(cid,records[cid]) for cid in row['source_record_ids']]
        dated=[(cid,e) for cid,e in sources if e['text_basis']=='dated_google_activity_title']
        if dated:
            titles={re.sub(r'^Visited\s+','',e['text']) for cid,e in dated}
            if len(titles)>1:return None
            cid,e=next(((cid,e) for cid,e in dated if not e['text'].startswith('Visited ')),dated[0])
        else:cid,e=sources[0]
        url=e['url'] or row.get('url') or ''
        is_instagram=e['platform']=='Instagram'
        if e['source']=='browser' and not dated:
            route=urlsplit(url).path
            if not re.search(r'/status/\d+|/(?:p|reel)/[^/]+',route):return None
        text=e.get('post_text') or (e['text'] if is_instagram and not e['text'].startswith('http') else '')
        text=html.unescape(text)
        if not text.strip() or text.strip().lower() in ['instagram','instagram photos and videos','home / x','x','twitter']:return None
        return {'id':row['entry_id'],'cid':cid,'text':text,'author':e.get('post_author') or '','url':url,'partial':e.get('post_text_partial',False),'time':row['time'],'source_ids':row['source_record_ids'],'platform':e['platform']}
    def post_row(row):
        sel=selected(row);e=records[row['source_record_ids'][0]];url=(sel or {}).get('url') or row.get('url') or e['url'] or ''
        ids=row['source_record_ids'];key=row['entry_id']+'-full'
        title=(sel or {}).get('text') or row.get('url') or row.get('title') or e['event_kind']
        who=(sel or {}).get('author','');body=h(title)
        link=safe_url(url)
        if sel:body='“'+h(title)+'”'
        if link:body=f'<a class="original" href="{h(link)}" target="_blank" rel="noopener noreferrer">'+body+'</a>'
        if sel and sel['partial']:body+='<span class="partial" title="The saved post text is incomplete." aria-label="The saved post text is incomplete."> …</span>'
        if who:body='<strong>'+h(who)+'</strong> '+body
        time=clock(row['time']) if row['time'] else 'Untimed'
        return f'<li class="evidence-host" data-entry="{h(row["entry_id"])}"><div class="post"><time datetime="{h(row["time"])}">{h(time)}</time><div class="post-text">'+body+' '+cite(ids,key,'“'+title+'”',label=None)+'</div></div></li>'
    for g in groups:
        g['full'].sort(key=lambda r:(stamp(r['time']),records[r['source_record_ids'][0]]['source_order'],r['entry_id']))
    def session_html(g):
        label=g['platform']+' '+clock(g['start'])
        if g['start']!=g['end']:label+='–'+clock(g['end'])
        label+=f" · {len(g['full'])} records"
        return f'<section class="session" id="{h(g["id"])}"><h3>{h(label)}</h3><div class="session-preview"><ol class="records">'+''.join(post_row(r) for r in g['social'] if selected(r))+'</ol></div><details class="full-session"><summary>Show all</summary><ol class="records">'+''.join(post_row(r) for r in g['full'])+'</ol></details></section>'
    put(dest/'sessions.html',page('X and Instagram sessions','<h1>X and Instagram sessions</h1>'+(''.join(session_html(g) for g in groups) or '<p>No saved social sessions for this day.</p>')))
    if browser_rows: put(dest/'browser.html',page('All browser visits','<h1>All browser visits</h1><ol class="records" style="max-height:none">'+''.join(post_row(r) for r in browser_rows)+'</ol>'))
    library='<h1>Full documents</h1><ul class="simple-list">'+''.join('<li><a href="'+h(document_page(d))+'">'+h(d['title'])+'</a></li>' for d in documents)+'</ul>'
    if contexts:library+='<h2>Earlier conversations</h2><ul>'+''.join('<li><a href="context-'+c['conversation_id']+'.html">'+h(c['title'])+'</a></li>' for c in contexts)+'</ul>'
    put(dest/'documents.html',page('Full documents',library))
    story=''
    sessions_by_id={g['id']:g for g in groups}
    for n,block in enumerate(proposal['blocks'],1):
        if block.get('session'):
            session=sessions_by_id.get(block['session'])
            if session is None:
                warning='Session link '+block['session']+' was not found. Linking to all saved social sessions.'
                print(warning,file=sys.stderr)
                progress(warning)
                story+='<p>This session link could not be found. <a href="sessions.html">View all saved social sessions</a>.</p>'
            else:
                story+=session_html(session)
            continue
        body=block['html']
        if block['type']=='paragraph':body=body.replace('<p>', '<p class="story-p">', 1)
        for i,citation in enumerate(proposal['citations']):
            label=citation['label']
            button=cite(citation['citations'],f'{n}-{i}',text=block['text'],label='Source',range_name=citation.get('source_range'))
            button=button.replace('>Source</button>', '>'+label+'</button>')
            body=body.replace(f'<!--briefing-citation-{i}-->',button)
        for i,asset in enumerate(proposal['photos']):
            body=body.replace(f'<!--briefing-photo-{i}-->',photo(asset['id'],asset['caption']))
        story+=f'<div class="evidence-host" id="p{n}">'+body+'</div>'
    story+='<footer><a href="documents.html">Full documents</a></footer>'
    put(dest/'index.html',page(title,story))
    put(dest/'display-groups.json',json.dumps([{'id':g['id'],'parent':g['parent'],'platform':g['platform'],'start':g['start'],'end':g['end'],'full':[r['entry_id'] for r in g['full']]} for g in groups],indent=2))
    print(json.dumps({'output':str(out),'blocks':len(proposal['blocks']),'display_groups':len(groups),'source_records':len(records)}))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ['prepared','briefing','out','marked']:parser.add_argument('--'+name,type=Path,required=True)
    args=parser.parse_args();build(args.prepared,args.briefing,args.out,args.marked)
```

## briefing_progress.py

```python
"""Report public work milestones without changing the final JSON result."""
import json
import os


def progress(message, completed=None, total=None, unit=None):
    fd = os.environ.get('METHOD_PROGRESS_FD')
    if fd is None:
        return
    update = {'message': message}
    if completed is not None and total is not None:
        update.update(completed=completed, total=total)
    if unit:
        update['unit'] = unit
    try:
        os.write(int(fd), (json.dumps(update) + '\n').encode())
    except (OSError, ValueError):
        pass
```

## reader/reader.css

```css
:root{--paper:#faf8f3;--ink:#232b28;--muted:#626e66;--accent:#23614b;--line:#d8ded6}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.7 Georgia,serif}a,button{color:var(--accent)}a{text-underline-offset:3px}button,summary{font:12px/1.5 'Helvetica Neue',sans-serif;cursor:pointer}button{border:0;background:none;padding:0}a:focus-visible,button:focus-visible,summary:focus-visible{outline:2px solid #bd7336;outline-offset:3px}nav{max-width:786px;margin:auto;display:flex;justify-content:space-between;gap:16px;padding:18px 28px;font:12px/1.5 'Helvetica Neue',sans-serif}nav a{text-decoration:none}main{max-width:786px;margin:40px auto;padding:0 28px}.mast{margin-bottom:30px}.eyebrow{text-transform:uppercase;letter-spacing:.13em;font:11px/1.5 'Helvetica Neue',sans-serif;color:var(--accent)}h1{font:normal clamp(38px,6vw,60px)/1.08 Georgia,serif;letter-spacing:-.04em;margin:15px 0 24px}h2{font:normal 27px/1.3 Georgia,serif;margin:40px 0 18px;border-top:1px solid var(--line);padding-top:18px}h3{font:600 13px/1.5 'Helvetica Neue',sans-serif;margin:0 0 7px}.story-p,.tldr{margin:0 0 22px}.tldr{font-size:18px}.cite{font:11px 'Helvetica Neue',sans-serif;vertical-align:super;position:relative;white-space:nowrap;margin-left:3px}.cite::before{content:'';position:absolute;inset:-9px -6px}.passage-button{display:inline-block;margin:0 0 18px}.evidence{font-size:15px;line-height:1.55;margin:4px 0 24px}.evidence[hidden]{display:none}.evidence .close{display:block;margin:0 0 14px}.record{margin:0 0 22px;scroll-margin-top:20px}.record-head{font:12px/1.5 'Helvetica Neue',sans-serif;color:var(--muted);margin-bottom:8px}.record-head a{font-size:11px;margin-left:10px}.source-text p{margin:0 0 12px}.source-text ul,.source-text ol{padding-left:22px}.source-text pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,monospace}.source-text code{font-size:.85em}.source-text a{overflow-wrap:anywhere}.source-text img{max-width:100%}mark{background:#f0e2ac;color:inherit;padding:0}.session{margin:22px 0 26px;scroll-margin-top:15px}.session h3 span{font-weight:400;color:var(--muted);margin-left:7px}.session-link{text-decoration:none}.post{display:grid;grid-template-columns:68px minmax(0,1fr);gap:10px;margin:0 0 3px;padding:0}.post time{font:11px/1.65 'Helvetica Neue',sans-serif;color:var(--muted);padding-top:2px;font-variant-numeric:tabular-nums}.post .post-text{font:15px/1.45 Georgia,serif;margin:0;overflow-wrap:anywhere}.post strong{font:600 12px/1.45 'Helvetica Neue',sans-serif}.post .cite{vertical-align:baseline}.post details{display:inline}.post summary{display:inline;margin-left:5px}.full-session{margin-top:7px}.full-session>summary{color:var(--accent);width:fit-content}.records{list-style:none;margin:10px 0;padding:0;max-height:65vh;overflow:auto;overscroll-behavior:contain}.records li{padding:0;border:0}.original{color:inherit;text-decoration:none}.original:hover{text-decoration:underline}.navigation-only{font:13px/1.5 'Helvetica Neue',sans-serif;color:var(--muted)}.partial{font:11px/1.5 'Helvetica Neue',sans-serif;color:var(--muted)}.photo{margin:12px 0 25px}.photo button{display:block}.photo img{display:block;width:190px;max-width:100%;height:auto}.photo figcaption{font:11px/1.5 'Helvetica Neue',sans-serif;color:var(--muted);margin-top:6px}dialog{border:0;background:var(--paper);padding:18px;max-width:95vw;max-height:95vh}dialog::backdrop{background:#000a}dialog img{display:block;max-width:86vw;max-height:82vh;width:auto;height:auto}dialog button{margin:0 0 8px}.simple-list{padding:0;list-style:none}.simple-list li{margin:0 0 10px}.small{font:12px/1.5 'Helvetica Neue',sans-serif;color:var(--muted)}footer{margin:40px 0 20px;font:12px/1.5 'Helvetica Neue',sans-serif}code{font-size:.85em}html{scroll-behavior:auto}@media(max-width:600px){main{margin:26px auto;padding:0 18px}nav{padding:15px 18px}.post{grid-template-columns:60px minmax(0,1fr);gap:7px}h1{font-size:42px}}

.track-list{margin-bottom:25px}.track-list>summary{color:var(--accent);width:fit-content}.track-list .simple-list{font-size:15px;line-height:1.5}.track-list .simple-list>li{margin:0 0 3px}

.evidence{margin:0 0 18px;font-size:15px;line-height:1.45}
.evidence-scroll{max-height:65vh;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}
.evidence-scroll:focus-visible{outline:2px solid #bd7336;outline-offset:2px}
.evidence .record{display:grid;grid-template-columns:68px minmax(0,1fr);gap:10px;margin:0 0 9px;scroll-margin:0}
.evidence .record>time{font:11px/1.65 'Helvetica Neue',sans-serif;color:var(--muted);padding-top:2px}
.evidence .record.untimed{display:block}
.evidence .record.untimed>time{display:none}
.evidence .record-head{display:flex;align-items:baseline;gap:7px;margin:0 0 3px;font:12px/1.45 'Helvetica Neue',sans-serif}
.evidence .record-head a{margin:0;text-decoration:none}
.evidence .source-text p{margin:0 0 6px}
.evidence .source-text ul,.evidence .source-text ol{margin:0 0 6px;padding-left:20px}
.evidence .source-text h1,.evidence .source-text h2,.evidence .source-text h3{font:bold 15px/1.45 Georgia,serif;letter-spacing:0;margin:8px 0 4px;padding:0;border:0}
.evidence .source-text pre{margin:5px 0}
.evidence .source-text>:last-child{margin-bottom:0}
.evidence-host:has(>.evidence:not([hidden]))>.story-p{margin-bottom:8px}
.evidence-host:has(>.evidence:not([hidden]))>.passage-button{margin-bottom:5px}
@media(max-width:600px){.evidence .record{grid-template-columns:60px minmax(0,1fr);gap:7px}}

.evidence .record-head{float:left;margin-right:6px}.evidence .source-text>p:first-child{display:inline}.evidence .record.untimed .record-head{float:none;margin-right:0}

.source-text table{border-collapse:collapse;margin:6px 0 10px;text-align:left}
.source-text th,.source-text td{padding:0 12px 2px 0;vertical-align:top}
.source-text th:last-child,.source-text td:last-child{padding-right:0}

.source-link{font:inherit;text-decoration:underline;text-underline-offset:3px;display:inline;margin:0;padding:0}.evidence-host{overflow-wrap:anywhere}.evidence-host>pre{white-space:pre-wrap}.evidence-host>table{display:block;overflow-x:auto;border-collapse:collapse}.evidence-host>table th,.evidence-host>table td{padding:4px 12px;text-align:left}

.session-preview{max-height:15rem;overflow:hidden;mask-image:linear-gradient(#000 75%,transparent)}
.session-preview .records{max-height:none;overflow:visible;margin-bottom:0}
.session:has(>.full-session[open])>.session-preview{display:none}
.evidence-host>table{overflow-wrap:normal;word-break:normal;max-width:100%}
.evidence-host>table th,.evidence-host>table td{min-width:9rem}
```

## reader/reader.js

```javascript
const cache=new Map();
async function record(id){if(!cache.has(id))cache.set(id,fetch(`data/${id}.json`).then(r=>{if(!r.ok)throw Error('Source could not be opened');return r.json()}));return cache.get(id)}
function highlight(root,quotes){for(const quote of quotes){if(!quote.trim())continue;const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);const nodes=[];let joined='',node;while(node=walker.nextNode()){if(node.parentElement.closest('mark'))continue;nodes.push({node,start:joined.length});joined+=node.textContent}const normalized=[];let text='';for(let i=0;i<joined.length;i++){if(/\s/.test(joined[i])){if(text.endsWith(' '))continue;text+=' '}else{text+=joined[i]}normalized.push(i)}const q=quote.replace(/\s+/g,' ');const at=text.indexOf(q);if(at<0)continue;const start=normalized[at],end=normalized[at+q.length-1]+1;for(const item of nodes.reverse()){let a=Math.max(0,start-item.start),b=Math.min(item.node.length,end-item.start);if(b<=a)continue;const range=document.createRange();range.setStart(item.node,a);range.setEnd(item.node,b);const mark=document.createElement('mark');range.surroundContents(mark)}}}
function sourceElement(data,range){
  const article=document.createElement('article');article.className='record';article.id=data.id;
  const writing=/^(roam|apple_notes)-/.test(data.id);
  const time=document.createElement('time');time.textContent=(data.time||'').split(' · ').at(-1);
  if(!/AM|PM/.test(time.textContent))time.textContent='';
  if(!time.textContent)article.classList.add('untimed');
  const body=document.createElement('div');body.className='record-body';
  const head=document.createElement('div');head.className='record-head';
  if(!writing&&data.speaker){const speaker=document.createElement('strong');speaker.textContent=data.speaker==='User'?'You':data.speaker==='Assistant'?(data.id.startsWith('codex-')?'Codex':'ChatGPT'):data.speaker;head.append(speaker)}
  const link=document.createElement('a');link.href=data.document;link.target='_blank';link.rel='noopener';link.textContent=writing?'Full note ↗':'↗';link.title=[data.reading_label,data.basis].filter(Boolean).join(' · ');link.setAttribute('aria-label',data.reading_label);head.append(link);
  const text=document.createElement('div');text.className='source-text';text.innerHTML=range?data.ranges[range]:data.html;
  body.append(head,text);article.append(time,body);return article;
}
async function openEvidence(button){
  const host=button.closest('.evidence-host');let panel=host.querySelector(':scope > .evidence');
  if(!panel){panel=document.createElement('div');panel.className='evidence';host.append(panel)}
  const isOpen=!panel.hidden&&panel.dataset.owner===button.dataset.panel;
  host.querySelectorAll('[data-ids]').forEach(b=>{b.setAttribute('aria-expanded','false');if(b.dataset.readLabel)b.textContent=b.dataset.readLabel});
  panel.dataset.owner=button.dataset.panel;button.setAttribute('aria-expanded',String(!isOpen));
  if(isOpen){panel.hidden=true;return}
  panel.hidden=false;const request=Symbol();panel.request=request;panel.replaceChildren();
  const scroll=document.createElement('div');scroll.className='evidence-scroll';scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label','Saved sources');
  panel.append(scroll);
  try{
    const ids=JSON.parse(button.dataset.ids),quotes=JSON.parse(button.dataset.quotes||'[]');
    for(const id of ids){
      const data=await record(id);if(panel.request!==request||panel.hidden)return;
      const el=sourceElement(data,button.dataset.range);scroll.append(el);highlight(el.querySelector('.source-text'),quotes);
      const mark=el.querySelector('mark');
      if(mark){const a=el.querySelector('.record-head a'),url=new URL(a.href);url.searchParams.set('quote',quotes.find(q=>el.querySelector('.source-text').textContent.includes(q))||mark.textContent);a.href=url}
    }
    const first=scroll.querySelector('mark');
    if(first)scroll.scrollTop=Math.max(0,first.getBoundingClientRect().top-scroll.getBoundingClientRect().top-30);
  }catch(error){if(panel.request===request&&!panel.hidden)scroll.append(document.createTextNode(error.message))}
}

document.addEventListener('click',e=>{const button=e.target.closest('[data-ids]');if(button)openEvidence(button);const photo=e.target.closest('[data-photo]');if(photo){const dlg=document.querySelector('dialog');dlg.querySelector('img').src=photo.dataset.photo;dlg.querySelector('img').alt=photo.querySelector('img').alt;dlg.showModal()}});
document.querySelector('dialog')?.addEventListener('click',e=>{if(e.target.tagName==='DIALOG'||e.target.closest('[data-close-photo]'))e.currentTarget.close()});
function revealHash(){const id=decodeURIComponent(location.hash.slice(1));if(!id)return;const el=document.getElementById(id);if(el){if(el.classList.contains('session')){const details=el.querySelector('.full-session');if(details)details.open=true}const q=new URLSearchParams(location.search).get('quote');if(q)highlight(el,[q]);(el.querySelector('mark')||el).scrollIntoView({block:'start'})}}window.addEventListener('hashchange',revealHash);revealHash();
```

## inputs.json

```json
{"day":"2026-05-11","timezone":"America/Chicago"}
```

## sample-report.md

```markdown
---
date: 2026-05-11
timezone: America/Chicago
title: May 11 — planning the Spring Glaze Workshop
---

# Monday, May 11

_One recorded conversation · All times in America/Chicago_

This sample contains one complete 28-message ChatGPT conversation. It covers part of the morning, not the full day. No social sessions, personal notes, travel records, or media are included.

## TL;DR

**You planned a four-week glaze workshop for eight people around one kiln, chose a price of $195, and wrote the text to announce it.** ChatGPT set one bisque firing after week 2 and one glaze firing after week 3. You rejected the first class description as “too salesy”, and the second one explains the limit of eight places by the kiln load. [Your opening question](source:chatgpt-0001) · [Schedule](source:chatgpt-0005) · [Plain description](source:chatgpt-0017)

At 11:12 AM, you came back with an invitation from Dana at the Millbrook library to do a free demo night. ChatGPT wrote a sign-up form and confirmed that six demo bowls can share the workshop’s glaze load if they are bisqued in time. The conversation does not show that the email was sent or that the demo night has a date. [Demo night](source:chatgpt-0022) · [Sign-up form](source:chatgpt-0025#L1-L3) · [Shared kiln load](source:chatgpt-0028#L1-L2)

**Time estimate:** about 28 minutes across two conversation periods. This estimate uses message timestamps and excludes gaps over 15 minutes. It does not measure continuous attention. The calculation method is given below.

## 10:42–10:45 AM: the kiln sets the schedule

At 10:42, you asked how to plan a four-week evening glaze workshop for 8 people with one kiln, so that everyone’s pieces are fired in time. ChatGPT planned the weeks around two firings: making pieces in week 1, trimming in week 2 with a bisque firing after it, glazing in week 3 with a glaze firing after it, and pickup in week 4. It asked for the kiln size and the firing time. [Your question](source:chatgpt-0001) · [Week-by-week plan](source:chatgpt-0003)

You answered that the kiln is a 7 cubic foot electric kiln, and that a glaze firing takes about 12 hours plus 10 hours to cool. With a Tuesday class, the glaze load goes in on Wednesday morning and is cool by Thursday afternoon, which leaves almost five days before week 4. ChatGPT estimated that the kiln holds 30 to 40 mugs, so the 16 workshop pieces fit with room to spare. [Kiln details](source:chatgpt-0004) · [Fixed days](source:chatgpt-0005)

For clay, it estimated about 4 lb per person, 32 lb for the class, and suggested buying two 25 lb bags of one mid-fire stoneware. [Clay question](source:chatgpt-0006) · [Estimate](source:chatgpt-0007)

## 10:45–10:55 AM: price, description, and supplies

You gave your costs: about $38 of materials per person and 10 hours of your time. ChatGPT counted $109 per person, including two firings and your time at $40 an hour, and suggested a price from $185 to $220. [Your costs](source:chatgpt-0008) · [Cost table](source:chatgpt-0009)

You asked whether $195 was too much, because the other studio in Millbrook charges $160 for a four-week wheel class without the glaze firing. ChatGPT compared what each class includes. With a glaze firing of about $10 a piece, the other class costs about $180 and has no glaze lesson. It advised saying plainly that both firings and the glazes are included. You chose $195. [Your question](source:chatgpt-0010) · [Comparison](source:chatgpt-0012) · [Decision](source:chatgpt-0013)

The first description started with “Discover the magic of glaze!” You asked for a shorter, plain text that gives the reason for eight places. The second version says that the class is limited to 8 people “so that everyone's pieces fit in one kiln load and come back in time for the last evening.” [First draft](source:chatgpt-0015) · [Your correction](source:chatgpt-0016) · [Second draft](source:chatgpt-0017)

You then asked what to buy before the first session, and for a short email to your mailing list. The checklist names the clay, eight tool sets, ware boards, tested glazes, and about 20 test tiles. The email gives the evenings, the price, and the eight places, and asks people to reply to save one. [Supply list](source:chatgpt-0019) · [Email draft](source:chatgpt-0021)

## 11:12–11:28 AM: a demo night at the library

At 11:12, you said that Dana at the Millbrook library wanted you to do a free demo night. ChatGPT suggested showing rather than teaching, bringing pieces at each stage, and having one sign-up sheet. It advised scheduling the demo about two weeks before the workshop. [Invitation](source:chatgpt-0022) · [Suggestions](source:chatgpt-0023)

You asked for a short sign-up form with name, email, and one question about experience with clay. The form asks “Have you worked with clay before?” with three answers. [Your request](source:chatgpt-0024) · [Form text](source:chatgpt-0025)

At 11:27, you asked whether six small bowls from the demo night could go into the same glaze load as the workshop. ChatGPT said yes, if the bowls are bisqued in the week 2 firing and glazed before week 3. It said to leave out a bowl that is still damp at the bisque firing, because it can crack and damage the pieces next to it. [Your question](source:chatgpt-0026) · [Answer](source:chatgpt-0028)

## Time estimate and record limits

The calculator grouped all 28 message times at gaps over 15 minutes. The first period ran from 10:42 to 10:55 AM, and the second from 11:12 to 11:27 AM. The 17-minute gap between them is not counted. [Calculation](source:time-estimates)

The sample has no records from the rest of the day, so no other activities are estimated.
```

## README.md

````markdown
# Write a daily briefing

TASK.md contains the task recorded in the Method's goal. daily-briefing.method implements it. approved-report.md contains the complete approved report that the writing step follows.

All people, places, and conversations in this example are fictional. Wren Talbot runs a pottery studio, Larkfield Ceramics, in the invented town of Millbrook.

## Run

Copy this folder to a working folder, then run:

```sh
cp -R sample prepared_day     # a folder named after the connection needs no binding
method validate daily-briefing.method
method run daily-briefing.method --inputs inputs.json
```

The run saves a version and prints the dashboard link. Method prepares the Python and Node dependencies. For another day, put that day's prepared records in `prepared_day/`, or bind another folder with `method bind daily-briefing.method prepared_day --file FOLDER`.

sample/ contains one complete conversation: 28 messages from the morning of May 11, in which Wren plans a glaze workshop. inputs.json selects that date and timezone. The approved report covers Wren's full day; the sample covers only this conversation.

Open the website returned by the run. Source links open the saved records and selected passages. The Markdown and supporting files are included with the website.

## Files

- daily-briefing.method: input checks, writing with a source check, and website rendering.
- daily-briefing.method `tools:`: the time calculation tool.
- briefing_*.py, reader/, vendor/: helpers and website assets.
- pyproject.toml, uv.lock, package.json, package-lock.json: dependencies.
- sample/, inputs.json: inputs for a sample run, kept outside the Method's saved files.
- approved-report.md: complete writing reference.
- sample-report.md, sample-output.zip: a briefing of the sample conversation, and the website that the Method's own scripts built from it. The draft was written for this example; the time tool, the source check, and the render step ran on it. checks.json records how, with the hashes.
````

## Installed files

- daily-briefing/README.md
- daily-briefing/TASK.md
- daily-briefing/approved-report.md
- daily-briefing/briefing_artifacts.py
- daily-briefing/briefing_check_inputs.py
- daily-briefing/briefing_files.py
- daily-briefing/briefing_manifest.py
- daily-briefing/briefing_markdown.py
- daily-briefing/briefing_progress.py
- daily-briefing/briefing_render.py
- daily-briefing/briefing_sessions.py
- daily-briefing/briefing_times.py
- daily-briefing/briefing_validation.py
- daily-briefing/briefing_website.py
- daily-briefing/checks.json
- daily-briefing/daily-briefing.method
- daily-briefing/inputs.json
- daily-briefing/package-lock.json
- daily-briefing/package.json
- daily-briefing/pyproject.toml
- daily-briefing/reader/reader.css
- daily-briefing/reader/reader.js
- daily-briefing/sample-output.zip
- daily-briefing/sample-report.md
- daily-briefing/sample/context.json
- daily-briefing/sample/documents/document-001.md
- daily-briefing/sample/media.json
- daily-briefing/sample/metadata/documents.json
- daily-briefing/sample/records/chatgpt-0001.json
- daily-briefing/sample/records/chatgpt-0002.json
- daily-briefing/sample/records/chatgpt-0003.json
- daily-briefing/sample/records/chatgpt-0004.json
- daily-briefing/sample/records/chatgpt-0005.json
- daily-briefing/sample/records/chatgpt-0006.json
- daily-briefing/sample/records/chatgpt-0007.json
- daily-briefing/sample/records/chatgpt-0008.json
- daily-briefing/sample/records/chatgpt-0009.json
- daily-briefing/sample/records/chatgpt-0010.json
- daily-briefing/sample/records/chatgpt-0011.json
- daily-briefing/sample/records/chatgpt-0012.json
- daily-briefing/sample/records/chatgpt-0013.json
- daily-briefing/sample/records/chatgpt-0014.json
- daily-briefing/sample/records/chatgpt-0015.json
- daily-briefing/sample/records/chatgpt-0016.json
- daily-briefing/sample/records/chatgpt-0017.json
- daily-briefing/sample/records/chatgpt-0018.json
- daily-briefing/sample/records/chatgpt-0019.json
- daily-briefing/sample/records/chatgpt-0020.json
- daily-briefing/sample/records/chatgpt-0021.json
- daily-briefing/sample/records/chatgpt-0022.json
- daily-briefing/sample/records/chatgpt-0023.json
- daily-briefing/sample/records/chatgpt-0024.json
- daily-briefing/sample/records/chatgpt-0025.json
- daily-briefing/sample/records/chatgpt-0026.json
- daily-briefing/sample/records/chatgpt-0027.json
- daily-briefing/sample/records/chatgpt-0028.json
- daily-briefing/sample/sessions.json
- daily-briefing/sample/timeline.jsonl
- daily-briefing/sample/untimed.jsonl
- daily-briefing/uv.lock
- daily-briefing/vendor/marked-LICENSE.md
- daily-briefing/vendor/marked.mjs
