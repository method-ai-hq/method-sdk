import {browserConfig} from './browser.js';
import { dirname, resolve } from "node:path";
import { readDocument } from "@withmethod/runtime/io.js";
import { validateConfig } from "@withmethod/runtime/validate.js";
import { authoringPath } from "./authoring.js";

export async function localSetup(file: string, flags: { config?: string; workspace?: string }) {
  const sourceRoot = authoringPath(flags.workspace ?? dirname(authoringPath(file)));
  const configFile = authoringPath(flags.config ?? resolve(sourceRoot, "runtime.json"));
  let config;
  try { config = await readDocument(configFile); }
  catch (error: any) {
    if (error.code !== "ENOENT" || flags.config) throw error;
    config = { allow_local_processes: true };
  }
  validateConfig(config);
  // Commands with a path and environment paths are relative to the configuration file.
  for (const profile of [...Object.values(config.runtimes ?? {}), ...Object.values(config.models ?? {})] as any[]) {
    if (profile.command?.includes("/")) profile.command = authoringPath(resolve(dirname(configFile), profile.command));
  }
  const method = await readDocument(authoringPath(file));
  for (const [name, path] of Object.entries(config.environment ?? {})) {
    if (method.environment?.[name]?.type === "files") config.environment[name] = authoringPath(resolve(dirname(configFile), String(path)));
  }
  return { config:browserConfig(method,config), configFile, sourceRoot };
}
