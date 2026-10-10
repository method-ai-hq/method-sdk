import {browserConfig} from './browser.js';
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readDocument } from "@withmethod/runtime/io.js";
import { validateConfig } from "@withmethod/runtime/validate.js";
import { authoringPath } from "./authoring.js";
import { readComputerSettings } from "./computer-settings.js";
import { typesafeModel } from "@withmethod/runtime/classification.js";

/**
 * The runtime configuration for a local Method. No file beside the Method is read: models come from the Method,
 * limits and tools from the Method (tools are copied into the configuration), connections and an own classifier key from this computer (computer.json), and
 * runtimes from PATH. A files connection with no
 * binding uses the folder of the same name beside the Method, when it exists.
 * `base` is a configuration that the SDK made itself (a saved version's package); bindings still apply.
 */
export async function localSetup(file: string, flags: { workspace?: string; agent?: string }, base?: any) {
  const path = authoringPath(file), folder = dirname(path);
  const sourceRoot = authoringPath(flags.workspace ?? folder);
  const settings = readComputerSettings();
  const method = await readDocument(path);
  const config: any = base ? structuredClone(base) : { allow_local_processes: true };
  config.allow_local_processes = true;
  if (settings.classification_key_env && !config.classification) config.classification = { provider: 'typesafe', model: typesafeModel, api_key_env: settings.classification_key_env };
  const bound = typeof method.id === 'string' ? settings.bindings[method.id] ?? {} : {};
  const environment: Record<string, string> = { ...config.environment };
  for (const [name, definition] of Object.entries(method.environment ?? {}) as [string, any][]) {
    if (bound[name]) environment[name] = definition.type === 'files' ? authoringPath(resolve(folder, bound[name])) : bound[name];
    else if (environment[name] && definition.type === 'files') environment[name] = authoringPath(resolve(sourceRoot, environment[name]));
    else if (!environment[name] && definition.type === 'files' && existsSync(join(folder, name)) && statSync(join(folder, name)).isDirectory()) environment[name] = join(folder, name);
  }
  if (Object.keys(environment).length) config.environment = environment;
  // A method/3.4 document declares its own tools; the runtime reads tools from the configuration.
  if (method.tools && Object.keys(method.tools).length) config.tools = { ...config.tools, ...method.tools };
  validateConfig(config);
  return { config: browserConfig(method, config), sourceRoot, agent: flags.agent ?? settings.agent };
}
