<!-- Generated from packages/sdk/src/method-help.ts. -->

# Author with Method

Build a Method for the user's repeated work. Understand the request and what a good result looks like before choosing an example.

Validate with method validate task.method, save with method save task.method, then run the returned version with method run WORKFLOW_ID --version VERSION_ID. Inspect the result and its links.

Use method schema for field definitions, method authoring execution for setup, and method COMMAND --help for command arguments.

# Method concepts

A method has format, name, goal, steps, result, and optional inputs, state, environment, and files.
Each step uses do or ask. The do kinds are run, call, agent, and classify. Script actions require name and purpose; script checks require reading.check. A classify action takes bound inputs, a question, and options, and returns a named choice with probabilities. Use a script to apply business rules to that result.
run uses runtime and entrypoint; call uses model and prompt; agent can select browser: environment.NAME and optional custom tools.
Optional run_prompt is plain text for the outside agent that starts a saved Method. Write which Method to run, where to find its inputs, and what to show when finished. Save it with the Method version and update it when inputs or outputs change. The copy button appends the exact version link and shared CLI setup; do not repeat them in run_prompt. This field is not a step prompt and does not expand variables. Set it with method set task.method /run_prompt --text-file run-prompt.txt.

Model and human prompts use {{date}} for the step input declared as in.date. Nested fields such as {{customer.name}} are allowed. Only text, numbers, and booleans can be inserted; pass lists and records as structured inputs. Whitespace inside braces is allowed. Escape a literal placeholder with a backslash before its opening braces (use a YAML block scalar). Values are inserted once, never evaluated or expanded again. Unknown variables, invalid paths, and non-scalar values fail validation. Missing runtime values fail before model execution. Defaults belong in input declarations. Human ask text uses the same scope; agent check prompts use {{inputs.date}} and {{outputs.answer}}. Script commands, labels, and tool descriptions are not templates. Single braces are ordinary text.
Runs record prompt.rendered with the template and expanded instructions for each invocation and phase; the run page shows the recorded expansion, with templates in technical details. Model and agent work uses finite default limits; steps can override them.
An optional step reading object explains inputs, outputs, condition, and check in plain text for the reading page. These descriptions do not alter execution. Describe the declared data and actual checks; keep them in sync when editing the step. The page always shows the exact do and check instructions as well. Give a separate executable check a short reading.check_name, such as “Compare saved text”, and use reading.check to explain what it checks. These fields change presentation only. Older checks without a name display “Check”. Do not imply that a file or reference check verifies facts, or add a check just to fill the display.
Inputs and outputs have a type. Script outputs require descriptions; other data descriptions are optional. Types: text, number, boolean, record, list, file. Records need fields; lists need items or fields. Files have path and sha256.
Online runs upload declared file outputs separately, up to 20,000 files and 100 MB total, with 25 MB per file. Hash-checked receipts let interrupted transfers resume with only missing files. The single-file inspect export retains its separate 20 MB compressed-data limit. For a website, declare format: method-website and write a JSON file {schema: "method-website/1", title, entrypoint, files: [{path, sha256, media_type}]}. Paths in the file list are relative to that file; list every asset and identify an HTML start page. The run page opens the website only when all listed assets are attached. It can also download the complete website as a ZIP. No workspace scan occurs. See docs/result-files.md and examples/website-result.method for the full contract and working example. method sync RUN_DIRECTORY uploads files without executing steps again.
Bind step inputs with in aliases and use named outputs as downstream references. These references set execution order. Use after for required order without a data reference, such as operations that share a browser session. Every output has one producer.
Checks use equals, count, present, file, a script, or a bounded agent. Checker output is {status: pass|fail|unknown, reason, evidence}. Unknown never passes.
Use changes for state.NAME or environment.NAME. External changes require a check. State changes commit only after acceptance. State is saved in state.json.
Use each for a collection, repeat for bounded iteration, when for a boolean condition, and after for dependencies. Each and repeat cannot be combined.
Run a single step with repeat: {max_iterations: N, until: BOOLEAN_OUTPUT}. The final accepted output is returned; all iterations are recorded.

## Script steps

