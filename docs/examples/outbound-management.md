# Worked example: outbound-management

Reads email and prospect sources, updates persistent CRM state, and saves daily tasks and outreach drafts for review.

## TASK.md

```markdown
# Request

Read campaign email and prospect sources each day. Keep the CRM current, preserve
owner notes and opt-outs, and prepare due tasks with outreach drafts for review.
Keep messages unsent. Reuse saved state on the next run.
```

## outbound.method

```yaml
format: method/3.3
name: Manage daily outbound
goal: Read campaign email, find prospects in Happenstance, enrich them from company and LinkedIn pages, update the CRM, and prepare today's outreach tasks.
inputs:
  day:
    type: text
    description: Date to plan, YYYY-MM-DD.
  from_date:
    type: text
    description: First email date to read, YYYY-MM-DD. Use an overlap with the last run.
state:
  crm:
    type: text
    description: CRM as JSON text in shared Method account state. Updated only by save_day, after every check passes.
environment:
  browser:
    type: browser
    description: Browser signed in to email, Happenstance, and LinkedIn.
steps:
  read_crm:
    name: Read the CRM
    purpose: Rejects an invalid date or an email start date after the planned day. Returns the target settings, the contacts, the IDs of messages already matched to a contact, and the hash of the supplied CRM text. Changes nothing.
    in:
      day: inputs.day
      from_date: inputs.from_date
      crm: state.crm
    do: {kind: run, runtime: python, entrypoint: read_crm.py}
    out:
      target:
        type: record
        fields: {customer: text, offer: text, new_prospects_per_day: number, mailbox_url: text}
        description: Target customer, offer, daily prospect limit, and mailbox URL.
      contacts:
        type: list
        fields:
          id: text
          name: text
          email: text
          company: text
          role: text
          fit: text
          sources: {type: list, items: text}
          status: text
          next_action: text
          next_action_date: text
          introduction_path: text
          manual_notes: text
        description: Contacts saved in the CRM.
      resolved:
        type: list
        items: text
        description: IDs of saved messages that are matched to a contact.
      crm_sha256:
        type: text
        description: SHA-256 of the CRM text that this run read.

  read_email:
    name: Read campaign email
    no_effect_reason: Reads the mailbox in the browser; sends, replies to, and deletes nothing.
    changes: [environment.browser]
    in:
      mailbox_url: target.mailbox_url
      offer: target.offer
      from_date: inputs.from_date
      day: inputs.day
      contacts: contacts
    do:
      kind: agent
      model: default
      browser: environment.browser
      prompt: |
        Open {{mailbox_url}} and read the received and sent campaign email from {{from_date}} through {{day}}.
        Search by the addresses and companies in contacts and by this offer: {{offer}}
        Open each matching thread and keep every message, including opt-outs and replies from people who are not in contacts.
        Set contact_id when the address matches a contact; otherwise leave it empty. Leave email empty when the address is not shown.
        If you cannot open the mailbox, set status to blocked and say why in notes.
    out:
      messages:
        type: list
        fields: {id: text, url: text, email: text, at: text, direction: text, text: text, contact_id: text}
        description: Campaign messages. id is the mailbox message ID, url the thread link, at an ISO date and time, direction received or sent.
      email_search:
        type: record
        fields: {status: text, notes: text}
        description: complete or blocked, and what limited the search.
    check: {kind: run, runtime: python, entrypoint: check_sources.py, args: [email]}
    reading:
      check_name: Check email records
      check: Requires a complete search, unique message IDs, valid dates, https thread links, and message text.

  find_prospects:
    name: Find prospects in Happenstance
    no_effect_reason: Searches Happenstance in the browser; sends no messages or introduction requests.
    changes: [environment.browser]
    after: read_email
    in:
      customer: target.customer
      offer: target.offer
      limit: target.new_prospects_per_day
      contacts: contacts
    do:
      kind: agent
      model: default
      browser: environment.browser
      prompt: |
        Open https://happenstance.ai and ask:
        "Find people in my network who fit this customer description: {{customer}}
        I offer {{offer}} Show their current roles, companies, profile links,
        and how I can reach them or get an introduction."
        Choose up to {{limit}} people from the results who fit the description and are not in contacts.
        Copy their details as Happenstance shows them. Leave email empty when it is not shown.
        If no one fits, return no prospects. If you cannot search, set status to blocked and say why in notes.
    out:
      prospects:
        type: list
        fields: {name: text, email: text, company: text, role: text, profile_url: text, introduction_path: text}
        description: New people who fit the target customer.
      prospect_search:
        type: record
        fields: {status: text, notes: text}
        description: complete or blocked, and what limited the search.
    check: {kind: run, runtime: python, entrypoint: check_sources.py, args: [prospects]}
    reading:
      check_name: Check search access
      check: Requires a complete Happenstance search. A complete search may find no prospects.

  enrich:
    name: Check each prospect's pages
    no_effect_reason: Reads company and LinkedIn pages in the browser; sends no messages or connection requests.
    changes: [environment.browser]
    after: find_prospects
    each: {prospect: prospects}
    in:
      offer: target.offer
    do:
      kind: agent
      model: default
      browser: environment.browser
      prompt: |
        Open the website of {{prospect.company}} and the LinkedIn profile of {{prospect.name}} ({{prospect.profile_url}}; search LinkedIn when this is empty).
        Record each page you read with its URL and the facts you read there.
        From those facts, give the current role and one sentence on why this offer fits: {{offer}}
        Give an email address only when a page shows it; otherwise leave email empty.
        In notes, name each page that you could not open.
    out:
      enrichment:
        type: record
        fields:
          email: text
          role: text
          fit: text
          sources: {type: list, fields: {url: text, facts: text}}
          notes: text
        description: What the prospect's pages show.
    check: {kind: run, runtime: python, entrypoint: check_sources.py, args: [enrichment]}
    reading:
      check_name: Check page records
      check: Requires at least one source, each with an https link and the facts read there.

  update_contacts:
    name: Update contacts
    in:
      contacts: contacts
      resolved: resolved
      messages: messages
      prospects: prospects
      enrichment: enrichment
    do:
      kind: call
      model: default
      prompt: |
        Return each contact that the new messages or the new prospects add or change.
        Skip messages whose id is in resolved. Match each other message to a contact by contact_id or exact email.
        Give each message a short resolution, such as "Asked for pricing". When no contact matches, leave contact_id empty and say what a person must check.
        Set the contact's status, next_action, and next_action_date from its messages. Status is new, contacted, replied, qualified, meeting, customer, closed, or opted_out.
        Never change a customer or opted_out status. Leave next_action_date empty when nothing is due.
        Add each prospect with status new. The enrichment at the same position gives its role, fit, email, and sources (the page URLs).
        Use email:<address> as a new contact's id, or its profile_url when the email is unknown. Leave an unknown email empty.
    out:
      updated_contacts:
        type: list
        fields:
          id: text
          name: text
          email: text
          company: text
          role: text
          fit: text
          sources: {type: list, items: text}
          status: text
          next_action: text
          next_action_date: text
          introduction_path: text
        description: New and changed contacts.
      resolutions:
        type: list
        fields: {id: text, contact_id: text, resolution: text}
        description: One entry for each new message.
    check: {kind: run, runtime: python, entrypoint: check_plan.py, args: [contacts]}
    reading:
      check_name: Check contacts
      check: Requires unique contacts with a valid status and date, collected sources and a fit for new prospects, one contact per email, unchanged customer and opt-out status, and one resolution per new message whose contact matches by ID or exact email.

  draft_tasks:
    name: Draft today's tasks
    in:
      day: inputs.day
      offer: target.offer
      contacts: contacts
      updated_contacts: updated_contacts
      enrichment: enrichment
    do:
      kind: call
      model: default
      prompt: |
        Write the outreach tasks due on {{day}}. A contact in updated_contacts replaces the contact with the same id in contacts.
        Make one task for each contact whose next_action_date is {{day}} or earlier, and one for each contact with status new.
        Skip contacts whose status is customer, closed, or opted_out.
        Set action to the next action, due_date to next_action_date or {{day}} when it is empty, and reason to one sentence.
        Write a short draft email that uses the contact's facts and this offer: {{offer}} Leave draft empty when the task is not an email, such as a meeting.
    out:
      day_tasks:
        type: list
        fields: {contact_id: text, action: text, due_date: text, reason: text, draft: text}
        description: Tasks and outreach drafts for review.
    check: {kind: run, runtime: python, entrypoint: check_plan.py, args: [tasks]}
    reading:
      check_name: Check tasks
      check: Requires unique tasks with an action and a reason, due by the planned day, for known contacts that are not customers, closed, or opted out.

  save_day:
    name: Update the CRM and save today's tasks
    purpose: Repeats the contact and task checks, then rejects a changed CRM unless this plan is already saved. Saves new and changed contacts with their owner notes kept, message resolutions, today's tasks, and research notes made from the search and page notes. Returns the replacement for state.crm, the task list, and a receipt. Repeating the same plan reuses its state update and rewrites the same local result files.
    changes: [state.crm]
    in:
      crm: state.crm
      crm_sha256: crm_sha256
      day: inputs.day
      contacts: contacts
      resolved: resolved
      messages: messages
      email_search: email_search
      prospect_search: prospect_search
      enrichment: enrichment
      updated_contacts: updated_contacts
      resolutions: resolutions
      day_tasks: day_tasks
    do: {kind: run, runtime: python, entrypoint: save_day.py}
    out:
      tasks:
        type: file
        description: Daily task list and outreach drafts for review.
      receipt:
        type: file
        description: Saved CRM hash, contact count, and message count.
    check: {file: tasks}
result:
  tasks: tasks
  receipt: receipt
run_prompt: Run Manage daily outbound for today using my CRM and new messages. Show me the tasks and outreach drafts for review.
files:
  - crm.py
  - read_crm.py
  - check_sources.py
  - check_plan.py
  - save_day.py
  - runtime.json
```

