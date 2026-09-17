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
