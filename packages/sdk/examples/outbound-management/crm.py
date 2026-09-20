"""Read, check, and commit a daily outbound plan."""
import datetime
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlparse


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read(args):
    datetime.date.fromisoformat(args['day'])
    raw = args['crm'].encode()
    crm = json.loads(raw)
    datetime.date.fromisoformat(args['from_date'])
    if args['from_date'] > args['day']:
        raise ValueError('Email start date is after the run date')
    return {'context': json.dumps({'day': args['day'], 'from_date': args['from_date'],
        'sha256': digest(raw), 'crm': crm})}


def sources(observations):
    data = json.loads(observations)
    for name in ['email', 'happenstance', 'enrichment']:
        if data['searches'][name]['status'] != 'complete':
            raise ValueError('Source access is incomplete: ' + name)
    ids = set()
    for message in data['messages']:
        if not message['id'] or message['id'] in ids:
            raise ValueError('Duplicate or empty email ID')
        ids.add(message['id'])
        if message['direction'] not in ['received', 'sent'] or not message['text']:
            raise ValueError('Invalid email record')
        datetime.datetime.fromisoformat(message['at'].replace('Z', '+00:00'))
        if urlparse(message['url']).scheme != 'https':
            raise ValueError('Email needs a source link')
    for prospect in data['prospects']:
        if not prospect['sources']:
            raise ValueError('Prospect needs enrichment sources')
        for source in prospect['sources']:
            if urlparse(source['url']).scheme != 'https' or not source['facts']:
                raise ValueError('Enrichment needs a page link and facts')
    return data


def checked(context, plan, observations):
    ctx, plan = json.loads(context), json.loads(plan)
    evidence = sources(observations)
    done = {m['id'] for m in ctx['crm']['messages'] if m['contact_id']}
    ctx['messages'] = [m for m in evidence['messages'] if m['id'] not in done]
    contacts = {c['id']: dict(c) for c in ctx['crm']['contacts']}
    old = dict(contacts)
    source_urls = {m['url'] for m in evidence['messages']}
    source_urls.update(s['url'] for p in evidence['prospects'] for s in p['sources'])
    source_urls.update(u for c in contacts.values() for u in c['sources'])
    seen = set()
    emails = {c['email'].lower(): c['id'] for c in contacts.values() if c['email']}
    for c in plan['contacts']:
        fields = ('id', 'name', 'email', 'company', 'role', 'fit', 'status', 'next_action', 'next_action_date', 'introduction_path')
        if any(not isinstance(c[k], str) for k in fields) or not c['id'] or c['id'] in seen:
            raise ValueError('Invalid or duplicate contact')
        seen.add(c['id'])
        if c['status'] not in ['new', 'contacted', 'replied', 'qualified', 'meeting', 'customer', 'closed', 'opted_out']:
            raise ValueError('Invalid contact status')
        if c['next_action_date']:
            datetime.date.fromisoformat(c['next_action_date'])
        if not isinstance(c['sources'], list) or any(urlparse(u).scheme not in ['https', 'http'] or not urlparse(u).netloc for u in c['sources']):
            raise ValueError('Invalid source URL')
        if any(url not in source_urls for url in c['sources']):
            raise ValueError('Contact source was not collected')
        if c['id'] not in old and (not c['sources'] or not c['fit']):
            raise ValueError('New prospects need sources and a reason they fit')
        if c['email']:
            email = c['email'].lower()
            if email in emails and emails[email] != c['id']:
                raise ValueError('Email belongs to an existing contact')
            emails[email] = c['id']
        if c['id'] in old and old[c['id']]['status'] in ['customer', 'opted_out'] and c['status'] != old[c['id']]['status']:
            raise ValueError('Keep customer and opt-out status')
        contacts[c['id']] = {**old.get(c['id'], {}), **{k: c[k] for k in (*fields, 'sources')},
            'manual_notes': old.get(c['id'], {}).get('manual_notes', '')}
    incoming = {m['id']: m for m in ctx['messages']}
    resolutions = plan['messages']
    if len(resolutions) != len(incoming) or {m['id'] for m in resolutions} != set(incoming):
        raise ValueError('Resolve each new message once')
    for m in resolutions:
        if not isinstance(m['resolution'], str) or not m['resolution']:
            raise ValueError('Each message needs a resolution')
        if m['contact_id']:
            if m['contact_id'] not in contacts:
                raise ValueError('Message refers to an unknown contact')
            source, contact = incoming[m['id']], contacts[m['contact_id']]
            if source.get('contact_id') != contact['id'] and not (source.get('email') and source['email'].lower() == contact['email'].lower()):
                raise ValueError('Message identity is not established')
    task_ids = set()
    for task in plan['tasks']:
        if any(not isinstance(task[k], str) for k in ['contact_id', 'action', 'due_date', 'reason', 'draft']):
            raise ValueError('Invalid task')
        contact = contacts[task['contact_id']]
        if contact['status'] in ['customer', 'opted_out', 'closed']:
            raise ValueError('Task targets an inactive contact')
        if datetime.date.fromisoformat(task['due_date']) > datetime.date.fromisoformat(ctx['day']):
            raise ValueError('Daily task is not due yet')
        key = (task['contact_id'], task['action'])
        if key in task_ids or not task['action'] or not task['reason']:
            raise ValueError('Empty or duplicate task')
        task_ids.add(key)
    if not isinstance(plan['research_notes'], str):
        raise ValueError('Research notes must be text')
    return ctx, plan, contacts


def save(args):
    ctx, plan, contacts = checked(args['context'], args['plan'], args['observations'])
    current = args['crm'].encode()
    plan_id = digest((ctx['day'] + args['context'] + args['plan']).encode())
    state = json.loads(current)
    if state.get('last_plan') != plan_id:
        if digest(current) != ctx['sha256']:
            raise ValueError('CRM changed after it was read; start a new run')
        messages = {m['id']: m for m in state['messages']}
        incoming = {m['id']: m for m in ctx['messages']}
        for m in plan['messages']:
            messages[m['id']] = {**incoming[m['id']], **m}
        state.update(contacts=list(contacts.values()), messages=list(messages.values()), last_plan=plan_id)
        state.setdefault('days', {})[ctx['day']] = {'tasks': plan['tasks'], 'research_notes': plan['research_notes']}
        current = (json.dumps(state, indent=2) + '\n').encode()
    lines = ['# Outbound tasks — ' + ctx['day'], '']
    for task in plan['tasks']:
        contact = contacts[task['contact_id']]
        lines += [f"## {task['action']}: {contact['name']} · {contact['company']}",
            'Due: ' + task['due_date'], '', task['reason'], '', task['draft'], '']
    if not plan['tasks']:
        lines += ['No outreach tasks are due today.', '']
    unresolved = [m for m in state['messages'] if not m['contact_id']]
    lines += ['## Messages to review', ''] + [m['id'] + ': ' + m['resolution'] for m in unresolved]
    lines += ['', '## Research notes', '', plan['research_notes']]
    output = Path(os.environ['METHOD_OUTPUT_DIR'])
    output.mkdir(parents=True, exist_ok=True)
    def artifact(name, data):
        (output / name).write_bytes(data)
        return {'path': name, 'sha256': digest(data)}
    return {'tasks': artifact('tasks.md', ('\n'.join(lines) + '\n').encode()),
        'receipt': artifact('receipt.json', json.dumps({'day': ctx['day'], 'crm_sha256': digest(current),
            'contacts': len(state['contacts']), 'messages': len(state['messages'])}).encode()),
        'state': {'crm': current.decode()}}