## read_crm.py

```python
import json
import sys
from crm import read
print(json.dumps(read(json.load(sys.stdin))))
```

## crm.py

```python
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
```

## check_sources.py

```python
import json
import sys
from crm import check_email, check_enrichment, check_search
args = json.load(sys.stdin)
out = args['outputs']
checks = {'email': lambda: check_email(out['email_search'], out['messages']),
    'prospects': lambda: check_search(out['prospect_search'], 'happenstance'),
    'enrichment': lambda: check_enrichment(out['enrichment'])}
try:
    checks[sys.argv[1]]()
    result = {'status': 'pass', 'reason': 'Source records are complete.', 'evidence': []}
except (ValueError, KeyError, TypeError) as error:
    result = {'status': 'fail', 'reason': str(error), 'evidence': []}
print(json.dumps(result))
```

## check_plan.py

```python
import json
import sys
from crm import check_contacts, check_tasks
args = json.load(sys.stdin)
given, out = args['inputs'], args['outputs']
try:
    if sys.argv[1] == 'contacts':
        check_contacts(given['contacts'], given['resolved'], given['messages'], given['enrichment'],
            out['updated_contacts'], out['resolutions'])
    else:
        contacts = {c['id']: c for c in given['contacts'] + given['updated_contacts']}
        check_tasks(given['day'], contacts, out['day_tasks'])
    result = {'status': 'pass', 'reason': 'The ' + sys.argv[1] + ' are valid.', 'evidence': []}
except (ValueError, KeyError, TypeError) as error:
    result = {'status': 'fail', 'reason': str(error), 'evidence': []}
print(json.dumps(result))
```

