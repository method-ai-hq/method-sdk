#!/usr/bin/env node
import packageInfo from '../package.json' with { type: 'json' };
import runtimeInfo from '@withmethod/runtime/package.json' with { type: 'json' };
import { startRunWorker, waitForRun, cancelRun, workerAlive } from './run-worker.js';
import { methodCache } from './prepare.js';
import { restorePackage } from './method-files.js';
import { publish, methodContent, methodIdPattern } from './versions.js';
import { runSaved } from './run-saved.js';
import { bindInput, bindConnection } from './bindings.js';
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { localAuthoring, authoringPath, readDocument, writeDocument } from "./authoring.js";
import { MethodClient, DEFAULT_SERVER, accountWords } from "./method-client.js";
import { MethodSync } from "./method-sync.js";
import { progressMain } from "./progress.js";
import { run, parse, localMain } from "./local-cli.js";
import { writePrivateJson } from "./files.js";
import { loadWorkflow } from "../../workflow-language/src/validate.js";

import { methodHelp, overviewHelp as help } from "./method-help.js";

/** The next step for a failure before the first step. */
function safePath(path: string) {
  return authoringPath(path);
}
/** A run target that can save a version: a saved Method (ID or link), or a Method file that loads. */
function loads(target?: string) {
  if (!target || !existsSync(target)) return true;
  try { loadWorkflow(methodContent(readDocument(target))); return true; } catch { return false; }
}
async function dispatchRunWorker(args: string[], flags: ReturnType<typeof parse>['values'], extra: string[] = [], savedClient?: MethodClient) {
  if (process.env.METHOD_RUN_WORKER === '1' || (!/[/\\]method\.(?:js|ts)$/.test(process.argv[1] ?? '') && !flags.background)) return false;
  if (flags.resume && !flags['run-dir']) throw Error('Resume needs --run-dir.');
  const directory = safePath(flags['run-dir'] ?? join(methodCache(), 'runs', randomUUID()));
  let workerArgs = [...args.filter(arg => arg !== '--background'), ...extra];
  if (!flags['run-dir']) workerArgs.push('--run-dir', directory);
  let client = savedClient;
  try { client ??= new MethodClient(flags.server); } catch { /* Not signed in to this server. */ }
  // The earlier run's inputs are read before the run starts, so a run that cannot find them does not start.
  if (flags['inputs-from']) {
    const { withInputsFrom, withoutOptions } = await import('./inputs-from.js');
    const resolved = await withInputsFrom(flags, directory, /\.method$/i.test(args[1] ?? '') ? args[1] : undefined, client);
    workerArgs = [...withoutOptions(workerArgs, ['inputs-from', 'inputs']), '--inputs', resolved.inputs!];
  }
  // A new run of a signed-in computer is synced; a resumed run keeps the link that it has. A Method file that does not
  // load saves no version, so its run sends no record and gets no link.
  const server = !flags.resume && client?.token() && loads(args[1]) ? client.server : undefined;
  await startRunWorker(workerArgs, directory, flags.background, server);
  return true;
}
/** Print a result that stops a command before it starts: the JSON on stdout, the three failure lines on stderr. Exit code 2. */
async function stopForPerson(result: { failure: any }) {
  process.stderr.write((await import('./failure.js')).failureLines(result.failure));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exitCode = 2;
}
/**
 * Bring a Method file to the newest version of its Method before a run or a publish, with one line on stderr. Returns
 * the catch-up status; conflict when the person must combine two texts first: then nothing runs and no file changes.
 */
