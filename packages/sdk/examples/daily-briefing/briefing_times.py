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
