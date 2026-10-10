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
format: method/3.4
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
    no_effect_reason: Reads posts and papers in the browser; sends, posts and submits nothing.
    accept:
      untrusted_content_can_act: The agent needs the signed-in browser to read Grok, alphaXiv, and LinkedIn. The prompt asks it only to search and read, and a person reads the briefing before it is shared.
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
      kind: call
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
        When a source has no quote, describe it without quotation marks. When
        research_notes name a site that could not be read, say so in the last sentence.
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
briefing with quotes and source links. It uses the SDK's standard browser tools.

The Method has two steps:

1. `gather_sources` (agent with a browser): opens Grok, alphaXiv, and LinkedIn in
   browser tabs, asks the two quoted questions, searches LinkedIn, and reads the
   useful posts and papers. It returns the sources and its research notes.
2. `write_briefing` (call): writes the briefing from the collected sources. It
   needs no browser and no tools, so it is a call, not an agent.

The result contains the briefing draft, the sources, and the research notes. The
sample topic and dates are in `inputs.json`; change them for the next run.

## Run

```sh
method run social-briefing.method --inputs inputs.json
```

The step selects `browser: environment.browser`. The SDK supplies browser-use's
standard controls and connects the browser during normal run setup. On macOS, the
default connection copies the last-used Chrome profile and runs headless. Run
`method browser connect` to choose another browser.

## Two choices in the file

- `no_effect_reason`: the browser step only reads. It sends, posts, and submits
  nothing, so there is no change to read back.
- `accept: {untrusted_content_can_act: ...}`: `validate` warns when an agent that
  reads web pages could also change things with the same browser. Here the agent
  needs the signed-in browser to read, and a person reads the briefing before it
  is shared, so the warning is accepted with that reason.

The count check stops an empty source list. It does not show that all three sites
were covered or that the briefing is good; read the briefing and open its links.

`result.fixture.json` is a fictional illustration of the result shape. It is not
a recorded research result.
````

## Installed files

- social-briefing/README.md
- social-briefing/TASK.md
- social-briefing/inputs.json
- social-briefing/result.fixture.json
- social-briefing/social-briefing.method
