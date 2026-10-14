# 0.17.3

Methods keep run data in the account unless the user asks.

- The authoring guide and the plugin tell the agent to set `run_data: device` only when the user explicitly asks for it. Before it sets it, the agent gets the user's confirmation and tells them in one line that the dashboard will no longer show inputs or results, and that improvements, Run now and Method Cloud stop working.
- The `support-triage` example keeps its run data in the account. It set `run_data: device` although its task did not ask for it, and agents copied it into new Methods.

# 0.17.2

Uses runtime 0.14.1. A converted agent keeps the user's rules, and a case cannot make the Method break them.

- **`method case new` checks a new case against the Method's instructions.** It reads the instructions of the model steps and the information that each step received on the recorded run. When a rule of the case can be met only by breaking an instruction (for example, the rule needs a fact that the inputs do not give, and a prompt says not to invent facts; or the rule requires what a prompt forbids), it refuses the case with `case_conflicts` and names the rule and the instruction. `--accept-conflict "the person's answer"` keeps the case; `case.json` records the answer and the conflicts.
- The authoring guide tells the agent to keep the user's rules word for word when it converts an agent or a prompt: copy the instruction files unchanged, give their complete text to every model step that applies them, and never reword, shorten, or split them. Before the Method replaces the old agent, the agent runs both on the same 3 to 5 sample inputs and shows the user every difference.
- The correction recipe tells the agent to ask what the user means when their words do not say what the right result is before it changes the Method or records a case, and never to choose a reading that breaks the user's instructions.
- Packages saved with runtime 0.14.0 still run.

# 0.17.1

- `method improve` (for Methods that keep run content on the computer) sends only the note, the step and the run to improve.method; `--case` is gone. An improvement gives a tested change or none; case, rubric and script-description proposals are gone, so `method apply` has no manual step for them.

# 0.17.0

- Uses runtime 0.14.0: `validate` follows text from web pages and services across steps. When it can reach a step that sends or changes things without a question to the person, it reports `untrusted_reaches_action` with the path and a patch that adds the question. This replaces `untrusted_content_can_act`; rename that code in `accept:`.

Method fixes a Method from the person's reactions to its results.

- **`method judge RUN_ID right|wrong`** records the person's reaction to a run's result. `--note` takes their words (at most 4000 characters), `--corrected FILE` the result they say is right (JSON is sent as JSON, other text as text; at most 1 MB), and `--step` the step whose output was wrong. RUN_ID is the `run_id` of the run's start line or the run ID on the dashboard. A wrong judgment makes Method fix the Method in the background: it applies a tested change that the person can undo, or changes nothing. The command prints one line, for example `Recorded: wrong on step choose. Method is fixing it in the background.`; `--json` prints the judgment.
- **`method changes FILE`** lists the changes that Method applied to a Method: the date, the version, and the cause of each. Commands that take a signed-in FILE still merge a new change into the file first and print one line. `method proposals` and its `--wait` are removed.
- **`method improve FILE` is for Methods that keep run content on this computer** (`run_data: device`, or an organization that keeps run content on devices). It runs the improvement on this computer as before, and `method apply FILE` merges its proposal. For a Method that keeps run content in the account, it starts nothing and says to record the person's reaction with `method judge`.
- **`method apply`** merges local proposals. It no longer takes the newest accepted proposal from the account; give it the ID that a conflict line names to merge a change that Method applied.
- The plugin and the authoring guide tell the agent to record the person's reaction with `method judge` after it shows a result, without asking the person to confirm it, and then to continue with what they asked.
- **A new check, `undeclared_change`,** looks for a step that can send or change something (a message, a post, a record in a service, a file outside its output folder) that its `changes` and effects do not declare. For a script step, code analysis decides when it finds a network host or a write, with no model request; when the script uses a library that can send or runs a command, Jev answers one yes/no question. An agent step with tools gets one question. The check starts in shadow mode: its answers are recorded on this computer and not shown, until its precision on the labeled set is measured.

# 0.16.0

A failed run says what went wrong, whose problem it is, and what to do next (runtime 0.13.0).

