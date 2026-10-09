#!/usr/bin/env node
import packageInfo from '../package.json' with { type: 'json' };
import runtimeInfo from '@withmethod/runtime/package.json' with { type: 'json' };
import { startRunWorker, waitForRun, cancelRun, workerAlive } from './run-worker.js';
import { methodCache } from './prepare.js';
import { restorePackage } from './method-files.js';
import { publish } from './versions.js';
import { runSaved } from './run-saved.js';
import { bindInput, bindConnection } from './bindings.js';
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { localAuthoring, authoringPath, readDocument, writeDocument } from "./authoring.js";
import { workflowDocumentDigest } from "../../contracts/src/identity.js";
import { MethodClient, DEFAULT_SERVER } from "./method-client.js";
import { MethodSync } from "./method-sync.js";
import { progressMain } from "./progress.js";
import { run, parse, localMain } from "./local-cli.js";
import { writePrivateJson } from "./files.js";
import { loadWorkflow } from "../../workflow-language/src/validate.js";

import { methodHelp, overviewHelp as help } from "./method-help.js";
import { fixFor } from "@withmethod/runtime/runner.js";

/** The next step for a failure before the first step. */
export function setupFix(error: any) {
  if (error.code === 'missing_secret') {
    const names = (error.missing ?? []).join(' ');
    return `No step ran. Copy the values from a file the user names with method secret import FILE ${names}, or ask the user to enter each one with method secret set NAME (a private form in their browser). Never ask for a value in chat.`;
  }
  return fixFor(error);
}
function safePath(path: string) {
  return authoringPath(path);
}
async function dispatchRunWorker(args: string[], flags: ReturnType<typeof parse>['values'], extra: string[] = []) {
  if (process.env.METHOD_RUN_WORKER === '1' || (!/[/\\]method\.(?:js|ts)$/.test(process.argv[1] ?? '') && !flags.background)) return false;
  if (flags.resume && !flags['run-dir']) throw Error('Resume needs --run-dir.');
  const directory = safePath(flags['run-dir'] ?? join(methodCache(), 'runs', randomUUID()));
  const workerArgs = [...args.filter(arg => arg !== '--background'), ...extra];
  if (!flags['run-dir']) workerArgs.push('--run-dir', directory);
  await startRunWorker(workerArgs, directory, flags.background);
  return true;
}
export async function methodMain(args = process.argv.slice(2), clientFactory: (server: string) => MethodClient = server => new MethodClient(server)) {
  const earlyHelp=methodHelp(args);if(earlyHelp!==undefined){process.stdout.write(earlyHelp);return;}
  if (args[0] === 'deploy') {
    const p=parseArgs({args:args.slice(1),options:{'from-run':{type:'string'},approve:{type:'string'},run:{type:'string'},login:{type:'string'},agent:{type:'string'},inputs:{type:'string'},resume:{type:'string'}}});
    if([p.values['from-run'],p.values.approve,p.values.run,p.values.login].filter(Boolean).length!==1)throw Error('Use method deploy --from-run DIR, --approve ID, --run ID, or --login ID.');
    const {prepareDeployment,approveDeployment}=await import('./deploy.js');
    const result=p.values['from-run']?await prepareDeployment(safePath(p.values['from-run'])):p.values.approve?await approveDeployment(p.values.approve):p.values.login?await (await import('./runner-deploy.js')).loginRunner(p.values.login,p.values.agent):await (await import('./runner-deploy.js')).runDeployment(p.values.run!,p.values.inputs? safePath(p.values.inputs):undefined,p.values.resume);
    process.stdout.write(JSON.stringify(result,null,2)+'\n');if(result.status==='needs_input')process.exitCode=2;return;
  }
  if (args[0] === 'browser' && args[1] === 'connect') {
    const {configureBrowser}=await import('./browser.js');
    const p=parseArgs({args:args.slice(2),options:{name:{type:'string'},cdp:{type:'string'}}});
    process.stdout.write(JSON.stringify(configureBrowser(p.values.name??'default',p.values.cdp))+'\n');return;
  }
  if (args[0] === '__worker') {
    const file = args[1]!; const directory=resolve(file,'..');
    writePrivateJson(join(directory,'worker.json'),{status:'running',pid:process.pid});
    try { await methodMain(JSON.parse(readFileSync(file,'utf8')).args,clientFactory); }
    catch(error:any){
      // A run that fails before its first step still prints one result that says why and what to do.
      const failed={status:error.code==='needs_input'?'needs_input':'failed',run_dir:directory,code:error.code??'setup_failed',error:error.message,...(error.missing?{missing:error.missing}:{}),fix:setupFix(error)};
      if(!existsSync(join(directory,'summary.json')))writePrivateJson(join(directory,'summary.json'),failed);
      process.stdout.write(JSON.stringify(failed,null,2)+'\n');process.exitCode=error.code==='needs_input'?2:1;
    }
    finally {writePrivateJson(join(directory,'worker.json'),{status:'finished',pid:process.pid,exit_code:Number(process.exitCode??0)});}
    return;
  }
  if (['wait','cancel','run-status'].includes(args[0]??'')) {
    if(!args[1])throw Error('Supply the local run directory.');
    const directory=safePath(args[1]);
    const result=args[0]==='wait'?await waitForRun(directory):args[0]==='cancel'?cancelRun(directory):{running:workerAlive(directory),...(existsSync(join(directory,'worker.json'))?readDocument(join(directory,'worker.json')):{})};
    process.stdout.write(JSON.stringify(result)+'\n');return;
  }
  if (args[0] === 'secret') return (await import('./secrets.js')).secretCommand(args.slice(1));
  if (args.length === 1 && args[0] === "--version") { process.stdout.write(`Method SDK ${packageInfo.version}; runtime ${runtimeInfo.version}; current format method/3.3\n`); return; }
  if (["observe", "test", "case", "effect"].includes(args[0] ?? "") && !args.includes("--help")) {
    const quality = await import("./quality.js");
    if (args[0] === "observe") return quality.observeCommand(args.slice(1));
    if (args[0] === "test") return quality.testCommand(args.slice(1));
    if (args[0] === "case") return quality.caseCommand(args.slice(1));
    return quality.effectCommand(args.slice(1));
  }
  if (args[0] === 'run' && /^https?:/.test(args[1] ?? '')) {
    const url = new URL(args[1]!);
    const match = url.pathname.match(/^\/methods\/([^/]+)$/);
    if (match) {
      if (url.username || url.password) throw Error('Use a Method dashboard URL without credentials.');
      args = ['run', decodeURIComponent(match[1]!), ...args.slice(2), '--server', url.origin,
        ...(url.searchParams.get('version') ? ['--version', url.searchParams.get('version')!] : [])];
    }
  }
  const localCommand = ["prompt", "inspect", "doctor"].includes(args[0] ?? "")
    || args[0] === "check" && /\.(method)$/i.test(args[1] ?? "")
    || ["run", "steps"].includes(args[0] ?? "") && /\.(method)$|^https?:\/\//i.test(args[1] ?? "");
  if (localCommand) {
    if (args[0] === 'run' && await dispatchRunWorker(args, parse(args).values)) return;
    return localMain(args);
  }
  const requestedHelp = methodHelp(args);
  if (requestedHelp !== undefined) { process.stdout.write(requestedHelp); return; }
  if (args[0] === "progress") return progressMain(args.slice(1));
  if (await localAuthoring(args)) return;
  // Strip only Method flags. Pass run flags unchanged to the existing SDK parser.
  const methodOptions = new Set([
    "server",
    "version",
    "file",
    "reason",
    "method",
    "connection",
    "accept-failing-case",
  ]);
  const values: Record<string, string> = {},
    rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const match = args[i]!.match(/^--([^=]+)(?:=(.*))?$/);
    if (match && methodOptions.has(match[1]!)) {
      const value = match[2] ?? args[++i];
      if (!value || value.startsWith("--"))
        throw Error(`Supply --${match[1]}.`);
      values[match[1]!] = value;
    } else rest.push(args[i]!);
  }
  const [command, target, step] = rest;
  if (!command || command === "--help" || command === "help") {
    process.stdout.write(help);
    return;
  }
  if (command === "sync") {
    if (!target) throw Error("Use method sync RUN_DIRECTORY.");
    await MethodSync.retry(
      safePath(target),
      values.server ? new MethodClient(values.server) : undefined,
    );
    return;
  }
  const authorFile = command === "publish" ? target : undefined;
  const metaFile = authorFile ? safePath(`${authorFile}.method.json`) : undefined;
  const meta = metaFile && existsSync(metaFile) ? readDocument(metaFile) : {};
  if (!["status","login","logout","devices","revoke","list","get","steps","step","run","runs","logs","publish","bind","state"].includes(command)) throw Error(help);
  const client = clientFactory(values.server ?? meta.server ?? DEFAULT_SERVER);
  if (command === "login") {
    await client.login();
    return;
  }
  if (command === "logout") {
    await client.logout();
    process.stdout.write("Method is disconnected.\n");
    return;
  }
  if (command === "status") {
    let signedIn = false;
    if (client.token()) {
      try { await client.request("/api/cli/me"); signedIn = true; }
      catch (error) { if (!/^401:/.test(String((error as Error).message))) throw error; }
    }
    process.stdout.write(JSON.stringify({ installed: true, server: client.server, signed_in: signedIn, ...(!signedIn ? { next: "Run method login to sign in with browser approval." } : {}) }, null, 2) + "\n");
    return;
  }
  // The first real command starts browser approval if no credential is saved.
  if (!client.token()) await client.login();
  else if(command==='run') {try{await client.request('/api/cli/me');}catch(error){if(String(error).includes('401:'))await client.login();else throw error;}}
  const print = (v: unknown) =>
    process.stdout.write(JSON.stringify(v, null, 2) + "\n");
  if (command === "devices") {
    print(await client.request("/api/cli/devices"));
    return;
  }
  if (command === "revoke") {
    if (!target) throw Error("Supply a device ID.");
    print(
      await client.request(
        `/api/cli/devices/${encodeURIComponent(target)}/revoke`,
        "POST",
        {},
      ),
    );
    return;
  }
  if (command === "list") {
    print(await client.request("/api/methods"));
    return;
  }
  if (command === "runs") {
    print(
      await client.request(
        `/api/workspace/runs${values.method ? `?workflow_id=${encodeURIComponent(values.method)}` : ""}`,
      ),
    );
    return;
  }
  if (command === "logs") {
    if (!target) throw Error("Supply a run ID.");
    print(
      await client.request(`/api/workspace/runs/${encodeURIComponent(target)}`),
    );
    return;
  }
  if (command === 'bind') {
    if(target&&step&&values.connection){print(await bindConnection(client,target,step,values.connection,rest.includes('--upload')));return;}
    if (!target || !step || !values.file) throw Error('Use method bind ID NAME --file FOLDER [--upload].');
    print(await bindInput(client,target,step,values.file,rest.includes('--upload'))); return;
  }
  if (command === 'state') {
    if (!target) throw Error('Supply a Method ID.');
    const path = `/api/cli/methods/${encodeURIComponent(target)}/state`;
    if (rest.includes('--enable')) { if(!values.file)throw Error('Supply --file with the initial state JSON.'); print(await client.request(path,'POST',{action:'enable',value:readDocument(values.file)})); }
    else if(rest.includes('--release')) {const id=rest[rest.indexOf('--release')+1];if(!id)throw Error('Supply the stopped run ID after --release. Inspect its actions first.');print(await client.request(path,'POST',{action:'release',run_id:id}));}
    else print(await client.request(path));
    return;
  }
  if (command === "publish") {
    if (!authorFile) throw Error("Use method publish FILE [--reason TEXT].");
    print(await publish(client, safePath(authorFile), values.reason, (values["accept-failing-case"] ?? "").split(",").map(id => id.trim()).filter(Boolean)));
    return;
  }
  if (!target) throw Error(help);
  const path = `/api/cli/methods/${encodeURIComponent(target)}`;
  if (!["get", "steps", "step", "run"].includes(command)) throw Error(help);
  const saved = await client.request<{
    workflow_id: string;
    version_id: string;
    version_number: number;
    workflow: unknown;
    package?: any;
  }>(
    path +
      (values.version ? `?version=${encodeURIComponent(values.version)}` : ""),
  );
  const workflow = command === "get" ? saved.workflow as any : loadWorkflow(saved.workflow);
  if (command === "steps") {
    print({ version_id: saved.version_id, steps: workflow.steps });
    return;
  }
  if (command === "step") {
    const found = step ? workflow.steps[step] : undefined;
    if (!found) throw Error("Step not found. Use method steps WORKFLOW_ID.");
    print({ version_id: saved.version_id, step: found });
    return;
  }
  if (command === "get") {
    const parsed = parseArgs({
      args: rest.slice(2),
      options: { out: { type: "string" } },
    });
    if (parsed.values.out) {
      const out = safePath(parsed.values.out);
      if (existsSync(out))
        throw Error("Choose a new output file; this file already exists.");
      const metadataPath = safePath(`${out}.method.json`);
      if (existsSync(metadataPath)) throw Error("Choose a file without existing Method metadata.");
      await restorePackage(saved, resolve(out, ".."), client);
      writeDocument(out, workflow);
      writePrivateJson(metadataPath, { server: client.server, workflow_id: saved.workflow_id, base_version: saved.version_id, digest: workflowDocumentDigest(loadWorkflow(workflow)), package_digest:saved.package?.digest, digest_format: "document/1" });
      print({
        workflow_id: saved.workflow_id,
        version_id: saved.version_id,
        version_number: saved.version_number,
        file: out,
      });
    } else print({ ...saved, workflow });
    return;
  }
  const flags = parse(rest.slice(2)).values;
  if(await dispatchRunWorker(args, flags, values.version ? [] : ['--version', saved.version_id])) return;
  await runSaved(saved, flags, client);

}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
)
  methodMain().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
