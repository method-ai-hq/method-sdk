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
