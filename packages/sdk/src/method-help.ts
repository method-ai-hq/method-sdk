import { authoringEntryRule, designProcedure, designExamples, proposalRequirements } from "./authoring-instructions.js";
export { exampleSelection } from "./authoring-instructions.js";
import { exampleCatalog, renderExample } from "./authoring-example.js";

type Command = { usage: string; purpose: string; arguments: string; result: string; errors: string; example: string; remote?: boolean };
const edited = "JSON {file, workflow}. The workflow field contains the method. Writes the local draft.";
const commonErrors = "File commands require readable YAML or JSON. Editing commands report draft locks and leave the original file unchanged after a failed edit. Online commands require sign-in and network access. Use method authoring recovery for conflicts and interrupted saves.";
const valueFlags = "Use exactly one: --json JSON, --value-file FILE (YAML or JSON), --text TEXT, --text-file FILE (UTF-8 text). Prefer files for long text.";
export const commandHelp: Record<string, Command> = {
  'browser connect': {usage:'method browser connect [--name NAME] [--cdp URL]',purpose:'Select a private browser connection.',arguments:'NAME defaults to default. --cdp attaches to a Chrome session that permits remote control. Without --cdp, Method runs headless. On macOS it copies your last-used Chrome profile to reuse sign-ins. Use method-browser:NAME for a named browser binding.',result:'Saves the browser selection on this computer. No browser is started by this command.',errors:'Invalid name or endpoint. Credentials must not be in the URL.',example:'method browser connect'},
  deploy: {usage:'method deploy --from-run RUN_DIRECTORY\nmethod deploy --approve DEPLOYMENT_ID\nmethod deploy --run DEPLOYMENT_ID [--inputs FILE] [--resume RUN_ID]\nmethod deploy --login DEPLOYMENT_ID [--agent codex|claude]',purpose:'Prepare and approve a runner from a successful run, then run it with new inputs.',arguments:'Preparation uses the selected Method runner and shows its files, inputs, state, and account scope. Approval applies that exact plan and checks access. Writable folders are copied once into persistent runner storage; local originals remain unchanged. --run starts a separate business run. --resume continues an existing runner run with the same inputs.',result:'Prepared review and approval command, or readiness and run command. Missing website sign-ins return a local viewer. Missing agent access returns a runner login command. Both continue the same deployment. Preparation transfers no user data. Session state stays outside the Method package and image.',errors:'Changed files, missing runner access, unsupported local dependencies, or missing completed-run file records. Missing setup exits 2.',example:'method deploy --from-run .method-runs/completed'},
  doctor: {usage:"method doctor [--config FILE] [--agent codex|claude]",purpose:"Check Node and configured runtime access without running a Method.",arguments:"A script-only configuration does not require an agent. Without config, check the selected local agent. Use validate FILE for the Method's own dependencies.",result:"Setup findings; no task execution.",errors:"Missing executable, credentials, or provider choice.",example:"method doctor --config runtime.json"},
  inspect: {usage:"method inspect RUN_DIRECTORY --out FILE",purpose:"Export saved execution evidence.",arguments:"Use a new output file. --include-files attaches declared result files.",result:"Saved inspection JSON.",errors:"Missing run or existing output.",example:"method inspect runs/example --out inspection.json"},
  prompt: {usage:"method prompt FILE",purpose:"Read the document as instructions.",arguments:"Current Method file.",result:"Text; no execution.",errors:"Invalid document.",example:"method prompt task.method"},
  bind: {usage:"method bind ID NAME (--file FOLDER | --connection URL) [--upload]",purpose:"Save a named input location or connection.",arguments:"Default: this computer only. --upload saves only the selected input folder or connection URL in the account. It never scans your disk. Keep credentials in the service's normal sign-in store.",result:"Saved binding and scope.",errors:"Missing input, invalid name, or unsafe path.",example:"method bind METHOD_ID prepared_day --file day-records --upload",remote:true},
  state: {usage:"method state ID [--enable --file state.json | --release RUN_ID]",purpose:"Read or explicitly enable shared account state.",arguments:"Accepted state updates use revision checks. Inspect a stopped run's external actions before releasing its ownership.",result:"Current revision, value, and owner run.",errors:"Concurrent ownership or stale revision. Existing state is never silently overwritten.",example:"method state METHOD_ID --enable --file initial-state.json",remote:true},
  wait: {usage:"method wait RUN_DIRECTORY",purpose:"Reconnect to the same local worker.",arguments:"Use the directory returned by run. Closing this output connection leaves the worker active.",result:"Live output and final worker status.",errors:"Stopped process or missing run.",example:"method wait .runs/example"},
  'run-status': {usage:"method run-status RUN_DIRECTORY",purpose:"Read worker status without waiting.",arguments:"Local run directory.",result:"Worker status and whether its process is active.",errors:"Unreadable run directory.",example:"method run-status .runs/example"},
  cancel: {usage:"method cancel RUN_DIRECTORY",purpose:"Stop a local run process.",arguments:"Inspect uncertain external actions before any explicit retry.",result:"Cancellation request. The checkpoint remains available.",errors:"Unreadable run directory.",example:"method cancel .runs/example"},
  progress: { usage: "method progress --message TEXT [--completed N --total N --unit NAME] [--child NAME]\nmethod progress --codex --child NAME", purpose: "Report public progress from a running script or relay a child Codex JSON stream.", arguments: "METHOD_PROGRESS_FD is supplied by the executor. --codex reads JSON lines from stdin; --message sends one message. Do not include secrets or source contents.", result: "Writes to the separate progress pipe. No stdout output. No-op outside a Method process.", errors: "Invalid arguments. Malformed Codex events are ignored.", example: "method progress --message 'Rendered 12 of 40 pages' --completed 12 --total 40 --unit pages" },
  authoring: { usage: "method authoring [start|concepts|execution|examples|recipes|recovery|commands|all]\nmethod authoring example EXAMPLE_ID", purpose: "Read the installed authoring guide. Available offline.", arguments: "Default topic: start, with the design procedure, contrasting design outlines, proposal requirements, concepts, and example catalog. Choose relevant examples after choosing the design. A named example prints its complete lesson and installed file paths. all prints the shared reference and catalog.", result: "Markdown text on stdout. No changes.", errors: "Unknown topic: lists the valid topics; exit 1.", example: "method authoring all > method-guide.md" },
  init: { usage: "method init FILE --name NAME --goal TEXT", purpose: "Create a local YAML draft.", arguments: "File must be new. Name and goal are required. The draft starts with an empty steps map and result map.", result: edited, errors: "Missing name or goal; file or sidecar already exists.", example: "method init task.method --name 'Find leads' --goal 'Find qualified leads from the specified sources.'" },
  show: { usage: "method show FILE [--path POINTER]", purpose: "Read a draft or one field.", arguments: "Default: the full document. Pointer example: /steps/search/do.", result: "Selected value as JSON. No changes.", errors: "The selected field does not exist.", example: "method show task.method --path /steps/search" },
  set: { usage: "method set FILE POINTER (--json JSON|--value-file FILE|--text TEXT|--text-file FILE)", purpose: "Add or replace one draft field.", arguments: valueFlags + " Parents must exist. An empty pointer replaces the document. Escape / as ~1 and ~ as ~0. Nested values replace in full.", result: edited, errors: "Invalid pointer, missing parent field, or conflicting value flags.", example: "method set task.method /steps/search/do/prompt --text-file search.txt" },
  remove: { usage: "method remove FILE POINTER", purpose: "Remove one draft field.", arguments: "The field must exist. Repair remaining references before saving.", result: edited, errors: "The selected field does not exist.", example: "method remove task.method /steps/search/each" },
  "step add": { usage: "method step add FILE --id ID --value-file STEP.yaml", purpose: "Add a complete operation.", arguments: "Supply do or ask and the bindings and outputs needed by the step in STEP.yaml. Script actions require name and purpose, and their outputs require descriptions. Script checks require reading.check. Checks and limit overrides are optional. Alternatively use --kind run --runtime PROFILE --entrypoint FILE. Agents can use --kind agent --instructions-file FILE; the default is the calling coding agent.", result: edited, errors: commonErrors, example: "method step add task.method --id copy --value-file copy.yaml" },
  "step update": { usage: "method step update FILE STEP_ID (--json JSON|--value-file FILE)", purpose: "Change fields of an existing step.", arguments: "Supply an object of fields. Top-level fields merge; nested values replace in full. Use remove to delete a field.", result: edited, errors: "Unknown step or invalid step fields.", example: "method step update task.method search --value-file search.yaml" },
  "step remove": { usage: "method step remove FILE STEP_ID", purpose: "Remove an operation.", arguments: "Repair references to its outputs and after constraints before saving.", result: edited, errors: "The selected step does not exist.", example: "method step remove task.method old_search" },
  "step move": { usage: "method step move FILE STEP_ID --before OTHER_ID", purpose: "Change display order.", arguments: "Both steps must exist. Data references and after still control execution order.", result: edited, errors: "The selected step or destination does not exist.", example: "method step move task.method search_exa --before search_bookface" },
  "check set": { usage: "method check set FILE STEP_ID (--json JSON|--value-file FILE)", purpose: "Set the operation's independent check.", arguments: "Current methods require an equals/count/present/file object, a run check, or an agent check. Put plain-English criteria in an agent check prompt.", result: edited, errors: "Unknown step, invalid check, or conflicting value flags.", example: "method check set task.method search --value-file check.yaml" },
  "check remove": { usage: "method check remove FILE STEP_ID", purpose: "Remove the operation's check.", arguments: "The operation will be unchecked. External changes require a check.", result: edited, errors: "The selected step does not exist.", example: "method check remove task.method copy" },
  check: { usage: "method check set|remove ...", purpose: "Edit an operation's check.", arguments: "Use method check set --help for arguments.", result: edited, errors: "Unknown action. Choose set or remove.", example: "method check set --help" },
  validate: { usage: "method validate FILE [--config FILE] [--workspace DIR]", purpose: "Check the definition and local setup without running the work.", arguments: "Checks data, names, dependencies, templates, declared files, executables, environment variables, runtime profiles and tool bindings. Defaults to runtime.json beside the Method. --workspace selects the helper folder and default config folder. Relative paths in config resolve from the config folder.", result: "JSON reports definition, local_setup, executed:false, and valid. Invalid definitions or missing declared files exit 1. Managed setup is reported separately as needs_preparation; run prepares it.", errors: "The error identifies the invalid field or reference.", example: "method validate task.method" },
  diff: { usage: "method diff FILE OTHER_FILE", purpose: "Compare two documents.", arguments: "Both files required. Values are compared after parsing YAML or JSON.", result: "JSON array of {path,before?,after?}. Empty means equal; exit 0 either way.", errors: "Both file paths are required.", example: "method diff original.method task.method" },
  schema: { usage: "method schema [method|config|step|data|environment|check]", purpose: "Read the machine-readable grammar.", arguments: "Default: method. Use authoring concepts for meaning and authoring recipes for examples.", result: "JSON Schema for tooling. Data declarations in methods use the six simple types.", errors: "Unknown schema name.", example: "method schema step" },
  create: { usage: "method create --file FILE [--request-id UUID] [--server URL]", purpose: "Save a complete local draft as a new online method.", arguments: "--file required. Request ID defaults to a new UUID and is saved before upload. The draft must not already belong to an online method. Validation runs before upload.", result: "JSON with workflow_id, version_id, version_number, server and url. Writes FILE.method.json.", errors: "Invalid method; linked draft; conflicting request ID; pending save with changed contents. See recovery for an uncertain upload.", example: "method create --file message.method", remote: true },
  get: { usage: "method get WORKFLOW_ID [--version VERSION_ID] [--out FILE] [--server URL]", purpose: "Read an online method; optionally make a local draft for editing.", arguments: "Default: latest version. --out must name a new file with no existing .method.json. Use a version ID to read an exact saved version.", result: "Without --out: {workflow_id,version_id,version_number,workflow}. With --out: {workflow_id,version_id,version_number,file}; writes the workflow and FILE.method.json.", errors: "Missing method or version; output file or sidecar already exists.", example: "method get wf_example --out edit.method", remote: true },
  save: { usage: "method save FILE [--reason TEXT] [--request-id UUID] [--server URL]", purpose: "Save a draft as one online version.", arguments: "New draft: creates a method. Linked draft: --reason required, base version and destination read from FILE.method.json. --request-id is used for first creation; retained pending ID wins on retry. Default server comes from the sidecar, then the online default.", result: "JSON with workflow_id, version_id, server, url, confirmed:true and document_sha256 after reading back the exact saved version; confirmed saves also include version_number. Updates FILE.method.json. Unchanged draft: unchanged:true, no new version.", errors: "Invalid method; missing reason; pending changed payload; wrong server; stale base (409). See recovery before retrying.", example: "method save edit.method --reason 'Give each output a clear description.'", remote: true },
  update: { usage: "method update WORKFLOW_ID --file FILE --base-version VERSION_ID --reason TEXT [--server URL]", purpose: "Save a full method against an explicit base version.", arguments: "All listed non-server arguments required. Prefer get --out and save for normal editing. This lower-level command does not read or update the local sidecar. It validates the whole document.", result: "JSON {version_id,version_number}. Creates an online version. After success, use get --out NEW_FILE for further edits.", errors: "Stale base (409); invalid method; missing reason. A repeated update returns the saved version only when parent, contents and reason still match the latest version.", example: "method update wf_example --file edit.method --base-version version_example --reason 'Clarify the query.'", remote: true },
  status: { usage: "method status [--server URL]", purpose: "Check installation and sign-in without listing Methods or starting login.", arguments: "No required arguments. Checks the selected server with the current credential when one exists.", result: "JSON {installed:true,server,signed_in}. A missing or expired credential returns signed_in:false. Does not print account details.", errors: "Network and server errors exit 1; they are not reported as signed out.", example: "method status", remote: true },
  list: { usage: "method list [--server URL]", purpose: "Find your online methods.", arguments: "No required arguments.", result: "Server JSON containing methods. No changes.", errors: "", example: "method list", remote: true },
  steps: { usage: "method steps WORKFLOW_ID [--version VERSION_ID] [--server URL]", purpose: "Read all complete step definitions in a saved method.", arguments: "Default: latest version. Use step with two IDs to read one saved step.", result: "JSON {version_id,steps}. No changes.", errors: "Missing method or version.", example: "method steps wf_example", remote: true },
  step: { usage: "method step WORKFLOW_ID STEP_ID [--version VERSION_ID] [--server URL]", purpose: "Read one online step. For local edits use step add/update/remove/move.", arguments: "Both IDs required. Default: latest version. Subcommand words add, update, remove, move are reserved for local editing.", result: "JSON {version_id,step}. No changes.", errors: "Missing method, version, or step. Use method steps to find step IDs.", example: "method step wf_example search", remote: true },
  login: { usage: "method login [--server URL]", purpose: "Connect this computer with browser approval.", arguments: "No credentials in chat or command flags. Method opens the sign-in/approval page and waits. Connection is saved per server in ~/.config/method. Sign in again if access expires or is revoked.", result: "Sign-in instructions and status text. Stores a private local credential after approval. Remote commands also start login when no credential exists.", errors: "Approval expired, denied, or network unavailable. Repeat login when ready.", example: "method login", remote: true },
  logout: { usage: "method logout [--server URL]", purpose: "Disconnect this computer from the selected Method server.", arguments: "No required arguments. Select the same server used for login.", result: "Status text. Revokes remote access, then removes the local credential.", errors: "If remote revocation fails, the local credential remains. Retry online, or use devices/revoke from another connected computer.", example: "method logout", remote: true },
  devices: { usage: "method devices [--server URL]", purpose: "List authorized computers.", arguments: "No required arguments.", result: "Server JSON device list. No changes.", errors: "", example: "method devices", remote: true },
  revoke: { usage: "method revoke DEVICE_ID [--server URL]", purpose: "Revoke a computer's Method access.", arguments: "Use the exact ID from method devices. This changes account access.", result: "Server JSON confirmation. The selected device can no longer use that credential.", errors: "Unknown device ID.", example: "method revoke device_example", remote: true },
  runs: { usage: "method runs [--method WORKFLOW_ID] [--server URL]", purpose: "Read saved run summaries.", arguments: "Default: all methods. --method filters the list.", result: "Server JSON containing runs. No changes.", errors: "", example: "method runs --method wf_example", remote: true },
  logs: { usage: "method logs RUN_ID [--server URL]", purpose: "Read saved run evidence before a repair.", arguments: "Use a run ID from method runs. Saved logs may be incomplete if upload failed.", result: "Server JSON containing the run, inputs, outputs, checks and events. No execution or changes.", errors: "Missing run.", example: "method logs run_example > run.json", remote: true },
  sync: { usage: "method sync RUN_DIRECTORY [--server URL]", purpose: "Retry upload of records from an existing local run.", arguments: "Directory must contain method-sync.json. Default destination is the saved run's server. Do not use a new business run to repair an upload.", result: "Upload status text. Updates dashboard records and local sync metadata. Does not execute steps.", errors: "Missing run/sync records; access or network error. Keep the original run directory and retry.", example: "method sync .method-runs/wf_example/saved-run", remote: true },
  run: { usage: "method run WORKFLOW_ID [--version VERSION_ID] [--server URL] [OPTIONS]", purpose: "Execute a saved method locally and upload its run records.", arguments: `Current methods optionally use runtime.json beside a local file, or in the current folder for a saved ID. --workspace selects a different folder. --config FILE overrides the config. See method authoring execution. Optional --state FILE initializes state for a new run. Resume with --resume --run-dir DIR; authorize unfinished work with --retry STEP:ITERATION.

--inputs FILE: JSON input values.
--run-dir DIR: saved run folder.
--agent codex|claude: select an agent for unconfigured profiles in a new run.
--resume: continue the same saved run with its saved agent.
--human FILE: saved human answers for the current runtime.
--verbose: print runtime events.
Use method doctor to check the installed Node and configured tools.`, result: "Progress and final status text; local result.json and run evidence; dashboard run link when synced. The runtime executes the method's declared scripts, calls, agents, and checks. Executes trusted local processes; changes declarations do not enforce permissions. Current runs exit 0 on completion, 1 on failure, and 2 when human input is needed.", errors: "Missing inputs/access, failed check, timeout, unsafe resume/version mismatch, upload failure. See recovery. Never retry a business write without inspecting its saved changes.", example: "method run wf_example --version version_example --config runtime.json --workspace . --inputs inputs.json", remote: true },
};


