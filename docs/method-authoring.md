<!-- Generated from packages/sdk/src/method-help.ts. -->

# Build a Method

1. **Sign in first.** Run `method status`. If it is not signed in, run `method login` and let the user approve in the browser. Signed in, model and classification steps need no keys, each run saves a version when the file changed, and runs appear on the dashboard.
2. **Each model or classifier request is its own step**: `call`, `agent`, or `classify`, with its prompt in the Method. Then the user can change one prompt, run again, and compare. A script never calls a model API; `validate` and `run` refuse it (`model_call_in_script`). When the user already has code that does the work, keep its fixed logic as `run` steps and move each prompt and rubric into its own step. "The same thing" means the same behavior with steps, not a wrapper around the code. If a request cannot become a step because Method lacks a feature, tell the user what is missing. Do not wrap the code.
3. **Show the design, then build it in the same turn.** Show each step with its type, purpose, and output, and the table of prompts and rubrics in the user's work with the step that holds each one. Do not wait for approval unless the user asked to approve first. Ask only for information that you cannot find and that would change the design.
4. **Run early and often.** Write the first steps, validate, run, then add the next steps. A new run reuses every step whose definition and inputs did not change, so each run executes only what changed. `--rerun STEP` runs a step again anyway; `--fresh` runs every step.
5. **Keep the inputs of the existing code.** If the code takes an ID and looks up the record, the Method takes the same ID and looks it up the same way.
6. **Use the defaults without asking.** Model steps use the account's hosted models and `classify` uses Method's classifier, so the user's model and classifier keys are not needed. To keep the model that existing code uses, add `models: {writer: {backend: method, model: "provider/model"}}` to runtime.json and use `model: writer` in the steps; it needs no key. Run content goes to the user's account; set `run_data: device` only when the user asks to keep it on this computer. Say these defaults in one line and continue.
7. **Keys stay out of chat.** Declare each key that a script needs under `secrets:` with its purpose. Look for the key where the project keeps its keys: the README, `.env` files, and the code. Name the file to the user, ask once, then run `method secret import FILE NAME...` for the declared names only. Only when you find no file, ask the user to run `method secret set NAME`, which opens a private form in their browser. Values stay on this computer. Never ask for a value in chat and never print one.
8. **Choose a sample yourself** from the user's data, and check that it has the sources the Method needs. Ask only when there is no good sample.
9. **Iterate.** After a good run, show the result and the dashboard link, and ask what to change. Change the step and run again.
10. **Publish** with `method publish FILE --reason TEXT` when the user wants to share or schedule a version. It runs the Method's cases first.

When a run fails, read its `fix` and `diagnostics`, change the step, and run again.

# A complete small Method

```yaml
format: method/3.3
name: Weekly ticket summary
goal: Score this week's support tickets by urgency and write a short summary for the team.
inputs:
  week:
    type: text
    description: Monday of the week to summarize, as YYYY-MM-DD.
secrets:
  HELPDESK_TOKEN: Read-only token for the help desk export.
steps:
  read:
    name: Read the tickets
    purpose: Downloads the week's tickets from the help desk export and returns each ticket's id and text. Changes nothing.
    in: {week: inputs.week}
    do: {kind: run, runtime: python, entrypoint: read_tickets.py}
    out:
      tickets: {type: list, fields: {id: text, text: text}, description: The week's tickets.}
  urgency:
    name: Score urgency
    each: {ticket: tickets}
    concurrency: 8
    do:
      kind: classify
      question: How urgent is this support ticket?
      options:
        high: High - a customer cannot work, or data is at risk.
        normal: Normal - a problem with a workaround.
        low: Low - a question or a request.
    out: urgency
  summary:
    in: {tickets: tickets, urgency: urgency}
    do:
      kind: call
      model: default
      prompt: |
        Write a five-sentence summary of this week's support tickets for the team.
        Start with the high-urgency tickets. Quote no customer names.
        The inputs hold the tickets and their urgency, in the same order.
    out:
      summary: {type: text, description: The summary for the team.}
result: summary
```

`read_tickets.py` reads HELPDESK_TOKEN from its environment. The classify and call steps use the Method account, so they need no key.

```sh
method validate tickets.method
method run tickets.method --inputs inputs.json   # prints the version and dashboard links
# change the summary prompt, then:
method run tickets.method --inputs inputs.json   # reuses read and urgency; runs summary
```

# Field reference

