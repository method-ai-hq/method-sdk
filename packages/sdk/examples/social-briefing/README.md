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
