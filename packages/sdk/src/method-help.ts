import { authoringEntryRule, designProcedure, designExamples, checkRules, firstMethodRules, fieldReference, promptRules, watchRules, afterRules, costRules } from "./authoring-instructions.js";
export { exampleSelection } from "./authoring-instructions.js";
import { exampleCatalog, renderExample } from "./authoring-example.js";

type Command = { usage: string; purpose: string; arguments: string; result: string; errors: string; example: string; remote?: boolean };
const edited = "JSON {file, workflow}. The workflow field contains the method. Writes the local draft.";
const commonErrors = "File commands require readable YAML or JSON. Editing commands leave the original file unchanged after a failed edit. Online commands require sign-in and network access. Use method authoring recovery for conflicts and interrupted saves.";
const valueFlags = "Use exactly one: --json JSON, --value-file FILE (YAML or JSON), --text TEXT, --text-file FILE (UTF-8 text). Prefer files for long text.";
export const commandHelp: Record<string, Command> = {
  'browser connect': {usage:'method browser connect [--name NAME] [--cdp URL]',purpose:'Select a private browser connection.',arguments:'NAME defaults to default. --cdp attaches to a Chrome session that permits remote control. Without --cdp, Method runs headless. On macOS it copies your last-used Chrome profile to reuse sign-ins. Use method-browser:NAME for a named browser binding.',result:'Saves the browser selection on this computer. No browser is started by this command.',errors:'Invalid name or endpoint. Credentials must not be in the URL.',example:'method browser connect'},
  doctor: {usage:"method doctor [--agent codex|claude]",purpose:"Check Node and the local agent without running a Method.",arguments:"Checks the agent from --agent, the computer setting (method config agent), or the one installed agent. Use validate FILE for the Method's own dependencies.",result:"Setup findings; no task execution.",errors:"Missing executable, credentials, or provider choice.",example:"method doctor --agent codex"},
  inspect: {usage:"method inspect RUN_DIRECTORY --out FILE",purpose:"Export saved execution evidence.",arguments:"Use a new output file. --include-files attaches declared result files.",result:"Saved inspection JSON.",errors:"Missing run or existing output.",example:"method inspect runs/example --out inspection.json"},
  prompt: {usage:"method prompt FILE",purpose:"Print the Method as plain-text instructions.",arguments:"Current Method file.",result:"Text; no execution.",errors:"Invalid document.",example:"method prompt task.method"},
  config: {usage:"method config [agent codex|claude|none]\nmethod config model-key [--off]",purpose:"Show or change this computer's settings.",arguments:"Settings live in ~/.config/method/computer.json (private): agent (run every model step with a local agent), bindings (method bind), and model_key_env. model-key imports OPENROUTER_API_KEY from the one nearby key file that holds it, or else opens a private browser form for it (the value stays in this computer's secret store), and then sends every hosted model step and every classify step on this computer to OpenRouter with your key, in place of the account's model credit; the run prints Using your own OpenRouter key. Your OpenRouter account's privacy settings then apply. --off goes back to the account. Run limits belong to the Method (limits:). Nothing goes into a Method file.",result:"The settings, or one line.",errors:"Unknown setting or agent.",example:"method config model-key"},
  "new-id": {usage:"method new-id FILE",purpose:"Make a copied Method file a new Method.",arguments:"Writes a new id: line. A copy that keeps its id: saves to the same Method.",result:"JSON with file and method_id.",errors:"Missing file.",example:"method new-id copy.method"},
  bind: {usage:"method bind FILE_OR_ID NAME (--file FOLDER | --connection URL) [--upload]",purpose:"Save a named input location or connection.",arguments:"Default: this computer only, in ~/.config/method/computer.json under the Method's ID (a FILE gets its id: line). A folder named NAME beside the Method needs no binding. --upload saves only the selected input folder or connection URL in the account. It never scans your disk. Keep credentials in the service's normal sign-in store.",result:"Saved binding and scope.",errors:"Missing input, invalid name, or unsafe path.",example:"method bind METHOD_ID prepared_day --file day-records --upload",remote:true},
  state: {usage:"method state ID [--enable --file state.json | --release RUN_ID]",purpose:"Read or explicitly enable shared account state.",arguments:"Accepted state updates use revision checks. Inspect a stopped run's external actions before releasing its ownership.",result:"Current revision, value, and owner run.",errors:"Concurrent ownership or stale revision. Existing state is never silently overwritten.",example:"method state METHOD_ID --enable --file initial-state.json",remote:true},
  wait: {usage:"method wait RUN_DIRECTORY",purpose:"Reconnect to the same local worker.",arguments:"Use the directory returned by run. Closing this output connection leaves the worker active.",result:"Live output and final worker status.",errors:"Stopped process or missing run.",example:"method wait .runs/example"},
  'run-status': {usage:"method run-status RUN_DIRECTORY",purpose:"Read worker status without waiting.",arguments:"Local run directory.",result:"Worker status and whether its process is active.",errors:"Unreadable run directory.",example:"method run-status .runs/example"},
  cancel: {usage:"method cancel RUN_DIRECTORY",purpose:"Stop a local run process.",arguments:"Inspect uncertain external actions before any explicit retry.",result:"Cancellation request. The checkpoint remains available.",errors:"Unreadable run directory.",example:"method cancel .runs/example"},
  progress: { usage: "method progress --message TEXT [--completed N --total N --unit NAME] [--child NAME]\nmethod progress --codex --child NAME", purpose: "Report public progress from a running script or relay a child Codex JSON stream.", arguments: "METHOD_PROGRESS_FD is supplied by the executor. --codex reads JSON lines from stdin; --message sends one message. Do not include secrets or source contents.", result: "Writes to the separate progress pipe. No stdout output. No-op outside a Method process.", errors: "Invalid arguments. Malformed Codex events are ignored.", example: "method progress --message 'Rendered 12 of 40 pages' --completed 12 --total 40 --unit pages" },
  authoring: { usage: "method authoring [start|concepts|execution|examples|recipes|recovery|commands|all]\nmethod authoring example EXAMPLE_ID", purpose: "Read the installed authoring guide. Available offline.", arguments: "Default topic: start, with the build steps, prompt rules, a complete example, the field reference, the step types, and the example catalog. concepts, execution, recipes, recovery, and commands hold the rest. Choose examples after choosing the design. A named example prints its complete lesson and installed file paths. all prints every topic except the example lessons.", result: "Markdown text on stdout. No changes.", errors: "Unknown topic: lists the valid topics; exit 1.", example: "method authoring all > method-guide.md" },
  init: { usage: "method init FILE --name NAME --goal TEXT", purpose: "Create a local YAML draft.", arguments: "File must be new. Name and goal are required. The draft starts with an empty steps map and result map.", result: edited, errors: "Missing name or goal; the file already exists.", example: "method init task.method --name 'Find leads' --goal 'Find qualified leads from the specified sources.'" },
  show: { usage: "method show FILE [--path POINTER]", purpose: "Read a draft or one field.", arguments: "Default: the full document. Pointer example: /steps/search/do.", result: "Selected value as JSON. No changes.", errors: "The selected field does not exist.", example: "method show task.method --path /steps/search" },
  set: { usage: "method set FILE POINTER (--json JSON|--value-file FILE|--text TEXT|--text-file FILE)", purpose: "Add or replace one draft field.", arguments: valueFlags + " Parents must exist. An empty pointer replaces the document. Escape / as ~1 and ~ as ~0. Nested values replace in full.", result: edited, errors: "Invalid pointer, missing parent field, or conflicting value flags.", example: "method set task.method /steps/search/do/prompt --text-file search.txt" },
  remove: { usage: "method remove FILE POINTER", purpose: "Remove one draft field.", arguments: "The field must exist. Repair remaining references before saving.", result: edited, errors: "The selected field does not exist.", example: "method remove task.method /steps/search/each" },
  "step add": { usage: "method step add FILE --id ID --value-file STEP.yaml", purpose: "Add a complete operation.", arguments: "Supply do or ask and the bindings and outputs needed by the step in STEP.yaml. Give a run step a name and a purpose, and describe its outputs. Checks and limit overrides are optional. Without a value file, use --kind run --runtime python|node --entrypoint FILE, or --kind agent|call|classify --instructions-file FILE; the model is default (the account's hosted model).", result: edited, errors: commonErrors, example: "method step add task.method --id copy --value-file copy.yaml" },
  "step update": { usage: "method step update FILE STEP_ID (--json JSON|--value-file FILE)", purpose: "Change fields of an existing step.", arguments: "Supply an object of fields. Top-level fields merge; nested values replace in full. Use remove to delete a field.", result: edited, errors: "Unknown step or invalid step fields.", example: "method step update task.method search --value-file search.yaml" },
  "step remove": { usage: "method step remove FILE STEP_ID", purpose: "Remove an operation.", arguments: "Repair references to its outputs and after constraints before saving.", result: edited, errors: "The selected step does not exist.", example: "method step remove task.method old_search" },
  "step move": { usage: "method step move FILE STEP_ID --before OTHER_ID", purpose: "Change display order.", arguments: "Both steps must exist. Data references and after still control execution order.", result: edited, errors: "The selected step or destination does not exist.", example: "method step move task.method search_exa --before search_bookface" },
  "check set": { usage: "method check set FILE STEP_ID (--json JSON|--value-file FILE)", purpose: "Set the operation's independent check.", arguments: "When a task check is needed, use an equals/count/present/file object, a run check, or an agent check. Put plain-English criteria in an agent check prompt.", result: edited, errors: "Unknown step, invalid check, or conflicting value flags.", example: "method check set task.method search --value-file check.yaml" },
  "check remove": { usage: "method check remove FILE STEP_ID", purpose: "Remove the operation's check.", arguments: "The operation will have no additional task check. Remove unnecessary checks and their supporting tests and instructions. External changes require effects (method effect add), not a check.", result: edited, errors: "The selected step does not exist.", example: "method check remove task.method copy" },
  check: { usage: "method check FILE [--notes] [--all]\nmethod check set|remove ...", purpose: "List the Method's issues, or edit an operation's check.", arguments: "With a Method file: the same issues as validate, without the local setup. Use method check set --help to edit a check.", result: "JSON with valid, issues, and issue_counts. Exit 1 only on errors.", errors: "Unknown action. Choose set or remove.", example: "method check task.method" },
  validate: { usage: "method validate FILE [--workspace DIR] [--notes] [--all]", purpose: "Check the definition, its issues, and the local setup without running the work.", arguments: "Checks data, names, dependencies, templates, declared files, executables, environment variables, models and connection bindings, then lists issues: errors, warnings, and notes. A file or the Method that contains a secret value of this computer is an error. Warnings are listed only for steps whose text changed since the last validate, at most 5; --all lists every one; --notes adds notes. Model checks run through your Method account for changed steps; validate waits at most 3 seconds and reports the rest as pending. Models come from the Method's models:, bindings from this computer (method bind), runtimes from PATH. --workspace selects the helper folder.", result: "JSON with valid, definition, local_setup, missing_setup, steps, executed:false, issues (each with level, code, at, message, fix, and for a warning on a step how to accept it), and issue_counts. Exit 1 only on errors. Fix errors. Fix each warning, or accept it with the user's reason. Never add a check only to remove a warning.", errors: "Each error issue names the field or file and the fix.", example: "method validate task.method" },
  models: { usage: "method models [--refresh] [--server URL]", purpose: "List the hosted models that work with the private options.", arguments: "Each listed model has a provider that does not train on requests and keeps no copy (zero data retention). Hosted runs use only those providers. The list comes from your Method account and is kept for a day; --refresh gets it again. validate warns with model_not_private when a step names a model that is not listed.", result: "JSON with default, checked_at, and models (model IDs).", errors: "No sign-in, or no network and no saved list.", example: "method models", remote: true },
  diff: { usage: "method diff FILE OTHER_FILE", purpose: "Compare two documents.", arguments: "Both files required. Values are compared after parsing YAML or JSON.", result: "JSON array of {path,before?,after?}. Empty means equal; exit 0 either way.", errors: "Both file paths are required.", example: "method diff original.method task.method" },
  schema: { usage: "method schema [method|config|step|data|environment|check]", purpose: "Read the format.", arguments: "Without a name: a short field reference, enough to write a Method. With a name: that JSON schema, for tools.", result: "Text, or JSON Schema.", errors: "Unknown schema name.", example: "method schema" },
  get: { usage: "method get WORKFLOW_ID [--version VERSION_ID] [--out FILE] [--server URL]", purpose: "Read an online method; optionally make a local draft for editing.", arguments: "Default: latest version. --out must name a new file. Use a version ID to read an exact saved version.", result: "Without --out: {workflow_id,version_id,version_number,workflow}. With --out: {workflow_id,version_id,version_number,file}; writes the workflow with its id: line and the saved files.", errors: "Missing method or version; output file already exists.", example: "method get wf_example --out edit.method", remote: true },
  explain: { usage: "method explain FILE [--step ID] [--no-round-trip] [--server URL]", purpose: "Explain each script step of the saved version in a script card.", arguments: "FILE is a local Method whose current content is a saved version (run or publish it while signed in). For each run step whose script has no card, code analysis finds the hosts, secrets, environment variables, files, and commands the script uses; a hosted model writes a one-sentence summary and 3 to 8 steps; every number, quoted name, and host in that text must appear in the code (one retry). The round trip writes a program from the steps alone and replays up to 3 recorded inputs of the step from local runs through both programs without network access. A script that calls the network is not replayed. --step explains one step. --no-round-trip skips the replay. A signed-in run starts this in the background; publish waits for it.", result: "One line per step with its summary and check results. Cards upload to the version; the dashboard shows them beside each script. A failed check is shown on the card and never blocks publish.", errors: "No saved version, local files that differ from the saved version, or no hosted-model credit. Without sign-in it prints one line and makes no card.", example: "method explain leads.method --step score", remote: true },
  publish: { usage: "method publish FILE [--reason TEXT] [--accept-failing-case ID[,ID]] [--cloud|--workers] [--env NAME] [--server URL]", purpose: "Mark a version as published, for sharing, schedules, and production runs.", arguments: "Runs the Method's cases first; a version that breaks an approved case is refused unless --accept-failing-case names it, and the version records that. Uses the version of the file's current content: it finishes that upload (no time limit while bytes move), checks the cases, then marks it published with the reason (default: Published.). --accept-failing-case needs --reason. The first save of a new file creates the Method. --cloud runs the production runs of the environment on Method Cloud; --workers runs them on your workers again. --env NAME selects the environment (default production).", result: "JSON with workflow_id, version_id, url, published_at, the cases line, and the open warnings and notes (issues). With --cloud or --workers: placement. Warnings and notes never block a publish.", errors: "An error issue (nothing is published), failing case, --accept-failing-case without --reason, or no network.", example: "method publish task.method --reason 'Shorter introduction'", remote: true },
  improve: { usage: "method improve FILE [--case ID] [--note TEXT] [--step ID] [--server URL]", purpose: "Ask Method to propose a better version of a Method.", arguments: "--note: the correction, in your words; it is about the newest run of the Method on this computer, which the improvement reads and a suggested case records. --step: improve only this step. --case: the case the change must pass. A Method with account run data improves in your account; see the progress on the dashboard. A Method with run_data: device improves on this computer, so its run content stays here; the result is a local proposal in .method/proposals/.", result: "JSON with the improvement and the dashboard link, or the local proposal ID. Nothing is published, and the file does not change.", errors: "No id: line (run the file once while signed in), an unknown step, or an improvement that is already running.", example: "method improve task.method --step summary --note 'Name the customer in the first sentence.'", remote: true },
  proposals: { usage: "method proposals FILE [--wait] [--server URL]", purpose: "List the proposals of a Method.", arguments: "Lists the proposals in your account and the local proposals beside the file. --wait: when an improvement is running, wait until it ends (usually a few minutes), printing each step it reaches.", result: "JSON list of proposals with id, source, status, kind, cause, and steps, and the newest improvement that has no proposal yet, with its status. No changes.", errors: "", example: "method proposals task.method", remote: true },
  apply: { usage: "method apply FILE [PROPOSAL_ID] [--resolved] [--server URL]", purpose: "Merge a proposal into the local file.", arguments: "Default: the newest accepted proposal, or else the newest local proposal. The merge is per step: a part that only the proposal changed takes the change; a part that you and the proposal both changed is a conflict. --resolved: you merged a conflict by hand; this marks the proposal applied. Commands that take a signed-in FILE apply an accepted proposal first and print one line.", result: "JSON with status applied and the changed steps; the file changes and the proposal is marked applied. Nothing is published. A conflict lists each part with the base, your, and the proposed value, changes nothing, and exits 1.", errors: "No proposal, a proposal that is not accepted, or a conflict.", example: "method apply task.method", remote: true },
  secret: { usage: "method secret find [FILE]\nmethod secret import FILE NAME...\nmethod secret set NAME\nmethod secret list [NAME...]", purpose: "Give this computer the values of a Method's declared secrets.", arguments: "find lists the KEY=VALUE files in this folder (3 levels down) and in the parent folder (2 levels down) with the key names in each, never values; for the Method FILE (or the only Method here) it says which declared secrets each file holds and prints the import command. import copies the named values from a KEY=VALUE file that the user names, without printing them. set opens a private form on 127.0.0.1 in the browser for one value. list shows names and where each value is found (shell, this computer, or missing), never values. Values are kept in ~/.config/method/secrets.json (mode 0600) and are never sent to Method. A value exported in the shell is used first. Every script of the Method receives all of its declared secrets.", result: "JSON with the saved names, or the list.", errors: "A name is missing from the file, or no value was entered.", example: "method secret find\nmethod secret import ../service/.env ARCHIVE_TOKEN" },
  connect: { usage: "method connect [APP_FOLDER] [--file METHOD_FILE]", purpose: "Connect an app to the Method in this folder, so the app runs it in production.", arguments: "Run it in the Method's folder. APP_FOLDER (default: this folder) is the app's folder. It makes a service key named after the app folder and writes METHOD_API_KEY to the app's .env (a new file, or a new or replaced line); it never prints the key. It adds .env to .gitignore in a git repository. When the Method has no published version, it publishes the current file. It detects Node (package.json) or Python (pyproject.toml, requirements.txt), and prints the install line and the code to add. Run it again: an app with a working key keeps it.", result: "JSON with the method_id, the published version, where the key is, install, code, secrets_to_set_on_the_host, and next.", errors: "No or several .method files (give --file), an app folder with no language marker, or a failing case at publish.", example: "method connect ../app", remote: true },
  answer: { usage: "method answer RUN_ID [--answer JSON]", purpose: "Show or answer the question of a production run that waits on an ask step.", arguments: "Without --answer it prints the question and its form (the fields of the answer). With --answer it checks the answer against the form and sends it; the run continues. A run that keeps its content on devices has a sealed question: run this where the app's METHOD_API_KEY is (the environment, or the .env of this folder), or on the laptop that started the run with its sign-in. Local runs (method run FILE) take answers with --human FILE as before.", result: "The question and form, or the run after the answer.", errors: "The run is not waiting, the answer does not match the form, or the key cannot open a sealed question (wrong_key).", example: "method answer 6f1c… --answer '{\"approved\":true}'", remote: true },
  worker: { usage: "method worker [--method ID]... [--concurrency N] [--server URL]", purpose: "Run production runs that an app started with the runs API.", arguments: "Uses METHOD_API_KEY, or the sign-in of this computer. Use the app's key: runs that keep content on devices open only with the key that started them. The worker claims queued runs of the organization (or only of each --method), renews each run's lease, downloads the run's saved version by ID, prepares its dependencies once per version, reads declared secrets from the environment, and sends the run records to the dashboard. An ask step makes the run wait: the worker saves the run folder, reports the question, and lets go of the run; after the answer, a worker continues it and reuses the finished steps. --concurrency runs that many at the same time (default 1). Ctrl+C stops after the current runs; a second Ctrl+C stops them and queues them again. The libraries start a worker in the app's process with method.run(), so this command is for separate worker processes.", result: "One JSON line for each finished run: {run_id, method_id, version_id, status, run_data, result?, error?, run_dir}, and one for each run that starts to wait: {run_id, status: waiting, question}. A run_data: device result is printed only here.", errors: "Missing or revoked key. A run whose lease expires goes back to the queue and runs again (at most 3 attempts).", example: "METHOD_API_KEY=mk_live_... method worker --method wf_example", remote: true },
  keys: { usage: "method keys create --name NAME\nmethod keys list\nmethod keys revoke KEY_ID", purpose: "Manage the organization's service keys for production runs.", arguments: "A service key (mk_live_...) lets an app start runs and lets a worker run them. method connect makes one for an app and writes it to the app's .env. Keep the key in the app's secret store as METHOD_API_KEY; never put it in a Method or in chat.", result: "create prints the key and its webhook_secret once; the server keeps only a hash of the key. list shows names, prefixes, and last use, never keys.", errors: "Requires a person's sign-in (method login), not a service key.", example: "method keys create --name 'Cuties backend'", remote: true },
  status: { usage: "method status [--server URL]", purpose: "Check installation and sign-in without listing Methods or starting login.", arguments: "No required arguments. Checks the selected server with the current credential when one exists.", result: "JSON {installed:true,server,signed_in}. A missing or expired credential returns signed_in:false. Does not print account details.", errors: "Network and server errors exit 1; they are not reported as signed out.", example: "method status", remote: true },
  list: { usage: "method list [--server URL]", purpose: "Find your online methods.", arguments: "No required arguments.", result: "Server JSON containing methods. No changes.", errors: "", example: "method list", remote: true },
  steps: { usage: "method steps WORKFLOW_ID [--version VERSION_ID] [--server URL]", purpose: "Read all complete step definitions in a saved method.", arguments: "Default: latest version. Use step with two IDs to read one saved step.", result: "JSON {version_id,steps}. No changes.", errors: "Missing method or version.", example: "method steps wf_example", remote: true },
  step: { usage: "method step WORKFLOW_ID STEP_ID [--version VERSION_ID] [--server URL]", purpose: "Read one online step. For local edits use step add/update/remove/move.", arguments: "Both IDs required. Default: latest version. Subcommand words add, update, remove, move are reserved for local editing.", result: "JSON {version_id,step}. No changes.", errors: "Missing method, version, or step. Use method steps to find step IDs.", example: "method step wf_example search", remote: true },
  login: { usage: "method login [--server URL]", purpose: "Connect this computer with browser approval.", arguments: "No credentials in chat or command flags. Method opens the sign-in/approval page and waits. Connection is saved per server in ~/.config/method. Sign in again if access expires or is revoked.", result: "Sign-in instructions and status text. Stores a private local credential after approval. Remote commands also start login when no credential exists.", errors: "Approval expired, denied, or network unavailable. Repeat login when ready.", example: "method login", remote: true },
  logout: { usage: "method logout [--server URL]", purpose: "Disconnect this computer from the selected Method server.", arguments: "No required arguments. Select the same server used for login.", result: "Status text. Revokes remote access, then removes the local credential.", errors: "If remote revocation fails, the local credential remains. Retry online, or use devices/revoke from another connected computer.", example: "method logout", remote: true },
  devices: { usage: "method devices [--server URL]", purpose: "List authorized computers.", arguments: "No required arguments.", result: "JSON list of the computers signed in to your account, with id, name, created_at, revoked_at, and this_computer (true for the computer that asks). Revoke one with method revoke ID. No changes.", errors: "", example: "method devices", remote: true },
  revoke: { usage: "method revoke DEVICE_ID [--server URL]", purpose: "Revoke a computer's Method access.", arguments: "Use the exact ID from method devices. This changes account access.", result: "Server JSON confirmation. The selected device can no longer use that credential.", errors: "Unknown device ID.", example: "method revoke device_example", remote: true },
  runs: { usage: "method runs [--method WORKFLOW_ID] [--server URL]", purpose: "Read saved run summaries.", arguments: "Default: all methods. --method filters the list.", result: "Server JSON containing runs. No changes.", errors: "", example: "method runs --method wf_example", remote: true },
  logs: { usage: "method logs RUN_ID [--server URL]", purpose: "Read saved run evidence before a repair.", arguments: "Use a run ID from method runs. Saved logs may be incomplete if upload failed.", result: "Server JSON containing the run, inputs, outputs, checks and events. No execution or changes.", errors: "Missing run.", example: "method logs run_example > run.json", remote: true },
  sync: { usage: "method sync RUN_DIRECTORY [--server URL]", purpose: "Retry upload of records from an existing local run.", arguments: "Directory must contain method-sync.json. Default destination is the saved run's server. Do not use a new business run to repair an upload.", result: "Upload status text. Updates dashboard records and local sync metadata. Does not execute steps.", errors: "Missing run/sync records; access or network error. Keep the original run directory and retry.", example: "method sync .method-runs/wf_example/saved-run", remote: true },
  run: { usage: "method run FILE.method [OPTIONS]\nmethod run WORKFLOW_ID [--version VERSION_ID] [--server URL] [OPTIONS]", purpose: "Run a local .method file, or a saved Method by ID. When this computer is signed in, a run of a local file starts at once and saves in the background: the version of the file's content and the run's records go to the dashboard through the outbox (~/.cache/method/outbox), and the last line says Saved as version N, or Will save when online; without sign-in the records stay in .method-runs. Steps whose definition and inputs match an earlier accepted run on this computer are reused.", arguments: `Models come from the Method's models: (or the account default); --agent codex|claude or method config agent runs model steps with a local agent. --workspace selects a different helper folder. See method authoring execution. Optional --state FILE initializes state for a new run. Resume with --resume --run-dir DIR; authorize unfinished work with --retry STEP:ITERATION.

--inputs FILE: JSON input values.
--run-dir DIR: the folder for this run's records (new runs too; default .method-runs/ID).
--agent codex|claude: run every model step of a new run with this local agent.
--resume: continue the same saved run with its saved agent.
--rerun STEP: run this step again even when an earlier run can be reused. Repeat for more steps.
--fresh: run every step; reuse nothing.
--human FILE: answers for ask steps, as {steps: {"STEP:ITERATION": {outputs: {...}}}}.
--verbose: print runtime events.
Use method doctor to check the installed Node and configured tools.`, result: "Progress and final status text; local result.json and run evidence; dashboard run link when synced. The runtime executes the method's declared scripts, calls, agents, and checks. Executes trusted local processes; changes declarations do not enforce permissions. Runs exit 0 on completion, 1 on failure, 2 when human input is needed, and 3 when an observer could not confirm an external change (unconfirmed).", errors: "Missing inputs/access, failed check, timeout, unsafe resume/version mismatch, upload failure. See recovery. Never retry a business write without inspecting its saved changes.", example: "method run wf_example --version v_example --inputs inputs.json", remote: true },
  observe: { usage: "method observe [RUN_DIRECTORY...] [--pending ROOT]...", purpose: "Make the effect observations that are due for finished runs.", arguments: "Without directories, checks runs with open effects under .method-runs and the Method cache. Runs only observers and judges; never repeats an action. Schedule it, for example hourly, so late evidence such as a bounce reaches the run.", result: "JSON with each run's new verdicts, status, and next observation time. A synced run whose status changed is uploaded again.", errors: "Locked run, changed bundle, or a missing observer credential.", example: "method observe --pending .method-runs" },
  test: { usage: "method test FILE [--case ID]... [--baseline OLD_FILE] [--new ID]... [--cases DIR] [--agent codex|claude]", purpose: "Replay recorded cases against this version of a Method. Every case must pass.", arguments: "Cases are in cases/ beside the Method. Unchanged steps return their recorded outputs; changed steps run; files connections are scratch folders, so a changed step that writes files runs safely. A changed step that asks a person or acts on a service makes the case unverifiable. --baseline also runs each case on the old version, to show what the change fixed or broke.", result: "JSON report with a verdict per case and passed:true when no case blocks the change. Exit 0 or 1.", errors: "Unknown case, invalid Method, or setup errors.", example: "method test task.method --baseline task-before.method --new bounce-reported" },
  case: { usage: "method case new|retire|list FILE ...", purpose: "Keep a correction as a recorded case that every later version must pass.", arguments: "Use method help case new, method help case retire, or method help case list.", result: "See the subcommand.", errors: "Unknown action. Choose new, retire, or list.", example: "method help case new" },
  "case new": { usage: "method case new FILE --id ID --note TEXT (--run BAD_RUN | --passing-run GOOD_RUN | both) (--rubric SENTENCE... | --expect FILE) [--ref outputs.NAME] [--context REF]... [--agent codex|claude]", purpose: "Turn a correction into a recorded case.", arguments: "--run is the run that went wrong; the case must fail on it. --passing-run is the run the person accepted after the fix; the case must pass on it. With only --passing-run, the case pins behaviour that is already right. --rubric is a plain sentence that must be true of the output (repeatable); a model judges it with quotes. --ref selects the output to judge; the default is the Method's result. --context REF gives the judge other values to check against, such as the sources or the person's words (outputs.NAME or inputs.NAME); they are read, not judged. --expect FILE gives exact checks instead: {kind: equals, ref: outputs.NAME, value}, {kind: status, in: [STATUS]}, {kind: effect, effect: STEP/ITERATION/NAME, verdict: [VERDICT]}, or {kind: predicate, runtime: node, entrypoint: check.mjs}. --redact FILE maps recorded text to replacements.", result: "The saved case, with its result on each run. A case that the bad run already meets is refused: it does not capture the problem, or the note does not match the run.", errors: "A case that does not fail on the bad run, or does not pass on the passing run; an existing ID; an unreadable run.", example: "method case new report.method --id sources-named --run .method-runs/bad --passing-run .method-runs/fixed --note 'Say which source backs each point.' --rubric 'Every point names the source file that supports it.'" },
  "case retire": { usage: "method case retire FILE ID --reason TEXT [--by NEW_ID]", purpose: "Retire a case whose rule no longer applies.", arguments: "The case stays on disk with its reason and is no longer run. Use it when a policy changed, not to make a failing change pass.", result: "JSON {retired}.", errors: "Unknown or already retired case.", example: "method case retire task.method old-terms --by new-terms --reason 'Payment terms changed on 1 October.'" },
  "case list": { usage: "method case list FILE", purpose: "List the cases of a Method.", arguments: "Reads cases/ beside the Method unless --cases DIR is given.", result: "JSON list of cases with status and note.", errors: "", example: "method case list task.method" },
  effect: { usage: "method effect add|list ...", purpose: "Use a reviewed observer for an external change.", arguments: "Use method help effect add or method help effect list.", result: "See the subcommand.", errors: "Unknown action. Choose add or list.", example: "method effect list" },
  "effect add": { usage: "method effect add FILE STEP NAME --observer OBSERVER [--connection NAME] [--in ALIAS=REF]... [--set KEY=VALUE]... [--intent TEXT] [--horizon DURATION] [--blocking]", purpose: "Declare an effect with a reviewed observer.", arguments: "Copies the observer, its judge, and its fixtures into observers/ beside the Method, adds the observer connection with role: observer, and sets the effect. --set fills observer settings. For files, SQLite databases and JSON services, write a built-in observer (kind: file, sqlite, or http) in the step instead. The step must already declare the changed connection in changes. Read the printed setup for the observer's credential.", result: "The edited workflow and the observer's setup instructions. Sets format method/3.4.", errors: "Unknown observer, missing --in binding, or a step without an external change.", example: "method effect add task.method send_summary delivered --observer mail.delivery --in to=inputs.ap_lead" },
  "effect list": { usage: "method effect list", purpose: "List the reviewed observers.", arguments: "No arguments.", result: "JSON list of observers and what they need.", errors: "", example: "method effect list" },
};