```text
format: method/3.3
name, goal          text
inputs              {NAME: DATA}           values the run receives (--inputs FILE)
secrets             {NAME: purpose}        keys that scripts receive as environment variables
environment         {NAME: {type: files | service | browser | desktop | tool, description}}
files               [PATH]                 helper files that scripts import or read
steps               {ID: STEP}
result              REF, or {NAME: REF}
run_data            account (default) | device

DATA   {type: text | number | boolean | record | list | file, description,
        fields: {NAME: TYPE}   (a record, or a list of records)
        items: TYPE            (a list of one type)
        default: VALUE}        A bare type such as text works inside fields and items.
REF    inputs.NAME | an output NAME | NAME.field | state.NAME | environment.NAME

STEP   name, purpose          a run step needs both: its rules, result, and external changes
       in: {ALIAS: REF}       the values that the step receives
       each: {ITEM: LIST_REF} run once per item; ITEM is given to the step, so do not repeat it in in
       concurrency: 1-32      items at once, for an each step that changes nothing
       when: BOOLEAN_REF      after: ID or [ID]      repeat: {max_iterations, until: BOOLEAN_OUTPUT}
       do: one of
         {kind: run, runtime: python | node, entrypoint: FILE, args: [...]}
             reads one JSON object (its in) on stdin, prints one JSON object (its out); files go under $METHOD_OUTPUT_DIR
         {kind: call, model: PROFILE, prompt: TEXT}
             the step's in go to the model as JSON; {{ALIAS}} puts a text, number, or boolean value into the prompt
         {kind: agent, model: PROFILE, prompt: TEXT, tools: [TOOL]}
         {kind: classify, question: TEXT, options: {ID: description}}
             out: NAME; the value has choice and probabilities
       ask: TEXT              in place of do: a question for the user
       out: {NAME: DATA}      (classify: out: NAME)
       changes: [state.NAME | environment.NAME]; a service change needs effects or no_effect_reason
       check, limits: {timeout_ms, max_model_requests, max_agent_turns}

runtime.json beside the Method (optional)
  models: {PROFILE: {backend: method, model: provider/model}}   a hosted model; no key. Steps without a profile use default.
  environment: {NAME: path}   limits: {...}   allow_local_processes: true
```

`method schema method` prints the complete JSON schema.

# Choose the design

Identify the supplied inputs, required result, constraints, and external changes. Use information already provided. Ask only for missing information that would materially change the design.

Choose each operation's execution type from its requirements:

| Requirement | Execution type |
| --- | --- |
| Fixed rules, calculations, file transformations, or a known API operation that is not a model | run |
| A structured model response from supplied information | call |
| Model-directed investigation or tool use | agent |
| Selection from named options with probabilities | classify |
| An answer or decision that must come from the user | ask |

For browser work, declare a browser environment and select it with do.browser: environment.NAME. Method supplies the browser controls. Put the research task, limits, and required results in the prompt. Read method authoring example social-briefing for a complete example.

Default to no additional task check. Add a check only when it detects a concrete failure that matters to the requested result. Do not add checks merely because a value can be checked. Do not repeat validation already supplied by output types or the runtime.

Do not enforce wording, headings, keywords, lengths, or counts unless the task requires them. An instruction to write accurate prose does not justify string matching.

When a check is needed, use the simplest check that establishes the required fact. Built-in equals, count, present, and file checks, scripts, and agent checks are options, not a checklist. Local file writes need no check: the runtime observes files connections itself. A change to a service, an API, email, or a browser that sends needs an effect that reads the result back, because a receipt or a 200 status shows only that the request was accepted. Use a built-in observer (http, sqlite, file) when one fits. When a change cannot or need not be observed, such as a browser step that only reads, write no_effect_reason instead.

Existing checks and tests are implementation choices, not user requirements. Remove checks that are unnecessary, duplicate existing validation, or enforce an invented requirement. Delete tests and instructions that exist only to support the removed check. Do not preserve a check merely because it already exists, and do not change useful output merely to satisfy it. Remove an unnecessary check without replacing it.

Use when for conditions, each for collections (add concurrency: N to run read-only items at once), repeat for bounded iteration, and after for required order without a data dependency.

Split operations when an intermediate check, independent retry, human decision, or external change requires a boundary. A separate reasoning stage does not by itself require a separate agent.

Check the model configuration before describing execution cost. A call with a direct API backend uses one request without tools. A coding-agent backend can start an agent process and use tools. Do not claim fewer agent processes from the step type alone.

# Contrasting design outlines

These are design outlines, not runnable Method files.

| Request | Design | Explanation |
| --- | --- | --- |
| Summarize supplied text | call → return summary | The model receives all source text. No additional task check is needed by default. Add a save step only if a saved file is requested. Use an agent if it must find or inspect additional sources. |
| Investigate a claim | agent to research and assess → return findings | Add a separate planning, checking, or saving step only when the task needs that boundary or result. A planning step does not require a task check merely because it returns structured data. When the user requires that the findings say only what the sources say, add an agent check on the assess step (method authoring recipes). |
| Route a message with human review for low confidence | classify → threshold run → conditional ask | Classification returns probabilities. Code applies the threshold. Human input resolves cases below the threshold. Add a separate action with an effect if the Method must send or change anything. |
| Send a daily summary email | call to write → run to send, with an effect | The send script puts METHOD_OPERATION_ID in the Message-ID. A mail.delivery effect searches the bounce mailbox through its own read-only connection until a 5-day horizon. A bounce fails the run; no bounce by the horizon is unrefuted, not proven. |

