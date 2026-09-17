import { existsSync, realpathSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve, relative, sep } from "node:path";
import type { LegacyWorkflow as Workflow, Json } from "../../workflow-language/src/schema.js";
import { shapeErrors } from "../../workflow-language/src/validate.js";
import type { Connections } from "./contracts.js";
export function safePath(path: string): string {
  const target = resolve(path);
  if (target.split(sep).includes("sensitive")) throw Error("Use a path outside sensitive/.");
  let existing = target; while (!existsSync(existing)) existing = dirname(existing);
  if (realpathSync(existing).split(sep).includes("sensitive")) throw Error("Use a path outside sensitive/.");
  return resolve(realpathSync(existing), relative(existing, target));
}
export function environmentResources(workflow: Workflow, workspace: string, _directory: string, supplied: Connections = {}): Connections {
  return Object.fromEntries(Object.entries(workflow.environment ?? {}).map(([id, definition]) => {
    const entry = supplied[id];
    if (!entry) throw Error(`Configure environment.${id}: ${definition.description}`);
    const setup = entry.setup ?? (entry.description !== definition.description ? entry.description : undefined);
    return [id, { description: definition.description, ...(setup !== undefined ? { setup } : {}), ...(entry.path ? { path: safePath(resolve(workspace, entry.path)) } : {}) }];
  }));
}
export function readState(workflow: Workflow, root: string): { values: Record<string, Json>; paths: Record<string, string> } {
  const values: Record<string, Json> = {}, paths: Record<string, string> = {};
  mkdirSync(safePath(root), { recursive: true, mode: 0o700 });
  for (const [name, definition] of Object.entries(workflow.state ?? {})) {
    const path = safePath(resolve(root, definition.file)); paths[name] = path;
    if (!path.startsWith(resolve(root) + sep)) throw Error(`State path escapes its folder: ${name}.`);
    if (existsSync(path)) values[name] = JSON.parse(readFileSync(path, "utf8"));
    else if (definition.default !== undefined) values[name] = structuredClone(definition.default);
    else throw Error(`Missing state.${name}: initialize ${path} or declare a default.`);
    const errors = shapeErrors(definition, values[name], `state.${name}`); if (errors.length) throw Error(errors.join("\n"));
  }
  return { values, paths };
}