## save_day.py

```python
import json
import sys
from crm import save
print(json.dumps(save(json.load(sys.stdin))))
```

## starter/crm.json

```json
{
  "target": {
    "customer": "Operations leaders at small US logistics companies who still process customer requests manually.",
    "offer": "A service that turns repeated work into reusable automated workflows.",
    "new_prospects_per_day": 3,
    "mailbox_url": "https://mail.google.com/mail/u/0/"
  },
  "contacts": [],
  "messages": [],
  "days": {}
}
```

## inputs.json

```json
{
  "day": "2026-09-17",
  "from_date": "2026-09-10"
}
```

## runtime.json

```json
{
  "allow_local_processes": true,
  "runtimes": { "python": { "command": "python3", "version": "3.11+" } }
}
```

## fixtures/crm.json

```json
{
  "target": {
    "customer": "Operations leaders at small US logistics companies who still process customer requests manually.",
    "offer": "A service that turns repeated work into reusable automated workflows.",
    "new_prospects_per_day": 3,
    "mailbox_url": "https://mail.google.com/mail/u/0/"
  },
  "contacts": [
    {
      "id": "c1",
      "name": "Alex Kim",
      "email": "alex@north.example",
      "company": "North",
      "role": "Operations lead",
      "fit": "Manages a small logistics team",
      "sources": [],
      "status": "contacted",
      "next_action": "Review follow-up",
      "next_action_date": "2026-09-17",
      "manual_notes": "Keep this owner note.",
      "introduction_path": ""
    },
    {
      "id": "c2",
      "name": "Morgan Bell",
      "email": "morgan@south.example",
      "company": "South",
      "role": "Operations lead",
      "fit": "Manages a small logistics team",
      "sources": [],
      "status": "customer",
      "next_action": "",
      "next_action_date": "",
      "manual_notes": "Keep this owner note.",
      "introduction_path": ""
    },
    {
      "id": "c3",
      "name": "Sam Lee",
      "email": "sam@east.example",
      "company": "East",
      "role": "Operations lead",
      "fit": "Manages a small logistics team",
      "sources": [],
      "status": "contacted",
      "next_action": "",
      "next_action_date": "",
      "manual_notes": "Keep this owner note.",
      "introduction_path": ""
    }
  ],
  "messages": [],
  "days": {}
}
```