# First design proposal

In the first design proposal, state the intended result and material assumptions. List each step's execution type, purpose, and output. When the user has existing prompts, rubrics, or code that calls a model, list each one and the step that holds it. Explain any additional check you choose to add. Explain boundaries added for checks, retries, human decisions, or external changes.

State the expected model requests and agent processes when the configuration makes those counts known. Mark unknown counts as unknown.

Explain why tool-free model work uses call or why it requires an agent. Keep intermediate checks only when they serve a concrete task requirement.

Follow the user's requested approval process. A proposal does not create an additional approval requirement when implementation is already authorized.


Use method schema for field definitions, method authoring concepts for the format, method authoring execution for setup, and method COMMAND --help for command arguments.

# Example catalog

- [notes-summary](examples/notes-summary.md): The smallest complete Method: reads a folder of meeting notes, finds decisions and action items with one model call, and saves a summary file. The folder is observed automatically.
- [daily-briefing](examples/daily-briefing.md): Turns prepared records into a cited briefing website using an approved writing example, a source check, and rendering scripts.
- [social-briefing](examples/social-briefing.md): Researches a topic through Grok, alphaXiv, and LinkedIn in the browser, then writes a briefing with quotes and source links.
- [outbound-management](examples/outbound-management.md): Reads email and prospect sources, updates persistent CRM state, and saves daily tasks and outreach drafts for review.
- [message-routing](examples/message-routing.md): Classifies a customer message with Jev, then applies a script rule to choose a support destination.

After choosing the execution types and step boundaries, read complete examples that help implement the design with `method authoring example EXAMPLE_ID`. Read additional examples when needed. Use their syntax and relevant implementation details. Choose the steps for the current task independently.


# Method concepts

A method has format, name, goal, steps, result, and optional inputs, state, environment, and files.
Each step uses do or ask. The do kinds are run, call, agent, and classify. Script actions require name and purpose; script checks require reading.check. A classify action takes bound inputs, a question, and options, and returns a named choice with probabilities. Use a script to apply business rules to that result.
run uses runtime and entrypoint; call uses model and prompt; agent can select browser: environment.NAME and optional custom tools.
Optional run_label selects one saved text, number, or boolean value, such as inputs.topic or steps.prepare.outputs.plan.date. Step references must select a step without each or repeat. Choose a short non-sensitive value. The site uses the current Method's reference with each run's recorded inputs or outputs; absent or empty values keep timestamps. Set it with method set task.method /run_label --json '"steps.prepare.outputs.plan.date"'.

Optional run_prompt is plain text for the outside agent that starts a saved Method. Write which Method to run, where to find its inputs, and what to show when finished. Save it with the Method version and update it when inputs or outputs change. The copy button appends the exact version link and shared CLI setup; do not repeat them in run_prompt. This field is not a step prompt and does not expand variables. Set it with method set task.method /run_prompt --text-file run-prompt.txt.