const exitHelp = "Success exits 0. Errors exit 1 with text on stderr, unless the command specifies another result.";
const serverHelp = "Server: https://app.withmethod.ai by default. --server selects another server and its login.";

export function renderCommand(name: string, includeCommon = true): string {
  const entry = commandHelp[name];
  if (!entry) throw Error(`Unknown command '${name}'. Use method authoring commands.`);
  return `## ${name}\n\n${entry.purpose}\n\nUsage:\n\n\`\`\`sh\n${entry.usage}\n\`\`\`\n\nArguments and defaults:\n${entry.arguments}\n\nResult and changes:\n${entry.result}${entry.errors ? `\n\nErrors:\n${entry.errors}` : ""}\n\nExample:\n\n\`\`\`sh\n${entry.example}\n\`\`\`\n` + (includeCommon ? `\n${entry.remote ? serverHelp + "\n" : ""}${exitHelp}\n\nCommon errors:\n${commonErrors}\n` : "");
}

const firstExample = `# A complete small Method

\`\`\`yaml
format: method/3.4
name: Weekly ticket summary
goal: Score this week's support tickets by urgency and write a short summary for the team.
inputs:
  week:
    type: text
    description: Monday of the week to summarize, as YYYY-MM-DD.
  example:
    type: text
    description: A past summary that the team liked. The summary step copies its style.
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
        unclear: Unclear - the ticket does not say enough to tell.
    out: urgency
  join:
    name: Join tickets and scores
    purpose: Gives each ticket its urgency. Marks a ticket unsure when the choice is unclear or its probability is below 0.7. Changes nothing.
    in: {tickets: tickets, urgency: urgency}
    do: {kind: run, runtime: python, entrypoint: join_scores.py}
    out:
      scored: {type: list, fields: {id: text, text: text, urgency: text, unsure: boolean}, description: Each ticket with its urgency.}
  summary:
    in: {scored: scored, example: inputs.example}
    do:
      kind: call
      model: default
      prompt: |
        Write a five-sentence summary of this week's support tickets for the team.
        Start with the high-urgency tickets. Quote no customer names.
        End with "Check these:" and the ids of the unsure tickets, or "Check these: none".
        Write it in the style of this summary from an earlier week:

        {{example}}
    out:
      summary: {type: text, description: The summary for the team.}
result: summary
\`\`\`

What this example shows:
- **One task per step.** The classifier only scores urgency. The script applies the 0.7 rule. The call only writes.
- **An example output.** The \`example\` input is a past summary that the team liked. One real example makes the style clear in fewer words than a description of it.
- **A way to say "I do not know".** The \`unclear\` option and the 0.7 rule mark tickets for a person to check, so a guess is not hidden.
- **The output shape is in \`out\`**, not in the prompt.

\`read_tickets.py\` reads HELPDESK_TOKEN from its environment. The classify and call steps use the Method account, so they need no key.

\`\`\`sh
method validate tickets.method
method run tickets.method --inputs inputs.json   # prints the version and dashboard links
# change the summary prompt, then:
method run tickets.method --inputs inputs.json   # reuses read, urgency and join; runs summary
\`\`\`
`;
const start = `${firstMethodRules}
${promptRules}
${firstExample}
${watchRules}
${afterRules}
${fieldReference}
${designProcedure}

Use method schema for field definitions, method authoring concepts for the format, method authoring execution for setup, and method COMMAND --help for command arguments.
`;
const concepts = `# Method concepts

${costRules}

${checkRules}

${designExamples}

A method has format, name, goal, steps, and result, and optional id, inputs, secrets, state, environment, files, models, limits, tools, run_data, run_label, and run_prompt (see the field reference in method authoring).
Each step uses do or ask. The do kinds are run, call, agent, and classify. Give script actions a name and a purpose; describe script checks in reading.check. A classify action takes bound inputs, a question, and one of options (a named choice with probabilities), answer: yes_no (answer and the probability of yes), or levels (2-10 ordered names; the most likely level, an expected level index as score, and probabilities). Use a script to apply business rules to that result.
run uses runtime and entrypoint; call uses model and prompt; agent can select browser: environment.NAME and optional custom tools.
Optional run_label selects one saved text, number, or boolean value, such as inputs.topic or steps.prepare.outputs.plan.date. Step references must select a step without each or repeat. Choose a short non-sensitive value. The site uses the current Method's reference with each run's recorded inputs or outputs; absent or empty values keep timestamps. Set it with method set task.method /run_label --json '"steps.prepare.outputs.plan.date"'.

Optional run_prompt is plain text for the outside agent that starts a saved Method. Write which Method to run, where to find its inputs, and what to show when finished. Save it with the Method version and update it when inputs or outputs change. The copy button appends the exact version link and shared CLI setup; do not repeat them in run_prompt. This field is not a step prompt and does not expand variables. Set it with method set task.method /run_prompt --text-file run-prompt.txt.

Model and human prompts use {{date}} for the step input declared as in.date. Nested fields such as {{customer.name}} are allowed. Only text, numbers, and booleans can be inserted; pass lists and records as structured inputs. Whitespace inside braces is allowed. Escape a literal placeholder with a backslash before its opening braces (use a YAML block scalar). Values are inserted once, never evaluated or expanded again. Unknown variables, invalid paths, and non-scalar values fail validation. Missing runtime values fail before model execution. Defaults belong in input declarations. Human ask text uses the same scope; agent check prompts use {{inputs.date}} and {{outputs.answer}}. Script commands, labels, and tool descriptions are not templates. Single braces are ordinary text.
Runs record prompt.rendered with the template and expanded instructions for each invocation and phase; the run page shows the recorded expansion, with templates in technical details. Model and agent work uses finite default limits; steps can override them.
An optional step reading object explains inputs, outputs, condition, and check in plain text for the reading page. These descriptions do not alter execution. Describe the declared data and actual checks; keep them in sync when editing the step. The page always shows the exact do and check instructions as well. Give a separate executable check a short reading.check_name, such as “Compare saved text”, and use reading.check to explain what it checks. These fields change presentation only. Do not imply that a file or reference check verifies facts, or add a check just to fill the display.
Inputs and outputs have a type. Describe the outputs of script steps; other descriptions are optional. Types: text, number, boolean, record, list, file. Records need fields; lists need items or fields. Files have path and sha256.
Online runs upload declared file outputs separately, up to 20,000 files and 100 MB total, with 25 MB per file. Hash-checked receipts let interrupted transfers resume with only missing files. The single-file inspect export retains its separate 20 MB compressed-data limit. For a website, declare format: method-website and write a JSON file {schema: "method-website/1", title, entrypoint, files: [{path, sha256, media_type}]}. Paths in the file list are relative to that file; list every asset and identify an HTML start page. The run page opens the website only when all listed assets are attached. It can also download the complete website as a ZIP. No workspace scan occurs. See docs/result-files.md for the full contract. method sync RUN_DIRECTORY uploads files without executing steps again.
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
Add concurrency: N (1-32) to an each step to run up to N items at once, for example a classify or call over many records. The Method's top-level limits.max_concurrency (default 8) caps it. The step cannot use ask, changes, or effects. Outputs keep item order; the first failure stops the other items, and resume runs only unfinished items. Raise limits.max_invocations for collections over 100 items.
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
write. Declare keys under secrets:.

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

`;
const execution = `
# Execution setup

Use method run FILE_OR_ID [--inputs inputs.json] [--state state.json] [--run-dir DIR] [--workspace HELPERS_FOLDER] [--agent codex|claude] [--background].
A Method needs no configuration file. What changes the result is in the Method: models, limits, tools, and secrets (the names). What belongs to this computer is in ~/.config/method/computer.json: method config (local agent, own model key) and method bind (folders and connections). python and node are found on PATH and prepared automatically. A saved version carries its helpers; versions saved without files still need --workspace DIR.

## Models

A call or agent step names model: NAME from the Method's models: ({NAME: provider/model | {model, max_output_tokens, reasoning_effort}}), a model ID such as openai/gpt-6-luna, or default. A step without model uses default: the account's default model. Hosted models need no key and no local agent. They are private by default: requests go only to providers that do not train on them and keep no copy (zero data retention). method models lists those models; validate warns with model_not_private when a step names another, and hosted runs refuse it. Hosted models and classification share the account's model credit; the run summary reports usage.cost_usd. When the credit is used, run method config model-key: hosted model and classify steps on this computer then call OpenRouter with the user's own key.
A models: entry {agent: codex | claude, model, reasoning_effort} runs the steps that name it with that local agent, which must be installed on the computer that runs the Method. --agent codex|claude, or method config agent codex|claude, runs every model step with a local Codex or Claude agent. Declared tools reach the agent through a temporary local MCP connection; no persistent agent configuration is edited. The model choice of a run stays fixed on resume.

## Classification

classify uses Method's classifier (Jev) through the account, with no key and no agent installation; it needs sign-in and network access. The SDK saves the pinned classifier version before execution and reuses it on resume. Each invocation makes one request; uncertain answers complete normally. Questions and option descriptions are literal text. Bind JSON inputs through in or each, and use out: RESULT_NAME for the result record. There must be 2–255 options or 2–10 levels. Classifiers cannot receive declared files or declare changes. Classification sends the step's declared inputs to Method and its classification provider. Saved runs contain the declared inputs and results.

## Browser

An agent with browser: environment.NAME receives the standard direct browser-use controls. The agent chooses the browser actions. Method opens the selected browser, keeps its sign-ins private, and reuses the session across steps. On macOS, Method copies the user's last-used Chrome profile and runs headless, so ask the user to sign in to the sites in Chrome before the run. For a visible browser, attach a Chrome session that permits control with method browser connect --cdp URL. Validation does not open a browser. Each run has a separate profile; resume reads the current page, not a saved web snapshot.

## Secrets, scripts, and tools

Declare each key that a script needs under secrets: with its purpose. Every script of the Method (run steps, script checks, tools, and observers) receives all of the Method's declared secrets as environment variables. Supply values with method secret find, method secret import, or method secret set; they stay on this computer and are never sent to Method. A missing value stops the run before its first step.
Scripts are trusted local processes; Method does not sandbox them. They receive one JSON object on stdin and return one JSON object on stdout. Write artifacts under METHOD_OUTPUT_DIR. State updates are returned under state.
Declare custom script tools at the top level, tools: {NAME: {description, in, out, run, effects}}, and list them in the agent step's tools:. Browser controls are supplied automatically; interactive controls require changes: [environment.NAME]. Check tools cannot declare external effects.
METHOD_OPERATION_ID identifies a script action or check within a run. It stays the same when that invocation is retried. Use it as the service’s idempotency key to prevent duplicate writes during recovery. Use a business key when duplicates must also be prevented across separate runs. Agent tools define duplicate prevention in their own contracts.

## Limits

Defaults: one hour per run, ten minutes per step, 100 model requests, 100 step invocations, 200 tool calls, 16 MiB for input and output, and 8 concurrent items per step; 32 agent turns and model requests per step. Change them in the Method: limits: {timeout_ms, max_model_requests, max_invocations, max_tool_calls, max_output_bytes, max_request_bytes, max_concurrency, step: {timeout_ms, max_agent_turns, max_model_requests}}. limits.step applies to every step without its own step limits:. max_model_requests counts direct model and classification requests; a local agent manages its own internal requests and built-in tools, and Method enforces its process timeout, prompt and output size, and tool-call limit.

## Runs and records

A version includes declared files, script and tool entrypoints, dependency lockfiles, and the runtime release. Run accepts a Method ID or dashboard URL and restores that version.
Use method inspect RUN_DIRECTORY --out inspection.json for a saved run; online runs sync to the same Method dashboard.
Use method bind FILE NAME --file FOLDER to remember an input on this computer. Add --upload only to save that selected input folder privately in the account.
Use method state ID --enable --file state.json to opt into shared account state. Concurrent runs cannot overwrite it. Account state is JSON; an uploaded SQLite input is a snapshot, not a shared database. Use a live service connection for a shared database. A stopped run keeps ownership until continued or explicitly released with method state ID --release RUN_ID after inspecting its actions.
CLI runs of local files and saved Methods have their own process. Use --background to return immediately, method run-status DIR, method wait DIR, or method cancel DIR. New runs accept package runtime versions explicitly tested by the installed SDK. The saved package stays unchanged; run records identify the executor used. Resume the same Method version and exact executor with --resume --run-dir DIR. Use method sync DIR to retry uploads without repeating work.

## Progress and result names

For live progress, native Codex forwards public updates as they arrive. Scripts use METHOD_PROGRESS_FD; run method progress --help for the message and child-agent relay protocol. Keep stdout for the final JSON result. Report real milestones without source passages or secrets. Quiet work still sends a five-second heartbeat; the page polls every three seconds. A heartbeat shows the executor is connected, not that new work has completed. See https://github.com/method-ai-hq/method-sdk/blob/main/docs/progress.md for complete examples.

Use reading.output_name to give a returned result a short, honest name. Use reading.outputs to explain its contents.
`;
const recipes = `# Recipes

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

For incremental exports, keep a declared state ledger of source IDs and evidence hashes. Compare new evidence to that ledger and rebuild only changed days. Supply the prior run's state.json with --state for a new run.
Resume continues the same input set and saved version. A new run can collect new files.
To edit a failed method, read its exact saved version and logs, compare the current version, change it, and run it. Publish with --reason when the user wants to share the repair.

`;
const recovery = `# Recovery

For a stopped run, read summary.json, events.jsonl, and checkpoint.json. Resume with the original method, --run-dir DIR, and --resume. Accepted steps and iterations are reused.
An unfinished action needs --retry STEP:ITERATION after inspection of its external effects. A retry consumes the remaining run budget. Budgets do not reset on resume. Resume always uses the run's saved bundle, so a code fix needs a new run.
To fix a failed or wrong step, change it and run the Method again. The new run reuses every iteration whose step definition, inputs, model, tools, runtime, and (for script steps) bundle files match an earlier accepted run on this computer, and copies their declared file outputs. Steps with ask or effects, steps that change state or a service, and tools with effects are never reused. Use --rerun STEP to run a step again anyway, or --fresh to reuse nothing.
For ask, supply --human FILE containing {steps: {"STEP:ITERATION": {outputs: {NAME: VALUE}}}}. Use the user's actual answer. Checks still run.
A save never blocks a run: a run that cannot save says "Will save when online", and any later method command sends the outbox.
State commits after checks. A local checkpoint cannot roll back an external write. Inspect external state before an explicit retry.
Two computers can save different content of one Method; each becomes a version with its parent. Going back to earlier content finds its existing version. The id: line keeps a renamed or moved file on its Method; method new-id FILE makes a copy a new Method.
Use method sync RUN_DIRECTORY to repair a dashboard upload without executing the method again.
New Methods use format method/3.4. A signed-in run moves a method/3.1 to 3.3 file to 3.4 when it writes the id: line.
After a failed action with effects, the failure lists what the observers saw. A confirmed effect means the change happened: do not retry the action. A run that is unconfirmed finished all its steps; inspect effects.jsonl and the external system before relying on its result.
`;

