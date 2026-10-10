# Worked example: support-triage

Reads a help desk ticket, classifies its team, refund request, and urgency, drafts a first reply, updates the ticket, and asks a person when the team is unclear.

## TASK.md

```markdown
# Request

When a support ticket arrives, choose its team, priority, and tags, write a first reply for an agent to check, and update the ticket in the help desk. When the team is not clear, put the ticket in the triage queue and ask a person which team should take it.
```

## support-triage.method

```yaml
format: method/3.4
name: Triage a support ticket
goal: Read a new help desk ticket, choose its queue and priority, draft a first reply, and update the ticket. Ask a person when the team is unclear.
run_data: device
models:
  writer: anthropic/claude-haiku-4.5
secrets:
  HELPDESK_TOKEN: API token for the help desk. read-ticket.mjs and set-ticket.mjs send it as a Bearer token.
inputs:
  ticket_id:
    type: text
    description: ID of the new ticket in the help desk, such as T-1042.
environment:
  helpdesk:
    type: service
    description: Help desk API. GET /tickets/ID reads a ticket; PATCH /tickets/ID sets its queue, priority, tags, and internal note.
steps:
  read:
    name: Read the ticket
    purpose: Reads the ticket from the help desk with HELPDESK_TOKEN and returns its id, subject, and text. Fails when the help desk does not return the ticket. Changes nothing.
    in: {ticket_id: inputs.ticket_id, helpdesk: environment.helpdesk}
    do: {kind: run, runtime: node, entrypoint: read-ticket.mjs}
    out:
      ticket: {type: record, fields: {id: text, subject: text, body: text}, description: The ticket as the help desk returned it.}

  team:
    name: Choose the team
    in: {subject: ticket.subject, body: ticket.body}
    do:
      kind: classify
      question: Which team should handle the main request in this support ticket?
      options:
        billing: Billing - invoices, charges, refunds, and plan changes.
        technical: Technical - errors, outages, and problems using the product.
        account: Account - sign-in, users, and access.
        unclear: Unclear - the ticket does not say enough to choose, or no listed team fits.
    out: team

  refund:
    name: Check for a refund request
    in: {body: ticket.body}
    do:
      kind: classify
      question: Does the customer ask for money back?
      answer: yes_no
    out: refund

  urgency:
    name: Score the urgency
    in: {subject: ticket.subject, body: ticket.body}
    do:
      kind: classify
      question: How urgent is this support ticket for the customer?
      levels: [low, normal, high, urgent]
    out: urgency

  route:
    name: Choose the queue and priority
    purpose: Chooses the team's queue when the team is not unclear and its probability is at least 80%. Otherwise chooses the triage queue and marks the ticket for a person. The priority is the most likely urgency level. Adds the tag refund_request when the probability of a refund request is at least 50%. Returns the rule used. Changes nothing.
    in: {team: team, refund: refund, urgency: urgency}
    do: {kind: run, runtime: node, entrypoint: route.mjs}
    out:
      decision:
        type: record
        description: The queue, priority, and tags, whether a person must choose the team, and the rule used.
        fields:
          queue: text
          priority: text
          tags: {type: list, items: text}
          needs_person: boolean
          rule: text
          reason: text

  draft_reply:
    name: Draft the first reply
    in: {ticket: ticket}
    do:
      kind: call
      model: writer
      prompt: |
        Write the first reply to this support ticket, for a support agent to check and send.
        Thank the customer in one sentence. Then say in one or two sentences what happens next.
        If the ticket does not say what is wrong, ask for the one detail that is missing.
        Do not promise a refund, a date, or a fix. Sign it "The support team".

        Subject: {{ticket.subject}}
        {{ticket.body}}

        Two replies that the team liked:

        Ticket: "I was charged twice for October."
        Reply: "Thank you for telling us about the double charge. Our billing team will check your October invoices and reply within one business day. The support team"

        Ticket: "The export button does nothing."
        Reply: "Thank you for the report. Which browser do you use, and does the export fail for every report or only for one? With that, our technical team can look into it. The support team"
    out:
      reply: {type: text, description: The reply draft for a support agent to check.}

  update:
    name: Update the ticket
    purpose: Sets the ticket's queue, priority, and tags, and adds the reply draft as an internal note, with one PATCH request. A repeated request sets the same values, so a retry is safe. A ticket whose team is unclear goes to the triage queue.
    in:
      ticket_id: inputs.ticket_id
      queue: decision.queue
      priority: decision.priority
      tags: decision.tags
      note: reply
      helpdesk: environment.helpdesk
    do: {kind: run, runtime: node, entrypoint: set-ticket.mjs}
    changes: [environment.helpdesk]
    effects:
      updated:
        intent: The ticket has the chosen priority. The queue is not part of this effect, because the move step changes it after a person's answer.
        in: {ticket_id: inputs.ticket_id, priority: decision.priority}
        observe:
          kind: http
          path: /tickets/{inputs.ticket_id}
          expect: {fields: {priority: "{inputs.priority}"}}
    out:
      updated: {type: record, fields: {id: text, queue: text, priority: text}, description: The queue and priority that the help desk returned.}

  ask_person:
    name: Ask a person for the team
    when: decision.needs_person
    after: update
    in: {ticket: ticket, reason: decision.reason}
    ask: |
      Ticket {{ticket.id}} is in the triage queue: {{reason}}.
      Subject: {{ticket.subject}}

      Which team should handle it: billing, technical, or account?
    out:
      chosen_queue: {type: text, description: "billing, technical, or account"}

  move:
    name: Move the ticket to the chosen team
    when: decision.needs_person
    purpose: Rejects an answer that is not billing, technical, or account. Then sets that queue with one PATCH request and keeps the priority and tags. A repeated request sets the same values.
    in:
      ticket_id: inputs.ticket_id
      queue: chosen_queue
      priority: decision.priority
      tags: decision.tags
      helpdesk: environment.helpdesk
    do: {kind: run, runtime: node, entrypoint: set-ticket.mjs, args: [--team-only]}
    changes: [environment.helpdesk]
    effects:
      moved:
        intent: The ticket is in the queue that the person chose.
        in: {ticket_id: inputs.ticket_id, queue: chosen_queue}
        observe:
          kind: http
          path: /tickets/{inputs.ticket_id}
          expect: {fields: {queue: "{inputs.queue}"}}
    out:
      moved: {type: record, fields: {id: text, queue: text, priority: text}, description: The queue and priority that the help desk returned.}
    accept:
      unused_output: The receipt stays in the run record. The result cannot name it, because the step is skipped when the team is clear.
result:
  decision: decision
  reply: reply
  ticket: updated
files:
  - helpdesk.mjs
  - triage.mjs
```