Model and human prompts use {{date}} for the step input declared as in.date. Nested fields such as {{customer.name}} are allowed. Only text, numbers, and booleans can be inserted; pass lists and records as structured inputs. Whitespace inside braces is allowed. Escape a literal placeholder with a backslash before its opening braces (use a YAML block scalar). Values are inserted once, never evaluated or expanded again. Unknown variables, invalid paths, and non-scalar values fail validation. Missing runtime values fail before model execution. Defaults belong in input declarations. Human ask text uses the same scope; agent check prompts use {{inputs.date}} and {{outputs.answer}}. Script commands, labels, and tool descriptions are not templates. Single braces are ordinary text.
Runs record prompt.rendered with the template and expanded instructions for each invocation and phase; the run page shows the recorded expansion, with templates in technical details. Model and agent work uses finite default limits; steps can override them.
An optional step reading object explains inputs, outputs, condition, and check in plain text for the reading page. These descriptions do not alter execution. Describe the declared data and actual checks; keep them in sync when editing the step. The page always shows the exact do and check instructions as well. Give a separate executable check a short reading.check_name, such as “Compare saved text”, and use reading.check to explain what it checks. These fields change presentation only. Older checks without a name display “Check”. Do not imply that a file or reference check verifies facts, or add a check just to fill the display.
Inputs and outputs have a type. Script outputs require descriptions; other data descriptions are optional. Types: text, number, boolean, record, list, file. Records need fields; lists need items or fields. Files have path and sha256.
Online runs upload declared file outputs separately, up to 20,000 files and 100 MB total, with 25 MB per file. Hash-checked receipts let interrupted transfers resume with only missing files. The single-file inspect export retains its separate 20 MB compressed-data limit. For a website, declare format: method-website and write a JSON file {schema: "method-website/1", title, entrypoint, files: [{path, sha256, media_type}]}. Paths in the file list are relative to that file; list every asset and identify an HTML start page. The run page opens the website only when all listed assets are attached. It can also download the complete website as a ZIP. No workspace scan occurs. See docs/result-files.md and examples/website-result.method for the full contract and working example. method sync RUN_DIRECTORY uploads files without executing steps again.
Bind step inputs with in aliases and use named outputs as downstream references. These references set execution order. Use after for required order without a data reference, such as operations that share a browser session. Every output has one producer.
Checks use equals, count, present, file, a script, or a bounded agent. Checker output is {status: pass|fail|unknown, reason, evidence}. Unknown never passes.
Use changes for state.NAME or environment.NAME on a step that changes them; other steps need no changes field. State changes commit only after acceptance. State is saved in state.json.
Local files need nothing more. For a files connection in changes, the runtime reads the folder before and after the step and records the changed files. When the step returns a path inside that folder, that file must have changed, or the run fails ("the step said it saved weekly.md, but weekly.md did not change"). A step that has nothing to save may change nothing.
A change to anything else (a service, an API, email, a browser that sends) needs an effect: the intended result, and how to read it back. A receipt or a 200 status shows only that a request was accepted. A short effect for a JSON service:
  effects:
    saved:
      intent: The CRM has one contact with this email address.
      in: {email: inputs.email}
      observe: {kind: http, path: "/contacts?email={inputs.email}", expect: {fields: {count: 1}}}
The observer reads the connection that the step changes, read-only. in may use inputs and earlier steps' outputs, but not this step's own outputs. Other built-in observers: kind: file (expect exists, contains, sha256) and kind: sqlite (one read-only SELECT; expect rows; more rows than intended is a duplicate). Templates insert {inputs.ALIAS} and {token}, the action's METHOD_OPERATION_ID. Defaults: one reading at once, a 1-minute horizon, and positive proof. For mail and other slow systems, use a reviewed observer (method effect list) or set schedule: {first, then, horizon} and confirm: unrefuted_at_horizon. For systems without a built-in observer, write a script observer with a deterministic judge and fixtures.
A run fails when an observer finds that the change did not happen, and is unconfirmed (exit 3) when nothing confirms it by the horizon. Readings due within five minutes happen inside the run; schedule method observe --pending for later ones.
When nothing can or needs to observe a change, write no_effect_reason with one sentence instead, for example "Reads pages only; sends and posts nothing." for a browser step. The run report lists every waiver.
Use each for a collection, repeat for bounded iteration, when for a boolean condition, and after for dependencies. Each and repeat cannot be combined.
Add concurrency: N (1-32) to an each step to run up to N items at once, for example a classify or call over many records. The operator limit max_concurrency (default 8) caps it. The step cannot use ask, changes, or effects. Outputs keep item order; the first failure stops the other items, and resume runs only unfinished items. Raise max_invocations for collections over 100 items.
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

**Test later scripts before the expensive step.** A script after an agent or a
long call fails only after that work is done. Run each such script on a saved
input before a full run: pipe one JSON object, such as the step inputs in a
step.started event of events.jsonl, to the entrypoint on stdin. Check that the
result has exactly the declared out names. Keep one real or redacted input as a
test fixture beside the helpers. Add a case for each input that broke the script.

**Make recovery explicit.** For external writes, describe what a retry does and
declare the effect that confirms completion. Use a stable operation or business key when
the service supports duplicate prevention. Test decision boundaries and an
interruption after the service commits but before the script saves its receipt.

Example purpose: “Chooses Billing when Billing is the selected category and its
probability is at least 90%. Otherwise chooses Manual review. Returns the
destination and the rule used.”




# Execution setup


Use method run FILE_OR_ID [--config runtime.json] [--workspace HELPERS_FOLDER] [--inputs inputs.json] [--state state.json] [--run-dir DIR].
Classification uses the Method account. A classifier-only Method needs sign-in and network access, with no agent installation or provider key. To use your own Typesafe key instead, set TYPESAFE_API_KEY (or classification: {provider: typesafe, model: MODEL, api_key_env: NAME} in runtime.json); the run then calls Typesafe directly, needs no sign-in, and is not counted against the Method allowance. The SDK saves the pinned model before execution and reuses it on resume. Each invocation makes one request; uncertain answers complete normally. Questions and option descriptions are literal text. Bind JSON inputs through in or each, and use out: RESULT_NAME for the choice and probability record. There must be 2–255 options. Classifiers cannot receive declared files or declare changes.

