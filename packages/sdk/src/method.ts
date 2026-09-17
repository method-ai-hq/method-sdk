#!/usr/bin/env node
import { startRunWorker, waitForRun, cancelRun, workerAlive } from './run-worker.js';
import { useCompatibleRelease } from './compatible-release.js';
import { methodCache } from './prepare.js';
import { collectPackage, restorePackage } from './method-files.js';
import { runSaved } from './run-saved.js';
import { bindInput, bindConnection } from './bindings.js';
import { existsSync, readFileSync, realpathSync, openSync, closeSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { localAuthoring, authoringPath, readDocument, writeDocument } from "./authoring.js";
import { semanticDigest, workflowDocumentDigest } from "../../contracts/src/identity.js";
import { MethodClient, DEFAULT_SERVER } from "./method-client.js";
import { MethodSync } from "./method-sync.js";
import { progressMain } from "./progress.js";
import { run, parse, localMain } from "./local-cli.js";
import { writePrivateJson } from "./files.js";
import { loadWorkflow } from "../../workflow-language/src/validate.js";

import { methodHelp, overviewHelp as help } from "./method-help.js";

function safePath(path: string) {
  return authoringPath(path);
}
export async function methodMain(args = process.argv.slice(2), clientFactory: (server: string) => MethodClient = server => new MethodClient(server)) {
  const earlyHelp=methodHelp(args);if(earlyHelp!==undefined){process.stdout.write(earlyHelp);return;}
  if (args[0] === '__worker') {
    const file = args[1]!; const directory=resolve(file,'..');
    writePrivateJson(join(directory,'worker.json'),{status:'running',pid:process.pid});
    try { await methodMain(JSON.parse(readFileSync(file,'utf8')).args,clientFactory); }
    catch(error:any){process.stderr.write(error.message+'\n');process.exitCode=error.code==='needs_input'?2:1;}
    finally {writePrivateJson(join(directory,'worker.json'),{status:'finished',pid:process.pid,exit_code:Number(process.exitCode??0)});}
    return;
  }
  if (['wait','cancel','run-status'].includes(args[0]??'')) {
    if(!args[1])throw Error('Supply the local run directory.');
    const directory=safePath(args[1]);
    const result=args[0]==='wait'?await waitForRun(directory):args[0]==='cancel'?cancelRun(directory):{running:workerAlive(directory),...(existsSync(join(directory,'worker.json'))?readDocument(join(directory,'worker.json')):{})};
    process.stdout.write(JSON.stringify(result)+'\n');return;
  }
  if (args.length === 1 && args[0] === "--version") { process.stdout.write("Method SDK 0.7.0; runtime 0.5.0; current format method/3.1\n"); return; }
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
    || args[0] === "check" && /\.(method|workflow)$/i.test(args[1] ?? "")
    || ["run", "steps"].includes(args[0] ?? "") && /\.(method|workflow)$|^https?:\/\//i.test(args[1] ?? "");
  if (localCommand) return localMain(args);
  const requestedHelp = methodHelp(args);
  if (requestedHelp !== undefined) { process.stdout.write(requestedHelp); return; }
  if (args[0] === "progress") return progressMain(args.slice(1));
  if (await localAuthoring(args)) return;
  // Strip only Method flags. Pass run flags unchanged to the existing SDK parser.
  const methodOptions = new Set([
    "server",
    "version",
    "file",
    "base-version",
    "reason",
    "workflow",
    "method",
    "request-id",
    "connection",
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
  if (!values.workflow && values.method) values.workflow = values.method;
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
  const authorFile = command === "save" ? target : command === "create" ? values.file : undefined;
  const metaFile = authorFile ? safePath(`${authorFile}.method.json`) : undefined;
  const meta = metaFile && existsSync(metaFile) ? readDocument(metaFile) : {};
  if (authorFile && meta.server && values.server && meta.server !== values.server.replace(/\/$/, ""))
    throw Error("This draft belongs to another server. Use method get from the intended server into a new file.");
  if (!["status","login","logout","devices","revoke","list","get","steps","step","update","run","runs","logs","create","save","bind","state"].includes(command)) throw Error(help);
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
        `/api/workspace/runs${values.workflow ? `?workflow_id=${encodeURIComponent(values.workflow)}` : ""}`,
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
  if (command === "create" || command === "save") {
    if (!authorFile || !metaFile) throw Error("Use method create --file FILE or method save FILE --reason TEXT.");
    if (command === "create" && meta.workflow_id) throw Error("This draft is already saved. Use method save to create a new version.");
    const lock = safePath(`${authorFile}.lock`);
    let fd: number;
    try { fd = openSync(lock, "wx", 0o600); } catch { throw Error("The draft is locked. Wait for the other command."); }
    try {
      const workflow = loadWorkflow(readDocument(authorFile));
      const latest = existsSync(metaFile) ? readDocument(metaFile) : {};
      if (JSON.stringify(latest) !== JSON.stringify(meta)) throw Error("The draft was saved by another process. Retry.");
      const pack = await collectPackage(authorFile, workflow, client);
      const digest = workflowDocumentDigest(workflow);
      const confirm = async (id: string, version: string) => {
        const stored = await client.request<any>(`/api/cli/methods/${encodeURIComponent(id)}?version=${encodeURIComponent(version)}`);
        if (stored.version_id !== version || workflowDocumentDigest(loadWorkflow(stored.workflow)) !== digest || stored.package?.digest !== pack?.digest) throw Error("The saved version does not match this draft. Keep the draft and its sidecar; retry the save before making changes.");
      };
      if (!meta.pending && meta.digest === digest && meta.package_digest === pack?.digest && meta.workflow_id) { await confirm(meta.workflow_id, meta.base_version); print({ confirmed: true, document_sha256: digest, unchanged: true, workflow_id: meta.workflow_id, version_id: meta.base_version, url: `${client.server}/methods/${meta.workflow_id}?version=${meta.base_version}` }); return; }
      if (meta.pending && ((meta.pending.digest !== digest && (meta.digest_format || meta.pending.digest !== semanticDigest(workflow))) || meta.pending.package_digest !== pack?.digest)) throw Error("A previous save has no confirmed response. Restore that draft and retry before changing it.");
      const reason = meta.pending?.reason ?? values.reason;
      if (meta.workflow_id && !reason) throw Error("Supply --reason for the new version.");
      const requestId = meta.pending?.request_id ?? values["request-id"] ?? randomUUID();
      const pending = { ...meta, digest_format: "document/1", server: client.server, pending: { digest, package_digest:pack?.digest, request_id: requestId, reason } };
      writePrivateJson(metaFile, pending);
      const saved = meta.workflow_id
        ? await client.request<any>(`/api/cli/methods/${encodeURIComponent(meta.workflow_id)}`, "POST", { workflow, package:pack, base_version: meta.base_version, reason })
        : await client.request<any>("/api/cli/methods", "POST", { workflow, package:pack, request_id: requestId });
      const workflowId = meta.workflow_id ?? saved.workflow_id;
      await confirm(workflowId, saved.version_id);
      writePrivateJson(metaFile, { server: client.server, workflow_id: workflowId, base_version: saved.version_id, digest, package_digest:pack?.digest, digest_format: "document/1" });
      print({ ...saved, confirmed: true, document_sha256: digest, ...(pack?{package_sha256:pack.digest,runtime:pack.runtime,files:pack.files.map(f=>f.path)}:{}), workflow_id: workflowId, server: client.server, url: `${client.server}/methods/${workflowId}?version=${saved.version_id}` });
    } finally { closeSync(fd); unlinkSync(lock); }
    return;
  }
  if (!target) throw Error(help);
  const path = `/api/cli/methods/${encodeURIComponent(target)}`;
  if (command === "update") {
    if (!values.file || !values["base-version"] || !values.reason)
      throw Error(
        "Supply --file, --base-version, and --reason. Use method get to read the current version first.",
      );
    const workflow = loadWorkflow(readFileSync(safePath(values.file), "utf8"));
    const pack = await collectPackage(values.file, workflow, client);
    const updated=await client.request<any>(path,"POST",{workflow,package:pack,base_version:values["base-version"],reason:values.reason});
    const confirmed=await client.request<any>(path+`?version=${encodeURIComponent(updated.version_id)}`);
    if(workflowDocumentDigest(loadWorkflow(confirmed.workflow))!==workflowDocumentDigest(workflow)||confirmed.package?.digest!==pack?.digest)throw Error('Saved version readback does not match the complete package.');
    print({...updated,confirmed:true,...(pack?{package_sha256:pack.digest,runtime:pack.runtime,files:pack.files.map(f=>f.path)}:{})});
    return;
  }
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
  if(saved.package && await useCompatibleRelease(saved.package.runtime,args))return;
  if (workflow.format === 'method/3' || workflow.format === 'method/3.1') {
    if(process.env.METHOD_RUN_WORKER!=='1' && (/[/\\]method\.(?:js|ts)$/.test(process.argv[1]??'') || flags.background)) {
      const directory=safePath(flags['run-dir']??join(methodCache(),'runs',randomUUID()));
      let workerArgs=args.filter(a=>a!=='--background');
      if(!values.version)workerArgs.push('--version',saved.version_id);
      if(!flags['run-dir'])workerArgs.push('--run-dir',directory);
      await startRunWorker(workerArgs,directory,flags.background);return;
    }
    await runSaved(saved, flags, client); return;
  }

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
