# 0.14.0

A first Method needs fewer steps, no keys, and no extra commands (runtime 0.12.0).

- **Method plugin for Claude Code and Codex.** The installer adds it to each of these agents that it finds, so later sessions know Method. By hand: `claude plugin marketplace add method-ai-hq/method-sdk && claude plugin install method@method`, or `codex plugin marketplace add method-ai-hq/method-sdk && codex plugin add method@method`. It installs the CLI on first use and starts the guide when the user asks for repeated work.
- **Sign in first; hosted models.** Signed in, `call` and `agent` steps without a configured profile use a hosted model through the Method account, with no key and no local agent. Each account has a model credit. Not signed in, runs use a local agent as before.
- **Each prompt is a step.** `validate` and `run` refuse a script that calls a model API (`model_call_in_script`).
- **Keys stay on this computer.** Declare `secrets:` with names and purposes. `method secret import FILE NAME...` copies values from a file; `method secret set NAME` opens a private form in the browser; `method secret list` shows where each one is found. A missing secret stops the run before its first step. Replaces `runtimes.*.env`.
- **Versions save themselves; `method publish` replaces `save`.** A signed-in run of a local file saves a version when the file changed and sends the run to the dashboard. `publish` runs the cases and marks a version published. `create`, `save`, and `update` are removed.
- **Unchanged steps are reused.** A new run reuses each iteration whose definition, inputs, and executed files match an earlier accepted run on this computer. `--rerun STEP` and `--fresh` run steps again. `--from-run` and `--reuse` are removed.
- **`run_data: device`** keeps run content on this computer; the dashboard shows the run's steps and timing.
- **Private runs.** Hosted model and classifier requests go only to providers that do not train on them and keep no copy (`model_not_private` when a model has none); the organization setting "Keep run content on devices" (off by default) makes every run work as `run_data: device`; secret values are redacted in every run file, `checkpoint.json` too (runtime 0.12.0); run folders under `~/.cache/method/runs` unchanged for 30 days are deleted when a run starts.
- **Clearer failures.** A failed run reports `failed_step`, `iteration`, `diagnostics`, and `fix`, also when it fails before its first step. A classification that the service briefly cannot answer gets three attempts. Saving a version waits up to two minutes.
- The default `method authoring` guide is short and starts with the rules for a first Method, with a field reference; `method schema` without a name prints the same reference. `method validate` lists each step with its runner and the secrets it needs. An `each` step whose `in` repeats the item names the fix. The installer adds the CLI to PATH. `METHOD_SERVER` selects another server.
- `method status` and `method run` name a newer release, checked once a day.
- **Classify answers yes/no and scores.** Besides `options`, a classify step takes `answer: yes_no` (value `{answer, probability}`) or `levels: [LOW, ..., HIGH]` (2–10 ordered names; value `{level, score, probabilities}`, where score is the expected level index).
- **Classification through OpenRouter.** Jev now runs through OpenRouter: the Method account uses the organization's OpenRouter key, so classification and hosted models share one model credit, and its cost appears in `usage.cost_usd`. To use your own key, set `classification: {provider: typesafe, model: jev-1.13.0, api_key_env: OPENROUTER_API_KEY}` in runtime.json; a key in the environment alone no longer changes where classification runs (`TYPESAFE_API_KEY` is gone).

# 0.13.1

- Fix items that run at once: they wrote `state.json` through one shared temporary file, so a run could fail under load (runtime 0.11.1).

# 0.13.0

