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
format: method/3.2
name: Manage daily outbound
goal: Search Happenstance, read email, enrich prospects from company and LinkedIn pages, and prepare today's outreach tasks.
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
    description: CRM as JSON text in shared Method account state. Updated only after the save check passes.
environment:
  browser:
    type: browser
    description: Browser signed in to email, Happenstance, and LinkedIn.
steps:
  read_crm:
    name: Read the CRM
    in:
      day: inputs.day
      crm: state.crm
      from_date: inputs.from_date
    do:
      kind: run
      runtime: python
      entrypoint: read_crm.py
    out:
      context:
        type: text
        description: Current CRM, target customer, email dates, and state hash as JSON.
    purpose: Checks the two dates and rejects an email start date after the planned day. Returns the CRM, date range, and hash of the supplied state.
  gather_sources:
    name: Read email and find prospects
    changes:
      - environment.browser
    in:
      context: context
    do:
      kind: agent
      model: default
      browser: environment.browser
      prompt: |
        Open target.mailbox_url from the CRM in context. Read received and sent
        email from from_date through day for the outbound campaign. Search by
        existing contact addresses, companies, and target.offer. Open the threads
        and read the messages, including opt-outs and requests. Keep each email's
        stable message ID, thread URL, sender address, date, direction, and text.
        Collect relevant replies from people not yet in the CRM too.

        Open https://happenstance.ai and ask:
        "Find people in my network who fit this customer description: <target.customer>.
        I offer <target.offer>. Show their current roles, companies, profile links,
        and how I can reach them or get an introduction."
        Replace the angle-bracket values with the CRM's target values.
        Select up to target.new_prospects_per_day suitable new prospects.

        Open each prospect's company website and LinkedIn profile. Check their
        current role, what the company does, and the reason our offer fits.
        Record source URLs and the facts read on each page. Use contact details
        shown by the sources; leave unknown details empty.

        Return observations as JSON with messages, prospects, and searches.
        Each message has id, url, email, at, direction, text, and contact_id
        when known. Each prospect has name, email, company, role, fit, sources,
        profile_url, and introduction_path. Each source has url and facts.
        searches contains email, happenstance, and enrichment; each has status
        complete or blocked, and notes describing the search and any limits.
        A completed search can have no results. Report blocked access as blocked.
        Read email and prepare evidence; leave messages unsent.
    out:
      observations:
        type: text
        description: Email records, Happenstance prospects, enrichment facts, and search results as JSON.
    check:
      kind: run
      runtime: python
      entrypoint: check_sources.py
    reading:
      check: Requires completed searches, unique email IDs, valid message dates and links, and linked enrichment facts. A completed search may contain no results.
  plan_day:
    name: Update contact status and plan the day
    in:
      context: context
      observations: observations
    do:
      kind: agent
      model: default
      prompt: |
        Read the CRM in context and the email and prospect records in observations.
        Use email:<address> as a new contact ID when an email is known,
        otherwise use the person's full profile URL. Keep existing IDs.
        Add the prospect's role, fit, source URLs, and introduction path to
        the CRM. sources is a list of URLs from the enrichment records.
        Skip email IDs already resolved in the CRM; revisit unresolved senders.

        Read each new message. Match it by contact ID or exact email. When its
        sender is unclear, record it as unresolved for review. Record replies,
        requests, meetings, opt-outs, and sent messages in the contact's status
        and next action. Keep customers and opt-outs out of outreach tasks.
        An outreach draft is a task to review; it is not a sent message.

        Prepare today's due tasks and drafts using target.offer and the facts
        you found. Each task needs a contact ID, action, due date, reason, and
        draft. For tasks such as meetings, draft can be empty. Record gaps in
        research_notes, including pages you could not read.

        Return plan as JSON with contacts, messages, tasks, and research_notes.
        contacts is a list of new or changed contacts with id, name, email,
        company, role, fit, sources, status, next_action, and next_action_date.
        Use status new, contacted, replied, qualified, meeting, customer,
        closed, or opted_out. Use an empty next_action_date when none is due.
        sources is a list of full page URLs. Include introduction_path as text. Leave unknown email empty.
        messages contains one entry per email not yet resolved in the CRM: id, contact_id, and
        resolution. Leave contact_id empty for an unresolved sender.
        tasks contains contact_id, action, due_date, reason, and draft.
        research_notes must be one JSON string. Combine multiple notes into
        paragraphs within that string. Use an empty string when there are no
        notes. Do not return a list or an object for research_notes.
        In draft and research_notes strings, encode paragraph breaks as JSON
        newline escapes that decode to line breaks, not literal backslash-n text.
    out:
      plan:
        type: text
        description: JSON object with contacts, messages, and tasks lists, and research_notes as one string.
    check:
      kind: run
      runtime: python
      entrypoint: check_plan.py
    reading:
      check: Checks contact identities and sources, resolves each new message once, preserves customers and opt-outs, and requires unique due tasks for active contacts and text research notes.
  save_day:
    name: Update the CRM and save today's tasks
    changes:
      - state.crm
    in:
      crm: state.crm
      context: context
      plan: plan
      observations: observations
    do:
      kind: run
      runtime: python
      entrypoint: save_day.py
    out:
      tasks:
        type: file
        description: Daily task list and outreach drafts for review.
      receipt:
        type: file
        description: Saved CRM hash, contact count, and message count.
    check:
      file: tasks
    purpose: Validates the plan and rejects a changed CRM unless this plan is already saved. Returns updated CRM state, daily tasks, and a receipt. Repeating the same plan reuses its state update and rewrites the same local result files.
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
```

## check_sources.py

```python
import json
import sys
from crm import sources
args = json.load(sys.stdin)
try:
    sources(args['outputs']['observations'])
    result = {'status': 'pass', 'reason': 'Source searches completed; email links and enrichment records are present.', 'evidence': []}
