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
    return `No step ran. Run method secret find to see which nearby files hold ${names}, then method secret import FILE ${names}; or ask the user to enter each one with method secret set NAME (a private form in their browser). Never open or print a key file, and never ask for a value in chat.`;
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
  if (['improve','proposals','apply'].includes(args[0] ?? '')) return (await import('./proposals.js')).proposalCommand(args, clientFactory);
  await (await import('./proposals.js')).autoApply(args, clientFactory);
  if (args[0] === 'worker' || args[0] === 'keys') return (await import('./worker.js')).productionCommand(args, clientFactory);
  if (args[0] === '__run-data') return (await import('./run-data.js')).runDataCommand(args.slice(1));
  if (args[0] === 'connect' || args[0] === 'answer') {
    const server = parseArgs({ args: args.slice(1), strict: false, options: { server: { type: 'string' } } }).values.server;
    const client = clientFactory(typeof server === 'string' ? server : DEFAULT_SERVER);
    const { connectCommand, answerCommand } = await import('./connect.js');
    process.stdout.write(JSON.stringify(await (args[0] === 'connect' ? connectCommand : answerCommand)(args.slice(1), client), null, 2) + '\n');
    return;
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
  if (args[0] === '__checks' && args[1]) return (await import('./method-issues.js')).checksWorker(args[1]);
  if (args[0] === 'models' && !args.includes('--help')) return (await import('./hosted-models.js')).modelsCommand(args.slice(1), clientFactory);
  if (args.length === 1 && args[0] === "--version") { process.stdout.write(`Method SDK ${packageInfo.version}; runtime ${runtimeInfo.version}; current format method/3.4\n`); return; }
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
  const authorFile = command === "publish" || command === "explain" ? target : undefined;
  if (command === "guard-keys") return (await import("./guard-keys.js")).guardKeysCommand();
  if (command === "config") return (await import("./computer-settings.js")).configCommand(rest.slice(1));
  if (command === "new-id") {
    if (!target || rest.length !== 2) throw Error("Use method new-id FILE.");
    const { newMethodId, writeMethodId } = await import("./versions.js");
    const id = newMethodId(); writeMethodId(safePath(target), id);
    process.stdout.write(JSON.stringify({ file: safePath(target), method_id: id }, null, 2) + "\n"); return;
  }
  if (!["status","login","logout","devices","revoke","list","get","steps","step","run","runs","logs","publish","explain","bind","state"].includes(command)) throw Error(help);
  const client = clientFactory(values.server ?? DEFAULT_SERVER);
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
    const update = await (await import("./update.js")).updateNotice();
    process.stdout.write(JSON.stringify({ installed: true, server: client.server, signed_in: signedIn, ...(!signedIn ? { next: "Run method login to sign in with browser approval." } : {}), ...(update ? { update } : {}) }, null, 2) + "\n");
    return;
  }
  // Without sign-in, explain prints one line and stops: script cards need a hosted model.
  if (command === "explain") { await (await import("./explain.js")).explainCommand(client, rest.slice(1)); return; }
  // The first real command starts browser approval if no credential is saved.
  if (!client.token()) await client.login();
  // Any signed-in command sends what is left in the outbox, in the background.
  else (await import("./outbox.js")).sendLeftovers(client);
  if(command==='run'&&client.token()) {try{await client.request('/api/cli/me');}catch(error){if(String(error).includes('401:'))await client.login();else throw error;}}
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
    if (!authorFile) throw Error("Use method publish FILE [--reason TEXT] [--cloud|--workers] [--env NAME].");
    print(await (await import("./cloud.js")).publishWithPlacement(client, rest, () => publish(client, safePath(authorFile), values.reason, (values["accept-failing-case"] ?? "").split(",").map(id => id.trim()).filter(Boolean))));
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
      await restorePackage(saved, resolve(out, ".."), client);
      // The id: line links the file to its Method; its content is the saved version.
      const { methodContent, writeMethodId } = await import("./versions.js");
      writeDocument(out, methodContent(workflow));
      writeMethodId(out, saved.workflow_id);
      (await import("./outbox.js")).recordCheckout(client.server, saved.workflow_id, saved.version_id, saved.version_number, methodContent(workflow));
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
