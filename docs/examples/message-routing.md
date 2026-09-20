# Worked example: message-routing

Classifies a customer message with Jev, then applies a script rule to choose a support destination.

## TASK.md

```markdown
# Request

Classify a customer message, then choose Billing or Technical support when the
selected category has at least 90% probability. Send all other cases to Manual
review. Return the destination, rule, probability, and threshold.
```

## message-routing.method

```yaml
format: method/3.2
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
        other: Other — no listed team fits, or more information is needed.
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
  const ids = ['billing', 'technical', 'other'];
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
  const automatic = category.choice !== 'other' && observed >= required;
  return {
    routing: {
      destination: automatic ? category.choice : 'manual_review',
      rule_applied: category.choice === 'other' ? 'other_requires_review' :
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

## README.md

```markdown
# Classify and route a message

This Method classifies a customer message, then returns a destination and the
rule used. Test the routing script with `node --test routing.test.mjs`.

Validate with `method validate message-routing.method`. Run with
`method run message-routing.method --inputs inputs.json`. Method uses your
existing sign-in and prepares the Node runtime through its normal setup.

The Method page explains the rule. The Run page shows the message, probabilities,
destination, and rule used. The example threshold is 90%; choose a production
threshold by testing your own labeled messages.

`result.fixture.json` is an illustrative result, not a live model response.
The `retry/` folder contains a loopback recovery test. Run it from this folder
with `node --test retry/retry.test.mjs`. It uses the installed Method runtime.
```

## Installed files

- message-routing/README.md
- message-routing/TASK.md
- message-routing/choose-destination.mjs
- message-routing/inputs.json
- message-routing/message-routing.method
- message-routing/result.fixture.json
- message-routing/retry/check-ticket.mjs
- message-routing/retry/create-ticket.mjs
- message-routing/retry/retry.test.mjs
- message-routing/retry/ticket.method
- message-routing/routing.mjs
- message-routing/routing.test.mjs
