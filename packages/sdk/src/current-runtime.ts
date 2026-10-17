import { managedClassification } from './classification-client.js';
import { MethodClient } from './method-client.js';
import {openBrowser} from './browser.js';
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from 'node:path';
import { hostedModelsFor, managedModels } from './hosted-models.js';
import { localAgent } from '@withmethod/runtime/agents.js';
import { resolveSecrets } from './secrets.js';
import { randomUUID } from 'node:crypto';
import { assertCheckpointExecutor } from '@withmethod/runtime/executor-version.js';
import { accountNeeds, checkAgents, resolveAgentProfiles } from './capabilities.js';
import { prepareRuntime, methodCache } from './prepare.js';
import { writePrivateJson } from './files.js';
import { runMethod as executeMethod } from "@withmethod/runtime/runner.js";
import { localSetup } from "./local-setup.js";
import { authoringPath } from "./authoring.js";
import type { MethodSync } from "./method-sync.js";
import { failureLines } from "./failure.js";
import { methodFileRecord } from "./local-judgments.js";
import type { parse } from "./local-cli.js";

export { executeMethod as runCurrentMethod };

/** Recent run folders on this computer, newest first. The runtime reuses only iterations whose key matches. */
export function recentRuns(exclude: string, limit = 20) {
  const roots = [join(methodCache(), 'runs'), join(process.cwd(), '.method-runs'), dirname(resolve(exclude))];
  const found = new Map<string, number>();
  for (const root of new Set(roots.map(path => resolve(path)))) {
    let names: string[] = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names) {
      const dir = join(root, name);
      if (dir === resolve(exclude)) continue;
      try { found.set(dir, statSync(join(dir, 'checkpoint.json')).mtimeMs); } catch { /* not a run */ }
    }
  }
  return [...found].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([dir]) => dir);
}
/** Answers for ask steps: a key without an iteration ("confirm") answers its first iteration ("confirm:0"). */
export function answers(human: any) {
  if (!human?.steps) return human;
  return { ...human, steps: Object.fromEntries(Object.entries(human.steps).map(([key, value]) => [key.includes(':') ? key : `${key}:0`, value])) };
}
/**
 * Run a local Method file. The run starts at once: saving and run records go through the outbox and never stop or fail
 * the run. baseConfig is a configuration the SDK made (a saved version's package); otherwise localSetup builds it.
 * runSecrets are values that the SDK gives this run only (such as the signed-in key for improve.method); they come
 * before the shell and the secret store, and are never saved.
 */
