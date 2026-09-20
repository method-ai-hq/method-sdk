# Worked example: social-briefing

Researches a topic through Grok, alphaXiv, and LinkedIn in the browser, then writes a briefing with quotes and source links.

## TASK.md

```markdown
# Request

Research the supplied topic and date range on Grok, alphaXiv, and LinkedIn.
Read the sources, then write a briefing with short quotes, links, and any gaps
in the research.
```

## social-briefing.method

```yaml
format: method/3.2
name: Research social posts and papers
goal: Read recent posts and papers in the browser, then write a briefing with quotes and links.
inputs:
  topic:
    type: text
  from_date:
    type: text
    description: First publication date, YYYY-MM-DD.
  to_date:
    type: text
    description: Last publication date, YYYY-MM-DD.
environment:
  browser:
    type: browser
    description: Browser with access to Grok, LinkedIn, and alphaXiv.
steps:
  gather_sources:
    name: Find and read sources
    changes:
      - environment.browser
    in:
      topic: inputs.topic
      from_date: inputs.from_date
      to_date: inputs.to_date
    do:
      kind: agent
      model: default
      browser: environment.browser
      prompt: |
        Use the browser to research {{topic}} from {{from_date}} through {{to_date}}.
        Open tabs for https://x.com/i/grok, https://www.alphaxiv.org, and https://www.linkedin.com.

        Ask Grok: "What are people saying on Twitter about {{topic}} from {{from_date}}
        through {{to_date}}? Find useful original posts and disagreements. Give names,
        dates, direct post links, and short exact quotes. Link both sides of each argument."

        Ask alphaXiv: "Find papers about {{topic}} published from {{from_date}} through
        {{to_date}}. What is new, and what do the papers say? Give titles, authors,
        dates, paper links, and short exact quotes."

        Search LinkedIn for posts about the same topic and dates. Open and read the
        useful posts and papers. Collect who said what, publication dates, direct
        links, and short exact quotes. In research_notes, record what you searched
        on each site and any pages you could not read.
    out:
      sources:
        type: list
        items:
          type: record
          fields:
            platform:
              type: text
            author:
              type: text
            published:
              type: text
            url:
              type: text
            quote:
              type: text
              description: Short exact quote from the page read; empty when unavailable.
            summary:
              type: text
      research_notes:
        type: text
    check:
      count:
        value: sources
        min: 1
  write_briefing:
    name: Write the briefing
    in:
      topic: inputs.topic
      sources: sources
      research_notes: research_notes
    do:
      kind: agent
      model: default
      prompt: |
        Write a briefing from the collected sources. Start with:
        "Here is the latest on what people are saying on {{topic}}."

        Give a short topline paragraph with highlights from the posts and papers.
        Then use short paragraphs like these:

        <Name> on Twitter says "<quote>" [link]. <Useful context.>

        <Name> and <name> are arguing over <issue>: one says "<quote>",
        while the other says "<quote>" [links to both posts].

        There is a new paper about <finding>. <Authors> say "<quote>" [paper link].

        Include useful LinkedIn posts in the same style. Describe disagreements
        when the sources show them. Use the collected quotes and put links beside
        each claim. Keep quotes to at most 25 words per source in total.
    out:
      briefing:
        type: text
        description: Briefing draft with source links.
result:
  briefing: briefing
  sources: sources
  research_notes: research_notes
run_prompt: Run this Method for the requested topic and dates. Show the briefing draft and its source links.
```

## inputs.json

```json
{
  "topic": "Where coding agents fail in real work, and what improves their reliability",
  "from_date": "2026-09-10",
  "to_date": "2026-09-17"
}
```

## result.fixture.json

```json
{
  "briefing": "Here is the latest on what people are saying on coding agent reliability.\n\nThis fictional fixture shows the result format. Alex says \u201cChecks need to cover the changed behavior.\u201d [Source](https://example.com/research).",
  "sources": [
    {
      "platform": "LinkedIn",
      "author": "Alex (fictional)",
      "published": "2026-09-15",
      "url": "https://example.com/research",
      "quote": "Checks need to cover the changed behavior.",
      "summary": "A fictional source about testing agent changes."
    }
  ],
  "research_notes": "Illustrative fixture only. No browser research was run to produce this file."
}
```

## README.md

````markdown
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
````

## Installed files

- social-briefing/README.md
- social-briefing/TASK.md
- social-briefing/inputs.json
- social-briefing/result.fixture.json
- social-briefing/social-briefing.method