## fixtures/observations.json

```json
{
  "email_search": {
    "status": "complete",
    "notes": ""
  },
  "prospects": [],
  "prospect_search": {
    "status": "complete",
    "notes": "No new prospects in this state test."
  },
  "enrichment": []
}
```

## fixtures/plan.json

```json
{
  "updated_contacts": [
    {
      "id": "c1",
      "name": "Alex Kim",
      "email": "alex@north.example",
      "company": "North",
      "role": "Operations lead",
      "fit": "Manages a small logistics team",
      "sources": [],
      "status": "replied",
      "next_action": "Send pricing",
      "next_action_date": "2026-09-17",
      "introduction_path": ""
    },
    {
      "id": "c2",
      "name": "Morgan Bell",
      "email": "morgan@south.example",
      "company": "South",
      "role": "Operations lead",
      "fit": "Manages a small logistics team",
      "sources": [],
      "status": "customer",
      "next_action": "",
      "next_action_date": "",
      "introduction_path": ""
    },
    {
      "id": "c3",
      "name": "Sam Lee",
      "email": "sam@east.example",
      "company": "East",
      "role": "Operations lead",
      "fit": "Manages a small logistics team",
      "sources": [],
      "status": "opted_out",
      "next_action": "",
      "next_action_date": "",
      "introduction_path": ""
    }
  ],
  "resolutions": [
    {
      "id": "m1",
      "contact_id": "c1",
      "resolution": "Recorded reply"
    },
    {
      "id": "m2",
      "contact_id": "c3",
      "resolution": "Recorded reply"
    },
    {
      "id": "m3",
      "contact_id": "",
      "resolution": "Review sender"
    }
  ],
  "day_tasks": [
    {
      "contact_id": "c1",
      "action": "Send pricing",
      "due_date": "2026-09-17",
      "reason": "Requested by Alex",
      "draft": "Hello Alex, let us review your needs."
    }
  ]
}
```

## fixtures/tasks.md

```markdown
# Outbound tasks — 2026-09-17

## Send pricing: Alex Kim · North
Due: 2026-09-17

Requested by Alex

Hello Alex, let us review your needs.

## Messages to review

m3: Review sender

## Research notes

Happenstance: No new prospects in this state test.
```

## fixtures/receipt.json

```json
{"day": "2026-09-17", "crm_sha256": "71a30d38fb2fcffb773ab3071367a239af0c01abca0394daef1d66a58fde9635", "contacts": 3, "messages": 3}
```

## fixtures/state.json

