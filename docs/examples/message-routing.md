# Worked example: message-routing

Classifies a customer message with Method's classifier, then a script rule chooses a support destination. ticket.method adds one ticket write that a retry does not repeat.

## TASK.md

```markdown
# Request

Classify a customer message, then choose Billing or Technical support when the
selected category has at least 90% probability. Send all other cases to Manual
review. Return the destination, rule, probability, and threshold.
```

## message-routing.method

```yaml
format: method/3.4
name: Classify and route a customer message
goal: Choose a support destination and show the rule used.
inputs:
  message:
    type: text
    description: The complete customer message to classify.
steps:
  classify_message:
    name: Classify the customer message
    in:
      message: inputs.message
    do:
      kind: classify
      question: Which team should handle the main request in this message?
      options:
        billing: Billing — invoices, charges, refunds, and payments.
        technical: Technical support — errors and problems using the product.
        unclear: Unclear — the message does not say enough to choose, or no listed team fits.
    out: message_category
  choose_destination:
    name: Choose the destination
    purpose: |
      Chooses Billing or Technical support when that category is selected
      and its probability is at least 90%. Otherwise chooses Manual review.
      Returns the destination, the rule used, and the probability and threshold.
    in:
      category: message_category
    do:
      kind: run
      runtime: node
      entrypoint: choose-destination.mjs
    out:
      routing:
        type: record
        description: The selected destination and the values used to choose it.
        fields:
          destination: text
          rule_applied: text
          selected_probability: number
          required_probability: number
result: routing
files:
  - routing.mjs
run_prompt: Run this Method with the customer message, then show the destination and the rule used.
```

## routing.mjs

```javascript
export function chooseDestination(category) {
  const ids = ['billing', 'technical', 'unclear'];
  if (!category || !ids.includes(category.choice)) {
    throw new Error('Expected a declared category.');
  }
  const probabilities = category.probabilities;
  if (!probabilities || Object.keys(probabilities).length !== ids.length ||
      ids.some(id => !Object.hasOwn(probabilities, id) ||
        !Number.isFinite(probabilities[id]) ||
        probabilities[id] < 0 || probabilities[id] > 1)) {
    throw new Error('Expected one valid probability per category.');
  }
  if (Math.abs(ids.reduce((sum, id) => sum + probabilities[id], 0) - 1) > 1e-6 ||
      probabilities[category.choice] + 1e-6 < Math.max(...ids.map(id => probabilities[id]))) {
    throw new Error('Expected a valid distribution and a maximum-probability choice.');
  }
  const required = 0.90;
  const observed = probabilities[category.choice];
  const automatic = category.choice !== 'unclear' && observed >= required;
  return {
    routing: {
      destination: automatic ? category.choice : 'manual_review',
      rule_applied: category.choice === 'unclear' ? 'unclear_requires_review' :
        automatic ? 'selected_category_meets_threshold' : 'below_threshold',
      selected_probability: observed,
      required_probability: required
    }
  };
}
```

## choose-destination.mjs

```javascript
import { chooseDestination } from './routing.mjs';
let text = '';
for await (const chunk of process.stdin) text += chunk;
try {
  const input = JSON.parse(text);
  process.stdout.write(JSON.stringify(chooseDestination(input.category)) + '\n');
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
```

## inputs.json

```json
{"message":"Can you send me the invoice for my last payment?"}
```

## result.fixture.json

```json
{
  "destination": "billing",
  "rule_applied": "selected_category_meets_threshold",
  "selected_probability": 0.94,
  "required_probability": 0.9
}
```

## ticket.method