**Split scripts at retry boundaries.** Put operations in separate steps when
retrying one could repeat another completed action. Keep calculations together
when they serve one decision. A routing script chooses a destination; a later
action sends the message.

**Describe the behavior.** Give each script action a name and a purpose that
explains its rules, boundary values, result, and external changes. Describe
script checks in reading.check and tools in their existing description field.
When code, arguments, helpers, or dependencies change, review affected
descriptions and update them with the behavior.

**Declare the data.** Read business data through declared inputs and connections.
Include helpers and dependency lockfiles in the package. Supply time, random
seeds, and external observations as inputs when a decision depends on them.

**Validate before acting.** Check requirements that types cannot express before
changing an external system. Declare those changes in changes. Use finite loops
and request timeouts within the step's limits. Report invalid data as a failure.

**Return an inspectable result.** Write one JSON result to stdout, diagnostics to
stderr, and public progress through Method's progress channel. Return the rule
used for an important decision and the receipt or record ID for an external
write. Keep credentials in runtime bindings.

**Make recovery explicit.** For external writes, describe what a retry does and
how to check uncertain completion. Use a stable operation or business key when
the service supports duplicate prevention. Test decision boundaries and an
interruption after the service commits but before the script saves its receipt.

Example purpose: “Chooses Billing when Billing is the selected category and its
probability is at least 90%. Otherwise chooses Manual review. Returns the
destination and the rule used.”


# Example catalog

- [daily-briefing](examples/daily-briefing.md): Turns prepared records into a cited briefing website using an approved writing example, a source check, and rendering scripts.
- [social-briefing](examples/social-briefing.md): Researches a topic through Grok, alphaXiv, and LinkedIn in the browser, then writes a briefing with quotes and source links.
- [outbound-management](examples/outbound-management.md): Reads email and prospect sources, updates persistent CRM state, and saves daily tasks and outreach drafts for review.
- [message-routing](examples/message-routing.md): Classifies a customer message with Jev, then applies a script rule to choose a support destination.

Read one complete example with `method authoring example EXAMPLE_ID`.

Once you understand the requested work, choose one example from the catalog whose execution structure best fits it. Read that complete example with method authoring example EXAMPLE_ID and use it as your one-shot reference. Choose by the work's structure: classification, persistent state, browser research, or report production.



For live progress, native Codex forwards public updates as they arrive. Scripts use METHOD_PROGRESS_FD; run method progress --help for the message and child-agent relay protocol. Keep stdout for the final JSON result. Report real milestones without source passages or secrets. Quiet work still sends a five-second heartbeat; the page polls every three seconds. A heartbeat shows the executor is connected, not that new work has completed. See https://github.com/method-ai-hq/method-sdk/blob/main/docs/progress.md for complete examples.

Use reading.output_name to give a returned result a short, honest name. Use reading.outputs to explain its contents.
# Execution setup

Use method run FILE_OR_ID [--config runtime.json] [--workspace HELPERS_FOLDER] [--inputs inputs.json] [--state state.json] [--run-dir DIR].
Classification uses the Method account. A classifier-only Method needs sign-in and network access, with no agent installation or provider key. The SDK saves the pinned model before execution and reuses it on resume. Each invocation makes one request; uncertain answers complete normally. Questions and option descriptions are literal text. Bind JSON inputs through in or each, and use out: RESULT_NAME for the choice and probability record. There must be 2–255 options. Classifiers cannot receive declared files or declare changes.

Classification sends the step's declared inputs to Method and its classification provider. Method currently covers the cost within service limits. Saved runs contain the declared inputs and results.