const exitHelp = "Success exits 0. Errors exit 1 with text on stderr, unless the command specifies another result.";
const serverHelp = "Server: https://app.withmethod.ai by default. --server selects another server and its login.";

export function renderCommand(name: string, includeCommon = true): string {
  const entry = commandHelp[name];
  if (!entry) throw Error(`Unknown command '${name}'. Use method authoring commands.`);
  return `## ${name}\n\n${entry.purpose}\n\nUsage:\n\n\`\`\`sh\n${entry.usage}\n\`\`\`\n\nArguments and defaults:\n${entry.arguments}\n\nResult and changes:\n${entry.result}${entry.errors ? `\n\nErrors:\n${entry.errors}` : ""}\n\nExample:\n\n\`\`\`sh\n${entry.example}\n\`\`\`\n` + (includeCommon ? `\n${entry.remote ? serverHelp + "\n" : ""}${exitHelp}\n\nCommon errors:\n${commonErrors}\n` : "");
}

const start = `# Author with Method

Build a Method for the user's repeated work.

${designProcedure}
${designExamples}
${proposalRequirements}

Validate with method validate task.method, save with method save task.method, then run the returned version with method run WORKFLOW_ID --version VERSION_ID. Inspect the result and its links.

Use method schema for field definitions, method authoring execution for setup, and method COMMAND --help for command arguments.
`;
const concepts = `# Method concepts

A method has format, name, goal, steps, result, and optional inputs, state, environment, and files.
Each step uses do or ask. The do kinds are run, call, agent, and classify. Script actions require name and purpose; script checks require reading.check. A classify action takes bound inputs, a question, and options, and returns a named choice with probabilities. Use a script to apply business rules to that result.
run uses runtime and entrypoint; call uses model and prompt; agent can select browser: environment.NAME and optional custom tools.
Optional run_label_input names one text, number, or boolean input that identifies a run, such as date or topic. Choose a short non-sensitive value. The site uses the current Method's choice with each run's recorded inputs; absent or empty values keep timestamps. Set it with method set task.method /run_label_input --json '"date"'.

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

`;
const execution = `
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
`;
const recipes = `# Recipes

Use a script for exact file transforms and exports. Use a call for a structured model response. A direct API call is one request without tools; the Codex backend controls its own internal requests and tools. Use an agent only when bounded tool use is needed.
For incremental exports, keep a declared state ledger of source IDs and evidence hashes. Compare new evidence to that ledger and rebuild only changed days. Supply the prior run's state.json with --state for a new run.
Resume continues the same input set and saved version. A new run can collect new files. A separate database is optional application state, not a workaround required to resume Method.
To edit a failed method, read its exact saved version and logs, compare the current version, then save the complete repair with a reason.
`;
const recovery = `# Recovery

For a stopped run, read summary.json, events.jsonl, and checkpoint.json. Resume with the original method, config, --run-dir DIR, and --resume. Accepted steps and iterations are reused.
An unfinished action needs --retry STEP:ITERATION after inspection of its external effects. A retry consumes the remaining run budget. Budgets do not reset on resume. Changed methods or config require a new run.
For ask, supply --human FILE containing {steps: {"STEP:ITERATION": {outputs: {NAME: VALUE}}}}. Use the user's actual answer. Checks still run.
For a stale .lock, first confirm the process has stopped. Never remove an active process lock.
State commits after checks. A local checkpoint cannot roll back an external write. Inspect external state before an explicit retry.
For a save conflict, get the latest version and apply the change there. For an uncertain upload, retry the same file and command with its sidecar unchanged.
Use method sync RUN_DIRECTORY to repair a dashboard upload without executing the method again.
New Methods use format method/3.2. Existing method/3.1 documents retain their validation rules.
`;