Classification sends the step's declared inputs to Method and its classification provider. Method currently covers the cost within service limits. Saved runs contain the declared inputs and results.

Explicit named model profiles keep their settings. For an unconfigured profile, Method uses --agent, the configured default, the account's hosted model when this computer is signed in, the identified calling agent, or the sole available supported agent. A hosted model needs no key and no local agent; each account has a model credit, and the run summary reports usage.cost_usd. If a choice is needed, use --agent codex or --agent claude. The selected provider stays fixed on resume.
A simple local-agent Method needs no runtime.json. When needed, put runtime.json beside the Method. New saved versions carry their helpers and runtime.json. Older versions without saved files still need --workspace DIR. --config overrides that file. Relative files-environment paths and executable paths in configuration resolve from the config folder. A bare executable name is found on PATH.
Environment declarations name required connections. An agent with browser: environment.NAME receives the standard direct browser-use controls. Codex or Claude chooses the browser actions. Method opens the selected browser, retains its sign-ins privately, and reuses the session across steps. On macOS, Method copies your last-used Chrome profile and runs headless. Sign in through Chrome before running the Method. Run headless by default. If a task requires a visible browser, show it only for that task, then return to headless mode. Use method browser connect --cdp URL to attach to a Chrome session that permits control. Validation does not open a browser. Each run has a separate profile; resume reads the current page, not a saved web snapshot.
Operator config supplies runtimes, tools, environment, and run limits. Optional models.PROFILE: {backend: codex, model: MODEL} selects a model; omit model to use the Codex default. command can select the Codex executable and reasoning_effort can override its setting.
A models.PROFILE with backend: openai-responses, anthropic-messages, or openrouter-chat calls that provider's API directly, without an agent process. It requires model, api_key_env, and max_output_tokens; optional reasoning_effort (openai-responses, openrouter-chat) or effort (anthropic-messages). Use a direct profile for call steps and for agent steps with script tools. Keep key values out of the config; api_key_env names an existing environment variable, for example ANTHROPIC_API_KEY or OPENROUTER_API_KEY.
runtimes.PROFILE uses command, version, and optional args. Scripts and Codex require allow_local_processes: true. They are trusted local processes. A script receives the Method's declared secrets as environment variables; declare them under secrets: and supply values with method secret import or method secret set. A missing value stops the run before its first step.
Custom script tools declare description, in, out, run, and effects. List custom tools in the step and config. Browser controls are supplied automatically; interactive controls require changes: [environment.NAME]. Check tools cannot declare external effects.
Defaults: one hour per run, ten minutes per step, 100 model requests, 100 step invocations, 200 tool calls, 16 MiB for input and output, and 8 concurrent items per step. Step defaults allow 32 agent turns/model requests. Override run limits with timeout_ms, max_model_requests, max_invocations, max_tool_calls, max_output_bytes, max_request_bytes, max_concurrency. Method enforces the Codex process timeout, prompt/output size, and declared Method tool-call limit. max_model_requests governs direct API and classification requests; max_agent_turns governs the direct API agent loop; Codex manages its own internal requests and built-in tools. Codex usage and process logs are saved separately.
Declared tools are exposed to each Codex or Claude step through a temporary local MCP connection. It uses the same script execution and checks as the API path. Codex also retains the user's installed tools. Method does not sandbox these processes. No persistent Codex configuration is edited.
METHOD_OPERATION_ID identifies a script action or check within a run. It stays the same when that invocation is retried. Use it as the service’s idempotency key to prevent duplicate writes during recovery. Use a business key when duplicates must also be prevented across separate runs. Agent tools define duplicate prevention in their own contracts.

Scripts receive one JSON object on stdin and return one JSON object on stdout. Write artifacts under METHOD_OUTPUT_DIR. State updates are returned under state.
Save includes declared files, script and tool entrypoints, dependency lockfiles, and the runtime release. Run accepts a Method ID or dashboard URL and restores that version. Standard node and python runtimes are prepared automatically. Custom runtime settings stay explicit.
Use method inspect RUN_DIRECTORY --out inspection.json for a saved run; online runs sync to the same Method dashboard.
Use method bind ID NAME --file FOLDER to remember an input on this computer. Add --upload only to save that selected input folder privately in the account. Bundled examples stay in the version; day records stay separate.
Use method state ID --enable --file state.json to opt into shared account state. Concurrent runs cannot overwrite it. Account state is JSON; an uploaded SQLite input is a snapshot, not a shared database. Use a live service connection for a shared database. A stopped run keeps ownership until continued or explicitly released with method state ID --release RUN_ID after inspecting its actions.
CLI runs of local files and saved Methods have their own process. Use --background to return immediately, method run-status DIR, method wait DIR, or method cancel DIR. New runs accept package runtime versions explicitly tested by the installed SDK. The saved package stays unchanged; run records identify the executor used. Resume the same Method version and exact executor with --resume --run-dir DIR. Checkpoints without an executor version need their original SDK/runtime installation. Use method sync DIR to retry uploads without repeating work.