Explicit named model profiles keep their settings. For an unconfigured profile, Method uses --agent, the configured default, the identified calling agent, or the sole available supported agent. If a choice is needed, use --agent codex or --agent claude. Both use normal sign-in. The selected provider stays fixed on resume.
A simple local-agent Method needs no runtime.json. When needed, put runtime.json beside the Method. New saved versions carry their helpers and runtime.json. Older versions without saved files still need --workspace DIR. --config overrides that file. Relative files-environment paths and executable paths in configuration resolve from the config folder. A bare executable name is found on PATH.
Environment declarations name required connections. An agent with browser: environment.NAME receives the standard direct browser-use controls. Codex or Claude chooses the browser actions. Method opens the selected browser, retains its sign-ins privately, and reuses the session across steps. On macOS, Method copies your last-used Chrome profile and runs headless. Sign in through Chrome before running the Method. Run headless by default. If a task requires a visible browser, show it only for that task, then return to headless mode. Use method browser connect --cdp URL to attach to a Chrome session that permits control. Validation does not open a browser. Each run has a separate profile; resume reads the current page, not a saved web snapshot.
Operator config supplies runtimes, tools, environment, and run limits. Optional models.PROFILE: {backend: codex, model: MODEL} selects a model; omit model to use the Codex default. command can select the Codex executable and reasoning_effort can override its setting.
An explicit models.PROFILE with backend: openai-responses keeps the direct API path. It requires model, api_key_env, and max_output_tokens. Keep key values out of the config; api_key_env names an existing environment variable.
runtimes.PROFILE uses command, version, optional args and env variable names. Scripts and Codex require allow_local_processes: true. They are trusted local processes.
Custom script tools declare description, in, out, run, and effects. List custom tools in the step and config. Browser controls are supplied automatically; interactive controls require changes: [environment.NAME]. Check tools cannot declare external effects.
Defaults: one hour per run, ten minutes per step, 100 model requests, 100 step invocations, 200 tool calls, and 16 MiB for input and output. Step defaults allow 32 agent turns/model requests. Override run limits with timeout_ms, max_model_requests, max_invocations, max_tool_calls, max_output_bytes, max_request_bytes. Method enforces the Codex process timeout, prompt/output size, and declared Method tool-call limit. max_model_requests governs direct API and classification requests; max_agent_turns governs the direct API agent loop; Codex manages its own internal requests and built-in tools. Codex usage and process logs are saved separately.
Declared tools are exposed to each Codex or Claude step through a temporary local MCP connection. It uses the same script execution and checks as the API path. Codex also retains the user's installed tools. Method does not sandbox these processes. No persistent Codex configuration is edited.
METHOD_OPERATION_ID identifies a script action or check within a run. It stays the same when that invocation is retried. Use it as the service’s idempotency key to prevent duplicate writes during recovery. Use a business key when duplicates must also be prevented across separate runs. Agent tools define duplicate prevention in their own contracts.

Scripts receive one JSON object on stdin and return one JSON object on stdout. Write artifacts under METHOD_OUTPUT_DIR. State updates are returned under state.
Save includes declared files, script and tool entrypoints, dependency lockfiles, and the runtime release. Run accepts a Method ID or dashboard URL and restores that version. Standard node and python runtimes are prepared automatically. Custom runtime settings stay explicit.
Use method inspect RUN_DIRECTORY --out inspection.json for a saved run; online runs sync to the same Method dashboard.
Use method bind ID NAME --file FOLDER to remember an input on this computer. Add --upload only to save that selected input folder privately in the account. Bundled examples stay in the version; day records stay separate.
Use method state ID --enable --file state.json to opt into shared account state. Concurrent runs cannot overwrite it. Account state is JSON; an uploaded SQLite input is a snapshot, not a shared database. Use a live service connection for a shared database. A stopped run keeps ownership until continued or explicitly released with method state ID --release RUN_ID after inspecting its actions.
CLI runs of local files and saved Methods have their own process. Use --background to return immediately, method run-status DIR, method wait DIR, or method cancel DIR. New runs accept package runtime versions explicitly tested by the installed SDK. The saved package stays unchanged; run records identify the executor used. Resume the same Method version and exact executor with --resume --run-dir DIR. Checkpoints without an executor version need their original SDK/runtime installation. Use method sync DIR to retry uploads without repeating work.


# Recipes

Use a script for exact file transforms and exports. Use a call for a structured model response. A direct API call is one request without tools; the Codex backend controls its own internal requests and tools. Use an agent only when bounded tool use is needed.
For incremental exports, keep a declared state ledger of source IDs and evidence hashes. Compare new evidence to that ledger and rebuild only changed days. Supply the prior run's state.json with --state for a new run.
Resume continues the same input set and saved version. A new run can collect new files. A separate database is optional application state, not a workaround required to resume Method.
To edit a failed method, read its exact saved version and logs, compare the current version, then save the complete repair with a reason.