except (ValueError, KeyError, TypeError) as error:
    result = {'status': 'fail', 'reason': str(error), 'evidence': []}
print(json.dumps(result))
```

## check_plan.py

```python
import json
import sys
from crm import checked
args = json.load(sys.stdin)
try:
    checked(args['inputs']['context'], args['outputs']['plan'], args['inputs']['observations'])
    result = {'status': 'pass', 'reason': 'Contact identities, message coverage, sources, and daily tasks are valid.', 'evidence': []}
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
  "messages": [
    {
      "id": "m1",
      "contact_id": "c1",
      "email": "alex@north.example",
      "at": "2026-09-17T09:00:00-04:00",
      "direction": "received",
      "text": "Can you send pricing today?",
      "url": "https://mail.google.com/mail/u/0/#inbox/m1"
    },
    {
      "id": "m2",
      "contact_id": "c3",
      "email": "sam@east.example",
      "at": "2026-09-17T10:00:00-04:00",
      "direction": "received",
      "text": "Please stop contacting me.",
      "url": "https://mail.google.com/mail/u/0/#inbox/m2"
    },
    {
      "id": "m3",
      "at": "2026-09-17T11:00:00-04:00",
      "direction": "received",
      "text": "Alex: send the contract. Sender address was not captured.",
      "url": "https://mail.google.com/mail/u/0/#inbox/m3"
    }
  ],
  "prospects": [],
  "searches": {
    "email": {
      "status": "complete",
      "notes": "Fixture"
    },
    "happenstance": {
      "status": "complete",
      "notes": "Fixture"
    },
    "enrichment": {
      "status": "complete",
      "notes": "Fixture"
    }
  }
}
```

## fixtures/plan.json

```json
{
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
  "tasks": [
    {
      "contact_id": "c1",
      "action": "Send pricing",
      "due_date": "2026-09-17",
      "reason": "Requested by Alex",
      "draft": "Hello Alex, let us review your needs."
    }
  ],
  "research_notes": "No new prospects in this state test."
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

No new prospects in this state test.
```

## fixtures/receipt.json

```json
{"day": "2026-09-17", "crm_sha256": "3db1de85d1289245898ac840bfb4434c529fb45ab342d04f2ee120f7e1c30be8", "contacts": 3, "messages": 3}
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
      "contact_id": "c1",
      "email": "alex@north.example",
      "at": "2026-09-17T09:00:00-04:00",
      "direction": "received",
      "text": "Can you send pricing today?",
      "url": "https://mail.google.com/mail/u/0/#inbox/m1",
      "resolution": "Recorded reply"
    },
    {
      "id": "m2",
      "contact_id": "c3",
      "email": "sam@east.example",
      "at": "2026-09-17T10:00:00-04:00",
      "direction": "received",
      "text": "Please stop contacting me.",
      "url": "https://mail.google.com/mail/u/0/#inbox/m2",
      "resolution": "Recorded reply"
    },
    {
      "id": "m3",
      "at": "2026-09-17T11:00:00-04:00",
      "direction": "received",
      "text": "Alex: send the contract. Sender address was not captured.",
      "url": "https://mail.google.com/mail/u/0/#inbox/m3",
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
      "research_notes": "No new prospects in this state test."
    }
  },
  "last_plan": "08a1cbcb3f30c7c867d61b314cec9be1ef1dc186b125c3417bbb63e5b30f69da"
}
```

## README.md

````markdown
# Manage daily outbound

Each run reads email, finds prospects in Happenstance, checks their company and
LinkedIn pages, updates the CRM, and writes today's tasks with outreach drafts.
Messages stay unsent until you review and act on the tasks.

## Sources

- **Email:** opens your mailbox in the browser and reads received and sent
  messages for the campaign. Saves message IDs and thread links with the CRM.
- **Happenstance:** searches your connected network for people who fit your
  target customer, including introduction paths. See its
  [people search guide](https://happenstance.ai/guides/ai-people-search).
- **Company websites and LinkedIn:** checks roles, company activity, and the
  reason your offer fits. Saves page links and the facts read there. This uses
  the existing browser and does not require a separate enrichment subscription.

The source check stops the run if the agent reports blocked access. A completed
search may return no matches. Checks require source records; they do not prove
that the agent found every email or that every source is accurate.

## Set up and run

Run from this folder. Copy the empty starter CRM once to set up the account.
Set `target.customer`, `target.offer`, `target.new_prospects_per_day`, and
`target.mailbox_url` for your business. The starter uses Gmail; replace its URL
with your webmail URL if needed. Use the intended signed-in account.

```sh
mkdir -p work/crm
cp starter/crm.json work/crm/crm.json
method validate outbound.method
method save outbound.method
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

