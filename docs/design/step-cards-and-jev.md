# Step cards, script explanations, and Jev through OpenRouter

Status: in progress (2026-10-09). This note fixes the contracts that the runtime, SDK, server, and dashboard share.

## 1. Classify through OpenRouter, with three answer types

Method's classifier is Typesafe's Jev model. OpenRouter serves it at `POST https://openrouter.ai/api/v1/systemone` with
Typesafe's request shape and an OpenRouter key. The server uses each organization's own OpenRouter key (the one that
`apps/api/src/models.ts` creates for hosted models), so classification and hosted models share one key, one credit
limit, and one bill. The server no longer holds a Typesafe key. A user's own key is `OPENROUTER_API_KEY` (direct
runs call the same OpenRouter endpoint).

Model identity: saved versions pin `{provider: "typesafe", model: "jev-1.13.0"}`. OpenRouter names that release
`jev-1.13` and answers with `typesafe/jev-1.13-<date>`. The pin stays `jev-1.13.0`; the server and runtime send
`jev-1.13` and accept an answer whose model starts with `typesafe/jev-1.13`.

Live probe (2026-10-09): `model: "jev-1.13"` → 200, `model: "typesafe/jev-1.13-20260917"`, usage
`{input_tokens: 345, output_tokens: 39, cost: 1.449e-05}`. A score question takes `criteria` as a list.

Step forms and output values:

| Form | Step | Output value |
| --- | --- | --- |
| choice | `do: {kind: classify, question, options: {ID: description}}` | `{choice: ID, probabilities: {ID: p}}` (unchanged) |
| yes/no | `do: {kind: classify, question, answer: yes_no}` | `{answer: boolean, probability: p}` where p is the probability of yes |
| score | `do: {kind: classify, question, levels: [NAME, ...]}` (2–10 ordered names, lowest first) | `{level: NAME, score: number, probabilities: {NAME: p}}` where score is the expected level index (0 = first level) |

Jev questions: choice → `{type: "choice", instructions, criteria: {ID: description}}`; yes/no → `{type: "noul",
instructions}` (answer `{p}`); score → `{type: "score", instructions, criteria: [NAME, ...]}` (answer `{score,
probabilities, legend, confidence}`).

## 2. Step types on the dashboard

Every step card shows a type label in its header, with an icon and a word: Script (`run`), Model call (`call`),
Agent (`agent`), Classifier (`classify`), Asks you (`ask`). Each type has its own body: a script shows its file and
its script card; a call shows its prompt as a quote with the model name; an agent shows its prompt, tools, and turn
limit; a classifier shows its question and its options, levels, or yes/no; an ask shows its question. The outline
shows each step's icon. Placeholder descriptions such as "Returned record value." are not shown.

## 3. Script cards

A script card explains one `run` step's entrypoint for one script hash. It has four layers:

1. `summary`: one sentence in command form, and `changes`: `nothing` or `data`.
2. `effects`: found by code analysis, never by a model.
3. `steps`: 3–8 numbered plain-English steps with exact values and the code's own field names, an "If…" line for
   each branch and failure path, line ranges, and `not_done` for edge cases that the code ignores.
4. A link to the code (the dashboard already shows saved scripts).

```ts
type ScriptCard = {
  schema: "method-script-card/1";
  step_id: string;
  entrypoint: string;
  script_sha256: string;            // sha256 of the entrypoint plus its declared helper files, as the step cache computes it
  summary: string;
  changes: "nothing" | "data";
  effects: {
    network: string[];              // hosts
    secrets: string[];              // declared secrets the code reads
    env: string[];                  // other environment variables
    reads: string[];                // file paths or globs
    writes: string[];
    runs: string[];                 // subprocess commands
    input_fields: string[];
    output_fields: string[];
  };
  steps: { text: string; lines: [number, number] }[];
  not_done: string[];
  checks: {
    entities: "passed" | "failed";  // every number, field, and host in summary/steps/not_done appears in the code
    entity_problems: string[];
    round_trip: "passed" | "failed" | "not_run";
    round_trip_inputs: number;      // recorded run inputs replayed
  };
  generated_at: string;
  model: string;
};
```

Generation runs on the device (`method explain FILE`), because the round trip runs scripts: the CLI extracts
effects, asks a hosted model for summary, steps, and not_done (with the code and the effects), runs the entity check,
then generates code from the steps and replays up to 3 recorded inputs of that step from local runs through both
programs and compares the JSON outputs. Cards upload to the version. A signed-in `method run` that saved a version
with a script that has no card starts `method explain` in the background; `method publish` waits for it.

Server: `PUT /api/cli/methods/:id/versions/:version/script-cards` (body `{cards: ScriptCard[]}`) and
`GET /api/workspace/methods/:id/versions/:version/script-cards` → `{cards: ScriptCard[]}`. A card applies to a step
only when its `script_sha256` matches the step in that version.

## 4. Effects a script really had

The runtime records, for each `run` step invocation, what the process did: `observed_effects: {network: [host],
reads: [path], writes: [path], env: [name], runs: [command]}` in the invocation record (and the step's
`step.accepted`/`step.failed` event). Python scripts use an audit hook (`sys.addaudithook`, events `socket.connect`,
`socket.getaddrinfo`, `open`, `os.getenv`/`os.environ` reads are not audited, `subprocess.Popen`); Node scripts use a
preload with `diagnostics_channel` (`undici:request:create`, `net.client.socket`) and `fs` and `child_process` hooks.
Paths inside the run's own temporary and output folders are left out. The dashboard compares them with the card's
`effects` and shows what the script did beyond the card.
