"""Read the CRM, check each step's records, and save the day's plan."""
import datetime
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlparse

STATUSES = ('new', 'contacted', 'replied', 'qualified', 'meeting', 'customer', 'closed', 'opted_out')
FIELDS = ('id', 'name', 'email', 'company', 'role', 'fit', 'sources', 'status',
    'next_action', 'next_action_date', 'introduction_path')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read(args):
    if datetime.date.fromisoformat(args['from_date']) > datetime.date.fromisoformat(args['day']):
        raise ValueError('Email start date is after the run date')
    crm = json.loads(args['crm'])
    return {'target': crm['target'], 'contacts': crm['contacts'],
        'resolved': [m['id'] for m in crm['messages'] if m['contact_id']],
        'crm_sha256': digest(args['crm'].encode())}


def check_search(search, name):
    if search['status'] != 'complete':
        raise ValueError('Source access is incomplete: ' + name)


def check_email(search, messages):
    check_search(search, 'email')
    ids = set()
    for m in messages:
        if not m['id'] or m['id'] in ids:
            raise ValueError('Duplicate or empty email ID')
        ids.add(m['id'])
        if m['direction'] not in ('received', 'sent') or not m['text']:
            raise ValueError('Invalid email record')
        datetime.datetime.fromisoformat(m['at'].replace('Z', '+00:00'))
        if urlparse(m['url']).scheme != 'https':
            raise ValueError('Email needs a source link')


def check_enrichment(enrichment):
    if not enrichment['sources']:
        raise ValueError('Prospect needs enrichment sources')
    for source in enrichment['sources']:
        if urlparse(source['url']).scheme != 'https' or not source['facts']:
            raise ValueError('Enrichment needs a page link and facts')


def check_contacts(contacts, resolved, messages, enrichment, updated, resolutions):
    """Return all contacts by ID after the updates, keeping owner notes."""
    old = {c['id']: c for c in contacts}
    collected = {m['url'] for m in messages} | {s['url'] for e in enrichment for s in e['sources']}
    collected |= {u for c in contacts for u in c['sources']}
    emails = {c['email'].lower(): c['id'] for c in contacts if c['email']}
    merged, seen = dict(old), set()
    for c in updated:
        if not c['id'] or c['id'] in seen:
            raise ValueError('Invalid or duplicate contact')
        seen.add(c['id'])
        if c['status'] not in STATUSES:
            raise ValueError('Invalid contact status')
        if c['next_action_date']:
            datetime.date.fromisoformat(c['next_action_date'])
        if any(url not in collected for url in c['sources']):
            raise ValueError('Contact source was not collected')
        if c['id'] not in old and (not c['sources'] or not c['fit']):
            raise ValueError('New prospects need sources and a reason they fit')
        if c['email']:
            if emails.setdefault(c['email'].lower(), c['id']) != c['id']:
                raise ValueError('Email belongs to an existing contact')
        before = old.get(c['id'], {})
        if before.get('status') in ('customer', 'opted_out') and c['status'] != before['status']:
            raise ValueError('Keep customer and opt-out status')
        merged[c['id']] = {**before, **{k: c[k] for k in FIELDS}, 'manual_notes': before.get('manual_notes', '')}
    incoming = {m['id']: m for m in messages if m['id'] not in resolved}
    if len(resolutions) != len(incoming) or {r['id'] for r in resolutions} != set(incoming):
        raise ValueError('Resolve each new message once')
    for r in resolutions:
        if not r['resolution']:
            raise ValueError('Each message needs a resolution')
        if r['contact_id']:
            if r['contact_id'] not in merged:
                raise ValueError('Message refers to an unknown contact')
            message, contact = incoming[r['id']], merged[r['contact_id']]
            if message['contact_id'] != contact['id'] and not (message['email'] and message['email'].lower() == contact['email'].lower()):
                raise ValueError('Message identity is not established')
    return merged


def check_tasks(day, contacts, tasks):
    keys = set()
    for task in tasks:
        contact = contacts.get(task['contact_id'])
        if not contact:
            raise ValueError('Task refers to an unknown contact')
        if contact['status'] in ('customer', 'opted_out', 'closed'):
            raise ValueError('Task targets an inactive contact')
        if datetime.date.fromisoformat(task['due_date']) > datetime.date.fromisoformat(day):
            raise ValueError('Daily task is not due yet')
        key = (task['contact_id'], task['action'])
        if key in keys or not task['action'] or not task['reason']:
            raise ValueError('Empty or duplicate task')
        keys.add(key)


def research_notes(args):
    notes = [('Email', args['email_search']['notes']), ('Happenstance', args['prospect_search']['notes'])]
    notes += [('Pages', e['notes']) for e in args['enrichment']]
    return '\n\n'.join(f'{name}: {text}' for name, text in notes if text)


def save(args):
    contacts = check_contacts(args['contacts'], args['resolved'], args['messages'], args['enrichment'],
        args['updated_contacts'], args['resolutions'])
    check_tasks(args['day'], contacts, args['day_tasks'])
    notes = research_notes(args)
    plan_id = digest(json.dumps({k: v for k, v in args.items() if k != 'crm'}, sort_keys=True).encode())
    current = args['crm']
    state = json.loads(current)
    if state.get('last_plan') != plan_id:
        if digest(current.encode()) != args['crm_sha256']:
            raise ValueError('CRM changed after it was read; start a new run')
        saved = {m['id']: m for m in state['messages']}
        incoming = {m['id']: m for m in args['messages']}
        for r in args['resolutions']:
            saved[r['id']] = {**incoming[r['id']], **r}
        state.update(contacts=list(contacts.values()), messages=list(saved.values()), last_plan=plan_id)
        state.setdefault('days', {})[args['day']] = {'tasks': args['day_tasks'], 'research_notes': notes}
        current = json.dumps(state, indent=2) + '\n'
    lines = ['# Outbound tasks — ' + args['day'], '']
    for task in args['day_tasks']:
        contact = contacts[task['contact_id']]
        lines += [f"## {task['action']}: {contact['name']} · {contact['company']}",
            'Due: ' + task['due_date'], '', task['reason'], '', task['draft'], '']
    if not args['day_tasks']:
        lines += ['No outreach tasks are due today.', '']
    unresolved = [m for m in state['messages'] if not m['contact_id']]
    lines += ['## Messages to review', ''] + [m['id'] + ': ' + m['resolution'] for m in unresolved]
    lines += ['', '## Research notes', '', notes]
    output = Path(os.environ['METHOD_OUTPUT_DIR'])
    output.mkdir(parents=True, exist_ok=True)
    def artifact(name, data):
        (output / name).write_bytes(data)
        return {'path': name, 'sha256': digest(data)}
    return {'tasks': artifact('tasks.md', ('\n'.join(lines) + '\n').encode()),
        'receipt': artifact('receipt.json', json.dumps({'day': args['day'], 'crm_sha256': digest(current.encode()),
            'contacts': len(state['contacts']), 'messages': len(state['messages'])}).encode()),
        'state': {'crm': current}}