export const guideTopics = ["start", "concepts", "execution", "examples", "example", "recipes", "recovery", "commands"] as const;
export function authoringGuide(topic = "start", exampleId?: string): string {
  if (exampleId && topic !== 'example') throw Error('Use method authoring example EXAMPLE_ID.');
  const catalog = () => exampleCatalog();
  const topics: Record<string, () => string> = {
    start: () => start + '\n' + catalog(), concepts: () => concepts,
    execution: () => execution, examples: catalog,
    example: () => exampleId ? renderExample(exampleId) : catalog(),
    recipes: () => recipes, recovery: () => recovery,
    commands: () => '# Command reference\n\nLocal authoring commands edit draft files. A signed-in run saves a version when the file changed. publish marks a version for sharing. run also executes a saved version by ID.\n\n' + serverHelp + '\n' + exitHelp + '\n\nCommon errors:\n' + commonErrors + '\n\n' + Object.keys(commandHelp).map(name => renderCommand(name, false)).join('\n'),
  };
  if (topic === 'all') return ['start','concepts','execution','recipes','recovery','commands'].map(key => topics[key]!()).join('\n\n');
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
Online documents: list, get, steps, step, publish, explain.
Improvements: improve, proposals, apply.
Keys for scripts: secret find, secret import, secret set, secret list.
Execution and evidence: run, run-status, wait, cancel, runs, logs, sync, observe.
Effects and corrections: effect add/list, case new/retire/list, test.
Inputs and shared state: bind, state.
Browser and computer setup: browser connect, config.
Account access: status, login, logout, devices, revoke.
Production runs: connect, answer, keys create/list/revoke, worker.

Sign in with method login first. Read the authoring guide, give each prompt its own step, write the files, validate, and run. Each signed-in run saves a version when the file changed. Publish a version when the user wants to share or schedule it.
Use method run task.method to run it.
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
