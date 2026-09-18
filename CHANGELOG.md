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
