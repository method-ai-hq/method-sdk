import { managedClassification } from './classification-client.js';
import { MethodClient } from './method-client.js';
import {recordDeploymentSource,finishDeploymentSource} from './deployment-source.js';
import {openBrowser} from './browser.js';
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from 'node:path';
import { managedModels } from './hosted-models.js';
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
export async function runCurrentFile(file: string, flags: ReturnType<typeof parse>["values"], syncFactory?: () => MethodSync, onEvent?: (event:any)=>Promise<void>, client = new MethodClient(flags.server)) {
  if (flags.resume && !flags['run-dir']) throw Error('Resume needs --run-dir.');
  flags = {...flags, 'run-dir': flags['run-dir'] ?? join(process.cwd(), '.method-runs', randomUUID())};
  const json = (path: string | undefined) => path ? JSON.parse(readFileSync(authoringPath(path), "utf8")) : undefined;
  if (flags.resume) assertCheckpointExecutor(json(join(flags['run-dir']!, 'checkpoint.json')));
  const setup = await localSetup(file, flags);
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
    sync = syncFactory?.();
    await sync?.start(method, json(flags.inputs) ?? {}, {});
    // A run with its own OpenRouter key (config.classification.api_key_env) needs no Method sign-in for classification.
    const needs = accountNeeds(method, config, flags.agent);
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
        if (needs.models && client.token()) {
          try { hostedModel = await managedModels(client).model(); }
          catch (error: any) { process.stderr.write(`Hosted models are unavailable (${error.message}). Using a local agent.\n`); }
        }
        config.models = await resolveAgentProfiles(method, config, flags.agent, hostedModel);
        if (classification) config.classification = await classification.resolve(controller.signal);
      }
      await checkAgents(config.models);
      prepared = await prepareRuntime(sourceRoot,config,method);
      config = prepared.config;
      if(resolvedFile){mkdirSync(dirname(resolvedFile),{recursive:true,mode:0o700});writePrivateJson(resolvedFile,config);}
      if(flags['run-dir']){const path=join(authoringPath(flags['run-dir']),'setup.json');const events=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):[];writePrivateJson(path,[...events,{at:new Date().toISOString(),type:'setup_completed'}]);}
    }
    if(!flags.resume)recordDeploymentSource(authoringPath(flags['run-dir']!),sourceRoot,authoringPath(file),method,config);
    browser = await openBrowser(method,config,flags['run-dir']!,controller.signal);
    const hostedModels = Object.values(config.models ?? {}).some((profile: any) => profile.backend === 'method') ? managedModels(client) : undefined;
    const result = await executeMethod(authoringPath(file), config, {
      runDir: flags["run-dir"] ? authoringPath(flags["run-dir"]) : undefined,
      agent: flags.agent as 'codex' | 'claude' | undefined, inputs: json(flags.inputs), state: json(flags.state), resume: flags.resume, retry: flags.retry,
      cacheFrom: flags.resume ? [] : recentRuns(authoringPath(flags['run-dir']!)),
      fresh: flags.fresh ? true : flags.rerun?.length ? flags.rerun.flatMap(step => step.split(',')).map(step => step.trim()).filter(Boolean) : undefined,
      secrets: resolveSecrets(Object.keys(method.secrets ?? {})), ...(hostedModels ? { hostedModels } : {}),
      human: json(flags.human), signal: controller.signal,
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
    if(result.status==='completed')finishDeploymentSource(authoringPath(flags['run-dir']!),method,config);
    await sync?.finish();
    const display=sync&&flags['run-dir']?{...result,dashboard_sync:existsSync(join(authoringPath(flags['run-dir']),'method-pending.json'))?'pending':'saved'}:result;
    process.stdout.write(JSON.stringify(display, null, 2) + "\n");
    // 3: every step finished, but an observer could not confirm an external change.
    if (result.status !== "completed") process.exitCode = ({needs_input:2,unconfirmed:3} as Record<string,number>)[result.status] ?? 1;
    return result;
  } catch (error) { failure = error; throw error; }
  finally { try { await browser?.close(); } catch(error) { if(!failure&&!runFailed&&!controller.signal.aborted)throw error; } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); await sync?.finish(failure); } }
}