## Progress and result names

For live progress, native Codex forwards public updates as they arrive. Scripts use METHOD_PROGRESS_FD; run method progress --help for the message and child-agent relay protocol. Keep stdout for the final JSON result. Report real milestones without source passages or secrets. Quiet work still sends a five-second heartbeat; the page polls every three seconds. A heartbeat shows the executor is connected, not that new work has completed. See https://github.com/method-ai-hq/method-sdk/blob/main/docs/progress.md for complete examples.

Use reading.output_name to give a returned result a short, honest name. Use reading.outputs to explain its contents.


# Recipes

## Corrections become cases

When the user says a result was wrong:
1. Read the run (result.json, events.jsonl) and fix the Method. Run it again and show the user the new result.
2. If the user wants the fix to stay, ask once: "Keep this as a rule: <the rule in plain words>?"
3. On yes, record it: method case new FILE --id ID --run BAD_RUN --passing-run NEW_RUN --note "the user's words" --rubric "plain sentence that must be true" (repeat --rubric for each rule). --ref names the output to judge (default: the Method's result; a path to a file that the run saved is judged by that file's contents). When a rule compares the output with the sources, add --context with the step output that holds them, for example --context outputs.material. Make each sentence fail on the bad run; case new warns about one that does not. For an exact value, use --expect instead.
4. Run method test FILE. Every case must pass. method publish refuses a version that breaks a case.
For a one-time preference, edit and run again; a case is not needed.

## Checked on every run, or on every new version

A case checks future versions of the Method: method test and method publish run it. A check on a step checks every run, and a failed check stops the run before later steps (for example before the save), with the check's reason in the error. When the user wants something "checked every time", add a step check; when they also want the rule kept for future edits, add a case too. A check that the output says only what the sources say:
  check:
    kind: agent
    model: default
    prompt: |
      Sources:
      {{inputs.material}}

      Report:
      {{outputs.report}}

      Return fail if the report states any fact, number, or cause that the sources do not give.
  reading: {check_name: Only what the sources say, check: Fails when the report states something the sources do not give.}
Check prompts insert the step's inputs as {{inputs.NAME}} and its outputs as {{outputs.NAME}}. Never edit or delete a case to make a change pass. When a rule really changed, retire the old case: method case retire FILE ID --reason TEXT.

Use a script for exact file transforms and exports. Use a call for a structured model response. A direct API call is one request without tools; the Codex backend controls its own internal requests and tools. Use an agent only when bounded tool use is needed.
For incremental exports, keep a declared state ledger of source IDs and evidence hashes. Compare new evidence to that ledger and rebuild only changed days. Supply the prior run's state.json with --state for a new run.
Resume continues the same input set and saved version. A new run can collect new files. A separate database is optional application state, not a workaround required to resume Method.
To edit a failed method, read its exact saved version and logs, compare the current version, then save the complete repair with a reason.



# Recovery

For a stopped run, read summary.json, events.jsonl, and checkpoint.json. Resume with the original method, config, --run-dir DIR, and --resume. Accepted steps and iterations are reused.
An unfinished action needs --retry STEP:ITERATION after inspection of its external effects. A retry consumes the remaining run budget. Budgets do not reset on resume. Resume always uses the run's saved bundle, so a code fix needs a new run.
To fix a failed or wrong step, change it and run the Method again. The new run reuses every iteration whose step definition, inputs, model profile, tools, runtime, and (for script steps) bundle files match an earlier accepted run on this computer, and copies their declared file outputs. Steps with ask or effects, steps that change state or a service, and tools with effects are never reused. Use --rerun STEP to run a step again anyway, or --fresh to reuse nothing.
For ask, supply --human FILE containing {steps: {"STEP:ITERATION": {outputs: {NAME: VALUE}}}}. Use the user's actual answer. Checks still run.
For a stale .lock, first confirm the process has stopped. Never remove an active process lock.
State commits after checks. A local checkpoint cannot roll back an external write. Inspect external state before an explicit retry.
For a version conflict, get the latest version and apply the change there. For an uncertain upload, retry the same file and command with its sidecar unchanged.
Use method sync RUN_DIRECTORY to repair a dashboard upload without executing the method again.
New Methods use format method/3.3. Existing method/3.1 and method/3.2 documents retain their validation rules.
After a failed action with effects, the failure lists what the observers saw. A confirmed effect means the change happened: do not retry the action. A run that is unconfirmed finished all its steps; inspect effects.jsonl and the external system before relying on its result.


# Command reference

