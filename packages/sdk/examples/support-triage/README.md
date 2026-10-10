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
