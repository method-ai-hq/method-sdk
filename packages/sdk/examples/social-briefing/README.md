# Social research example

This Method researches a topic on Grok, alphaXiv, and LinkedIn, then writes a
briefing with quotes and source links. It uses the SDK’s standard browser tools.

The Method has two steps:

1. Open Grok, alphaXiv, and LinkedIn in browser tabs. Ask the two quoted questions,
   search LinkedIn, and read the useful posts and papers.
2. Write the briefing from the collected sources, with quotes and links.

The result contains the briefing draft, sources, and research notes. Method's
normal run output saves them. The example has no report renderer or browser
relay. Browser-use runs locally on the runner. Codex or Claude controls its
browser tools. The sample topic and dates live in `inputs.json`; change them
for the next run.

## Run

```sh
method run social-briefing.method \
  --inputs inputs.json
```

The step selects `browser: environment.browser`. The SDK supplies browser-use's
standard direct controls and connects the browser during
normal run setup. On macOS, the default connection copies the last-used Chrome
profile and runs headless. The author does not install an MCP server or handle request
files. The [browser and deployment guide](https://github.com/method-ai-hq/method-sdk/blob/main/docs/browser-execution-and-deployment.md)
describes browser setup and the deployment approval flow.

## Slow end-to-end test

Use a new work folder and agent session for each trial. Use the same YAML under
Codex and Claude. Keep each trial's browser and run records separate.

1. Run locally with the selected signed-in browser. Check that the research agent
   opened all three sites, sent the quoted prompts, and read sources itself.
   Open the report's links. Retain the successful run ID and selected account names.
2. The test setup configures Docker as the runner. Say only: "Deploy this."
   The agent prepares a plan from the successful run and shows the selected
   files, inputs, runtime, browser accounts, and the runner's user-facing name.
   The user does not need to know that the test runner uses Docker.
3. Approve that plan once. Product setup transfers the approved items and opens
   the sites inside the container to check account access.
4. Start a new run of the same Method inside Docker. All browser actions and
   source reading occur there. Inspect the report and links. Then repeat with
   the persisted runner session to check sign-in reuse.

For the transfer case, needing to sign in again is a failed seamless-transfer
result. Record it, even if a later manual sign-in makes the research work.
Record browser setup failures and blocked pages as observed. Do not repair the
Method, preselect sources, manually copy session files, or move research back
to the Mac to make the test pass. Use the current social access approvals.

The count check stops an empty source list. It does not establish coverage of
all three sites or report quality; those are reviewed in this test.

Fresh authoring remains a separate case in `testkit/authoring-cases`. Give that
agent the user's request, not this YAML. This test measures execution and transfer
of the saved Method; the authoring case measures what a new author builds.

`result.fixture.json` is a fictional illustration of the result shape. It is not
a recorded research result.
