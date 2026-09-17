import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { resolveModels } from '@withmethod/runtime/agents.js';
import { checkAgents } from './capabilities.js';
import { prepareRuntime } from './prepare.js';
import { writePrivateJson } from './files.js';
import { runMethod as executeMethod } from "@withmethod/runtime/runner.js";
import { localSetup } from "./local-setup.js";
import { authoringPath } from "./authoring.js";
import type { MethodSync } from "./method-sync.js";
import type { parse } from "./local-cli.js";

export { executeMethod as runCurrentMethod };
export async function runCurrentFile(file: string, flags: ReturnType<typeof parse>["values"], syncFactory?: () => MethodSync, onEvent?: (event:any)=>Promise<void>) {
  const json = (path: string | undefined) => path ? JSON.parse(readFileSync(authoringPath(path), "utf8")) : undefined;
  const setup = await localSetup(file, flags);
  let config = setup.config;
  const sourceRoot = setup.sourceRoot;
  const method = (await import('./authoring.js')).readDocument(file);
  const controller = new AbortController();
  const stop = () => controller.abort(Object.assign(new Error("Interrupted by operator"), { code: "interrupted" }));
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  let sync: MethodSync | undefined;
  let failure: unknown;
  try {
    sync = syncFactory?.();
    await sync?.start(method, json(flags.inputs) ?? {}, {});
    const resolvedFile = flags['run-dir'] ? join(authoringPath(flags['run-dir']), 'runtime.resolved.json') : undefined;
    if (flags.resume && resolvedFile && existsSync(resolvedFile)) config = JSON.parse(readFileSync(resolvedFile,'utf8'));
    const preferenceFile = join(homedir(),'.config','method','agent.json');
    const preference = existsSync(preferenceFile) ? JSON.parse(readFileSync(preferenceFile,'utf8')).agent : undefined;
    config.models = await resolveModels(method, config, {agent:flags.agent,preference});
    if(flags.agent) writePrivateJson(preferenceFile,{agent:flags.agent});
    await checkAgents(config.models);
    const prepared = await prepareRuntime(sourceRoot,config,method);
    config = prepared.config;
    if(resolvedFile){mkdirSync(dirname(resolvedFile),{recursive:true,mode:0o700});writePrivateJson(resolvedFile,config);}
    if(flags['run-dir']){const path=join(authoringPath(flags['run-dir']),'setup.json');const events=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):[];writePrivateJson(path,[...events,{at:new Date().toISOString(),type:'setup_completed'}]);}
    const result = await executeMethod(authoringPath(file), config, {
      runDir: flags["run-dir"] ? authoringPath(flags["run-dir"]) : undefined,
      inputs: json(flags.inputs), state: json(flags.state), resume: flags.resume, retry: flags.retry,
      human: json(flags.human), signal: controller.signal,
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
  finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); await sync?.finish(failure); }
}