```json
{
  "target": {
    "customer": "Operations leaders at small US logistics companies who still process customer requests manually.",
    "offer": "A service that turns repeated work into reusable automated workflows.",
    "new_prospects_per_day": 3,
    "mailbox_url": "https://mail.google.com/mail/u/0/"
  },
  "contacts": [
    {
      "id": "c1",
      "name": "Alex Kim",
      "email": "alex@north.example",
      "company": "North",
      "role": "Operations lead",
      "fit": "Manages a small logistics team",
      "sources": [],
      "status": "replied",
      "next_action": "Send pricing",
      "next_action_date": "2026-09-17",
      "manual_notes": "Keep this owner note.",
      "introduction_path": ""
    },
    {
      "id": "c2",
      "name": "Morgan Bell",
      "email": "morgan@south.example",
      "company": "South",
      "role": "Operations lead",
      "fit": "Manages a small logistics team",
      "sources": [],
      "status": "customer",
      "next_action": "",
      "next_action_date": "",
      "manual_notes": "Keep this owner note.",
      "introduction_path": ""
    },
    {
      "id": "c3",
      "name": "Sam Lee",
      "email": "sam@east.example",
      "company": "East",
      "role": "Operations lead",
      "fit": "Manages a small logistics team",
      "sources": [],
      "status": "opted_out",
      "next_action": "",
      "next_action_date": "",
      "manual_notes": "Keep this owner note.",
      "introduction_path": ""
    }
  ],
  "messages": [
    {
      "id": "m1",
      "url": "https://mail.google.com/mail/u/0/#inbox/m1",
      "email": "alex@north.example",
      "at": "2026-09-17T09:00:00-04:00",
      "direction": "received",
      "text": "Can you send pricing today?",
      "contact_id": "c1",
      "resolution": "Recorded reply"
    },
    {
      "id": "m2",
      "url": "https://mail.google.com/mail/u/0/#inbox/m2",
      "email": "sam@east.example",
      "at": "2026-09-17T10:00:00-04:00",
      "direction": "received",
      "text": "Please stop contacting me.",
      "contact_id": "c3",
      "resolution": "Recorded reply"
    },
    {
      "id": "m3",
      "url": "https://mail.google.com/mail/u/0/#inbox/m3",
      "email": "",
      "at": "2026-09-17T11:00:00-04:00",
      "direction": "received",
      "text": "Alex: send the contract. Sender address was not captured.",
      "contact_id": "",
      "resolution": "Review sender"
    }
  ],
  "days": {
    "2026-09-17": {
      "tasks": [
        {
          "contact_id": "c1",
          "action": "Send pricing",
          "due_date": "2026-09-17",
          "reason": "Requested by Alex",
          "draft": "Hello Alex, let us review your needs."
        }
      ],
      "research_notes": "Happenstance: No new prospects in this state test."
    }
  },
  "last_plan": "f3052a54726c6e2b793368cd8138303959e788fe23adee2f2975fdf4303737f4"
}
```

## README.md

````markdown
# Manage daily outbound

Each run reads email, finds prospects in Happenstance, checks their company and
LinkedIn pages, updates the CRM, and writes today's tasks with outreach drafts.
Messages stay unsent until you review and act on the tasks.

## Steps

| Step | Type | Output |
| --- | --- | --- |
| `read_crm` | run | target settings, contacts, resolved message IDs, CRM hash |
| `read_email` | agent, browser | `messages`, `email_search` |
| `find_prospects` | agent, browser | `prospects`, `prospect_search` |
| `enrich` | agent, browser, `each` prospect | `enrichment` for each prospect |
| `update_contacts` | call | `updated_contacts`, `resolutions` |
| `draft_tasks` | call | `day_tasks` |
| `save_day` | run, changes `state.crm` | `tasks.md`, `receipt.json` |

Each model step does one task. The shape of each output is declared in `out`, so
the prompts say only what to do and what to leave empty when a source does not
have the answer.

## Sources

- **Email:** opens your mailbox in the browser and reads received and sent
  messages for the campaign. Saves message IDs and thread links with the CRM.
