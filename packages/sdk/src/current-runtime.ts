import {recordDeploymentSource} from './deployment-source.js';
import {openBrowser} from './browser.js';
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertCheckpointExecutor } from '@withmethod/runtime/executor-version.js';
import { checkAgents, resolveAgentProfiles } from './capabilities.js';
import { prepareRuntime } from './prepare.js';
import { writePrivateJson } from './files.js';
import { runMethod as executeMethod } from "@withmethod/runtime/runner.js";
import { localSetup } from "./local-setup.js";
import { authoringPath } from "./authoring.js";
import type { MethodSync } from "./method-sync.js";
import type { parse } from "./local-cli.js";

export { executeMethod as runCurrentMethod };
export async function runCurrentFile(file: string, flags: ReturnType<typeof parse>["values"], syncFactory?: () => MethodSync, onEvent?: (event:any)=>Promise<void>) {
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
  let browser: Awaited<ReturnType<typeof openBrowser>>;
  try {
    sync = syncFactory?.();
    await sync?.start(method, json(flags.inputs) ?? {}, {});
    const resolvedFile = flags['run-dir'] ? join(authoringPath(flags['run-dir']), 'runtime.resolved.json') : undefined;
    const priorCheckpoint = !!flags.resume && !!resolvedFile && !existsSync(resolvedFile)
      && existsSync(join(dirname(resolvedFile), 'checkpoint.json'));
    let prepared:{config:any;processPath:string;prepareBundle:(path:string)=>Promise<void>};
    if(priorCheckpoint){
      // Direct executor runs retain the supplied config without SDK preparation.
      prepared={config,processPath:process.env.PATH??'',prepareBundle:async()=>{}};
    } else {
      if (flags.resume && resolvedFile && existsSync(resolvedFile)) config = JSON.parse(readFileSync(resolvedFile,'utf8'));
      else config.models = await resolveAgentProfiles(method, config, flags.agent);
      await checkAgents(config.models);
      prepared = await prepareRuntime(sourceRoot,config,method);
      config = prepared.config;
      if(resolvedFile){mkdirSync(dirname(resolvedFile),{recursive:true,mode:0o700});writePrivateJson(resolvedFile,config);}
      if(flags['run-dir']){const path=join(authoringPath(flags['run-dir']),'setup.json');const events=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):[];writePrivateJson(path,[...events,{at:new Date().toISOString(),type:'setup_completed'}]);}
    }
    if(!flags.resume)recordDeploymentSource(authoringPath(flags['run-dir']!),sourceRoot,authoringPath(file),method,config);
    browser = await openBrowser(method,config,flags['run-dir']!,controller.signal);
    const result = await executeMethod(authoringPath(file), config, {
      runDir: flags["run-dir"] ? authoringPath(flags["run-dir"]) : undefined,
      agent: flags.agent as 'codex' | 'claude' | undefined, inputs: json(flags.inputs), state: json(flags.state), resume: flags.resume, retry: flags.retry,
      human: json(flags.human), signal: controller.signal,
      ...(browser ? {connections:browser.connections} : {}),
      sourceRoot,
      processPath: prepared.processPath,
      prepareBundle: prepared.prepareBundle,
      onStart: async ({ method, inputs }: any) => {
        await sync?.start(method, inputs, Object.fromEntries(Object.entries(config.environment ?? {}).map(([key, path]) => [key, { description: method.environment[key].description, path: String(path) }])));
      },
      onEvent: async (event: any) => { await onEvent?.(event); sync?.snapshot(); if (flags.verbose) process.stderr.write(JSON.stringify(event) + "\n"); },
    });
    await sync?.finish();
    const display=sync&&flags['run-dir']?{...result,dashboard_sync:existsSync(join(authoringPath(flags['run-dir']),'method-pending.json'))?'pending':'saved'}:result;
    process.stdout.write(JSON.stringify(display, null, 2) + "\n");
    if (result.status !== "completed") process.exitCode = result.status === "needs_input" ? 2 : 1;
    return result;
  } catch (error) { failure = error; throw error; }
  finally { try { await browser?.close(); } catch(error) { if(!failure&&!controller.signal.aborted)throw error; } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); await sync?.finish(failure); } }
}