export const guideTopics = ["start", "concepts", "execution", "examples", "example", "recipes", "recovery", "commands"] as const;
export function authoringGuide(topic = "start", exampleId?: string): string {
  if (exampleId && topic !== 'example') throw Error('Use method authoring example EXAMPLE_ID.');
  const catalog = () => exampleCatalog();
  const topics: Record<string, () => string> = {
    start: () => start + '\n' + concepts + '\n' + catalog(), concepts: () => concepts,
    execution: () => execution, examples: catalog,
    example: () => exampleId ? renderExample(exampleId) : catalog(),
    recipes: () => recipes, recovery: () => recovery,
    commands: () => '# Command reference\n\nLocal authoring commands edit draft files. create, save and update publish Method versions. run executes a saved version.\n\n' + serverHelp + '\n' + exitHelp + '\n\nCommon errors:\n' + commonErrors + '\n\n' + Object.keys(commandHelp).map(name => renderCommand(name, false)).join('\n'),
  };
  if (topic === 'all') return ['start','execution','recipes','recovery','commands'].map(key => topics[key]!()).join('\n\n');
  if (!topics[topic]) throw Error(`Unknown authoring topic '${topic}'. Choose ${guideTopics.join(', ')}, or all.`);
  return topics[topic]!();
}

export const overviewHelp = `Method — author, save and run methods with your coding agent.

${authoringEntryRule}

Learn: method authoring                 Start the installed guide.
       method authoring all             Read the full manual offline.
       method COMMAND --help            Read arguments, results and examples.
       method help step add             Read help for a subcommand.
       method schema [TYPE]             Read a formal JSON schema.

Local drafts: init, show, set, remove, step add/update/remove/move,
              check set/remove, validate, diff.
Online documents: list, get, steps, step, create, save, update.
Execution and evidence: run, run-status, wait, cancel, runs, logs, sync.
Inputs and shared state: bind, state.
Browser and runner setup: browser connect, deploy.
Account access: status, login, logout, devices, revoke.

Read the authoring guide, choose the execution types and boundaries, consult relevant examples, write the files, validate, save, and inspect an agreed sample run.
Use method run task.method to run with runtime.json beside the Method.
Online server: https://app.withmethod.ai. Use --server only to select another
server. Sign-in uses browser approval. Never send credentials in chat.
`;

/** Resolve help before parsing flags, creating a client, or touching any draft. */
export function methodHelp(args: string[]): string | undefined {
  if (!args.length) return overviewHelp;
  const explicit = args[0] === "help";
  if (!explicit && !args.includes("--help")) return undefined;
  const words = explicit ? args.slice(1) : args;
  const command = words[0];
  if (!command || command === "--help") return overviewHelp;
  const key = [command, words[1]].join(" ");
  return renderCommand(commandHelp[key] ? key : command);
}

/** The CLI and published reference use this same command inventory. */
export function commandTable(): string {
  return '| Command | Purpose |\n| --- | --- |\n' + Object.entries(commandHelp).map(([name, help]) => `| \`${name}\` | ${help.purpose} |`).join('\n');
}