- **Happenstance:** searches your connected network for people who fit your
  target customer, including introduction paths. See its
  [people search guide](https://happenstance.ai/guides/ai-people-search).
- **Company websites and LinkedIn:** checks roles, company activity, and the
  reason your offer fits. Saves page links and the facts read there. This uses
  the existing browser and does not require a separate enrichment subscription.

Each browser step has a check. It stops the run if the agent reports blocked
access or returns a record without its link. A complete search may return no
matches. Checks require source records; they do not prove that the agent found
every email or that every source is accurate.

## Set up and run

Run from this folder. Copy the empty starter CRM once to set up the account.
Set `target.customer`, `target.offer`, `target.new_prospects_per_day`, and
`target.mailbox_url` for your business. The starter uses Gmail; replace its URL
with your webmail URL if needed. Use the intended signed-in account.

```sh
mkdir -p work/crm
cp starter/crm.json work/crm/crm.json
method validate outbound.method
method publish outbound.method --reason "First version"
python3 - <<'PY' > work/state.json
import json
from pathlib import Path
print(json.dumps({'crm': Path('work/crm/crm.json').read_text()}))
PY
chmod 600 work/state.json
method state WORKFLOW_ID --enable --file work/state.json
method run WORKFLOW_ID --version VERSION_ID --inputs inputs.json
```

Use the IDs returned by `save`. Set `day` and `from_date` in `inputs.json` before
each run. Use an overlap with the last run so late replies are included.
Method connects the browser and uses the calling agent. Follow its setup request
if email, Happenstance, or LinkedIn needs sign-in.

Open the returned `tasks.md` and `receipt.json`. Updates are saved in shared
Method account state. The setup file is a snapshot, not the current CRM. Run the saved Method daily
or use your scheduler; this Method does not create a schedule itself.

## Saved state

The CRM keeps contacts, owner notes, message history, introduction paths, and
daily plans. Already resolved email IDs are skipped. Unclear senders remain for
review. Customers and opt-outs stay out of outreach tasks.

A checked plan returns a replacement for `state.crm`. Method accepts that state
only after the save check passes. Shared account state uses a run lock and revision
checks so local and deployed runs use one current CRM. If the CRM changed during
research, the save stops. Repeating the same save does not repeat its updates.
The receipt records the saved state hash. Keep shared state enabled for normal use.

`update_contacts` and `draft_tasks` each have a check that `save_day` runs again
before it changes the CRM. The research notes for the day are the notes from the
email search, the Happenstance search, and the pages that could not be opened.

## Deploy

After a saved-version run completes, use `method deploy --from-run RUN_DIRECTORY`.
Review its runner, browser sites, coding-agent access, and shared state, then use
the returned approval command. The deployed Method uses the same account CRM;
it does not need a writable local folder. Complete any runner sign-in checks.
Deployment prepares the runner; it does not schedule or send outreach.

## Files and checks

- `outbound.method`: read CRM, read email, find and enrich prospects, update contacts, draft tasks, save.
- `crm.py` and entry scripts: state reads, source checks (`check_sources.py email|prospects|enrichment`),
  contact and task checks (`check_plan.py contacts|tasks`), state replacements.
- `runtime.json`: Python setup; no third-party Python libraries.
- `starter/crm.json`: empty CRM with editable target settings.
- `inputs.json`: email date range and date to plan.

Fictional records are only in `fixtures/` for local state
tests. They are not inputs to this Method. The tests cover two-day history,
repeated saves, stale writes, owner notes, opt-outs, unclear senders, and blocked
sources. A live run is still needed to check signed-in access and research quality.

Run the state tests offline with `python3 -m unittest crm_test.py`.
`fixtures/observations.json` and `fixtures/plan.json` hold step outputs for the
fictional first day. `fixtures/tasks.md`, `fixtures/receipt.json`, and
`fixtures/state.json` are the outputs that `save_day` makes from them, not a live
account run. A test checks that they are current.
````

## Installed files

- outbound-management/README.md
- outbound-management/TASK.md
- outbound-management/check_plan.py
- outbound-management/check_sources.py
- outbound-management/crm.py
- outbound-management/crm_test.py
- outbound-management/fixtures/README.md
- outbound-management/fixtures/crm.json
- outbound-management/fixtures/day-1/messages.json
- outbound-management/fixtures/day-2/messages.json
- outbound-management/fixtures/observations.json
- outbound-management/fixtures/plan.json
- outbound-management/fixtures/receipt.json
- outbound-management/fixtures/state.json
- outbound-management/fixtures/tasks.md
- outbound-management/inputs.json
- outbound-management/outbound.method
- outbound-management/read_crm.py
- outbound-management/runtime.json
- outbound-management/save_day.py
- outbound-management/starter/crm.json
