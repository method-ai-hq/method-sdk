import { runCurrentFile } from "./current-runtime.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { executionLabel } from "../../workflow-language/src/schema.js";
import { loadWorkflow } from "../../workflow-language/src/validate.js";
import { renderPrompt } from "../../method-document/src/conversion-report.js";
import { checkNode } from "./doctor.js";
import { writePrivateJson } from "./files.js";
import { isWorkflowLink, saveWorkflowLink } from "./link.js";
import { inspectRun } from "./inspect.js";
import type { MethodSync } from "./method-sync.js";
import { accountNeeds, checkConfiguration, resolveAgentProfiles } from './capabilities.js';
import { MethodClient } from "./method-client.js";
import { MethodSync as Sync } from "./method-sync.js";
import { prepareVersion, savedLine, methodContent } from "./versions.js";
import { Outbox, savedVersions } from "./outbox.js";
import { readComputerSettings } from "./computer-settings.js";
import { localSetup } from "./local-setup.js";
import { readDocument } from "./authoring.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const help = "Use method run, steps, prompt, inspect, or doctor. See method help.";
export function parse(args: string[]) {
  return parseArgs({ args, allowPositionals: true, options: {
    server: {type:"string"}, agent: {type:"string"}, background: {type:"boolean"}, state: {type:"string"}, out: {type:"string"}, inputs: {type:"string"}, workspace: {type:"string"},
    "run-dir": {type:"string"}, fresh: {type:"boolean"}, rerun: {type:"string",multiple:true}, resume: {type:"boolean"}, human: {type:"string"}, retry: {type:"string",multiple:true},
    "include-files": {type:"boolean"}, verbose: {type:"boolean"}, help: {type:"boolean"}
  }});
}
export async function run(target: string, flags: ReturnType<typeof parse>["values"], syncFactory?: () => MethodSync): Promise<void> {
  const path = isWorkflowLink(target) ? (await saveWorkflowLink(target, process.cwd())).path : resolve(target);
  const legacy = (await import("./method-issues.js")).legacyIssues(path);
  if (legacy.length) throw Error(legacy.map(issue => `${issue.code}: ${issue.message} ${issue.fix}`).join('\n'));
  loadWorkflow(methodContent(readDocument(path)));
  const notice = await (await import("./quality.js")).casesNotice(path);
  if (notice) process.stderr.write(notice + "\n");
  const update = await (await import("./update.js")).updateNotice();
  if (update) process.stderr.write(update + "\n");
  (await import("./prepare.js")).pruneCachedRuns();
  flags = { ...flags, "run-dir": flags["run-dir"] ?? join(process.cwd(), ".method-runs", randomUUID()) };
  const account = syncFactory ? undefined : await accountSync(path, flags);
  try { await runCurrentFile(path, flags, syncFactory ?? account?.sync); }
  finally {
    if (account) {
      // The run's records were sent when it finished; this sends what is left and says where the version is.
      await account.outbox.drain();
      process.stderr.write(savedLine(account.client, account.outbox, account.version) + "\n");
      // Script cards are made after the run, so that this run's inputs can be replayed. They never delay or fail it.
      if (savedVersions(account.client.server)[account.version.version_id]) (await import("./explain.js")).startBackgroundExplain(path, account.version.workflow, account.version.version_id, account.client.server);
    }
  }
}

/**
 * When this computer is signed in, each run of a local file belongs to the version of its content. Saving sends no
 * request before the run: the version ID comes from the content, and the outbox uploads the version and the run's
 * records while and after it runs. A save failure never stops the run. A run that needs the account starts sign-in.
 */
async function accountSync(path: string, flags: ReturnType<typeof parse>["values"]) {
  const client = new MethodClient(flags.server);
  const runDir = resolve(flags["run-dir"]!), linked = join(runDir, "method-sync.json");
  try {
    const outbox = new Outbox(client);
    if (flags.resume) {
      if (!existsSync(linked) || !client.token()) return undefined;
      const state = JSON.parse(readFileSync(linked, "utf8"));
      const version = await prepareVersion(client, outbox, path);
      if (version.version_id !== state.version_id) throw Error("The file changed since this run started. Resume runs the version it started with; its records stay on this computer.");
      return { client, outbox, version, sync: () => new Sync(client, runDir, state.workflow_id, state.version_id, state.id, readDocument(path).run_data === "device", outbox) };
    }
    const method = readDocument(path);
    const setup = await localSetup(path, flags);
    const needs = accountNeeds(method, setup.config, setup.agent);
    if (needs.classification && !client.token()) await client.login();
    if (!client.token()) { process.stderr.write(`Sign in to keep versions and runs in your account${needs.models ? " and to use hosted models" : ""}: method login\n`); return undefined; }
    const version = await prepareVersion(client, outbox, path);
    return { client, outbox, version, sync: () => new Sync(client, runDir, version.method_id, version.version_id, undefined, method.run_data === "device", outbox) };
  } catch (error) {
    process.stderr.write(`Not saved to your Method account: ${(error as Error).message} The run continues on this computer.\n`);
    return undefined;
  }
}
export async function localMain(args = process.argv.slice(2)) {
  const parsed = parse(args);
  const [command, target] = parsed.positionals;
  const flags = parsed.values;
  if (flags.help || !command) { process.stdout.write(help); return; }
  if (command === "inspect") {
    if (!target || parsed.positionals.length !== 2 || !flags.out) throw new Error("Use method inspect RUN_DIRECTORY --out inspection.json.");
    const output = resolve(flags.out);
    if (existsSync(output)) throw new Error("INSPECTION_EXISTS: choose a new output file.");
    writePrivateJson(output, inspectRun(target, { includeFiles: flags["include-files"] ?? false }));
    process.stdout.write(`Saved run evidence: ${output}\nContains run inputs and results. Load it in the method viewer; no upload occurs.\n`);
    return;
  }
  if (command === "doctor") {
    if (parsed.positionals.length !== 1) throw new Error(help);
    const node = checkNode();
    process.stdout.write(node.detail + "\n");
    if (!node.ok) { process.exitCode = 1; return; }
    const config: any = {allow_local_processes:true}, agent = flags.agent ?? readComputerSettings().agent;
    // Without a local agent, model steps use hosted models after method login; scripts need no agent.
    try { config.models = await resolveAgentProfiles({steps:{agent:{do:{kind:'agent',model:'default'}}}}, config, agent); }
    catch (error: any) { if (agent || error.code !== 'needs_input') throw error; process.stdout.write('No local agent found. Model steps use hosted models after method login.\n'); }
    await checkConfiguration(config);
    process.stdout.write('Runtime configuration checked. No method was run. Use method validate FILE to check the Method and its declared dependencies.\n');
    return;
  }

  if (!["steps", "prompt", "run"].includes(command) || !target || parsed.positionals.length !== 2) throw new Error(help);
  if (command === "run") return run(target, flags);
  const workflow = loadWorkflow(methodContent(readDocument(resolve(target))));
  if (command === "steps") {
    process.stdout.write(Object.entries(workflow.steps).map(([id, step], index) => `${index + 1}. ${id}: ${step.name ?? id.replaceAll("_", " ")} (${executionLabel(step).toLowerCase()}; ${step.check ? "checked" : "unchecked"})`).join("\n") + "\n"); return;
  }
  process.stdout.write(renderPrompt(workflow) + "\n");
}