- **Run items at once.** Add `concurrency: N` (1–32) to an `each` step to run up to N items at the same time, for example a classify or `call` over many records. The operator limit `max_concurrency` (default 8) caps it. The step cannot use `ask`, `changes`, or `effects`. Outputs keep item order. The first failure stops the other items; resume runs only the items that did not finish (runtime 0.11.0).
- **Call Anthropic and OpenRouter directly.** New model backends `anthropic-messages` and `openrouter-chat` sit next to `openai-responses`. A `call` or tool-using `agent` step uses the provider's API without an agent process. Each backend has a fixed endpoint; the profile names the key's environment variable (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`), `model`, and `max_output_tokens`.
- **Use your own Typesafe key.** With `TYPESAFE_API_KEY` set (or `classification.api_key_env` in runtime.json), classify steps call Typesafe directly: no Method sign-in, and no Method allowance. The key is redacted from run records.
- Run Methods saved with SDK 0.12.x (runtime 0.10.0).

# 0.12.1

- Run Methods saved with SDK 0.11.8 (runtime 0.9.5). SDK 0.12.0 refused their packages and asked for an update.

# 0.12.0

- Method 3.3 (runtime 0.10.0): the runtime confirms external changes by reading the changed system, not by trusting a receipt.
  - **Local files need nothing.** For a `files` connection in `changes`, the runtime reads the folder before and after the step, records the changed files, keeps a copy of what the step wrote, and fails the run when the step returns a path that did not change. A step with nothing to save may change nothing.
  - **Other connections** (a service, email, a browser that sends) need an effect or a one-sentence `no_effect_reason`. Built-in observers need no script: `http` (JSON fields, `increases` for a trend), `sqlite` (read-only; extra rows are a duplicate), and `file`. Effects default to one reading at once, a 1-minute horizon, positive proof, and the changed connection read-only. A contradiction fails the run; no confirmation by the horizon makes it `unconfirmed` (exit code 3).
  - `changes` defaults to none. `method observe` makes later readings, for example a bounce a day later.
- **Corrections become cases**, handled by the user's own coding agent: fix the Method, run it again, and on the user's yes record the rule with `method case new FILE --id ID --run BAD_RUN --passing-run GOOD_RUN --note "..." --rubric "plain sentence"`. The case must fail on the bad run and pass on the good one. A rubric is judged by a model with quotes that must exist in the output, 3 votes, cached; a classification judge is used only where it agrees with the examples.
- `method test` replays the cases: every case must pass. Unchanged steps return recorded outputs; written folders become scratch copies; only the steps a case needs run; cases run in parallel and stop early.
- `method save` (and `update`) refuse a version that breaks an approved case, unless `--accept-failing-case ID --reason TEXT` is given; the version records the result. `method run` notes when the cases were not checked since the Method changed.
- `method effect list|add` with the reviewed `mail.delivery` observer (IMAP, read-only).
- A case with a live model step runs three times by default, and a rule kept only sometimes is reported as unreliable. `method save` says how many cases it checks, then the time, live model steps and judge calls. `method case new` warns when `cases/` (which holds run data) would be committed to Git.
- A saved Method whose run ends `unconfirmed` now releases its shared account state.
- Observed folders are listed in about a second; a folder over 20,000 files or 3 seconds is reported once as not observed.
- Clearer errors: schema errors name the field and explain a YAML comma in `{ }`; an input that shares a name with an output names the step. `method validate` shows managed runtimes as a note. A run that waits for an effect reading shows progress.
- Examples use Method 3.3. New smallest example: `notes-summary`. The ticket example confirms its ticket with the built-in `http` observer.
- The guide treats local runs as the normal path, explains effects with one short example, and gives the correction loop as a recipe.

# 0.11.8

- Add `method run FILE --from-run RUN_DIR --reuse STEP[,STEP]`. A new run reuses accepted steps of a stopped or completed run when their definition, referenced inputs, model, tools, entrypoint files, and runtime are unchanged. The run records `forked_from`, and the run page shows reused steps (runtime 0.9.5).
- A failed run's recovery text names the steps that a fork can reuse.
- Tell authors to test later scripts on saved inputs before an expensive step, and to fork after a fix to steps that were not accepted.

# 0.11.7

- Default authoring to no additional task check. Require a concrete task purpose for each added check.
- Tell authors and repair agents to delete unnecessary checks and their supporting tests and instructions.
- Show summary and research designs without automatic checking steps, and explain the check-free routing example.
- Report declared-check failure without claiming that the output is wrong (runtime 0.9.4).

# 0.11.6

- Guide browser research authors to select Method's browser connection and use the existing social-briefing example.

# 0.11.5

- Replace the input-only run label field with `run_label`, a reference to a saved input or step output. Runtime 0.9.3 validates the reference.

# 0.11.4

- Guide authors through execution choices, step boundaries, and a concise proposal before consulting complete examples.
- Include three contrasting design outlines and require reading authoring guidance before proposing a Method.
- Move account sign-in to the save stage in the shared setup prompt.

# 0.11.3

- Support method-owned `run_label_input` with runtime 0.9.2. Existing methods remain valid.

# 0.11.2

- Preserve authored classifier option order in saved document and package identities, so an order-only change creates a version.

# 0.11.1

- Preserve total run duration in inspection and sync.
- Use runtime 0.9.1 with complete run metadata types and explicit cancellation and iteration-ID checks.

# 0.11.0

- Add Method 3.2 classification through the Method account, with a saved model version and one request per invocation.
- Require script descriptions and record stable operation IDs for retry. Preserve run start time, device, classifier usage, and attempt-specific evidence in inspection.
- Ship four complete authoring examples. Select one by structure with `method authoring example EXAMPLE_ID`; the general guide shows the catalog.
- Include an offline ticket recovery test that proves retry creates no duplicate and reuses accepted classification.
- Use runtime 0.9.0. Existing Method 3.1 definitions remain supported.

# 0.10.9

- Remove the sample briefing README from the source folder and start reading at the timeline.

# 0.10.8

- Preserve complete Claude result events within the existing process output limit.
- Check Linux worker processes without requiring ps; retain macOS process checks. Report inspection errors instead of claiming a worker stopped.

# 0.10.7

- Deploy writable folders from their completed-run contents into persistent runner storage.
- Keep runner changes on repeated setup, later runs, and container recreation. Local originals remain unchanged.

# 0.10.6

- Clarify that visible browser tasks return to headless mode.

# 0.10.5

- Omit Node development headers and documentation from standalone CLI downloads. Keep Node, npm, and licenses.

# 0.10.4

- Accept dependency-free Node packages during run setup.

# 0.10.3

- Remove reference photos and the old website archive from the briefing example. Read the complete approved report directly.
- Remove the unused website inspection tool and its Playwright dependency.
- Ship compiled SDK code and one copy of the example; development source remains in the public repository.

# 0.10.2

- Stop the active step when a browser connection fails. Keep normal action failures available to the agent.
- Preserve the original run error if browser cleanup also fails.
- Use executor 0.8.2.

# 0.10.1

Use the calling Codex or Claude agent ahead of a generic configured default. Honor explicit agent selection and preserve it throughout a run. Remove the native Claude turn cap.

# SDK 0.10.0

Run browser steps through the local browser-use library with the existing Codex or Claude agent. Supply its standard tools from one browser declaration. Use headless Chrome by default and copy the last-used Mac Chrome profile to reuse sign-ins. Keep each run separate and export only visited sites.

Prepare deployment from a successful run. Review the exact files, inputs, dependencies, account access, and target once before transfer. Use the same SDK and executor on the Docker runner, check access, and retain private sessions for later runs. Saved stateful Methods use the existing shared state and lock. Stop for unsupported local services and writable folders.

Support saved runtime 0.7.2 after its upgrade checks. Keep the full daily briefing one-shot unchanged.

# SDK 0.9.4

Run saved packages from tested runtimes 0.7.0 and 0.7.1 without saving replacement Methods. Record the actual executor version and require that exact version before resuming unfinished work, including before SDK setup and shared-state access. Completed results can still be uploaded after an upgrade. Clarify connection access and operation order in the execution guide; keep the complete one-shot unchanged.

# SDK 0.9.3

Select the calling agent without a machine-wide remembered preference. Ask for a choice when the caller is unclear and both agents are available. Keep the selected profiles when a run resumes, and reject checkpoints that have lost that selection. An explicit --agent selects unconfigured profiles ahead of the configured default.

# SDK 0.9.2

Keep the complete daily briefing one-shot in `method authoring`, with its recorded request, YAML Method, and full approved report in order. Remove report-specific instructions from the general guide and edit history from the example. Declare the writer's source check in the Method and keep sample inputs separate from saved files. Include the new sample run and its actual output.

# SDK 0.9.1

Include the declared runtime.json in the installed daily briefing example. Check all declared example files in the packed release.

# Changes

## 0.9.0

Use method/3.1 and the current runtime. Removed old format conversion, runtime-version dispatch, old account credential lookup, Builder report payloads, ZIP result payloads, and old example document parsing. The installer installs the current release.