export async function catchUpFile(client: MethodClient | undefined, file: string, doing = 'running') {
  if (!client) return 'skipped';
  const result = await (await import('./home.js')).catchUp(client, file, doing);
  if (result.status === 'conflict') await stopForPerson(result.result);
  else if ('line' in result) process.stderr.write(result.line + '\n');
  return result.status;
}
/** The line that says the same run (same version, same inputs) is already going. Never blocks; nothing for device runs. */
async function sameRunLine(client: MethodClient | undefined, methodId: string, versionId: string, flags: ReturnType<typeof parse>['values'], device: boolean) {
  if (!client || device || process.env.METHOD_RUN_WORKER === '1' || flags.resume || flags['inputs-from']) return;
  let inputs: unknown = {};
  try { if (flags.inputs) inputs = JSON.parse(readFileSync(resolve(flags.inputs), 'utf8')); } catch { return; }
  const line = await (await import('./method-sync.js')).sameRunNotice(client, methodId, versionId, inputs);
  if (line) process.stderr.write(line + '\n');
}
/**
 * Before method run FILE in the parent process: the outcomes of fixes not yet shown are printed, the file takes the
 * newest version of its Method, corrections that wait start a fix, and the same-run line is printed. Returns false when the run must not start.
 */
async function beforeFileRun(args: string[], clientFactory: (server: string) => MethodClient) {
  if (process.env.METHOD_RUN_WORKER === '1' || args.includes('--resume') || !existsSync(args[1]!)) return true;
  const server = parseArgs({ args: args.slice(2), strict: false, options: { server: { type: 'string' } } }).values.server;
  let client: MethodClient | undefined;
  try { client = clientFactory(typeof server === 'string' ? server : DEFAULT_SERVER); if (!client.token()) client = undefined; } catch { client = undefined; }
  const file = authoringPath(args[1]!);
  // The outcomes of fixes that nobody has seen yet come first.
  const id = (() => { try { return readDocument(file).id; } catch { return undefined; } })();
  if (typeof id === 'string' && methodIdPattern.test(id)) for (const line of (await import('./fix-outcomes.js')).unshownLines(id)) process.stderr.write(line + '\n');
  const caught = await catchUpFile(client, file);
  if (caught === 'conflict') return false;
  await fixWaitingCorrections(args, clientFactory);
  const version = client && caught !== 'offline' ? await (await import('./versions.js')).currentVersion(file).catch(() => undefined) : undefined;
  if (version) { let flags; try { flags = parse(args.slice(2)).values; } catch { return true; } await sameRunLine(client, version.method_id, version.version_id, flags, readDocument(file).run_data === 'device'); }
  return true;
}
/**
 * Before method run FILE: corrections that wait for this Method (from the dashboard, an answer on the dashboard, or a
 * fix that stopped) start a fix in its own process, with one line; the run does not wait for it. Signed out, offline,
 * a resumed run, or the run worker: nothing.
 */
async function fixWaitingCorrections(args: string[], clientFactory: (server: string) => MethodClient) {
  if (process.env.METHOD_RUN_WORKER === '1' || args.includes('--resume') || !existsSync(args[1]!)) return;
  const file = authoringPath(args[1]!), id = (() => { try { return readDocument(file).id; } catch { return undefined; } })();
  if (typeof id !== 'string' || !methodIdPattern.test(id)) return;
  const outcomes = await import('./fix-outcomes.js');
  const server = parseArgs({ args: args.slice(2), strict: false, options: { server: { type: 'string' } } }).values.server;
  let client: MethodClient;
  try { client = clientFactory(typeof server === 'string' ? server : DEFAULT_SERVER); if (!client.token()) return; } catch { return; }
  const { fixRunning, waitingCorrections } = await import('./improve.js');
  // A fix that runs now takes the waiting corrections in its next pass.
  if (fixRunning(id)) return;
  try {
    const waiting = (await waitingCorrections(client, file, id, 3000)).map(j => j.id);
    if (!waiting.length) return;
    outcomes.markWorking(id, file, waiting);
    await outcomes.fixStarter.start(file, id, waiting, client.server);
    process.stderr.write((await import('./fix-lines.js')).waitingLine(waiting.length) + '\n');
  } catch (error) { if (!/^(fetch failed|401:|404:)|abort|timed? ?out/i.test((error as Error).message)) process.stderr.write(`The waiting corrections are not fixed yet: ${(error as Error).message}\n`); }
}
/**
 * The ID of the workspace's Method with this name (case-insensitive, archived Methods left out), or null when none has
 * it. Several matches list their names and IDs and run nothing (exit code 2): then undefined.
 */