# Recovery

For a stopped run, read summary.json, events.jsonl, and checkpoint.json. Resume with the original method, config, --run-dir DIR, and --resume. Accepted steps and iterations are reused.
An unfinished action needs --retry STEP:ITERATION after inspection of its external effects. A retry consumes the remaining run budget. Budgets do not reset on resume. Changed methods or config require a new run.
For ask, supply --human FILE containing {steps: {"STEP:ITERATION": {outputs: {NAME: VALUE}}}}. Use the user's actual answer. Checks still run.
For a stale .lock, first confirm the process has stopped. Never remove an active process lock.
State commits after checks. A local checkpoint cannot roll back an external write. Inspect external state before an explicit retry.
For a save conflict, get the latest version and apply the change there. For an uncertain upload, retry the same file and command with its sidecar unchanged.
Use method sync RUN_DIRECTORY to repair a dashboard upload without executing the method again.
New Methods use format method/3.2. Existing method/3.1 documents retain their validation rules.


# Command reference

Local authoring commands edit draft files. create, save and update publish Method versions. run executes a saved version.

Server: https://app.withmethod.ai by default. --server selects another server and its login.
Success exits 0. Errors exit 1 with text on stderr, unless the command specifies another result.

Common errors:
File commands require readable YAML or JSON. Editing commands report draft locks and leave the original file unchanged after a failed edit. Online commands require sign-in and network access. Use method authoring recovery for conflicts and interrupted saves.

## browser connect

Select a private browser connection.

Usage:

```sh
method browser connect [--name NAME] [--cdp URL]
```

Arguments and defaults:
NAME defaults to default. --cdp attaches to a Chrome session that permits remote control. Without --cdp, Method runs headless. On macOS it copies your last-used Chrome profile to reuse sign-ins. Use method-browser:NAME for a named browser binding.

Result and changes:
Saves the browser selection on this computer. No browser is started by this command.

Errors:
Invalid name or endpoint. Credentials must not be in the URL.

Example:

```sh
method browser connect
```

## deploy

Prepare and approve a runner from a successful run, then run it with new inputs.

Usage:

```sh
method deploy --from-run RUN_DIRECTORY
method deploy --approve DEPLOYMENT_ID
method deploy --run DEPLOYMENT_ID [--inputs FILE] [--resume RUN_ID]
method deploy --login DEPLOYMENT_ID [--agent codex|claude]
```

Arguments and defaults:
Preparation uses the selected Method runner and shows its files, inputs, state, and account scope. Approval applies that exact plan and checks access. Writable folders are copied once into persistent runner storage; local originals remain unchanged. --run starts a separate business run. --resume continues an existing runner run with the same inputs.

Result and changes:
Prepared review and approval command, or readiness and run command. Missing website sign-ins return a local viewer. Missing agent access returns a runner login command. Both continue the same deployment. Preparation transfers no user data. Session state stays outside the Method package and image.

Errors:
Changed files, missing runner access, unsupported local dependencies, or missing completed-run file records. Missing setup exits 2.

Example:

```sh
method deploy --from-run .method-runs/completed
```

## doctor

Check Node and configured runtime access without running a Method.

Usage:

```sh
method doctor [--config FILE] [--agent codex|claude]
```

Arguments and defaults:
A script-only configuration does not require an agent. Without config, check the selected local agent. Use validate FILE for the Method's own dependencies.

Result and changes:
Setup findings; no task execution.

Errors:
Missing executable, credentials, or provider choice.

Example:

```sh
method doctor --config runtime.json
```

## inspect

Export saved execution evidence.

Usage:

```sh
method inspect RUN_DIRECTORY --out FILE
```

Arguments and defaults:
Use a new output file. --include-files attaches declared result files.

Result and changes:
Saved inspection JSON.

Errors:
Missing run or existing output.

Example:

```sh
method inspect runs/example --out inspection.json
```

## prompt

Read the document as instructions.

Usage:

```sh
method prompt FILE
```

Arguments and defaults:
Current Method file.

Result and changes:
Text; no execution.

Errors:
Invalid document.

Example:

```sh
method prompt task.method
```

