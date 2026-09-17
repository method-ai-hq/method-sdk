# Method SDK

Method uses one CLI to author, save, run, resume, and inspect methods. New files use `format: method/3.1` with scripts, direct model calls, and bounded tool-using agents.

```sh
npm install -g https://app.withmethod.ai/downloads/withmethod-sdk-latest.tgz
method authoring all
method schema
method schema config
method validate task.method
method save task.method --reason 'Describe the change.'
method run METHOD_ID --version VERSION_ID --config runtime.json --workspace . --inputs inputs.json --run-dir runs/example
```

Node.js 22+ is required. The CLI contains the runtime; no separate Method3 install is needed. Sign-in for saved methods opens a browser. Local scripts need no model credentials. Agent and call steps start Codex CLI with its existing sign-in and default model. Simple local-agent Methods need no runtime.json. Custom scripts and tools require their actual configuration. When you supply a configuration file, set `allow_local_processes: true` for scripts and Codex. Without a configuration file, the CLI enables local processes for the default Codex path. An explicit `backend: openai-responses` profile retains direct API execution. Declared Method tools are exposed to Codex for that step, and process logs are saved under the run artifacts. See `method authoring execution` for settings and limits.

## Configuration

Use `method schema config` and `method authoring execution`. Operator configuration defines model profiles, runtime commands, tools, environment bindings, and finite run limits. Scripts require `allow_local_processes: true`. Finite limits are supplied by the runtime; configuration and individual steps can override them. Keep secret values out of methods and run files.

Scripts receive one JSON object on stdin and return one JSON object on stdout. File outputs include a relative `path` under `METHOD_OUTPUT_DIR` and a `sha256`. Declare helper files under `files`; script entrypoints are included automatically. The CLI snapshots helpers from the method directory, or `--workspace` when set. Saved methods retain helper paths; provide their local helper folder when running them.

`--inputs` supplies initial inputs. `--state` supplies initial state for a new run. A later run can import a prior `state.json` and use an evidence-hash ledger to process only changed records. A separate database is optional application state.

## Limits and model backends

Defaults are one hour per run, ten minutes per step, 100 model requests, 100 step invocations, 200 Method tool calls, and 16 MiB for input and output. Step defaults allow 32 agent turns/model requests. Configuration and steps can set overrides within the run caps.

`max_model_requests` and `max_agent_turns` govern the direct Responses API loop. A direct API `call` makes one request without tools; an API `agent` runs the declared tool loop. Codex handles its own internal requests and built-in tools, including for `call`. Method enforces Codex process time, prompt/output size, and declared Method tool limits; it does not count all internal Codex requests or enforce a dollar budget. Script-internal API calls are also outside that counter.

## Resume and evidence

```sh
method run task.method --config runtime.json --run-dir runs/example --resume
# After inspecting an unfinished action and its external effects:
method run task.method --config runtime.json --run-dir runs/example --resume --retry save:0
method inspect runs/example --out inspection.json
method sync runs/example
```

Accepted steps and loop iterations are reused. Method and config hashes, helper hashes, inputs, and state must match the saved run. Time and request budgets do not reset. A failed or interrupted action requires an explicit retry. A checkpoint cannot undo an external action. `ask` resumes with `--human` containing `{ "steps": { "STEP:ITERATION": { "outputs": { "answer": "actual user answer" } } } }`.

Run records include `checkpoint.json`, `state.json`, `manifest.json`, `events.jsonl`, `summary.json`, and `result.json` on success. Online runs upload to the same Method dashboard. `sync` uploads evidence without running business steps. It requires the `method-sync.json` from a run started against a saved Method; it cannot attach an arbitrary local run.

## JavaScript

```js
import { runMethod, loadMethod } from '@withmethod/sdk';
import { readFileSync } from 'node:fs';
const method = loadMethod(readFileSync('task.method', 'utf8'));
const config = JSON.parse(readFileSync('runtime.json', 'utf8'));
const result = await runMethod('task.method', config, { inputs: { text: 'Hello\n' }, runDir: 'runs/example' });
```

The SDK includes its own MIT source under `source/` and installs the pinned MIT public runtime from `method-ai-hq/method-spec`. Scripts and Codex are trusted local processes. The Codex backend disables its approval and sandbox prompts and retains the user's installed tools. A step's `tools` list restricts the Method tool bridge, not all Codex access. Review the Method and helpers before running them. Model checks can be wrong. Read the evidence before treating a run as correct.

## Saved older methods

The same `method` command reads and runs older saved methods with their original Codex execution, `--resources`, state files, and recovery behavior. Existing `runWorkflow` and callback APIs remain available. Their saved hashes and history stay unchanged.

For an explicit new version, use `method migrate old.method --model PROFILE --timeout-ms 60000 --max-agent-turns 8 --max-model-requests 12 --output current.method`. Review tool and state warnings, validate, and save the new version. Migration does not invent tool access or approve model spending.

## Result files on the dashboard

Online runs attach declared file outputs (up to 20,000 files, with 100 MB decoded and 20 MB transferred), after checking their saved hashes. The run page can read text and download binary files. `method sync RUN_DIRECTORY` can attach files to an existing completed run without running its steps again. Missing or changed files remain unavailable.

For a complete website, return a file with `format: method-website`. Its `method-website/1` JSON manifest names the title, HTML start page, and each asset's relative path, SHA-256, and media type. Method uploads only those listed assets. See [the file contract and limits](https://docs.withmethod.ai/guides/result-files) and the complete example shipped at `source/examples/website-result.method` in the SDK archive.

## Create a Method

Run `method status`, then `method authoring`. The guide includes the complete approved Daily Briefing Method and the path to its supporting example files. Write your Method, helper files, and runtime.json in one folder. Run `method validate task.method`, run an agreed sample, and inspect the result. Use `method save task.method` to save and confirm the version. The result includes its dashboard link and document hash.

Versioned package URLs are immutable. The latest alias points to the current release. Older compatibility aliases can redirect to latest; use the download manifest to identify stored archives. The real 0.4.2 archive remains available with its original bytes. The public example file list is in scripts/public-examples.json and is used by both packaging paths.