## triage.mjs

```javascript
// The rules of support-triage.method: the routing rule and the ticket change. No requests; the tests import them.
export const TEAM_THRESHOLD = 0.8;
export const REFUND_THRESHOLD = 0.5;
export const TEAMS = ['billing', 'technical', 'account'];
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

const probability = value => Number.isFinite(value) && value >= 0 && value <= 1;

/** Chooses the queue, priority, and tags from the three classifier results. */
export function route(team, refund, urgency) {
  const options = [...TEAMS, 'unclear'];
  if (!options.includes(team?.choice) || !options.every(id => probability(team.probabilities?.[id])))
    throw Error('Expected a team choice with one probability per option.');
  if (typeof refund?.answer !== 'boolean' || !probability(refund.probability))
    throw Error('Expected a yes or no (true or false) refund answer with the probability of yes.');
  if (!PRIORITIES.includes(urgency?.level)) throw Error('Expected an urgency level.');

  const chosen = team.probabilities[team.choice];
  const base = {priority: urgency.level, tags: refund.probability >= REFUND_THRESHOLD ? ['refund_request'] : []};
  const percent = `${Math.round(chosen * 100)}% probability`;
  if (team.choice === 'unclear')
    return {...base, queue: 'triage', needs_person: true, rule: 'team_unclear', reason: 'the classifier could not choose a team'};
  if (chosen < TEAM_THRESHOLD)
    return {...base, queue: 'triage', needs_person: true, rule: 'team_below_threshold', reason: `the classifier chose ${team.choice} with only ${percent}`};
  return {...base, queue: team.choice, needs_person: false, rule: 'team_meets_threshold', reason: `the classifier chose ${team.choice} with ${percent}`};
}

/** The PATCH body. After a person's answer (teamOnly), the queue must be a team and no note is added. */
export function change({queue, priority, tags, note}, teamOnly = false) {
  const queues = teamOnly ? TEAMS : [...TEAMS, 'triage'];
  const target = teamOnly ? String(queue ?? '').trim().toLowerCase() : queue;
  if (!queues.includes(target)) throw Error(`The queue must be one of ${queues.join(', ')}, not "${queue}".`);
  if (!PRIORITIES.includes(priority)) throw Error(`Unknown priority "${priority}".`);
  if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string')) throw Error('Expected a list of tags.');
  if (teamOnly) return {queue: target, priority, tags};
  if (typeof note !== 'string') throw Error('Expected the reply draft as the note.');
  return {queue: target, priority, tags, internal_note: note};
}
```