## bind

Save a named input location or connection.

Usage:

```sh
method bind ID NAME (--file FOLDER | --connection URL) [--upload]
```

Arguments and defaults:
Default: this computer only. --upload saves only the selected input folder or connection URL in the account. It never scans your disk. Keep credentials in the service's normal sign-in store.

Result and changes:
Saved binding and scope.

Errors:
Missing input, invalid name, or unsafe path.

Example:

```sh
method bind METHOD_ID prepared_day --file day-records --upload
```

## state

Read or explicitly enable shared account state.

Usage:

```sh
method state ID [--enable --file state.json | --release RUN_ID]
```

Arguments and defaults:
Accepted state updates use revision checks. Inspect a stopped run's external actions before releasing its ownership.

Result and changes:
Current revision, value, and owner run.

Errors:
Concurrent ownership or stale revision. Existing state is never silently overwritten.

Example:

```sh
method state METHOD_ID --enable --file initial-state.json
```

## wait

Reconnect to the same local worker.

Usage:

```sh
method wait RUN_DIRECTORY
```

Arguments and defaults:
Use the directory returned by run. Closing this output connection leaves the worker active.

Result and changes:
Live output and final worker status.

Errors:
Stopped process or missing run.

Example:

```sh
method wait .runs/example
```

## run-status

Read worker status without waiting.

Usage:

```sh
method run-status RUN_DIRECTORY
```

Arguments and defaults:
Local run directory.

Result and changes:
Worker status and whether its process is active.

Errors:
Unreadable run directory.

Example:

```sh
method run-status .runs/example
```

## cancel

Stop a local run process.

Usage:

```sh
method cancel RUN_DIRECTORY
```

Arguments and defaults:
Inspect uncertain external actions before any explicit retry.

Result and changes:
Cancellation request. The checkpoint remains available.

Errors:
Unreadable run directory.

Example:

```sh
method cancel .runs/example
```

## progress

Report public progress from a running script or relay a child Codex JSON stream.

Usage:

```sh
method progress --message TEXT [--completed N --total N --unit NAME] [--child NAME]
method progress --codex --child NAME
```

Arguments and defaults:
METHOD_PROGRESS_FD is supplied by the executor. --codex reads JSON lines from stdin; --message sends one message. Do not include secrets or source contents.

Result and changes:
Writes to the separate progress pipe. No stdout output. No-op outside a Method process.

Errors:
Invalid arguments. Malformed Codex events are ignored.

Example:

```sh
method progress --message 'Rendered 12 of 40 pages' --completed 12 --total 40 --unit pages
```

## authoring

Read the installed authoring guide. Available offline.

Usage:

```sh
method authoring [start|concepts|execution|examples|recipes|recovery|commands|all]
method authoring example EXAMPLE_ID
```

Arguments and defaults:
Default topic: start, with shared rules and the example catalog. Choose one named example after understanding the request. A named example prints its complete lesson and installed file paths. all prints the shared reference and catalog.

Result and changes:
Markdown text on stdout. No changes.

Errors:
Unknown topic: lists the valid topics; exit 1.

Example:

```sh
method authoring all > method-guide.md
```

## init

Create a local YAML draft.

Usage:

```sh
method init FILE --name NAME --goal TEXT
```

Arguments and defaults:
File must be new. Name and goal are required. The draft starts with an empty steps map and result map.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
Missing name or goal; file or sidecar already exists.

Example:

```sh
method init task.method --name 'Find leads' --goal 'Find qualified leads from the specified sources.'
```

## show

Read a draft or one field.

Usage:

```sh
method show FILE [--path POINTER]
```

Arguments and defaults:
Default: the full document. Pointer example: /steps/search/do.

Result and changes:
Selected value as JSON. No changes.

Errors:
The selected field does not exist.

Example:

```sh
method show task.method --path /steps/search
```

## set

Add or replace one draft field.

Usage:

```sh
method set FILE POINTER (--json JSON|--value-file FILE|--text TEXT|--text-file FILE)
```

Arguments and defaults:
Use exactly one: --json JSON, --value-file FILE (YAML or JSON), --text TEXT, --text-file FILE (UTF-8 text). Prefer files for long text. Parents must exist. An empty pointer replaces the document. Escape / as ~1 and ~ as ~0. Nested values replace in full.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
Invalid pointer, missing parent field, or conflicting value flags.

