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