- **One failure record.** A run that stops has `failure` in its result, its `summary.json`, and its dashboard record: `owner` (whose problem it is: the Method's code, the agent's work, a service outside Method, a limit, your setup, your answer, or Method itself), `code`, a one-sentence `headline`, the step, its name and the failed tasks, the phase and check, `next` (an action and one sentence, sometimes a command), and the `evidence`, `details`, and `diagnostics`. The top-level `code`, `error`, `failed_step`, `iteration`, `diagnostics`, `fix`, and `recovery` fields are gone. A run that waits for an answer has `failure.next.text` that says to ask the user.
- **Three plain lines for a failed run.** `method run` prints `Failed:`, `Whose problem:`, and `Next:` on stderr. The JSON on stdout keeps its form.
- **`method wait` ends with the run's status** (`succeeded`, `unconfirmed`, `waiting_for_you`, or `failed`) and the headline of a failure, not `finished`.
- **Run records use the runtime's statuses.** An inspection has `status` `running`, `waiting_for_you`, `succeeded`, `unconfirmed`, or `failed` (no `needs_attention`) and the failure record (no `error`). The failed tasks of the failed step are `failed`; other tasks that were running when the run stopped are `stopped`, with no copied error. Only the final run event gives the run a duration. Events keep a task `total` without a count, and notices keep their `key`, `attempt`, and `attempts`. A `run_data: device` record keeps the failure record without its evidence, details, and diagnostics.
- **The runtime gives the agent one more attempt after a failed check** of an `agent` or `call` step with no `changes` or `effects`, with the check's reason and evidence in the prompt. The run records `step.retry`. A failed task of a parallel `each` step no longer stops the other tasks; the step fails after they end, with all failed tasks in `failure.failed_iterations`.
- **Notices.** The run records a `notice` event for each retry of a model or service, each error or warning that Codex or Claude Code reports, and a limit that is 80% used. Each user-facing event has a plain `message`.
- `ownerText(owner)` from `@method-ai-hq/sdk/inspection` gives the words for each owner.
- The authoring guide tells the agent to read `failure.headline` and `failure.next` when a run fails.

# 0.15.1

- The start link of a saved Method's run opens the run. Its records now use the run ID of the start line, so the page no longer waits for a record that never comes.

# 0.15.0