Example:

```sh
method set task.method /steps/search/do/prompt --text-file search.txt
```

## remove

Remove one draft field.

Usage:

```sh
method remove FILE POINTER
```

Arguments and defaults:
The field must exist. Repair remaining references before saving.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
The selected field does not exist.

Example:

```sh
method remove task.method /steps/search/each
```

## step add

Add a complete operation.

Usage:

```sh
method step add FILE --id ID --value-file STEP.yaml
```

Arguments and defaults:
Supply do or ask and the bindings and outputs needed by the step in STEP.yaml. Script actions require name and purpose, and their outputs require descriptions. Script checks require reading.check. Checks and limit overrides are optional. Alternatively use --kind run --runtime PROFILE --entrypoint FILE. Agents can use --kind agent --instructions-file FILE; the default is the calling coding agent.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
File commands require readable YAML or JSON. Editing commands report draft locks and leave the original file unchanged after a failed edit. Online commands require sign-in and network access. Use method authoring recovery for conflicts and interrupted saves.

Example:

```sh
method step add task.method --id copy --value-file copy.yaml
```

## step update

Change fields of an existing step.

Usage:

```sh
method step update FILE STEP_ID (--json JSON|--value-file FILE)
```

Arguments and defaults:
Supply an object of fields. Top-level fields merge; nested values replace in full. Use remove to delete a field.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
Unknown step or invalid step fields.

Example:

```sh
method step update task.method search --value-file search.yaml
```

## step remove

Remove an operation.

Usage:

```sh
method step remove FILE STEP_ID
```

Arguments and defaults:
Repair references to its outputs and after constraints before saving.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
The selected step does not exist.

Example:

```sh
method step remove task.method old_search
```

## step move

Change display order.

Usage:

```sh
method step move FILE STEP_ID --before OTHER_ID
```

Arguments and defaults:
Both steps must exist. Data references and after still control execution order.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
The selected step or destination does not exist.

Example:

```sh
method step move task.method search_exa --before search_bookface
```

## check set

Set the operation's independent check.

Usage:

```sh
method check set FILE STEP_ID (--json JSON|--value-file FILE)
```

Arguments and defaults:
Current methods require an equals/count/present/file object, a run check, or an agent check. Put plain-English criteria in an agent check prompt.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
Unknown step, invalid check, or conflicting value flags.

Example:

```sh
method check set task.method search --value-file check.yaml
```

## check remove

Remove the operation's check.

Usage:

```sh
method check remove FILE STEP_ID
```

Arguments and defaults:
The operation will be unchecked. External changes require a check.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
The selected step does not exist.

Example:

```sh
method check remove task.method copy
```

## check

Edit an operation's check.

Usage:

```sh
method check set|remove ...
```

Arguments and defaults:
Use method check set --help for arguments.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
Unknown action. Choose set or remove.

Example:

```sh
method check set --help
```

## validate

Check the definition and local setup without running the work.

Usage:

```sh
method validate FILE [--config FILE] [--workspace DIR]
```

Arguments and defaults:
Checks data, names, dependencies, templates, declared files, executables, environment variables, runtime profiles and tool bindings. Defaults to runtime.json beside the Method. --workspace selects the helper folder and default config folder. Relative paths in config resolve from the config folder.

Result and changes:
JSON reports definition, local_setup, executed:false, and valid. Invalid definitions or missing declared files exit 1. Managed setup is reported separately as needs_preparation; run prepares it.

Errors:
The error identifies the invalid field or reference.

Example:

```sh
method validate task.method
```

## diff

Compare two documents.

Usage:

```sh
method diff FILE OTHER_FILE
```

Arguments and defaults:
Both files required. Values are compared after parsing YAML or JSON.

Result and changes:
JSON array of {path,before?,after?}. Empty means equal; exit 0 either way.

Errors:
Both file paths are required.

Example:

```sh
method diff original.method task.method
```

## schema

Read the machine-readable grammar.

Usage:

```sh
method schema [method|config|step|data|environment|check]
```