export async function runCurrentFile(file: string, flags: ReturnType<typeof parse>["values"], syncFactory?: () => MethodSync, onEvent?: (event:any)=>Promise<void>, client = new MethodClient(flags.server), baseConfig?: any, runSecrets: Record<string, string> = {}) {
  if (flags.resume && !flags['run-dir']) throw Error('Resume needs --run-dir.');
  flags = {...flags, 'run-dir': flags['run-dir'] ?? join(process.cwd(), '.method-runs', randomUUID())};
  const json = (path: string | undefined) => path ? JSON.parse(readFileSync(authoringPath(path), "utf8")) : undefined;
  if (flags.resume) assertCheckpointExecutor(json(join(flags['run-dir']!, 'checkpoint.json')));
  const setup = await localSetup(file, flags, baseConfig);
  let config = setup.config;
  const sourceRoot = setup.sourceRoot;
  const method = (await import('./authoring.js')).readDocument(file);
  const controller = new AbortController();
  const stop = () => controller.abort(Object.assign(new Error("Interrupted by operator"), { code: "interrupted" }));
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  let sync: MethodSync | undefined;
  let failure: unknown;
  let runFailed = false;
  let browser: Awaited<ReturnType<typeof openBrowser>>;
  try {
    try { sync = syncFactory?.(); } catch (error) { process.stderr.write(`Run records stay on this computer: ${(error as Error).message}\n`); }
    // Records the start; sends nothing. The outbox starts when the run starts.
    await sync?.start(method, json(flags.inputs) ?? {}, {}, false);
    // A run with its own OpenRouter key (config.classification.api_key_env) needs no Method sign-in for classification.
    const needs = accountNeeds(method, config);
    const classification = needs.classification ? managedClassification(client) : undefined;
    // Classification uses the Method account. Hosted models are used when this computer is signed in.
    if (classification && !client.token()) await client.login();
    const resolvedFile = flags['run-dir'] ? join(authoringPath(flags['run-dir']), 'runtime.resolved.json') : undefined;
    const priorCheckpoint = !!flags.resume && !!resolvedFile && !existsSync(resolvedFile)
      && existsSync(join(dirname(resolvedFile), 'checkpoint.json'));
    let prepared:{config:any;processPath:string;prepareBundle:(path:string)=>Promise<void>};
    if(priorCheckpoint){
      // Direct executor runs retain the supplied config without SDK preparation.
      prepared={config,processPath:process.env.PATH??'',prepareBundle:async()=>{}};
    } else {
      if (flags.resume && resolvedFile && existsSync(resolvedFile)) config = JSON.parse(readFileSync(resolvedFile,'utf8'));
      else {
        let hostedModel: string | undefined;
        // The hosted model is asked for only when no local agent (Claude Code or Codex) can run the model steps.
        if (needs.models && client.token() && !await localAgent()) {
          try { hostedModel = await managedModels(client).model(); }
          catch (error: any) { process.stderr.write(`Hosted models are unavailable (${error.message}).\n`); }
        }
        config.models = await resolveAgentProfiles(method, config, hostedModel);
        if (classification) config.classification = await classification.resolve(controller.signal);
      }
      await checkAgents(config.models);
      prepared = await prepareRuntime(sourceRoot,config,method);
      config = prepared.config;
      if(resolvedFile){mkdirSync(dirname(resolvedFile),{recursive:true,mode:0o700});writePrivateJson(resolvedFile,config);}
      if(flags['run-dir']){const path=join(authoringPath(flags['run-dir']),'setup.json');const events=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):[];writePrivateJson(path,[...events,{at:new Date().toISOString(),type:'setup_completed'}]);}
    }
    browser = await openBrowser(method,config,flags['run-dir']!,controller.signal);
    const hostedModels = Object.values(config.models ?? {}).some((profile: any) => profile.backend === 'method') ? await hostedModelsFor(client) : undefined;
    // The run folder records its Method file, so method judge can keep a note next to it.
    if (flags['run-dir']) writePrivateJson(join(authoringPath(flags['run-dir']), methodFileRecord), { path: authoringPath(file) });
    const result = await executeMethod(authoringPath(file), config, {
      runDir: flags["run-dir"] ? authoringPath(flags["run-dir"]) : undefined,
      inputs: json(flags.inputs), state: json(flags.state), resume: flags.resume, retry: flags.retry,
      cacheFrom: flags.resume ? [] : recentRuns(authoringPath(flags['run-dir']!)),
      fresh: flags.fresh ? true : flags.rerun?.length ? flags.rerun.flatMap(step => step.split(',')).map(step => step.trim()).filter(Boolean) : undefined,
      secrets: { ...resolveSecrets(Object.keys(method.secrets ?? {})), ...Object.fromEntries(Object.entries(runSecrets).filter(([key]) => Object.hasOwn(method.secrets ?? {}, key))) }, ...(hostedModels ? { hostedModels } : {}),
      human: answers(json(flags.human)), signal: controller.signal,
      ...(browser ? {connections:browser.connections} : {}),
      sourceRoot, ...(classification ? {classification} : {}),
      processPath: prepared.processPath,
      prepareBundle: prepared.prepareBundle,
      onStart: async ({ method, inputs }: any) => {
        // A configured binding that the Method does not declare is not one of its connections.
        await sync?.start(method, inputs, Object.fromEntries(Object.entries(config.environment ?? {}).filter(([key]) => method.environment?.[key]).map(([key, path]) => [key, { description: method.environment[key].description, path: String(path) }])));
      },
      onEvent: async (event: any) => { await onEvent?.(event); sync?.snapshot(); if (flags.verbose) process.stderr.write(JSON.stringify(event) + "\n"); },
    });
    runFailed = !['completed','unconfirmed'].includes(result.status);
    const synced = await sync?.finish();
    let display:any=synced?{...result,dashboard:sync!.dashboard,dashboard_sync:synced}:result;
    // A run that waits for a person shows the question itself, so the agent can ask the user and pass on the answer.
    const question=result.status==='needs_input'?(await import('./worker.js')).lastQuestion(authoringPath(flags['run-dir']!)):null;
    if(question&&display.failure)display={...display,question,failure:{...display.failure,next:{...display.failure.next,text:`Ask the user this question in plain words and wait for the answer; do not answer it yourself. Then write {"steps": {"${question.step}": {"outputs": {...}}}} with the user's answer (the fields are in question.form) to a file, and run the same command again with --resume --run-dir ${JSON.stringify(flags['run-dir'])} --human FILE.`}}};
    // People read three plain lines on stderr; agents, apps, and tests parse the JSON on stdout.
    if (result.status === "failed" && display.failure) process.stderr.write(failureLines(display.failure) + (display.dashboard ? `Dashboard: ${display.dashboard}\n` : ""));
    process.stdout.write(JSON.stringify(display, null, 2) + "\n");
    // 3: every step finished, but an observer could not confirm an external change.
    if (result.status !== "completed") process.exitCode = ({needs_input:2,unconfirmed:3} as Record<string,number>)[result.status] ?? 1;
    return result;
  } catch (error) { failure = error; throw error; }
  finally { try { await browser?.close(); } catch(error) { if(!failure&&!runFailed&&!controller.signal.aborted)throw error; } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); await sync?.finish(failure); } }
}
