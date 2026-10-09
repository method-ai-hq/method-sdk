import {browserConfig} from './browser.js';
import { dirname, resolve } from "node:path";
import { readDocument } from "@withmethod/runtime/io.js";
import { validateConfig } from "@withmethod/runtime/validate.js";
import { typesafeModel } from "@withmethod/runtime/classification.js";
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
  const method = await readDocument(authoringPath(file));
  // An own Typesafe key replaces the Method account for classification.
  const classifies = Object.values(method.steps ?? {}).some((step: any) => step.do?.kind === "classify");
  if (classifies && !config.classification?.api_key_env && process.env.TYPESAFE_API_KEY)
    config.classification = { provider: "typesafe", model: config.classification?.model ?? typesafeModel, api_key_env: "TYPESAFE_API_KEY" };
  // Commands with a path and environment paths are relative to the configuration file.
  for (const profile of [...Object.values(config.runtimes ?? {}), ...Object.values(config.models ?? {})] as any[]) {
    if (profile.command?.includes("/")) profile.command = authoringPath(resolve(dirname(configFile), profile.command));
  }
  for (const [name, path] of Object.entries(config.environment ?? {})) {
    if (method.environment?.[name]?.type === "files") config.environment[name] = authoringPath(resolve(dirname(configFile), String(path)));
  }
  return { config:browserConfig(method,config), configFile, sourceRoot };
}
