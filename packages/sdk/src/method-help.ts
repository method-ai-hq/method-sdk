import { authoringEntryRule, designProcedure, designExamples, checkRules, firstMethodRules, fieldReference, promptRules, watchRules, afterRules, costRules, justWorksRules } from "./authoring-instructions.js";
export { exampleSelection } from "./authoring-instructions.js";
import { exampleCatalog, exampleDirectory, renderExample } from "./authoring-example.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Command = { usage: string; purpose: string; arguments: string; result: string; errors: string; example: string; remote?: boolean };
const edited = "JSON {file, workflow}. The workflow field contains the method. Writes the local draft.";
const commonErrors = "File commands require readable YAML or JSON. Editing commands leave the original file unchanged after a failed edit. Online commands require sign-in and network access. Use method authoring recovery for conflicts and interrupted saves.";
const valueFlags = "Use exactly one: --json JSON, --value-file FILE (YAML or JSON), --text TEXT, --text-file FILE (UTF-8 text). Prefer files for long text.";
export const commandHelp: Record<string, Command> = {
  'browser connect': {usage:'method browser connect [--name NAME] [--cdp URL]',purpose:'Select a private browser connection.',arguments:'NAME defaults to default. --cdp attaches to a Chrome session that permits remote control. Without --cdp, Method runs headless. On macOS it copies your last-used Chrome profile to reuse sign-ins. Use method-browser:NAME for a named browser binding.',result:'Saves the browser selection on this computer. No browser is started by this command.',errors:'Invalid name or endpoint. Credentials must not be in the URL.',example:'method browser connect'},
  doctor: {usage:"method doctor",purpose:"Check Node and the installed local agents without running a Method.",arguments:"Checks each installed Codex or Claude Code agent and says which one runs the steps that name no model. Use validate FILE for a Method's own dependencies.",result:"Setup findings; no task execution.",errors:"An old Node.js.",example:"method doctor"},
  inspect: {usage:"method inspect RUN_DIRECTORY --out FILE",purpose:"Export saved execution evidence.",arguments:"Use a new output file. --include-files attaches declared result files.",result:"Saved inspection JSON.",errors:"Missing run or existing output.",example:"method inspect runs/example --out inspection.json"},
  prompt: {usage:"method prompt FILE",purpose:"Print the Method as plain-text instructions.",arguments:"Current Method file.",result:"Text; no execution.",errors:"Invalid document.",example:"method prompt task.method"},
  config: {usage:"method config\nmethod config model-key [--off]",purpose:"Show or change this computer's settings.",arguments:"Settings live in ~/.config/method/computer.json (private): bindings (method bind) and model_key_env. model-key imports OPENROUTER_API_KEY from the one nearby key file that holds it, or else opens a private browser form for it (the value stays in this computer's secret store), and then sends every hosted model step and every classify step on this computer to OpenRouter with your key, in place of the account's model credit; the run prints Using your own OpenRouter key. Those requests keep Method's private options: no provider that trains on the data, and zero data retention. --off goes back to the account. Run limits belong to the Method (limits:). Nothing goes into a Method file.",result:"The settings, or one line.",errors:"Unknown setting.",example:"method config model-key"},
  "new-id": {usage:"method new-id FILE",purpose:"Make a copied Method file a new Method.",arguments:"Writes a new id: line. A copy that keeps its id: saves to the same Method.",result:"JSON with file and method_id.",errors:"Missing file.",example:"method new-id copy.method"},
  bind: {usage:"method bind FILE_OR_ID NAME (--file FOLDER | --connection URL) [--upload]",purpose:"Save a named input location or connection.",arguments:"Default: this computer only, in ~/.config/method/computer.json under the Method's ID (a FILE gets its id: line). A folder named NAME beside the Method needs no binding. --upload saves only the selected input folder or connection URL in the account. It never scans your disk. Keep credentials in the service's normal sign-in store.",result:"Saved binding and scope.",errors:"Missing input, invalid name, or unsafe path.",example:"method bind METHOD_ID prepared_day --file day-records --upload",remote:true},
  state: {usage:"method state ID [--enable --file state.json | --release RUN_ID]",purpose:"Read or explicitly enable shared account state.",arguments:"Accepted state updates use revision checks. Inspect a stopped run's external actions before releasing its ownership.",result:"Current revision, value, and owner run.",errors:"Concurrent ownership or stale revision. Existing state is never silently overwritten.",example:"method state METHOD_ID --enable --file initial-state.json",remote:true},
  wait: {usage:"method wait RUN_DIRECTORY\nmethod wait [JUDGMENT_ID] [--timeout SECONDS] [--json]",purpose:"Reconnect to a local run, or get what a fix did with a correction.",arguments:"With a run directory: reconnects to the same local worker; closing this output connection leaves the worker active. With a judgment ID (from method judge --json), or with nothing: waits for the fix of that correction, or of every correction that this computer is fixing, for up to --timeout seconds (default 100), and prints what it did. A wait that ends first says so in one line; the fix goes on, and method wait can run again.",result:"For a run: live output, then a final line with the run status (succeeded, unconfirmed, waiting_for_you, or failed), the headline of a failure, and the dashboard link of a synced run. For a fix: one plain line per correction for the person (Fixed, No fix found yet, Could not test a fix safely, a question, ...). After a fix it shows what the fixed agent gives now, from the test; nothing was sent. After a question, one more line says how to send the person's answer. --json prints {outcomes: [{judgment, status, outcome, lines, next?}]}.",errors:"Stopped process or missing run, or a judgment that this computer is not fixing.",example:"method wait .runs/example\nmethod wait\nmethod wait jdg_6f1c…"},
  'run-status': {usage:"method run-status RUN_DIRECTORY",purpose:"Read worker status without waiting.",arguments:"Local run directory.",result:"Worker status and whether its process is active.",errors:"Unreadable run directory.",example:"method run-status .runs/example"},
  cancel: {usage:"method cancel RUN_DIRECTORY",purpose:"Stop a local run process.",arguments:"Inspect uncertain external actions before any explicit retry.",result:"Cancellation request. The checkpoint remains available.",errors:"Unreadable run directory.",example:"method cancel .runs/example"},
  progress: { usage: "method progress --message TEXT [--completed N --total N --unit NAME] [--child NAME]\nmethod progress --codex --child NAME", purpose: "Report public progress from a running script or relay a child Codex JSON stream.", arguments: "METHOD_PROGRESS_FD is supplied by the executor. --codex reads JSON lines from stdin; --message sends one message. Do not include secrets or source contents.", result: "Writes to the separate progress pipe. No stdout output. No-op outside a Method process.", errors: "Invalid arguments. Malformed Codex events are ignored.", example: "method progress --message 'Rendered 12 of 40 pages' --completed 12 --total 40 --unit pages" },
  authoring: { usage: "method authoring [start|concepts|execution|examples|recipes|recovery|comparisons|commands|all]\nmethod authoring example EXAMPLE_ID", purpose: "Read the installed authoring guide. Available offline.", arguments: "Default topic: start, with the build steps, prompt rules, a complete example, the field reference, the step types, and the example catalog. concepts, execution, recipes, recovery, and commands hold the rest. Choose examples after choosing the design. A named example prints its complete lesson and installed file paths. all prints every topic except the example lessons.", result: "Markdown text on stdout. No changes.", errors: "Unknown topic: lists the valid topics; exit 1.", example: "method authoring all > method-guide.md" },
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
  publish: { usage: "method publish FILE [--reason TEXT] [--accept-failing-case ID[,ID]] [--cloud|--workers] [--env NAME] [--server URL]\nmethod publish NAME.compare", purpose: "Mark a version as published, for sharing, schedules, and production runs. For a comparison file: save it as a draft for review.", arguments: "A NAME.compare file is saved to your account as a draft of its comparison, with its inputs, and nothing runs. Give the user the link: the page asks them about it one question at a time, and the trial runs after their yes there. A later method run NAME.compare of the same file continues from that draft. For a Method file: Runs the Method's cases first; a version that breaks an approved case is refused unless --accept-failing-case names it, and the version records that. Uses the version of the file's current content: it finishes that upload (no time limit while bytes move), checks the cases, then marks it published with the reason (default: Published.). --accept-failing-case needs --reason. The first save of a new file creates the Method. --cloud runs the production runs of the environment on Method Cloud; --workers runs them on your workers again. --env NAME selects the environment (default production).", result: "JSON with workflow_id, version_id, url, published_at, the cases line, and the open warnings and notes (issues). With --cloud or --workers: placement. Warnings and notes never block a publish. For a comparison: JSON with comparison_id, version_number, stage, url (the page to review), questions_open, answers (what to do about each answer on the page) and next.", errors: "An error issue (nothing is published), failing case, --accept-failing-case without --reason, or no network. A comparison file with an error, or no sign-in.", example: "method publish task.method --reason 'Shorter introduction'\nmethod publish replies.compare", remote: true },
  judge: { usage: "method judge RUN_ID right|wrong [--step STEP_ID] [--note TEXT] [--corrected FILE] [--json] [--server URL]\nmethod judge RUN_ID keep JUDGMENT_ID", purpose: "Record the person's reaction to a run's result. A wrong one starts a fix on this computer and returns at once.", arguments: "RUN_ID is the run_id of the run's start line, or the run ID on the dashboard. right: the person used or approved the result; it is recorded only. wrong: the person corrected it, or asked to change the Method because of it. --note: the person's words (at most 4000 characters), even when they are vague. --corrected FILE: the result that the person says is right; JSON is sent as JSON, other text as text (at most 1 MB). --step: the step whose output was wrong. A wrong judgment starts the fix in its own process, with your own Claude Code or Codex (hosted models only when neither is signed in), and prints one line at once. The fix is one session of the agent that the Method's own steps use, on its model and effort, in a private copy of the Method's folder: it writes a check of the correction in cases/ next to the Method file, judged on what the person saw (the result, the files the run wrote, the messages it sent), changes what the Method needs (a prompt, a learned rule, a new script step with a data file, a check, a split step), and runs method validate and method test. Method then applies the change only when the new check fails on the Method as it was and passes on the new one, every earlier check that passed still passes, the person's own words in the prompts and in the .md and .txt files are unchanged (unless the person approved the change in an answer), and method validate gives no errors. Otherwise the session gets the exact failure and tries again, 3 times in all. Every test runs on private copies, with every message or change held back. The outcome is fixed, no change needed (the run already does what the person asks), no fix found, could not test, a question, or held (the fix breaks another person's correction). method wait prints what it did, and so does the next method run of the Method. method undo restores the Method as it was before. The fix starts from the newest version of the Method, as method run does. Two people who judge the same step of a run in opposite ways are held: the output shows both, and method judge RUN_ID keep JUDGMENT_ID keeps one and sets the other aside. For a run whose content stays on this computer (run_data: device), the account gets only the verdict and the step; the note and the corrected result go in .method/judgments.jsonl next to the Method file. Do not ask the person to confirm a judgment, and do not edit the Method yourself for the same correction.", result: "One line: Working on it. --json prints the judgment and {fix: {status: working, wait}}; method wait JUDGMENT_ID gives the outcome.", errors: "An unknown run, a run of a Method that is not in your account, or no sign-in.", example: "method judge 6f1c… wrong --note \"it's not even redlined\"\nmethod wait", remote: true },
  learned: { usage: "method learned FILE [--remove NUMBER] [--json]", purpose: "List the rules that the agent learned from corrections, or remove one.", arguments: "The rules are in learned.json beside the Method file; a step uses a rule when its condition holds. Each line says the rule in plain words, who taught it, when, and how often it applied in this computer's runs. --remove NUMBER (from the list, or the rule's id from --json) retires one rule and saves a new version; method undo brings it back.", result: "One line per rule, or the rule that was removed. --json prints {rules: [{id, step, when, then, by, created, applied, text}]}.", errors: "No such rule, or a learned.json that is not valid.", example: "method learned nda.method\nmethod learned nda.method --remove 2", remote: true },
  undo: { usage: "method undo [FILE] [--json]", purpose: "Undo Method's last change to a Method: a fix, or a removed learned rule.", arguments: "FILE defaults to the only Method file in this folder, else the Method of the last change on this computer. Restores the Method file and the files the change wrote, and saves that as a new version. A file that changed after Method's change is not overwritten. Run it again to undo the change before.", result: "One line: what is undone.", errors: "Nothing to undo, or the file changed after the change.", example: "method undo", remote: true },
  changes: { usage: "method changes FILE [--json] [--server URL]", purpose: "List the changes that Method applied to a Method.", arguments: "Lists, newest first, the changes that method judge applied on this computer and the changes that Method made in the account. A change made in the account is a new version: the next method run of the file takes it.", result: "One line per change: its date, its version, and its cause. --json prints {file, method_id, changes: [{id, source, cause, date, version_id, steps}]}; a fix on this computer also has the correction it came from (judgment, note) and its diff. No changes.", errors: "No id: line and no change made on this computer.", example: "method changes task.method", remote: true },
  secret: { usage: "method secret find [FILE]\nmethod secret import FILE NAME...\nmethod secret set NAME\nmethod secret list [NAME...]", purpose: "Give this computer the values of a Method's declared secrets.", arguments: "find lists the KEY=VALUE files in this folder (3 levels down) and in the parent folder (2 levels down) with the key names in each, never values; for the Method FILE (or the only Method here) it says which declared secrets each file holds and prints the import command. import copies the named values from a KEY=VALUE file that the user names, without printing them. set opens a private form on 127.0.0.1 in the browser for one value. list shows names and where each value is found (shell, this computer, or missing), never values. Values are kept in ~/.config/method/secrets.json (mode 0600) and are never sent to Method. A value exported in the shell is used first. Every script of the Method receives all of its declared secrets.", result: "JSON with the saved names, or the list.", errors: "A name is missing from the file, or no value was entered.", example: "method secret find\nmethod secret import ../service/.env ARCHIVE_TOKEN" },
  connect: { usage: "method connect [APP_FOLDER] [--file METHOD_FILE]", purpose: "Connect an app to the Method in this folder, so the app runs it in production.", arguments: "Run it in the Method's folder. APP_FOLDER (default: this folder) is the app's folder. It makes a service key named after the app folder and writes METHOD_API_KEY to the app's .env (a new file, or a new or replaced line); it never prints the key. It adds .env to .gitignore in a git repository. When the Method has no published version, it publishes the current file. It detects Node (package.json) or Python (pyproject.toml, requirements.txt), and prints the install line and the code to add. Run it again: an app with a working key keeps it.", result: "JSON with the method_id, the published version, where the key is, install, code, secrets_to_set_on_the_host, and next.", errors: "No or several .method files (give --file), an app folder with no language marker, or a failing case at publish.", example: "method connect ../app", remote: true },
  answer: { usage: "method answer RUN_ID [--answer JSON]\nmethod answer JUDGMENT_ID \"THE PERSON'S WORDS\"", purpose: "Answer the question of a run that waits on an ask step (on this computer or a production run), or the question that a fix asked about a correction.", arguments: "With a run ID: without --answer it prints the question and its form (the fields of the answer); with --answer it checks the answer against the form and sends it, and the run continues. A run that keeps its content on devices has a sealed question: run this where the app's METHOD_API_KEY is (the environment, or the .env of this folder), or on the laptop that started the run with its sign-in. A run on this computer (method run FILE) takes its answer the same way: the answer is kept in its run folder, and the run continues in the background, as method run does, from that step. With a judgment ID: send the person's own words, word for word, and the fix starts again with them in its own process; method wait gives what it did. Never answer a fix's question yourself. For a Method whose run content stays on this computer, the answer stays next to the Method file.", result: "The question and form, or the run after the answer; for a fix, one line.", errors: "The run is not waiting, the answer does not match the form, the key cannot open a sealed question (wrong_key), or the correction has no open question.", example: "method answer 6f1c… --answer '{\"approved\":true}'\nmethod answer jdg_6f1c… \"Every counterparty NDA must come back redlined.\"", remote: true },
  worker: { usage: "method worker [--method ID]... [--concurrency N] [--server URL]", purpose: "Run production runs that an app started with the runs API.", arguments: "Uses METHOD_API_KEY, or the sign-in of this computer. Use the app's key: runs that keep content on devices open only with the key that started them. The worker claims queued runs of the organization (or only of each --method), renews each run's lease, downloads the run's saved version by ID, prepares its dependencies once per version, reads declared secrets from the environment, and sends the run records to the dashboard. An ask step makes the run wait: the worker saves the run folder, reports the question, and lets go of the run; after the answer, a worker continues it and reuses the finished steps. --concurrency runs that many at the same time (default 1). Ctrl+C stops after the current runs; a second Ctrl+C stops them and queues them again. The libraries start a worker in the app's process with method.run(), so this command is for separate worker processes.", result: "One JSON line for each finished run: {run_id, method_id, version_id, status, run_data, result?, error?, run_dir}, and one for each run that starts to wait: {run_id, status: waiting, question}. A run_data: device result is printed only here.", errors: "Missing or revoked key. A run whose lease expires goes back to the queue and runs again (at most 3 attempts).", example: "METHOD_API_KEY=mk_live_... method worker --method wf_example", remote: true },
  keys: { usage: "method keys create --name NAME\nmethod keys list\nmethod keys revoke KEY_ID", purpose: "Manage the organization's service keys for production runs.", arguments: "A service key (mk_live_...) lets an app start runs and lets a worker run them. method connect makes one for an app and writes it to the app's .env. Keep the key in the app's secret store as METHOD_API_KEY; never put it in a Method or in chat.", result: "create prints the key and its webhook_secret once; the server keeps only a hash of the key. list shows names, prefixes, and last use, never keys.", errors: "Requires a person's sign-in (method login), not a service key.", example: "method keys create --name 'Cuties backend'", remote: true },
  status: { usage: "method status [--server URL]", purpose: "Check installation and sign-in, and name the signed-in accounts, without listing Methods or starting login.", arguments: "No required arguments. Checks each signed-in account of the selected server.", result: "JSON {installed:true,server,signed_in,account,other_accounts}. account is the current account: person, email and workspace. other_accounts lists the other signed-in accounts of this computer. A missing or expired credential returns signed_in:false; an account whose credential expired shows signed_in:false.", errors: "Network and server errors exit 1; they are not reported as signed out.", example: "method status", remote: true },
  list: { usage: "method list [--server URL]", purpose: "Find your online methods.", arguments: "No required arguments.", result: "Server JSON containing methods. No changes.", errors: "", example: "method list", remote: true },
  steps: { usage: "method steps WORKFLOW_ID [--version VERSION_ID] [--server URL]", purpose: "Read all complete step definitions in a saved method.", arguments: "Default: latest version. Use step with two IDs to read one saved step.", result: "JSON {version_id,steps}. No changes.", errors: "Missing method or version.", example: "method steps wf_example", remote: true },
  step: { usage: "method step WORKFLOW_ID STEP_ID [--version VERSION_ID] [--server URL]", purpose: "Read one online step. For local edits use step add/update/remove/move.", arguments: "Both IDs required. Default: latest version. Subcommand words add, update, remove, move are reserved for local editing.", result: "JSON {version_id,step}. No changes.", errors: "Missing method, version, or step. Use method steps to find step IDs.", example: "method step wf_example search", remote: true },
  login: { usage: "method login [--server URL]", purpose: "Connect this computer to a Method account with browser approval, or add another account.", arguments: "No credentials in chat or command flags. Method always opens the approval page and waits. The account that approves becomes the current account: a new account is added, and an account this computer already has gets a new credential. The other accounts stay signed in. To add another account, open the link where you are signed in to that account, for example in a private window. Each command uses the account that owns its Method or comparison, whichever account is current; a new Method uses the current account. Credentials are kept privately per server in ~/.config/method.", result: "Sign-in instructions, then the current account and the other signed-in accounts. Remote commands also start login when no account is signed in.", errors: "Approval expired, denied, or network unavailable. Repeat login when ready.", example: "method login", remote: true },
  logout: { usage: "method logout [--server URL]", purpose: "Sign out of the current account on this computer.", arguments: "No required arguments. Select the same server used for login. The other accounts stay signed in; the most recently used of them becomes the current account.", result: "One line: the account signed out, and the account that is current now (or that none is).", errors: "If remote revocation fails, the credential remains. Retry online, or use devices/revoke from another connected computer.", example: "method logout", remote: true },
  devices: { usage: "method devices [--server URL]", purpose: "List authorized computers.", arguments: "No required arguments.", result: "JSON list of the computers signed in to your account, with id, name, created_at, revoked_at, and this_computer (true for the computer that asks). Revoke one with method revoke ID. No changes.", errors: "", example: "method devices", remote: true },
  revoke: { usage: "method revoke DEVICE_ID [--server URL]", purpose: "Revoke a computer's Method access.", arguments: "Use the exact ID from method devices. This changes account access.", result: "Server JSON confirmation. The selected device can no longer use that credential.", errors: "Unknown device ID.", example: "method revoke device_example", remote: true },
  runs: { usage: "method runs [--method WORKFLOW_ID] [--server URL]", purpose: "Read saved run summaries.", arguments: "Default: all methods. --method filters the list.", result: "Server JSON containing runs. No changes.", errors: "", example: "method runs --method wf_example", remote: true },
  logs: { usage: "method logs RUN_ID [--server URL]", purpose: "Read saved run evidence before a repair.", arguments: "Use a run ID from method runs. Saved logs may be incomplete if upload failed.", result: "Server JSON containing the run, inputs, outputs, checks and events. No execution or changes.", errors: "Missing run.", example: "method logs run_example > run.json", remote: true },
  sync: { usage: "method sync RUN_DIRECTORY [--server URL]", purpose: "Retry upload of records from an existing local run.", arguments: "Directory must contain method-sync.json. Default destination is the saved run's server. Do not use a new business run to repair an upload.", result: "Upload status text. Updates dashboard records and local sync metadata. Does not execute steps.", errors: "Missing run/sync records; access or network error. Keep the original run directory and retry.", example: "method sync .method-runs/wf_example/saved-run", remote: true },
  run: { usage: "method run FILE.method [OPTIONS]\nmethod run NAME.compare [OPTIONS]\nmethod run WORKFLOW_ID [--version VERSION_ID] [--server URL] [OPTIONS]\nmethod run NAME [OPTIONS]", purpose: "Run a local .method file, or a saved Method by ID or by its name in your workspace. When this computer is signed in, a run of a local file starts at once and saves in the background: the version of the file's content and the run's records go to the dashboard through the outbox (~/.cache/method/outbox), and the last line says Saved as version N, or Will save when online; without sign-in the records stay in .method-runs. Steps whose definition and inputs match an earlier accepted run on this computer are reused.", arguments: `Models come from the Method's models: (or the account default). --workspace selects a different helper folder. See method authoring execution. Optional --state FILE initializes state for a new run. Resume with --resume --run-dir DIR; authorize unfinished work with --retry STEP:ITERATION.

--inputs FILE: JSON input values.
--inputs-from RUN_ID: use the inputs of that run; --inputs FILE overrides single values.
--run-dir DIR: the folder for this run's records (new runs too; default .method-runs/ID).
--resume: continue the same saved run with its saved models.

## Comparisons

A NAME.compare file asks one question about two or more agents and answers "ARM is better" or "Can't tell yet". Read method authoring comparisons before writing one. method publish NAME.compare saves it as a draft and prints its page, so the user can review every part before any run; the page asks them one question at a time. method publish and method run print their answers for you: make each change, then publish again; the run does not start while an answer waits for a change. method run NAME.compare checks the file, asks to run the trial, runs it (what each arm received, what happened to each correction, and the start of every checking input with 2 learners per arm), and asks to start the full run. The person says yes on the page, and a later run goes on; or, when they say it to you, pass their answer with method answer RUN_ID --answer '{"start": true}' for the trial or '{"go": true}' for the full run. A later run of the same file does not ask again. The start line and the result link to the comparison's page on the dashboard. A failed run stops with a plain error; run the comparison again and finished runs are reused. A changed measure grades again without running the arms. Events that change the model cannot run yet.
--rerun STEP: run this step again even when an earlier run can be reused. Repeat for more steps.
--fresh: run every step; reuse nothing.
--verbose: print runtime events.
NAME: the name of a Method in your workspace (not case-sensitive), run as method run ID runs it: the newest version. When several Methods have the name, the run does not start; the result lists their names and IDs (exit 2).
Before a signed-in run of a FILE, the file takes the newest version of its Method. When a teammate saved a newer version, an unchanged file takes it, and a changed file combines it step by step and file by file; one line on stderr says whose version it took and which of your changes are kept. When you and a teammate changed the same step or the same script file, nothing runs and no file changes: the result has status needs_you and both texts of each part (exit 2). Combine them in the file, then run again. Offline, the file runs as it is, with one line. --resume does not change the file.
First, the outcomes of fixes of this Method that nobody has seen yet are printed, one line each. Then corrections of the Method that wait (from the dashboard, an answer, or a fix that stopped) start a fix in the background, as method judge does, with one line on stderr; the run does not wait for it. After a run that completed, its output is checked in the background against the corrections that fixes of the last 30 days answered; nothing runs again, and a problem that comes back twice is reported on the next run.
When the same run (the same version and the same inputs) is already going in your workspace, one line says who started it and links to it; this run starts too. To find it, each run record has a sha256 of its inputs; a run whose content stays on devices (run_data: device) sends none, because a hash of short inputs can show them.
A Method that uses shared state (method state) waits while another person's run holds the state, with one line, and starts when it is free. A run that stopped while it held the state stops this run, and the line names the person who must check it.
A Method whose declared secrets are not on this computer stops before the first step with the list of missing keys, each with its method secret set command. A step that stops because a file is not on this computer names the file and who saved this version.
Use method doctor to check the installed Node and configured tools.`, result: "When signed in, the start line and the final result have dashboard: the link to the run's page; give it to the user when the run starts. Progress, then the final result as JSON on stdout; a run that stopped has failure (owner, headline, step, next), and a failed run also prints Failed, Whose problem, and Next lines on stderr. Local result.json and run evidence. The runtime executes the method's declared scripts, calls, agents, and checks. Executes trusted local processes; changes declarations do not enforce permissions. Runs exit 0 on completion, 1 on failure, 2 when human input is needed, and 3 when an observer could not confirm an external change (unconfirmed).", errors: "Missing inputs/access, failed check, timeout, unsafe resume/version mismatch, upload failure. See recovery. Never retry a business write without inspecting its saved changes.", example: "method run wf_example --version v_example --inputs inputs.json", remote: true },
  observe: { usage: "method observe [RUN_DIRECTORY...] [--pending ROOT]...", purpose: "Make the effect observations that are due for finished runs.", arguments: "Without directories, checks runs with open effects under .method-runs and the Method cache. Runs only observers and judges; never repeats an action. Schedule it, for example hourly, so late evidence such as a bounce reaches the run.", result: "JSON with each run's new verdicts, status, and next observation time. A synced run whose status changed is uploaded again.", errors: "Locked run, changed bundle, or a missing observer credential.", example: "method observe --pending .method-runs" },
  test: { usage: "method test FILE [--case ID]... [--baseline OLD_FILE] [--new ID]... [--cases DIR] [--once | --runs N [--min-pass N]] [--live STEP]... [--no-judge-cache] [--keep-dir DIR]", purpose: "Replay recorded cases against this version of a Method. Every case must pass.", arguments: "Cases are in cases/ beside the Method. Unchanged steps return their recorded outputs; changed steps run; each attempt works on its own copy of the files the recorded run read, so a changed step that writes files runs safely; a Method tool that sends or changes something returns a stand-in instead. --baseline also runs each case on the old version, to show what the change fixed or broke, and answers which version is better: the new one when it fixes a case and breaks none, the old one when it breaks a case and fixes none, else can't tell yet. --once runs each case once; --runs N and --min-pass N replace each case's own counts. --live STEP runs that step live even when it matches the recording. --no-judge-cache judges again instead of reusing earlier judgments. --keep-dir keeps each attempt's run folder there.", result: "JSON report with a verdict per case and passed:true when no case blocks the change; with --baseline also comparison: {answer, reason}. Exit 0 or 1.", errors: "Unknown case or step, invalid Method, or setup errors.", example: "method test task.method --baseline task-before.method --new bounce-reported" },
  case: { usage: "method case new|retire|list FILE ...", purpose: "Keep a correction as a recorded case that every later version must pass.", arguments: "Use method help case new, method help case retire, or method help case list.", result: "See the subcommand.", errors: "Unknown action. Choose new, retire, or list.", example: "method help case new" },
  "case new": { usage: "method case new FILE --id ID --note TEXT (--run BAD_RUN | --passing-run GOOD_RUN | both) (--rubric SENTENCE... | --expect FILE) [--ref outputs.NAME] [--context REF]... [--accept-conflict TEXT]", purpose: "Turn a correction into a recorded case.", arguments: "--run is the run that went wrong; the case must fail on it. --passing-run is the run the person accepted after the fix; the case must pass on it. With only --passing-run, the case pins behaviour that is already right. --rubric is a plain sentence that must be true of the output (repeatable); a model judges it with quotes. --ref selects the output to judge; the default is the Method's result. --context REF gives the judge other values to check against, such as the sources or the person's words (outputs.NAME or inputs.NAME); they are read, not judged. --expect FILE gives exact checks instead: {kind: equals, ref: outputs.NAME, value}, {kind: status, in: [STATUS]}, {kind: effect, effect: STEP/ITERATION/NAME, verdict: [VERDICT]}, or {kind: predicate, runtime: node, entrypoint: check.mjs}. --redact FILE maps recorded text to replacements. --accept-conflict TEXT keeps a case that conflicts with an instruction of the Method, with the person's answer.", result: "The saved case, with its result on each run. Its author is the signed-in person, so a refusal and the run notice name whose case it is. A case that the bad run already meets is refused: it does not capture the problem, or the note does not match the run. A case that can pass only by breaking an instruction of the Method's model steps is refused (case_conflicts): the error names the rule and the instruction.", errors: "A case that does not fail on the bad run, or does not pass on the passing run; a case that conflicts with an instruction; an existing ID; an unreadable run.", example: "method case new report.method --id sources-named --run .method-runs/bad --passing-run .method-runs/fixed --note 'Say which source backs each point.' --rubric 'Every point names the source file that supports it.'" },
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
method run tickets.method --inputs inputs.json   # prints the run's dashboard link at the start and with the result
# change the summary prompt, then:
method run tickets.method --inputs inputs.json   # reuses read, urgency and join; runs summary
\`\`\`
`;
const start = `${firstMethodRules}
${justWorksRules}
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
Optional run_label selects one saved text, number, or boolean value, such as inputs.topic or steps.prepare.outputs.plan.date. Step references must select a step without each or repeat. Choose a short non-sensitive value that tells runs apart. When an input can be empty and a default picks the value, select the step output that holds the resolved value, not the input. The site uses the current Method's reference with each run's recorded inputs or outputs; absent or empty values keep timestamps. Set it with method set task.method /run_label --json '"steps.prepare.outputs.plan.date"'.

Optional run_prompt is plain text for the outside agent that starts a saved Method. Write which Method to run, where each input comes from (for example "as_of is today's date in YYYY-MM-DD"), and what to show when finished. Leave out SDK, runtime, and version details. Save it with the Method version and update it when inputs or outputs change. The copy button appends the exact version link and shared CLI setup; do not repeat them in run_prompt. This field is not a step prompt and does not expand variables. Set it with method set task.method /run_prompt --text-file run-prompt.txt.

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

Use method run FILE_OR_ID [--inputs inputs.json] [--inputs-from RUN_ID] [--state state.json] [--run-dir DIR] [--workspace HELPERS_FOLDER] [--background].
A Method needs no configuration file. What changes the result is in the Method: models, limits, tools, and secrets (the names). What belongs to this computer is in ~/.config/method/computer.json: method config (own model key) and method bind (folders and connections). python and node are found on PATH and prepared automatically. A saved version carries its helpers; versions saved without files still need --workspace DIR.

## Models

A call or agent step names model: NAME from the Method's models: ({NAME: provider/model | {model, max_output_tokens, reasoning_effort}}), a model ID such as openai/gpt-6-luna, or default. A step without model uses default: the user's own subscription first, which is the Claude Code or Codex that started the run, else an installed and signed-in Claude Code or Codex (Claude Code when both are); the account's default hosted model on account credit only when no local agent is signed in. If the local agent fails, for example at a usage limit, the step fails like any other outside service; run again later. Each step's run record names the backend and model that ran it (model.used). Hosted models need no key and no local agent. They are private by default: requests go only to providers that do not train on them and keep no copy (zero data retention). method models lists those models; validate warns with model_not_private when a step names another, and hosted runs refuse it. Hosted models and classification share the account's model credit; the run summary reports usage.cost_usd. When the credit is used, run method config model-key: hosted model and classify steps on this computer then call OpenRouter with the user's own key.
A models: entry {agent: codex | claude, model, reasoning_effort} runs the steps that name it with that local agent, which must be installed on the computer that runs the Method. A step that names a model keeps it; no flag or computer setting overrides the Method's models:. Declared tools reach the agent through a temporary local MCP connection; no persistent agent configuration is edited. The model choice of a run stays fixed on resume.

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
1. Record it: method judge RUN_ID wrong --note "the user's words" (--corrected FILE when they gave the right result). Use their words even when they are vague. Do not ask them to confirm it, and do not edit the Method for the same correction. method judge returns at once with one line and tests a fix in the background, on a private copy of the run, with every message held back.
2. Get the result with method wait. It waits up to 100 seconds; when it says it is still working, run it again. Tell the user the line it prints, in their words.
3. After a fix, show the user what the fixed agent gives now: method wait prints the output from the test. Do not run the Method again to show it, above all when it sends or changes things: that would send it again.
4. When method wait prints a question, show it to the user word for word and never answer it yourself. Send their own words with the command it prints: method answer JUDGMENT_ID "their words". Then run method wait again.
5. When the user wants to see or remove what the agent learned from corrections, run method learned FILE, and method learned FILE --remove NUMBER. To go back to how the agent worked before Method's last change, run method undo.
6. For a rule the user states outside a run, record it: method case new FILE --id ID --run BAD_RUN --passing-run GOOD_RUN --note "the user's words" --rubric "plain sentence that must be true" (repeat --rubric for each rule). --ref names what to judge (default: the Method's result; result, outputs.NAME, file:PATH for a file the run wrote, or effect:NAME for what a tool or effect sent). When a rule compares the output with the sources, add --context with the step output that holds them, for example --context outputs.material. Make each sentence fail on the bad run; case new warns about one that does not. For an exact value, use --expect instead.
7. case new refuses a case that can pass only by breaking one of the Method's instructions (case_conflicts). Show the user the rule and the instruction, and ask which one is right. When the user says the case is right, change the instruction first and record the case again. Add --accept-conflict "the user's answer" only when the user wants both.
8. After any edit by hand, run method test FILE. Every case must pass. method publish refuses a version that breaks a case.
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
For ask, the run stops (exit 2) with its run_id and the question; pass the user's actual answer with method answer RUN_ID --answer JSON, and the run continues. Checks still run.
A save never blocks a run: a run that cannot save says "Will save when online", and any later method command sends the outbox.
State commits after checks. A local checkpoint cannot roll back an external write. Inspect external state before an explicit retry.
Two computers can save different content of one Method; each becomes a version with its parent. Going back to earlier content finds its existing version. The id: line keeps a renamed or moved file on its Method; method new-id FILE makes a copy a new Method. On one computer a Method is saved from one file (every checkout of one Git repository counts as one): a copy in another folder or a temporary folder does not run while that file exists, and the error names the file to change. Before a run, a fix or a publish, the file takes the newest version of its Method: an unchanged file takes it, a changed file combines it step by step and file by file, and a step or a script file that you and a teammate changed in different ways stops the command with both texts, until you combine them in the file. A save that a teammate's newer save overtook is kept beside it, and the next run combines the two.
Use method sync RUN_DIRECTORY to repair a dashboard upload without executing the method again.
After a failed action with effects, failure.next.text lists what the observers saw. A confirmed effect means the change happened: do not retry the action. A run that is unconfirmed finished all its steps; inspect effects.jsonl and the external system before relying on its result.
`;

const comparisonsChapter = () => `# Comparisons

When the user asks whether one agent is better than another, write a NAME.compare file (YAML or JSON), publish it as a draft with \`method publish NAME.compare\`, and run it with \`method run NAME.compare\`. Method checks the file, asks the user on the page to run the trial, runs it, measures the noise, asks the user to approve the full run, runs every cell, and answers "ARM is better" or "Can't tell yet" by a fixed rule. The comparison's page on the dashboard shows every value with who decided it: you (the user), the writer (you, the agent that wrote the file) or Method.

## The seven rules

1. Write the question so that it names the treatment and the test.
2. Mark \`decided_by_you\` only for a value the user stated. The question is the user's only when the file has it in the user's own words; when you rephrase it, it is the writer's. Everything else is the writer's choice, and the page asks the user to review it. Naming an arm (\`arms.plain\`) says which agent it is; a plain arm's starting instructions are the user's only as \`arms.plain.instructions\`.
3. Write corrections as the expert would say them: "It needs to be X because Y". Use the expert's real corrections when you have them.
4. One main measure, in plain words, scored on what each input has.
5. Assumptions are only things that must be true for the answer to mean something. Each one has "if false" and "how to check". Notes go with their part. The user reads the question, the difference, the notes and the assumptions on the page: write them in the user's words, name files and folders by what they are ("the 30 corrections", "the expected answers"), never by their path, and leave out how Method gives each arm its corrections, which the page says. The difference is one short phrase, such as "How a correction changes the agent."
6. Publish the draft with \`method publish NAME.compare\` and give the user the link before any run, so they can review every part. The page asks them one question at a time: whether to keep each of your choices, and whether to run the trial. \`method publish\` and \`method run\` print their answers: make each change they ask for, add each value they kept to \`decided_by_you\` as printed, and publish again. When they say yes to the trial, run it.
7. After the trial, read one run of each agent. The page asks the user to approve the full run; when they say yes, run the comparison again.

When a correction's words are yours and not the expert's, say so in the event's \`source\` ("written by us: …"): the page asks the expert, any member of the workspace, whether they would give it, and asks a member whom an assumption's check names whether it is true.

## What Method decides

Do not write these into the file; Method applies them to every comparison and shows them on the page.

- Every arm runs on the same model and effort, with no personal instructions, memory, settings or plugins, and with the same task prompt, tools and output file. A plain arm takes the Method arm's model. No arm uses the web unless \`tested: tools\`; arms differ in model only with \`tested: model\`.
- Every arm hands in the file \`deliverable\` names; a plain agent's last message is not its output.
- With corrections, a plain arm learns from each correction this way: a Claude Code (or Codex) session gets the correction, the wrong output of a training run, the task's files as the agent got them, and the earlier corrections in order, and edits the agent's instructions file. A Method arm gets each correction through \`method judge\`; its fix runs on the model of the Method's own agent steps, so on the arms' model. Corrections arrive one at a time; each fix or edit has up to 2 hours, and the next correction or checkpoint waits until the fix has ended completely (its later check of earlier corrections too).
- A project arm ({project: claude, plugins?: [method], files?: FOLDER, model?, effort?}) is Claude Code used as a person uses the desktop app, compared only with other project arms. Its state is one project folder (empty, or the files given). Each event is one new chat in the folder: the input's folders go in, the first message is \`message\` filled with the input's values (the first chat of a project gets \`first_message\` before it), and a correction is the second message of the same chat ("That's right, thanks." when the feedback writer finds nothing wrong). Only the folder carries over; Claude Code's memory is off. plugins: [method] loads Method's plugin and puts the method CLI on PATH, signed in to your account; without it there is no plugin and no method command. A checkpoint is measured in fresh copies of the project, one new chat per checking input. The page says what each chat did with a correction (files written, Methods built, method commands run). \`treatment.probe\` asks a question in a copy at each later checkpoint; code measures get the answer as probe.
- \`runs\` counts separate copies of each arm (learners). Each copy gets the full treatment; each checkpoint measures each copy once per input. The trial gives one copy of each arm its first 2 corrections (enough to see what it received, what changed it, and how long a fix takes); the full run gives every copy the rest.
- A correction is received when its fix applied a tested change, found that the run already does what it asks (no change needed), or found no fix, or when the session that edits the instructions finished, or when a feedback writer found nothing wrong (was right, or no feedback when it checked only a part). The page and the trial count apart the corrections that changed the agent (a tested change applied, or the instructions edited). A fix that could not test or that stopped (a usage limit too) is not received, and the comparison stops with the reason. Run it again: a stopped fix is fixed again on the same correction, never given twice.
- One Claude judge marks each item met, partly or not met. Partly counts as half. It reads every source the agent read in full.
- The trial runs every checking input at the start with 2 copies of each arm, and shows how much the copies differ there. That noise does not stop anything: with corrections, the noise that decides is how differently copies learn, so the decision checks the spread between copies of the same arm at the point that decides. An arm is better only when its lead is at least the margin and larger than that spread. With one copy of each arm there is no spread to compare, so the answer is "can't tell yet": give each arm at least 2 copies (\`runs\`, 4 or more is better).
- When the main measure is a share from 0 to 1 (a rubric, a checklist, or a code measure whose start values are all from 0 to 1) and every arm already scores more than 1 minus the margin at the start, no arm can lead by the margin, and the comparison stops before approval: the test is too easy. Use harder inputs or a stricter measure.
- Usage per correction is shown for each arm and does not decide.

## The file

Required: \`question\`; \`arms\` (a short name for each: a .method file, {agent: claude|codex, instructions: FILE}, or {project: claude, plugins?: [method]}); \`difference\`; \`inputs\` (JSON files of input values or case IDs, the same for each arm; an input's own folder, inputs/ID/ beside inputs/ID.json with one subfolder per files connection, replaces the arm's folders of those names for that input. This holds for teaching inputs too: a training run sees only its own input's folders); \`measure\` ({name, description, and one of code: SCRIPT, rubric: [sentences], checklist: expected (each input's expected answer is its checklist; add covered: true to score only the items that corrections given so far cover), person: QUESTION}); \`rule\` ({margin, min_runs, at?, guard?: {measure, max_drop}}); \`runs\` (learners per arm).

Optional: \`deliverable\` (the file each arm hands in, such as work/reply.md; needed with a plain or project arm); \`message\` and \`first_message\` (files; needed with project arms); \`treatment\` ({events: [{correction, input, source?}, {feedback: WRITER, input, source?} or {input}], checkpoints, seed?, feedback_writers?: {WRITER: {code: SCRIPT} or {judge: INSTRUCTION}}}); \`teaching\` (the inputs the events use); \`expected\` ({INPUT: FILE}; for a checklist, "- item" lines or JSON [{text, covered_by: [EVENT, ...]}], events by their place in the file; also the hidden answer of each feedback event's input); \`other_measures\`; \`assumptions\` (text, or {text, if_false, check}, or {text, limit: true} for a known limit); \`notes\` ({PART: [text]}); \`about_inputs\` ({noun, description, teaching_description, names: {INPUT: NAME}}); \`tested\` (model or tools); \`decided_by_you\` ([PART, PART.FIELD or notes.PART, ...]). \`method validate NAME.compare\` checks the file and lists the writer's choices; \`method schema compare\` prints the full form.

A feedback writer writes each correction from the arm's own output: use one when the expert's feedback depends on what the agent did. After the event's training run, the writer reads that arm's handed-in file (null when none) and the input's hidden expected answer, never which arm it is, and returns the correction that the arm gets. A code writer reads {input, values, output, expected} as JSON on stdin and prints {"correction": TEXT or null, "checked": "all" or the part it checked}; a judge writer is one Claude judge that follows your instruction and says the same. When it checked all of the output and found nothing wrong, the arm is told the output was right. When it checked one part (one clause, one figure) and found nothing wrong there, the arm gets no feedback, because nothing says the rest is right. The page lists the words each copy received.

## Worked example: a support-reply agent with 20 corrections

The support lead corrects a reply agent every week. The user asks whether the Method agent follows those corrections better than plain Claude Code. Both arms get the same 20 corrections on four past tickets, one at a time in one shuffled order, and are measured on three new tickets after every 5. Each new ticket's checklist is its expected answer, and each item names the corrections that cover it. The user named the arms, so only \`arms\` is marked \`decided_by_you\`. The question is the writer's: it rephrases the user's request.

\`\`\`yaml
${readFileSync(join(exampleDirectory('support-replies').directory, 'replies.compare'), 'utf8').trimEnd()}
\`\`\`

The Method arm, its starting instructions, the tickets and the checklists are in \`method authoring example support-replies\`.
`;

export const guideTopics = ["start", "concepts", "execution", "examples", "example", "recipes", "recovery", "commands", "comparisons"] as const;
export function authoringGuide(topic = "start", exampleId?: string): string {
  if (exampleId && topic !== 'example') throw Error('Use method authoring example EXAMPLE_ID.');
  const catalog = () => exampleCatalog();
  const topics: Record<string, () => string> = {
    start: () => start + '\n' + catalog(), concepts: () => concepts,
    execution: () => execution, examples: catalog,
    example: () => exampleId ? renderExample(exampleId) : catalog(),
    recipes: () => recipes, recovery: () => recovery, comparisons: comparisonsChapter,
    commands: () => '# Command reference\n\nLocal authoring commands edit draft files. A signed-in run saves a version when the file changed. publish marks a version for sharing. run also executes a saved version by ID.\n\n' + serverHelp + '\n' + exitHelp + '\n\nCommon errors:\n' + commonErrors + '\n\n' + Object.keys(commandHelp).map(name => renderCommand(name, false)).join('\n'),
  };
  if (topic === 'all') return ['start','concepts','execution','recipes','recovery','comparisons','commands'].map(key => topics[key]!()).join('\n\n');
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
Results and improvements: judge, wait, answer, learned, undo, changes.
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