## helpdesk.mjs

```javascript
// Help desk requests for the scripts of support-triage.method. Every request sends HELPDESK_TOKEN and stops after 10 seconds.
export async function readInput() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return JSON.parse(text);
}

export async function helpdesk(base, path, {method = 'GET', body} = {}) {
  if (typeof base !== 'string' || !/^https?:\/\//.test(base)) throw Error('The helpdesk connection must be an http or https URL.');
  const token = process.env.HELPDESK_TOKEN;
  if (!token) throw Error('HELPDESK_TOKEN is not set. Run method secret find, or method secret set HELPDESK_TOKEN.');
  const response = await fetch(new URL(path, base.endsWith('/') ? base : base + '/'), {
    method, signal: AbortSignal.timeout(10_000), redirect: 'error',
    headers: {authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? {'content-type': 'application/json'} : {})},
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  if (!response.ok) throw Error(`The help desk returned ${response.status} for ${method} ${path}.`);
  return response.json();
}

export function ticketPath(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw Error('Expected a ticket ID of letters, digits, - and _.');
  return `tickets/${id}`;
}

export async function main(run) {
  try {
    process.stdout.write(JSON.stringify(await run(await readInput())) + '\n');
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
```

## read-ticket.mjs

```javascript
import {helpdesk, main, ticketPath} from './helpdesk.mjs';

await main(async ({ticket_id, helpdesk: base}) => {
  const ticket = await helpdesk(base, ticketPath(ticket_id));
  if (ticket.id !== ticket_id || typeof ticket.subject !== 'string' || typeof ticket.body !== 'string')
    throw Error(`The help desk did not return ticket ${ticket_id} with a subject and a body.`);
  return {ticket: {id: ticket.id, subject: ticket.subject, body: ticket.body}};
});
```

## route.mjs

```javascript
import {main} from './helpdesk.mjs';
import {route} from './triage.mjs';

await main(async ({team, refund, urgency}) => ({decision: route(team, refund, urgency)}));
```

## set-ticket.mjs

```javascript
import {helpdesk, main, ticketPath} from './helpdesk.mjs';
import {change} from './triage.mjs';

// --team-only: the move after a person's answer. It sets the chosen team's queue and adds no note.
const teamOnly = process.argv.includes('--team-only');
await main(async input => {
  const ticket = await helpdesk(input.helpdesk, ticketPath(input.ticket_id), {method: 'PATCH', body: change(input, teamOnly)});
  return {[teamOnly ? 'moved' : 'updated']: {id: ticket.id, queue: ticket.queue, priority: ticket.priority}};
});
```

## triage.test.mjs

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {route, change} from './triage.mjs';
import {startHelpdesk} from './fake-helpdesk.mjs';

const team = (choice, p) => ({choice, probabilities: {billing: 0, technical: 0, account: 0, unclear: 0, [choice]: p}});
const no = {answer: false, probability: 0.1};
const normal = {level: 'normal', score: 1, probabilities: {low: 0, normal: 1, high: 0, urgent: 0}};

test('a clear team at the threshold gets its own queue', () => {
  const decision = route(team('billing', 0.8), no, normal);
  assert.deepEqual(decision, {priority: 'normal', tags: [], queue: 'billing', needs_person: false, rule: 'team_meets_threshold', reason: 'the classifier chose billing with 80% probability'});
});
test('a team below the threshold goes to triage for a person', () => {
  const decision = route(team('technical', 0.79), no, normal);
  assert.equal(decision.queue, 'triage');
  assert.equal(decision.needs_person, true);
  assert.equal(decision.rule, 'team_below_threshold');
});
test('unclear always goes to triage, whatever its probability', () => {
  const decision = route(team('unclear', 1), no, normal);
  assert.equal(decision.rule, 'team_unclear');
  assert.equal(decision.needs_person, true);
});
test('a refund probability of at least 50% adds the tag, and urgency sets the priority', () => {
  const decision = route(team('billing', 0.95), {answer: true, probability: 0.5}, {...normal, level: 'urgent'});
  assert.deepEqual(decision.tags, ['refund_request']);
  assert.equal(decision.priority, 'urgent');
  assert.deepEqual(route(team('billing', 0.95), {answer: false, probability: 0.49}, normal).tags, []);
});
test('invalid classifier results are refused', () => {
  assert.throws(() => route({choice: 'sales', probabilities: {}}, no, normal));
  assert.throws(() => route(team('billing', 0.9), {answer: 'yes', probability: 0.5}, normal));
  assert.throws(() => route(team('billing', 0.9), no, {level: 'critical'}));
});
test('the move after a person accepts only a team and adds no note', () => {
  assert.deepEqual(change({queue: ' Account ', priority: 'high', tags: []}, true), {queue: 'account', priority: 'high', tags: []});
  assert.throws(() => change({queue: 'triage', priority: 'high', tags: []}, true), /must be one of billing, technical, account/);
  assert.throws(() => change({queue: 'billing', priority: 'high', tags: []}), /reply draft/);
});