Arguments and defaults:
Default: method. Use authoring concepts for meaning and authoring recipes for examples.

Result and changes:
JSON Schema for tooling. Data declarations in methods use the six simple types.

Errors:
Unknown schema name.

Example:

```sh
method schema step
```

## create

Save a complete local draft as a new online method.

Usage:

```sh
method create --file FILE [--request-id UUID] [--server URL]
```

Arguments and defaults:
--file required. Request ID defaults to a new UUID and is saved before upload. The draft must not already belong to an online method. Validation runs before upload.

Result and changes:
JSON with workflow_id, version_id, version_number, server and url. Writes FILE.method.json.

Errors:
Invalid method; linked draft; conflicting request ID; pending save with changed contents. See recovery for an uncertain upload.

Example:

```sh
method create --file message.method
```

## get

Read an online method; optionally make a local draft for editing.

Usage:

```sh
method get WORKFLOW_ID [--version VERSION_ID] [--out FILE] [--server URL]
```

Arguments and defaults:
Default: latest version. --out must name a new file with no existing .method.json. Use a version ID to read an exact saved version.

Result and changes:
Without --out: {workflow_id,version_id,version_number,workflow}. With --out: {workflow_id,version_id,version_number,file}; writes the workflow and FILE.method.json.

Errors:
Missing method or version; output file or sidecar already exists.

Example:

```sh
method get wf_example --out edit.method
```

## save

Save a draft as one online version.

Usage:

```sh
method save FILE [--reason TEXT] [--request-id UUID] [--server URL]
```

Arguments and defaults:
New draft: creates a method. Linked draft: --reason required, base version and destination read from FILE.method.json. --request-id is used for first creation; retained pending ID wins on retry. Default server comes from the sidecar, then the online default.

Result and changes:
JSON with workflow_id, version_id, server, url, confirmed:true and document_sha256 after reading back the exact saved version; confirmed saves also include version_number. Updates FILE.method.json. Unchanged draft: unchanged:true, no new version.

Errors:
Invalid method; missing reason; pending changed payload; wrong server; stale base (409). See recovery before retrying.

Example:

```sh
method save edit.method --reason 'Give each output a clear description.'
```

## update

Save a full method against an explicit base version.

Usage:

```sh
method update WORKFLOW_ID --file FILE --base-version VERSION_ID --reason TEXT [--server URL]
```

Arguments and defaults:
All listed non-server arguments required. Prefer get --out and save for normal editing. This lower-level command does not read or update the local sidecar. It validates the whole document.

Result and changes:
JSON {version_id,version_number}. Creates an online version. After success, use get --out NEW_FILE for further edits.

Errors:
Stale base (409); invalid method; missing reason. A repeated update returns the saved version only when parent, contents and reason still match the latest version.

Example:

```sh
method update wf_example --file edit.method --base-version version_example --reason 'Clarify the query.'
```

## status

Check installation and sign-in without listing Methods or starting login.

Usage:

```sh
method status [--server URL]
```

Arguments and defaults:
No required arguments. Checks the selected server with the current credential when one exists.

Result and changes:
JSON {installed:true,server,signed_in}. A missing or expired credential returns signed_in:false. Does not print account details.

Errors:
Network and server errors exit 1; they are not reported as signed out.

Example:

```sh
method status
```

## list

Find your online methods.

Usage:

```sh
method list [--server URL]
```

Arguments and defaults:
No required arguments.

Result and changes:
Server JSON containing methods. No changes.

Example:

```sh
method list
```

## steps

Read all complete step definitions in a saved method.

Usage:

```sh
method steps WORKFLOW_ID [--version VERSION_ID] [--server URL]
```

Arguments and defaults:
Default: latest version. Use step with two IDs to read one saved step.

Result and changes:
JSON {version_id,steps}. No changes.

Errors:
Missing method or version.

Example:

```sh
method steps wf_example
```

## step

Read one online step. For local edits use step add/update/remove/move.

Usage:

```sh
method step WORKFLOW_ID STEP_ID [--version VERSION_ID] [--server URL]
```

Arguments and defaults:
Both IDs required. Default: latest version. Subcommand words add, update, remove, move are reserved for local editing.