async function methodByName(client: MethodClient, name: string) {
  const found: Array<{ id: string; name: string }> = [];
  for (let cursor: string | null = null, first = true; first || cursor; first = false) {
    const page: { workflows?: any[]; next_cursor?: string | null } = await client.request(`/api/methods?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    found.push(...(page.workflows ?? []).filter(w => !w.archived_at && typeof w.name === 'string' && w.name.trim().toLowerCase() === name.trim().toLowerCase()));
    cursor = page.next_cursor ?? null;
  }
  if (found.length === 1) return found[0]!.id;
  if (!found.length) return null;
  const message = `${found.length} Methods are named "${name}". Run one by its ID: ${found.map(w => `method run ${w.id} (${w.name})`).join(', ')}.`;
  process.stderr.write(message + '\n');
  process.stdout.write(JSON.stringify({ status: 'needs_you', message, matches: found.map(w => ({ name: w.name, id: w.id })) }, null, 2) + '\n');
  process.exitCode = 2;
  return undefined;
}
/**
 * The Method, comparison or run that a command acts on, by its ID: a Method or comparison file (its id: line), a
 * Method or comparison ID, a dashboard link, the run of method judge, or the Method of a judgment that this computer
 * fixes. Undefined when the command names none.
 */
async function commandTarget(args: string[]): Promise<string | undefined> {
  const [command, first] = args;
  const idOf = (file: string) => { try { const id = readDocument(file).id; return typeof id === 'string' && /^(wf|cmp)_[a-f0-9]{32}$/.test(id) ? id : undefined; } catch { return undefined; } };
  if (command === 'judge' && first) {
    const { findRunFolder } = await import('./local-judgments.js');
    const dir = findRunFolder(first);
    if (!dir) return first;
    try { const id = JSON.parse(readFileSync(join(dir, 'method.json'), 'utf8')).id; if (typeof id === 'string' && methodIdPattern.test(id)) return id; } catch { /* no Method ID */ }
    return undefined;
  }
  if ((command === 'answer' || command === 'wait') && /^jdg_/.test(first ?? ''))
    return (await import('./fix-outcomes.js')).storedOutcomes().find(r => r.judgment === first)?.method_id || undefined;
  if (command === 'undo' && (!first || first.startsWith('--'))) { const last = (await import('./fix-outcomes.js')).lastChangedFile(); return last ? idOf(last) : undefined; }
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--file' && args[i + 1]) { const id = idOf(args[i + 1]!); if (id) return id; }
    if (arg.startsWith('-')) continue;
    if (/^(wf|cmp)_[a-f0-9]{32}$/.test(arg)) return arg;
    const linked = /^https?:\/\/[^/]+\/(?:methods|comparisons)\/((?:wf|cmp)_[a-f0-9]{32})/.exec(arg)?.[1];
    if (linked) return linked;
    if (/\.(method|compare)$/i.test(arg) && existsSync(arg)) return idOf(arg);
  }
  // method connect without --file: the one Method file in this folder.
  if (command === 'connect') { const found = readdirSync('.').filter(name => /\.method$/i.test(name)); if (found.length === 1) return idOf(found[0]!); }
  return undefined;
}
/**
 * Every command uses the account that owns its Method or comparison, whichever account is current: this process and
 * the processes it starts (the run, the fix, a comparison's arms and learners).
 */
async function routeAccount(args: string[], clientFactory: (server: string) => MethodClient) {
  if (process.env.METHOD_API_KEY || ['login', 'logout', 'status'].includes(args[0] ?? '')) return;
  const id = await commandTarget(args);
  if (!id) return;
  const server = parseArgs({ args: args.slice(1), strict: false, options: { server: { type: 'string' } } }).values.server;
  try { await clientFactory(typeof server === 'string' ? server : DEFAULT_SERVER).route?.(id); } catch { /* the current account */ }
}
export async function methodMain(args = process.argv.slice(2), clientFactory: (server: string) => MethodClient = server => new MethodClient(server)) {
  const resumed = (await import('./resume-release.js')).resumeWithOriginalRelease(args);
  if (resumed !== undefined) { process.exitCode = resumed; return; }
  // An installed CLI keeps itself current in the background, with no output; this command is not delayed.
  void (await import('./update.js')).updateInBackground();
  const earlyHelp=methodHelp(args);if(earlyHelp!==undefined){process.stdout.write(earlyHelp);return;}
  await routeAccount(args, clientFactory);
  if (args[0] === 'judge') return (await import('./judge.js')).judgeCommand(args.slice(1), clientFactory);
  if (args[0] === 'answer' && /^jdg_/.test(args[1] ?? '')) return (await import('./judge.js')).answerJudgmentCommand(args.slice(1), clientFactory);
  if (args[0] === 'wait' && (!args[1] || /^jdg_|^--/.test(args[1]))) return (await import('./fix-outcomes.js')).waitCommand(args.slice(1));
  if (args[0] === 'learned') return (await import('./learned.js')).learnedCommand(args.slice(1), clientFactory);
  if (args[0] === 'undo') return (await import('./undo.js')).undoCommand(args.slice(1), clientFactory);
  if (args[0] === '__fix' || args[0] === '__watch') {
    const p = parseArgs({ args: args.slice(1), allowPositionals: true, options: { server: { type: 'string' }, judgment: { type: 'string', multiple: true }, prune: { type: 'boolean' } } });
    const client = clientFactory(p.values.server ?? DEFAULT_SERVER), file = authoringPath(p.positionals[0]!);
    if (args[0] === '__watch') { await (await import('./watch.js')).watchRun(client, file, resolve(p.positionals[1]!)); return; }
    return (await import('./improve.js')).backgroundFix(client, file, p.values.judgment ?? [], { prune: !!p.values.prune });
  }
  if (args[0] === 'changes') return (await import('./proposals.js')).changesMain(args.slice(1), clientFactory);
  // A comparison file publishes as a draft for review, and runs as the Method it compiles into.
  if (args[0] === 'publish' && /\.compare$/i.test(args[1] ?? '')) return (await import('./compare.js')).publishComparison(args);
  if (args[0] === 'run' && /\.compare$/i.test(args[1] ?? '') && !args.includes('--help')) args = await (await import('./compare.js')).comparisonRunArgs(args);
  if (args[0] === 'run' && /\.method$/i.test(args[1] ?? '') && !args.includes('--help') && !await beforeFileRun(args, clientFactory)) return;
  if (args[0] === 'worker' || args[0] === 'keys') return (await import('./worker.js')).productionCommand(args, clientFactory);
  if (args[0] === '__run-data') return (await import('./run-data.js')).runDataCommand(args.slice(1));
  if (args[0] === '__model') return (await import('./model-call.js')).modelCallCommand();
  if (args[0] === '__compare' && args[1]) return (await import('./compare.js')).compareStageCommand(args[1]);
  if (args[0] === '__local-server') return (await import('./local-server.js')).localServerCommand();
  // A run on this computer takes its answer here and continues; a production run's answer goes to the account.
  if (args[0] === 'answer' && (await import('./local-answer.js')).localRunFolder(args[1] ?? '')) return (await import('./local-answer.js')).answerLocalRun(args.slice(1));
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
      const {setupFailure,failureLines}=await import('./failure.js');
      const failure=setupFailure(error);
      const failed={status:error.code==='needs_input'?'needs_input':'failed',run_dir:directory,failure,...(error.missing?{missing:error.missing}:{})};
      if(!existsSync(join(directory,'summary.json')))writePrivateJson(join(directory,'summary.json'),failed);
      if(failed.status==='failed')process.stderr.write(failureLines(failure));
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
  const [command, , step] = rest;
  let target = rest[1];
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
    const { signed_out, current } = await client.logout();
    process.stdout.write(!signed_out ? "No account is signed in.\n"
      : `Signed out of ${accountWords(signed_out)}. ${current ? `The current account is now ${accountWords(current)}.` : "No account is signed in now."}\n`);
    return;
  }
  if (command === "status") {
    // The current account, by person and workspace, and the other accounts of this computer. Nothing else about them.
    const accounts = client.token() ? await client.check() : [];
    const words = (a: (typeof accounts)[number]) => ({ person: a.person?.name ?? null, email: a.person?.email ?? null, workspace: a.workspace?.name ?? null, ...(a.signed_in ? {} : { signed_in: false }) });
    const [current, ...others] = accounts;
    const signedIn = !!current?.signed_in;
    process.stdout.write(JSON.stringify({ installed: true, server: client.server, signed_in: signedIn,
      ...(current ? { account: words(current) } : {}), ...(others.length ? { other_accounts: others.map(words) } : {}),
      ...(!signedIn ? { next: "Run method login to sign in with browser approval." } : others.some(a => !a.signed_in) ? { next: "An account with signed_in false needs method login again, approved with that account." } : {}) }, null, 2) + "\n");
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
    if (await catchUpFile(client, safePath(authorFile), 'publishing') === 'conflict') return;
    print(await (await import("./cloud.js")).publishWithPlacement(client, rest, () => publish(client, safePath(authorFile), values.reason, (values["accept-failing-case"] ?? "").split(",").map(id => id.trim()).filter(Boolean))));
    return;
  }
  if (!target) throw Error(help);
  // method run NAME: the Method of the workspace with this name, run as method run ID runs it.
  let named: string | undefined;
  if (command === "run" && !methodIdPattern.test(target) && !existsSync(target)) {
    const found = await methodByName(client, target);
    if (found === undefined) return;
    if (found) { const at = args.indexOf(target); args = [...args.slice(0, at), found, ...args.slice(at + 1)]; target = found; }
    else named = target;
  }
  const path = `/api/cli/methods/${encodeURIComponent(target)}`;
  if (!["get", "steps", "step", "run"].includes(command)) throw Error(help);
  const saved = await client.request<{
    workflow_id: string;
    version_id: string;
    version_number: number;
    workflow: unknown;
    package?: any;
    saved_by?: string | null;
  }>(
    path +
      (values.version ? `?version=${encodeURIComponent(values.version)}` : ""),
  ).catch(error => {
    if (named && /^40[34]:/.test(error.message)) throw Error(`No Method named "${named}" in your workspace, and no file or Method ID ${named}. Run method list to see the names.`);
    throw error;
  });
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
      // An older saved version carries runtime.json; the file gets it in the Method, as in format 3.4.
      (await import("./legacy.js")).convertLegacyOrThrow(out);
      writeMethodId(out, saved.workflow_id);
      (await import("./outbox.js")).recordCheckout(client.server, saved.workflow_id, saved.version_id, saved.version_number, methodContent(workflow), { saved_by: saved.saved_by ?? null });
      // The new file becomes the Method's home on this computer unless another file already is.
      const home = await import("./home.js");
      try { home.claimHome(client.server, saved.workflow_id, out); } catch { /* a copy for reading */ }
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
  await sameRunLine(client, saved.workflow_id, saved.version_id, flags, (saved.workflow as any)?.run_data === 'device');
  if(await dispatchRunWorker(args, flags, values.version ? [] : ['--version', saved.version_id], client)) return;
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