Local authoring commands edit draft files. A signed-in run saves a version when the file changed. publish marks a version for sharing. run also executes a saved version by ID.

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
Default topic: start, with the design procedure, contrasting design outlines, proposal requirements, concepts, and example catalog. Choose relevant examples after choosing the design. A named example prints its complete lesson and installed file paths. all prints the shared reference and catalog.

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
When a task check is needed, use an equals/count/present/file object, a run check, or an agent check. Put plain-English criteria in an agent check prompt.

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
The operation will have no additional task check. Remove unnecessary checks and their supporting tests and instructions. In method/3.3, external changes require effects (method effect add), not a check.

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

Read the format.

Usage:

```sh
method schema [method|config|step|data|environment|check]
```

Arguments and defaults:
Without a name: a short field reference, enough to write a Method. With a name: that JSON schema, for tools.

Result and changes:
Text, or JSON Schema.

Errors:
Unknown schema name.

Example:

```sh
method schema
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

## publish

Mark a version as published, for sharing, schedules, and deploys.

Usage:

```sh
method publish FILE [--reason TEXT] [--accept-failing-case ID[,ID]] [--server URL]
```

Arguments and defaults:
Runs the Method's cases first; a version that breaks an approved case is refused unless --accept-failing-case names it, and the version records that. Saves a version when the file changed since its last run, then marks it published with the reason (default: Published.). The first publish of a new file creates the Method.

Result and changes:
JSON with workflow_id, version_id, url, published_at, and the cases line.

Errors:
Invalid method, failing case, conflicting saved version, or no network.

Example:

```sh
method publish task.method --reason 'Shorter introduction'
```

## secret

Give this computer the values of a Method's declared secrets.

Usage:

```sh
method secret import FILE NAME...
method secret set NAME
method secret list [NAME...]
```

Arguments and defaults:
import copies the named values from a KEY=VALUE file that the user names, without printing them. set opens a private form on 127.0.0.1 in the browser for one value. list shows names and where each value is found (shell, this computer, or missing), never values. Values are kept in ~/.config/method/secrets.json (mode 0600) and are never sent to Method. A value exported in the shell is used first.

Result and changes:
JSON with the saved names, or the list.

Errors:
A name is missing from the file, or no value was entered.

Example:

```sh
method secret import ../service/.env ARCHIVE_TOKEN
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

Run a local .method file, or a saved Method by ID. When this computer is signed in, a run of a local file saves a version when the file changed and sends the run's records to the dashboard; without sign-in the records stay in .method-runs. Steps whose definition and inputs match an earlier accepted run on this computer are reused.

Usage:

```sh
method run FILE.method [OPTIONS]
method run WORKFLOW_ID [--version VERSION_ID] [--server URL] [OPTIONS]
```

Arguments and defaults:
Current methods optionally use runtime.json beside a local file, or in the current folder for a saved ID. --workspace selects a different folder. --config FILE overrides the config. See method authoring execution. Optional --state FILE initializes state for a new run. Resume with --resume --run-dir DIR; authorize unfinished work with --retry STEP:ITERATION.

--inputs FILE: JSON input values.
--run-dir DIR: the folder for this run's records (new runs too; default .method-runs/ID).
--agent codex|claude: select an agent for unconfigured profiles in a new run.
--resume: continue the same saved run with its saved agent.
--rerun STEP: run this step again even when an earlier run can be reused. Repeat for more steps.
--fresh: run every step; reuse nothing.
--human FILE: saved human answers for the current runtime.
--verbose: print runtime events.
Use method doctor to check the installed Node and configured tools.

Result and changes:
Progress and final status text; local result.json and run evidence; dashboard run link when synced. The runtime executes the method's declared scripts, calls, agents, and checks. Executes trusted local processes; changes declarations do not enforce permissions. Current runs exit 0 on completion, 1 on failure, 2 when human input is needed, and 3 when an observer could not confirm an external change (unconfirmed).

Errors:
Missing inputs/access, failed check, timeout, unsafe resume/version mismatch, upload failure. See recovery. Never retry a business write without inspecting its saved changes.

Example:

```sh
method run wf_example --version version_example --config runtime.json --workspace . --inputs inputs.json
```

## observe

Make the effect observations that are due for finished runs.

Usage:

```sh
method observe [RUN_DIRECTORY...] [--pending ROOT]... [--config FILE]
```

Arguments and defaults:
Without directories, checks runs with open effects under .method-runs and the Method cache. Runs only observers and judges; never repeats an action. Schedule it, for example hourly, so late evidence such as a bounce reaches the run.

Result and changes:
JSON with each run's new verdicts, status, and next observation time. A synced run whose status changed is uploaded again.

Errors:
Locked run, changed bundle, or a missing observer credential.

Example:

```sh
method observe --pending .method-runs
```

## test

Replay recorded cases against this version of a Method. Every case must pass.