The plan uses lists for `contacts`, `messages`, and `tasks`. Its `research_notes`
field is one text string, with paragraph breaks between notes or an empty string
when there are none. The plan check rejects lists and objects in that field before
the CRM is changed.

## Deploy

After a saved-version run completes, use `method deploy --from-run RUN_DIRECTORY`.
Review its runner, browser sites, coding-agent access, and shared state, then use
the returned approval command. The deployed Method uses the same account CRM;
it does not need a writable local folder. Complete any runner sign-in checks.
Deployment prepares the runner; it does not schedule or send outreach.

## Files and checks

- `outbound.method`: read CRM, gather sources, plan and check, save.
- `crm.py` and entry scripts: state reads, source and plan checks, state replacements.
- `runtime.json`: Python setup; no third-party Python libraries.
- `starter/crm.json`: empty CRM with editable target settings.
- `inputs.json`: email date range and date to plan.

Fictional records are only in `fixtures/` for local state
tests. They are not inputs to this Method. The tests cover two-day history,
repeated saves, stale writes, owner notes, opt-outs, unclear senders, and blocked
sources. A live run is still needed to check signed-in access and research quality.

Run the state tests offline with `python3 -m unittest crm_test.py`.
`fixtures/tasks.md`, `fixtures/receipt.json`, and `fixtures/state.json` are recorded
outputs from the fictional first-day fixture, not a live account run.
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