const run = promisify(execFile);
const script = (name, input, args = [], token = 'test-token') => {
  const child = run(process.execPath, [fileURLToPath(new URL(name, import.meta.url)), ...args], {env: {...process.env, HELPDESK_TOKEN: token}});
  child.child.stdin.end(JSON.stringify(input));
  return child.then(({stdout}) => JSON.parse(stdout));
};

test('the scripts read and change a ticket with the token, and a repeat sets the same values', async t => {
  const tickets = JSON.parse(readFileSync(new URL('./sample-tickets.json', import.meta.url), 'utf8'));
  const desk = await startHelpdesk({token: 'test-token', tickets});
  t.after(() => desk.close());
  const read = await script('read-ticket.mjs', {ticket_id: 'T-1042', helpdesk: desk.url});
  assert.equal(read.ticket.subject, 'Charged twice this month');
  const input = {ticket_id: 'T-1042', helpdesk: desk.url, queue: 'billing', priority: 'high', tags: ['refund_request'], note: 'Draft reply'};
  const first = await script('set-ticket.mjs', input), second = await script('set-ticket.mjs', input);
  assert.deepEqual(first, {updated: {id: 'T-1042', queue: 'billing', priority: 'high'}});
  assert.deepEqual(second, first);
  assert.deepEqual(desk.store.get('T-1042').notes, ['Draft reply']);
  const moved = await script('set-ticket.mjs', {...input, queue: 'account'}, ['--team-only']);
  assert.deepEqual(moved, {moved: {id: 'T-1042', queue: 'account', priority: 'high'}});
  await assert.rejects(script('set-ticket.mjs', input, [], 'wrong-token'), /401/);
  await assert.rejects(script('read-ticket.mjs', {ticket_id: 'T-9999', helpdesk: desk.url}), /404/);
});
```

## inputs.json

```json
{"ticket_id": "T-1042"}
```

## cases/double-charge-to-billing/case.json

```json
{
  "format": "method-case/1",
  "id": "double-charge-to-billing",
  "status": "active",
  "method_file": "support-triage.method",
  "note": "A customer charged twice asks for the second charge back. The ticket goes to Billing with the refund_request tag, and no person is asked.",
  "author": null,
  "created": "2026-10-10T02:31:11.810Z",
  "source": {
    "run_dir": "/work/support-triage/run2",
    "execution_id": "6707d77c-38bc-4e10-a5f3-cebd56ddeb71",
    "method_sha256": "bbbb45763b9b8db47305c6af4940052c2282f4b8a1e607b36eb6732b97a41fb9",
    "passing_run_dir": "/work/support-triage/run2"
  },
  "expect": [
    {
      "kind": "equals",
      "ref": "outputs.decision.queue",
      "value": "billing"
    },
    {
      "kind": "equals",
      "ref": "outputs.decision.tags",
      "value": [
        "refund_request"
      ]
    },
    {
      "kind": "equals",
      "ref": "outputs.decision.needs_person",
      "value": false
    }
  ],
  "runs": null,
  "min_pass": null,
  "supersedes": [],
  "superseded_by": null,
  "retention_until": "2027-10-10",
  "redacted": true
}
```

## README.md

````markdown
# Triage a support ticket

When a ticket arrives, this Method reads it from the help desk, chooses its queue, priority, and tags, drafts a first reply, and updates the ticket. When the team is not clear, the ticket goes to the triage queue and a person chooses the team.

| Step | Type | What it does |
| --- | --- | --- |
| `read` | run | Reads the ticket with `HELPDESK_TOKEN`. |
| `team` | classify, options | billing, technical, account, or `unclear`. |
| `refund` | classify, `answer: yes_no` | Does the customer ask for money back? |
| `urgency` | classify, `levels` | low, normal, high, or urgent. |
| `route` | run | The rule: the team's queue at 80% or more, else triage and a person; the refund tag at 50% or more. |
| `draft_reply` | call, `model: writer` | A first reply for an agent to check. The prompt shows two replies that the team liked. |
| `update` | run, changes the help desk | Sets queue, priority, and tags, and adds the reply as an internal note. |
| `ask_person` | ask, when a person is needed | "Which team should handle it?" |
| `move` | run, when a person is needed | Moves the ticket to the team that the person chose. |

What the file shows:

- **`models:`** names the model of the reply step: `writer: anthropic/claude-haiku-4.5`. Hosted models need no key.
- **`secrets:`** declares `HELPDESK_TOKEN`. Scripts read it from their environment. It never goes into the Method or the run records.
- **Three classify forms**, each with one question. The `unclear` option lets the classifier say that it cannot choose; a guess is not hidden.
- **The rule is in a script**, not in a prompt, so it is the same on every run and `triage.test.mjs` tests it.
- **An effect on each help desk change.** The http observer reads the ticket back. A 200 response shows only that the help desk accepted the request. The `update` effect checks the priority but not the queue, because the `move` step changes the queue after a person's answer.
- **`run_data: device`** keeps the run records on this computer. The classify and call steps still send the ticket text to the classifier and the model.

## Try it on this computer

`fake-helpdesk.mjs` is a small help desk with the three tickets in `sample-tickets.json`. It keeps them in memory.

```sh
method secret set HELPDESK_TOKEN          # opens a private form; enter any test value
HELPDESK_TOKEN=THE_SAME_VALUE node fake-helpdesk.mjs 4310 &
method bind support-triage.method helpdesk --connection http://127.0.0.1:4310
method run support-triage.method --inputs inputs.json
```

For your own help desk, run `method secret find` in this folder. It lists the key files nearby and the names in each, never the values, and prints the `method secret import` command for the file that has `HELPDESK_TOKEN`. Then bind `helpdesk` to your help desk's API URL. A help desk that needs a token for reads too gets it from `METHOD_OBSERVER_TOKEN`: the http observer sends that as a Bearer token.

T-1042 (charged twice) goes to Billing with the `refund_request` tag. T-1043 ("Can't get in") does not say enough, so the run stops at `ask_person` with exit code 2. Answer it with `--human`:

```sh
echo '{"steps": {"ask_person:0": {"outputs": {"chosen_queue": "account"}}}}' > answer.json
method run support-triage.method --run-dir RUN_DIR --resume --human answer.json
```

## The case in cases/

`cases/double-charge-to-billing` keeps the right result for T-1042: queue billing, tag `refund_request`, no person asked. It was made with `method case new support-triage.method --id double-charge-to-billing --passing-run RUN --expect expect.json`, where `expect.json` has three `equals` checks on `outputs.decision`. The classify answers in its recording came from a fixed test classifier, so the case checks the rule and not the classifier. `method test support-triage.method` replays it: steps that did not change return their recorded outputs. When you change the route rule, the route step runs again and the case shows whether T-1042 still goes to Billing.

## Tests

`node --test triage.test.mjs` tests the rule at its thresholds, the change that the scripts send, and the scripts against the fake help desk (the token, a repeated update, and a missing ticket).

## Put it in your app

Publish the Method and connect your app to it:

```sh
method connect ../my-app
```

`method connect` publishes the Method if it has no published version, makes a service key for the app, writes it to the app's `.env` without showing it, and prints the code to add. For a Python app the code is like this:

```python
from withmethod import Method

method = Method()  # reads METHOD_API_KEY from the environment or .env

def on_ask(question):
    # question.step is "ask_person", question.question is the text, question.form the answer's JSON Schema.
    return None  # return {"chosen_queue": "billing"}, or None to send the question to the team inbox

run = method.run("METHOD_ID", {"ticket_id": ticket_id}, on_ask=on_ask, idempotency_key=f"ticket-{ticket_id}")
result = run["result"]
```

In Node, use `new Method().run({method, inputs, idempotencyKey, onAsk})`. One idempotency key for each ticket means that a repeated webhook does not triage the ticket twice. A question that the app does not answer waits in the team inbox until a person answers it there or with `method answer RUN_ID`.
````

## Installed files

- support-triage/README.md
- support-triage/TASK.md
- support-triage/cases/double-charge-to-billing/case.json
- support-triage/cases/double-charge-to-billing/recording.json
- support-triage/fake-helpdesk.mjs
- support-triage/helpdesk.mjs
- support-triage/inputs.json
- support-triage/read-ticket.mjs
- support-triage/route.mjs
- support-triage/sample-tickets.json
- support-triage/set-ticket.mjs
- support-triage/support-triage.method
- support-triage/triage.mjs
- support-triage/triage.test.mjs