- **Run again with the inputs of an earlier run.** `method run FILE|ID --inputs-from RUN_ID` uses the inputs of that run. `--inputs FILE` given with it replaces single values. The inputs of an account run come from the account. The inputs of a `run_data: device` run come from its run folder on this computer (in `.method-runs` here and beside the Method, and in the CLI's run cache), found by its dashboard run ID; so do the inputs of any run when the account cannot be reached. When no run has the ID, the error says where it looked.
- **A device run says which phase failed.** A run with `run_data: device` keeps the phase of its failure and of each step's failure (environment, input, action, check, or change) in the record it sends to the dashboard, so the dashboard no longer says that the cause was not recorded. The expected and observed text, the evidence, and the error message stay on this computer.
- **`method proposals` says when an improvement found no safe change.** When the newest improvement has no proposal and its outcome is `none`, the printed `improvement` has `outcome: "none"`, and `next` says to add a note on a run with `method improve FILE --note TEXT` or to record a case with `method case new`. `--wait` returns with the same result.
- The authoring guide and the plugin tell the agent to give each Method a `run_label` that tells its runs apart (the resolved value when a default picks it), to put the readable output in `result`, to write a `run_prompt` that says where each input comes from and what to show, and to use `--inputs-from RUN_ID` for a "Run again" prompt from the dashboard.

# 0.14.6

- **A run links to its dashboard page from the start.** When this computer is signed in, the start line of `method run` has `dashboard`, the link to the run's page. The final result and the last line of `method wait` have it too. Before the run's first record arrives, the page waits for it. The `Dashboard:` line on stderr is gone.
- The authoring guide and the plugin tell the agent to give the user the link as soon as the run starts.

# 0.14.5

- A Method file in JSON keeps its home: a copy no longer takes over the home of a JSON Method file.

# 0.14.4

A Method keeps working when Method changes, with nothing for the user to do or to answer.

- **The CLI updates itself.** An installed CLI checks for a newer release at most once a day and installs it in the background, with no message; the next command uses it. The Method plugin also updates a CLI that is older than the plugin when a session starts. `METHOD_NO_UPDATE=1` turns this off. `method status` and `method run` no longer print an update notice.
- **A resume uses the release that started the run**, so a run that waits on an ask step continues after an update.
- **Older Method folders convert themselves.** `method run`, `method validate` and `method get` move a `runtime.json` and a `FILE.method.json` into the Method (format 3.4) and delete them: profiles become `models` (a direct OpenAI or Anthropic profile becomes the same model, hosted), limits become `limits`, folder paths become this computer's bindings. When the result would not validate, nothing changes and validate reports `older_format`. `method get` of an older saved version now gives a file that runs.
- **One file for each Method on a computer.** Versions are saved from one file (all checkouts of one Git repository count as one). A copy in a temporary or another folder does not run while that file exists, and the error names the file. When that file is unchanged since its last save and the account has a newer version, a run takes it first, with no message.
- **A run that waits for a person shows the question.** The `needs_input` result has the `question` text and its answer form, and the fix says to ask the user. `--human` accepts `"STEP"` for the first iteration.
- `method validate` names the local agent for model steps when this computer runs them with one.
- The authoring guide and the plugin tell the agent to talk about the user's work, not Method's versions, files, or settings, and to run a Method to show that it works.
- The Method plugin no longer puts the CLI version in the session context.

# 0.14.3

- The Python package is now `method-ai` on PyPI (`pip install method-ai`); the import stays `from withmethod import Method`.

# 0.14.2

- The Python library works with Method's production server: it names itself in each request (`withmethod-python/<version>`), because Cloudflare refuses the default Python user agent.

# 0.14.1

- The npm package is now `@method-ai-hq/sdk` (was `@withmethod/sdk`). Update imports and install lines.

# 0.14.0

A first Method needs fewer steps, no keys, and no extra commands (runtime 0.12.0).

- **Method plugin for Claude Code and Codex.** The installer adds it to each of these agents that it finds, so later sessions know Method. By hand: `claude plugin marketplace add method-ai-hq/method-sdk && claude plugin install method@method`, or `codex plugin marketplace add method-ai-hq/method-sdk && codex plugin add method@method`. It installs the CLI on first use and starts the guide when the user asks for repeated work.
- **Sign in first; hosted models.** Signed in, `call` and `agent` steps without a configured profile use a hosted model through the Method account, with no key and no local agent. Each account has a model credit. Not signed in, runs use a local agent as before.
- **Each prompt is a step.** `method validate` warns when a script calls a model API (`script_calls_model`); it never refuses the Method.
- **Keys stay on this computer.** Declare `secrets:` with names and purposes. `method secret import FILE NAME...` copies values from a file; `method secret set NAME` opens a private form in the browser; `method secret list` shows where each one is found. A missing secret stops the run before its first step. Replaces `runtimes.*.env`.
- **Versions save themselves; `method publish` replaces `save`.** A signed-in run of a local file saves a version when the file changed and sends the run to the dashboard. `publish` runs the cases and marks a version published. `create`, `save`, and `update` are removed.
- **Unchanged steps are reused.** A new run reuses each iteration whose definition, inputs, and executed files match an earlier accepted run on this computer. `--rerun STEP` and `--fresh` run steps again. `--from-run` and `--reuse` are removed.
- **`run_data: device`** keeps run content on this computer; the dashboard shows the run's steps and timing.
- **Private runs.** Hosted model and classifier requests go only to providers that do not train on them and keep no copy (`model_not_private` when a model has none); the organization setting "Keep run content on devices" (off by default) makes every run work as `run_data: device`; secret values are redacted in every run file, `checkpoint.json` too (runtime 0.12.0); run folders under `~/.cache/method/runs` unchanged for 30 days are deleted when a run starts.
- **Clearer failures.** A failed run reports `failed_step`, `iteration`, `diagnostics`, and `fix`, also when it fails before its first step. A classification that the service briefly cannot answer gets three attempts. Saving a version waits up to two minutes.
- The default `method authoring` guide is short and starts with the rules for a first Method, with a field reference; `method schema` without a name prints the same reference. `method validate` lists each step with its runner and the secrets it needs. An `each` step whose `in` repeats the item names the fix. The installer adds the CLI to PATH. `METHOD_SERVER` selects another server.
- **Put a Method in your app.** `method connect APP_FOLDER` writes a service key to the app's `.env` (never shown), publishes the Method if needed, and prints the install line and code for Node or Python. `method.run(...)` starts a worker in the app's process on first use; without `METHOD_API_KEY` a laptop uses the CLI sign-in. `ask` steps work in production: the run waits with no process held, the app's `onAsk`/`on_ask` handler (or a `needs_input` webhook) answers, or else the team inbox and an email with a one-time link; `method answer RUN_ID` answers from a computer. The run waits until it is answered, unless the step sets `limits.timeout_ms`. For `run_data: device`, inputs, questions, answers, and the saved run folder are encrypted with a key derived from the app's key, so the server stores only ciphertext.
- `method status` and `method run` name a newer release, checked once a day.
- **Classify answers yes/no and scores.** Besides `options`, a classify step takes `answer: yes_no` (value `{answer, probability}`) or `levels: [LOW, ..., HIGH]` (2–10 ordered names; value `{level, score, probabilities}`, where score is the expected level index).
- **Classification through OpenRouter.** Jev now runs through OpenRouter: the Method account uses the organization's OpenRouter key, so classification and hosted models share one model credit, and its cost appears in `usage.cost_usd`. A key in the environment alone no longer changes where classification runs (`TYPESAFE_API_KEY` is gone).
- **Your own OpenRouter key.** `method config model-key` opens a private form for `OPENROUTER_API_KEY` (the value stays in this computer's secret store). Then every hosted model step and every classify step on this computer calls OpenRouter with that key, and the run says "Using your own OpenRouter key". `--off` goes back to the account's model credit.
- **No runtime.json.** Models, limits (`limits`, `limits.step`), and tools are in the Method (format 3.4). `method validate` and `method run` stop with `legacy_runtime_json` or `legacy_sidecar` when a runtime.json or FILE.method.json is next to the Method, and the fix says what to move where; validate changes no file. A step `model: NAME` that is not in `models:`, not a model ID, and not `default` is the error `unknown_model`.
- **`method test` and `method case new` judge with the account's model** when this computer is signed in; `--agent` still selects a local agent.
- **`method deploy` is removed.** Production runs use `method connect`, `method worker`, or Method Cloud (`method publish --cloud`).

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