```yaml
format: method/3.4
name: Route a message and create one ticket
goal: Create a ticket and recover an interrupted response without a duplicate write.
inputs:
  message:
    type: text
    description: The complete customer message to classify.
steps:
  classify_message:
    name: Classify the customer message
    in:
      message: inputs.message
    do:
      kind: classify
      question: Which team should handle the main request in this message?
      options:
        billing: Billing — invoices, charges, refunds, and payments.
        technical: Technical support — errors and problems using the product.
        unclear: Unclear — the message does not say enough to choose, or no listed team fits.
    out: message_category
  choose_destination:
    name: Choose the destination
    purpose: |
      Chooses Billing or Technical support when that category is selected
      and its probability is at least 90%. Otherwise chooses Manual review.
      Returns the destination, the rule used, and the probability and threshold.
    in:
      category: message_category
    do:
      kind: run
      runtime: node
      entrypoint: choose-destination.mjs
    out:
      routing:
        type: record
        description: The selected destination and the values used to choose it.
        fields:
          destination: text
          rule_applied: text
          selected_probability: number
          required_probability: number
  create_ticket:
    name: Create the support ticket
    purpose: Creates a ticket for the selected destination and returns its receipt.
      Sends the operation ID as the Idempotency-Key, so a retry returns the same
      ticket. The saved effect reads the ticket back by the operation ID.
    in:
      message: inputs.message
      routing: routing
      service: environment.ticket_service
    do:
      kind: run
      runtime: node
      entrypoint: create-ticket.mjs
    changes:
      - environment.ticket_service
    out:
      ticket:
        type: record
        description: The service receipt for this operation.
        fields:
          ticket_id: text
          operation_id: text
    effects:
      saved:
        intent: The ticket service stores one ticket for this operation with the
          submitted message and destination.
        in:
          message: inputs.message
          destination: routing.destination
        observe:
          kind: http
          path: /tickets/by-operation/{token}
          expect:
            fields:
              operation_id: "{token}"
              message: "{inputs.message}"
              destination: "{inputs.destination}"
        blocking: true
result: ticket
files:
  - routing.mjs
run_prompt: Run this Method with the customer message, then show the destination
  and the rule used.
environment:
  ticket_service:
    type: service
    description: Ticket service with idempotent writes and operation lookup.
```

## create-ticket.mjs

```javascript
let text = '';
for await (const chunk of process.stdin) text += chunk;
const {message, routing, service} = JSON.parse(text);
const operation = process.env.METHOD_OPERATION_ID;
if (!operation || typeof message !== 'string' || !['billing','technical','manual_review'].includes(routing?.destination))
  throw Error('Expected a message, destination, and Method operation ID.');
const response = await fetch(new URL('/tickets', service), {
  method: 'POST', signal: AbortSignal.timeout(10_000),
  headers: {'content-type':'application/json','Idempotency-Key':operation},
  body: JSON.stringify({message,destination:routing.destination}),
});
if (!response.ok) throw Error(`Ticket service returned ${response.status}. Inspect operation ${operation} before retrying.`);
const ticket = await response.json();
if (typeof ticket.ticket_id !== 'string' || ticket.operation_id !== operation) throw Error('The ticket receipt does not match this operation.');
process.stdout.write(JSON.stringify({ticket:{ticket_id:ticket.ticket_id,operation_id:operation}})+'\n');
```

## README.md

````markdown
# Classify and route a message

`message-routing.method` classifies a customer message, then returns a destination and the rule used.

- The classify step has an `unclear` option, so the classifier can say that the message does not say enough. It does not have to guess a team.
- The classifier returns a probability for each option. The routing script applies the rule: Billing or Technical support when that option is chosen with at least 90%; Manual review for `unclear` or a lower probability. The example threshold is 90%; choose your own from a few labeled messages.
- Test the rule with `node --test routing.test.mjs`.

```sh
method validate message-routing.method
method run message-routing.method --inputs inputs.json
```

The classify step uses Method's classifier through your sign-in. The Run page shows the message, the probabilities, the destination, and the rule used. `result.fixture.json` is an illustrative result, not a live classifier response.

## Create one ticket, also after a retry

`ticket.method` adds a step that creates a ticket in a ticket service (`environment.ticket_service`). A retry must not create a second ticket:

- `create-ticket.mjs` sends the run's operation ID (`METHOD_OPERATION_ID`) as the `Idempotency-Key`, so the service returns the same ticket for a repeated request.
- The `saved` effect reads the ticket back by the operation ID. A receipt shows only that the service accepted the request; the read-back shows that the ticket exists with the right message and destination.

`node --test ticket.test.mjs` runs the Method against a local ticket service. It stops the run after the service saved the ticket and before the script returned, then resumes with `--retry`. The test checks that the service has one ticket, that the two requests used the same key, and that the effect is confirmed.
````

## Installed files

- message-routing/README.md
- message-routing/TASK.md
- message-routing/choose-destination.mjs
- message-routing/create-ticket.mjs
- message-routing/inputs.json
- message-routing/message-routing.method
- message-routing/result.fixture.json
- message-routing/routing.mjs
- message-routing/routing.test.mjs
- message-routing/ticket.method
- message-routing/ticket.test.mjs
