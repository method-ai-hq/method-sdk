# Worked example: support-replies

A comparison: is a Method reply agent better than plain Claude Code at following a support lead's 20 corrections? Both get the same corrections one at a time and are measured on new tickets after every 5.

## TASK.md

```markdown
# Request

Our support lead corrects the reply agent every week. Is the Method agent better than plain Claude Code at following those corrections? Give both the same 20 corrections on past tickets, then measure them on new tickets.
```

## replies.compare

```markdown
question: After the support lead gives the same 20 corrections to both reply agents, which one follows them better on new tickets?
arms:
  method: support-reply.method
  plain: {agent: claude, instructions: plain-instructions.md}
difference: How a correction changes the agent.
inputs: [tickets/t-201.json, tickets/t-202.json, tickets/t-203.json]
teaching: [teach/t-101.json, teach/t-102.json, teach/t-103.json, teach/t-104.json]
about_inputs:
  noun: ticket
  description: Three new tickets that the corrections never saw.
  teaching_description: Four past tickets that the support lead corrected.
  names: {tickets/t-201.json: Cracked lamp, tickets/t-202.json: Parcel not moving, tickets/t-203.json: Late return}
deliverable: work/reply.md
treatment:
  seed: 7
  checkpoints: [0, 5, 10, 15, 20]
  events:
    - {input: teach/t-101.json, correction: "It needs to ask for one photo of the damage first, because we approve a damaged-item refund only with a photo."}
    - {input: teach/t-101.json, correction: "It needs to say the money goes back to the card that paid, because customers ask where the refund goes."}
    - {input: teach/t-102.json, correction: "It needs to say that 7 days with no movement counts as lost, because that is our rule and it ends the waiting."}
    - {input: teach/t-102.json, correction: "It needs to leave out the carrier's phone number, because we handle the carrier ourselves."}
    - {input: teach/t-101.json, correction: "It needs to leave out store credit, because we offer it only when the customer asks for it."}
    - {input: teach/t-102.json, correction: "It needs to say we send a replacement now, because a lost parcel is replaced without more waiting."}
    - {input: teach/t-104.json, correction: "It needs to check the date against the 30-day limit, because refunds stop 30 days after delivery."}
    - {input: teach/t-103.json, correction: "It needs to say the address can change only until the label is printed, because after that we cannot stop it."}
    - {input: teach/t-101.json, correction: "It needs to call the item what the customer called it, because our product codes mean nothing to them."}
    - {input: teach/t-102.json, correction: "It needs to apologize once, in the first sentence, because repeated apologies read as a script."}
    - {input: teach/t-104.json, correction: "It needs to promise only what the articles allow, because an exception we cannot keep makes a second complaint."}
    - {input: teach/t-103.json, correction: "It needs to ask for the new address in full, because a partial address delays the change."}
    - {input: teach/t-104.json, correction: "It needs to stay under 120 words, because customers read replies on their phones."}
    - {input: teach/t-104.json, correction: "It needs to give the refund time as 5 business days after approval, because that is when the bank shows it."}
    - {input: teach/t-102.json, correction: "It needs to stop asking the customer to wait longer, because 7 days is already the limit."}
    - {input: teach/t-103.json, correction: "It needs to say express shipping takes 1 to 2 business days, because the customer asked how fast it can be."}
    - {input: teach/t-104.json, correction: "It needs to name the order number the customer gave, because it shows we found the right order."}
    - {input: teach/t-102.json, correction: "It needs to give the replacement's shipping time as 3 to 5 business days, because customers plan around it."}
    - {input: teach/t-104.json, correction: "It needs to say no when the articles say no, because a vague maybe makes the customer write again."}
    - {input: teach/t-101.json, correction: "It needs to end with one clear next step, because a reply without one gets a follow-up question."}
expected:
  tickets/t-201.json: expected/t-201.json
  tickets/t-202.json: expected/t-202.json
  tickets/t-203.json: expected/t-203.json
measure:
  name: corrected items right
  description: For each new ticket, the share of its checklist items, already covered by a correction, that the reply meets.
  checklist: expected
  covered: true
other_measures:
  - name: all items right
    description: For each new ticket, the share of all its checklist items that the reply meets.
    checklist: expected
rule:
  margin: 0.1
  min_runs: 2
  at: 20
  guard: {measure: all items right, max_drop: 0.05}
runs: 2
assumptions:
  - text: The judge marks the checklist the way the support lead would.
    if_false: The scores show the judge's taste, not the support lead's.
    check: The support lead marks 10 verdicts on the run pages.
  - text: The checklist items are what the support lead requires.
    if_false: An agent can win by following the wrong rules.
    check: The support lead reviews the 14 corrected items before the full run.
  - text: The corrections and the checklist come from the same support lead, so both agents are told what the test checks.
    limit: true
notes:
  inputs: [Each ticket runs alone with an empty work folder.]
  treatment: [The corrections come from the support lead's notes on four past tickets.]
decided_by_you: [arms]
```