Result and changes:
JSON {version_id,step}. No changes.

Errors:
Missing method, version, or step. Use method steps to find step IDs.

Example:

```sh
method step wf_example search
```

## login

Connect this computer with browser approval.

Usage:

```sh
method login [--server URL]
```

Arguments and defaults:
No credentials in chat or command flags. Method opens the sign-in/approval page and waits. Connection is saved per server in ~/.config/method. Sign in again if access expires or is revoked.

Result and changes:
Sign-in instructions and status text. Stores a private local credential after approval. Remote commands also start login when no credential exists.

Errors:
Approval expired, denied, or network unavailable. Repeat login when ready.

Example:

```sh
method login
```

## logout

Disconnect this computer from the selected Method server.

Usage:

```sh
method logout [--server URL]
```

Arguments and defaults:
No required arguments. Select the same server used for login.

Result and changes:
Status text. Revokes remote access, then removes the local credential.

Errors:
If remote revocation fails, the local credential remains. Retry online, or use devices/revoke from another connected computer.

Example:

```sh
method logout
```

## devices

List authorized computers.

Usage:

```sh
method devices [--server URL]
```

Arguments and defaults:
No required arguments.

Result and changes:
Server JSON device list. No changes.

Example:

```sh
method devices
```

## revoke

Revoke a computer's Method access.

Usage:

```sh
method revoke DEVICE_ID [--server URL]
```

Arguments and defaults:
Use the exact ID from method devices. This changes account access.

Result and changes:
Server JSON confirmation. The selected device can no longer use that credential.

Errors:
Unknown device ID.

Example:

```sh
method revoke device_example
```

## runs

Read saved run summaries.

Usage:

```sh
method runs [--method WORKFLOW_ID] [--server URL]
```

Arguments and defaults:
Default: all methods. --method filters the list.

Result and changes:
Server JSON containing runs. No changes.

Example:

```sh
method runs --method wf_example
```

## logs

Read saved run evidence before a repair.

Usage:

```sh
method logs RUN_ID [--server URL]
```

Arguments and defaults:
Use a run ID from method runs. Saved logs may be incomplete if upload failed.

Result and changes:
Server JSON containing the run, inputs, outputs, checks and events. No execution or changes.

Errors:
Missing run.

Example:

```sh
method logs run_example > run.json
```

## sync

Retry upload of records from an existing local run.

Usage:

```sh
method sync RUN_DIRECTORY [--server URL]
```

Arguments and defaults:
Directory must contain method-sync.json. Default destination is the saved run's server. Do not use a new business run to repair an upload.

Result and changes:
Upload status text. Updates dashboard records and local sync metadata. Does not execute steps.

Errors:
Missing run/sync records; access or network error. Keep the original run directory and retry.

Example:

```sh
method sync .method-runs/wf_example/saved-run
```

## run

Execute a saved method locally and upload its run records.

Usage:

```sh
method run WORKFLOW_ID [--version VERSION_ID] [--server URL] [OPTIONS]
```

Arguments and defaults:
Current methods optionally use runtime.json beside a local file, or in the current folder for a saved ID. --workspace selects a different folder. --config FILE overrides the config. See method authoring execution. Optional --state FILE initializes state for a new run. Resume with --resume --run-dir DIR; authorize unfinished work with --retry STEP:ITERATION.

--inputs FILE: JSON input values.
--run-dir DIR: saved run folder.
--agent codex|claude: select an agent for unconfigured profiles in a new run.
--resume: continue the same saved run with its saved agent.
--human FILE: saved human answers for the current runtime.
--verbose: print runtime events.
Use method doctor to check the installed Node and configured tools.

Result and changes:
Progress and final status text; local result.json and run evidence; dashboard run link when synced. The runtime executes the method's declared scripts, calls, agents, and checks. Executes trusted local processes; changes declarations do not enforce permissions. Current runs exit 0 on completion, 1 on failure, and 2 when human input is needed.

Errors:
Missing inputs/access, failed check, timeout, unsafe resume/version mismatch, upload failure. See recovery. Never retry a business write without inspecting its saved changes.

Example:

```sh
method run wf_example --version version_example --config runtime.json --workspace . --inputs inputs.json
```
