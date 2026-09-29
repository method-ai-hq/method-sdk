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

This complete Method has no additional task checks. The runtime checks output types. Classification and routing return the requested result without changing an external system. Add a task check only when the request introduces a concrete failure that needs one.