## support-reply.method

```yaml
format: method/3.4
name: Support reply
goal: Write the first reply to a customer ticket from the help center articles, and save it to work/reply.md.
inputs:
  ticket: {type: text, description: The customer's message.}
environment:
  policy:
    type: files
    description: The help center articles that a reply may rely on.
  work:
    type: files
    description: Where the reply is saved.
steps:
  read:
    name: Read the articles
    purpose: Reads every Markdown article in the policy folder and returns their text headed by the file name.
    in: {policy: environment.policy}
    do: {kind: run, runtime: node, entrypoint: read-policy.mjs}
    out:
      articles: {type: text, description: "Every article, headed by its file name."}
  draft:
    name: Write the reply
    in: {ticket: inputs.ticket, articles: articles}
    do:
      kind: call
      model: default
      prompt: |
        Write the first reply to this customer. Answer what they ask, using only
        the articles below. Say what happens next and when.

        Ticket:
        {{ticket}}

        Articles:
        {{articles}}
    out:
      reply: {type: text, description: The reply in Markdown.}
  save:
    name: Save the reply
    purpose: Writes the reply to work/reply.md and returns it.
    in: {reply: reply, work: environment.work}
    do: {kind: run, runtime: node, entrypoint: save-reply.mjs}
    changes: [environment.work]
    out:
      saved: {type: text, description: The reply as saved.}
result: saved
```

## plain-instructions.md

```markdown
You write the first reply to a customer ticket. Read the help center articles in policy/. Answer what the customer asks, using only those articles. Say what happens next and when. Save the reply as work/reply.md.
```

## expected/t-201.json

```json
[
  {"text": "Asks for one photo of the damage before the refund is approved.", "covered_by": [1]},
  {"text": "Says the refund goes back to the card that paid, within 5 business days of approval.", "covered_by": [2, 14]},
  {"text": "Does not offer store credit, because the customer did not ask for it.", "covered_by": [5]},
  {"text": "Uses the customer's own words for the item (the lamp), not a product code.", "covered_by": [9]},
  {"text": "Ends with one clear next step for the customer."}
]
```

## README.md

```markdown
# Which reply agent follows corrections better

A comparison of a Method agent against plain Claude Code. Both get the same 20 corrections on four past tickets, one at a time, and are measured on three new tickets after every 5.

- `replies.compare` is the comparison. Run it with `method run replies.compare`: Method runs a trial, measures the noise, and asks before the full run.
- `support-reply.method` is the Method arm. It saves its reply to `work/reply.md`; `deliverable: work/reply.md` makes the plain arm hand in the same file.
- `plain-instructions.md` is the plain arm's starting instructions: the same words as the Method's prompt. A builder edits them after each correction.
- `expected/` holds each new ticket's checklist. Each item names the corrections that cover it (`covered_by`, by their place in the file), so the main measure counts only items that a correction given so far covers.
- The user named the arms (`decided_by_you`). The question rephrases the user's request, so it is the writer's. Every other value is the writer's choice, and the comparison page asks the user to review it.
```

## Installed files

- support-replies/README.md
- support-replies/TASK.md
- support-replies/expected/t-201.json
- support-replies/expected/t-202.json
- support-replies/expected/t-203.json
- support-replies/plain-instructions.md
- support-replies/policy/refunds.md
- support-replies/policy/shipping.md
- support-replies/read-policy.mjs
- support-replies/replies.compare
- support-replies/save-reply.mjs
- support-replies/support-reply.method
- support-replies/teach/t-101.json
- support-replies/teach/t-102.json
- support-replies/teach/t-103.json
- support-replies/teach/t-104.json
- support-replies/tickets/t-201.json
- support-replies/tickets/t-202.json
- support-replies/tickets/t-203.json
- support-replies/work/.keep