Usage:

```sh
method test FILE [--case ID]... [--baseline OLD_FILE] [--new ID]... [--cases DIR] [--agent codex|claude]
```

Arguments and defaults:
Cases are in cases/ beside the Method. Unchanged steps return their recorded outputs; changed steps run; files connections are scratch folders, so a changed step that writes files runs safely. A changed step that asks a person or acts on a service makes the case unverifiable. --baseline also runs each case on the old version, to show what the change fixed or broke.

Result and changes:
JSON report with a verdict per case and passed:true when no case blocks the change. Exit 0 or 1.

Errors:
Unknown case, invalid Method, or setup errors.

Example:

```sh
method test task.method --baseline task-before.method --new bounce-reported
```

## case

Keep a correction as a recorded case that every later version must pass.

Usage:

```sh
method case new|retire|list FILE ...
```

Arguments and defaults:
Use method help case new, method help case retire, or method help case list.

Result and changes:
See the subcommand.

Errors:
Unknown action. Choose new, retire, or list.

Example:

```sh
method help case new
```

## case new

Turn a correction into a recorded case.

Usage:

```sh
method case new FILE --id ID --note TEXT (--run BAD_RUN | --passing-run GOOD_RUN | both) (--rubric SENTENCE... | --expect FILE) [--ref outputs.NAME] [--context REF]... [--agent codex|claude]
```

Arguments and defaults:
--run is the run that went wrong; the case must fail on it. --passing-run is the run the person accepted after the fix; the case must pass on it. With only --passing-run, the case pins behaviour that is already right. --rubric is a plain sentence that must be true of the output (repeatable); a model judges it with quotes. --ref selects the output to judge; the default is the Method's result. --context REF gives the judge other values to check against, such as the sources or the person's words (outputs.NAME or inputs.NAME); they are read, not judged. --expect FILE gives exact checks instead: {kind: equals, ref: outputs.NAME, value}, {kind: status, in: [STATUS]}, {kind: effect, effect: STEP/ITERATION/NAME, verdict: [VERDICT]}, or {kind: predicate, runtime: node, entrypoint: check.mjs}. --redact FILE maps recorded text to replacements. Cases from sensitive/ are refused.

Result and changes:
The saved case, with its result on each run. A case that the bad run already meets is refused: it does not capture the problem, or the note does not match the run.

Errors:
A case that does not fail on the bad run, or does not pass on the passing run; an existing ID; an unreadable run.

Example:

```sh
method case new report.method --id sources-named --run .method-runs/bad --passing-run .method-runs/fixed --note 'Say which source backs each point.' --rubric 'Every point names the source file that supports it.'
```

## case retire

Retire a case whose rule no longer applies.

Usage:

```sh
method case retire FILE ID --reason TEXT [--by NEW_ID]
```

Arguments and defaults:
The case stays on disk with its reason and is no longer run. Use it when a policy changed, not to make a failing change pass.

Result and changes:
JSON {retired}.

Errors:
Unknown or already retired case.

Example:

```sh
method case retire task.method old-terms --by new-terms --reason 'Payment terms changed on 1 October.'
```

## case list

List the cases of a Method.

Usage:

```sh
method case list FILE
```

Arguments and defaults:
Reads cases/ beside the Method unless --cases DIR is given.

Result and changes:
JSON list of cases with status and note.

Example:

```sh
method case list task.method
```

## effect

Use a reviewed observer for an external change.

Usage:

```sh
method effect add|list ...
```

Arguments and defaults:
Use method help effect add or method help effect list.

Result and changes:
See the subcommand.

Errors:
Unknown action. Choose add or list.

Example:

```sh
method effect list
```

## effect add

Declare an effect with a reviewed observer.

Usage:

```sh
method effect add FILE STEP NAME --observer OBSERVER [--connection NAME] [--in ALIAS=REF]... [--set KEY=VALUE]... [--intent TEXT] [--horizon DURATION] [--blocking]
```

Arguments and defaults:
Copies the observer, its judge, and its fixtures into observers/ beside the Method, adds the observer connection with role: observer, and sets the effect. --set fills observer settings. For files, SQLite databases and JSON services, write a built-in observer (kind: file, sqlite, or http) in the step instead. The step must already declare the changed connection in changes. Read the printed setup for the observer's credential.

Result and changes:
The edited workflow and the observer's setup instructions. Sets format method/3.3.

Errors:
Unknown observer, missing --in binding, or a step without an external change.

Example:

```sh
method effect add task.method send_summary delivered --observer mail.delivery --in to=inputs.ap_lead
```

## effect list

List the reviewed observers.

Usage:

```sh
method effect list
```

Arguments and defaults:
No arguments.

Result and changes:
JSON list of observers and what they need.

Example:

```sh
method effect list
```
