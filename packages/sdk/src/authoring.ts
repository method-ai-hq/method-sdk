import { migrateMethod2 } from "@withmethod/runtime/migrate.js";
import { preflight } from "@withmethod/runtime/preflight.js";
import { configSchema,methodSchema } from "@withmethod/runtime/schema.js";
import { localSetup } from "./local-setup.js";
/** Deterministic local authoring. No model calls, network calls, or workflow execution. */
import { closeSync,existsSync,mkdirSync,openSync,readFileSync,realpathSync,unlinkSync } from "node:fs";
import { dirname,resolve,sep } from "node:path";

import { renameSync,writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { CheckSchema,CurrentCheckSchema,CurrentStepSchema,StepSchema } from "../../workflow-language/src/schema.js";
import { loadWorkflow,parseDocumentValue,serializeWorkflow } from "../../workflow-language/src/validate.js";
export function writeDocument(path: string, value: unknown) { const tmp = `${path}.${process.pid}.tmp`; try { writeFileSync(tmp, serializeWorkflow(value), { mode: 0o600, flag: "wx" }); renameSync(tmp, path); } finally { if (existsSync(tmp)) unlinkSync(tmp); } }

import { exampleDirectory } from "./authoring-example.js";
import { authoringGuide,methodHelp } from "./method-help.js";
export const authoringHelp = authoringGuide();

export function authoringPath(path: string): string {
  const full = resolve(path);
  if (full.split(sep).includes("sensitive")) throw Error("Use a path outside sensitive/.");
  let existing = full;
  while (!existsSync(existing)) existing = dirname(existing);
  if (realpathSync(existing).split(sep).includes("sensitive")) throw Error("Use a path outside sensitive/.");
  return full;
}
export const readDocument = (file: string): any => parseDocumentValue(readFileSync(authoringPath(file), "utf8"));
const own = (v: any, k: string) => v !== null && typeof v === "object" && Object.hasOwn(v, k);
function keys(path: string) {
  if (!/^(?:\/(?:[^~]|~[01])*)*$/.test(path)) throw Error("Use a valid JSON Pointer, for example /steps/0/name.");
  return path === "" ? [] : path.slice(1).split("/").map(k => k.replaceAll("~1", "/").replaceAll("~0", "~"));
}
export function at(document: any, path: string): any {
  let node = document;
  for (const key of keys(path)) { if (!own(node, key)) throw Error(`No value at ${path}.`); node = node[key]; }
  return node;
}
export function change(document: any, path: string, value: any, remove = false): any {
  const parts = keys(path), key = parts.pop();
  if (key === undefined) { if (remove) throw Error("Cannot remove the whole document."); return value; }
  const parent = at(document, parts.length ? "/" + parts.map(k => k.replaceAll("~", "~0").replaceAll("/", "~1")).join("/") : "");
  if (!parent || typeof parent !== "object") throw Error("The parent must be an object or array.");
  if (Array.isArray(parent)) {
    const index = key === "-" && !remove ? parent.length : /^(0|[1-9][0-9]*)$/.test(key) ? Number(key) : -1;
    if (index < 0 || index > parent.length || remove && index === parent.length) throw Error("Invalid array position.");
    if (remove) parent.splice(index, 1); else parent[index] = value;
  } else {
    if (remove) { if (!own(parent, key)) throw Error(`No value at ${path}.`); delete parent[key]; }
    else Object.defineProperty(parent, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return document;
}
export function editDocument(file: string, edit: (doc: any) => any) {
  const path = authoringPath(file), lock = authoringPath(`${path}.lock`);
  let fd: number;
  try { fd = openSync(lock, "wx", 0o600); } catch { throw Error("The draft is locked by another command. Retry after it finishes."); }
  try { const result = edit(readDocument(path)); writeDocument(path, result); return result; }
  finally { closeSync(fd); unlinkSync(lock); }
}
export function differences(a: any, b: any, path = ""): any[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b))
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(k => differences(a[k], b[k], path + "/" + k.replaceAll("~", "~0").replaceAll("/", "~1")));
  return [{ path, ...(a !== undefined ? { before: a } : {}), ...(b !== undefined ? { after: b } : {}) }];
}

export async function localAuthoring(args: string[]): Promise<boolean> {
  const command = args[0];
  const stepEdit = command === "step" && ["add", "update", "remove", "move"].includes(args[1] ?? "");
  if (!stepEdit && !["authoring", "init", "show", "set", "remove", "check", "validate", "diff", "schema", "migrate"].includes(command ?? "")) return false;
  if (args.includes("--help")) { process.stdout.write(methodHelp(args)!); return true; }
  if (command === "authoring") {
    if (args.length > 2) throw Error("Use method authoring [TOPIC].");
    process.stdout.write(authoringGuide(args[1]));
    if (!args[1] || ["start", "example", "all"].includes(args[1])) process.stdout.write(`\nInstalled example folder: ${exampleDirectory}\nRead ${exampleDirectory}README.md for its files and setup.\n`);
    return true;
  }
  const { values: v, positionals: p } = parseArgs({ args: args.slice(1), allowPositionals: true, options: Object.fromEntries(["name", "goal", "id", "instructions-file", "json", "value-file", "text", "text-file", "path", "before", "model", "purpose", "kind", "runtime", "entrypoint", "timeout-ms", "max-agent-turns", "max-model-requests", "output", "config", "workspace"].map(k => [k, { type: "string" as const }])) });
  const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  const value = () => {
    const sources = ["json", "value-file", "text", "text-file"].filter(k => v[k] !== undefined);
    if (sources.length !== 1) throw Error("Supply exactly one of --json, --value-file, --text, or --text-file.");
    return v.json !== undefined ? JSON.parse(v.json) : v["value-file"] ? readDocument(v["value-file"]) : v.text !== undefined ? v.text : readFileSync(authoringPath(v["text-file"]!), "utf8");
  };
  if (command === "migrate") {
    if (!p[0]) throw Error("Supply a saved method file.");
    const result = migrateMethod2(readDocument(p[0]), { model: v.model, timeout_ms: Number(v["timeout-ms"]), max_agent_turns: Number(v["max-agent-turns"]), max_model_requests: Number(v["max-model-requests"]) });
    result.warnings.forEach((warning: string) => process.stderr.write(warning + "\n"));
    if (v.output) { const out = authoringPath(v.output); if (existsSync(out)) throw Error("Choose a new output file."); writeDocument(out, result.method); }
    else print(result.method);
    return true;
  }
  if (command === "schema") {
    if (!p[0] || ["method", "workflow", "config"].includes(p[0])) { print(p[0] === "config" ? configSchema : methodSchema); return true; }
    const schemas: Record<string, unknown> = {method: methodSchema, workflow: methodSchema, config: configSchema,
      ...Object.fromEntries(["step", "check", "data"].map(name => [name, { $schema: methodSchema.$schema, $defs: methodSchema.$defs, $ref: `#/$defs/${name}` }])),
      environment: { ...methodSchema.properties.environment.additionalProperties }};
    const schema = schemas[p[0] ?? "method"];
    if (!schema) throw Error("Unknown schema. See method authoring.");
    print(schema); return true;
  }
  const file = stepEdit || command === "check" ? p[1] : p[0];
  if (!file) throw Error(`Supply a Method file. Read method ${command} --help.`);
  if (command === "init") {
    if (!v.name || !v.goal) throw Error("Supply --name and --goal.");
    const path = authoringPath(file);
    if (existsSync(path) || existsSync(`${path}.method.json`)) throw Error("Choose a new draft file.");
    const draft = { format: "method/3.1", name: v.name, goal: v.goal, steps: {}, result: {} };
    // Exclusive creation prevents simultaneous init from replacing a draft.
    mkdirSync(dirname(path), {recursive:true,mode:0o700});
    const fd = openSync(path, "wx", 0o600); closeSync(fd); writeDocument(path, draft); print({ file: path, workflow: draft }); return true;
  }
  if (command === "validate") {
    let definition = "invalid";
    try {
      const workflow = loadWorkflow(readDocument(file)); definition = "valid";
      if (workflow.format === "method/3" || workflow.format === "method/3.1") {
        const { config, configFile, sourceRoot } = await localSetup(file, v);
        const { files } = await preflight(workflow, config, sourceRoot);
        print({ valid: true, definition, local_setup: "valid", config: configFile, workspace: sourceRoot, files: files.length, steps: Object.keys(workflow.steps).length, executed: false });
      } else print({ valid: true, definition, local_setup: "not_checked_legacy", steps: Object.keys(workflow.steps).length, executed: false });
    } catch (error) { print({ valid: false, definition, local_setup: definition === "valid" ? "invalid" : "not_checked", executed: false, error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; }
    return true;
  }
  if (command === "show") { print(at(readDocument(file), v.path ?? "")); return true; }
  if (command === "diff") { if (!p[1]) throw Error("Supply two files."); print(differences(readDocument(file), readDocument(p[1]))); return true; }
  const result = editDocument(file, doc => {
    if (command === "set" || command === "remove") {
      if (p[1] === undefined) throw Error("Supply a JSON Pointer.");
      return change(doc, p[1], command === "set" ? value() : undefined, command === "remove");
    }
    if (!doc.steps || Array.isArray(doc.steps) || typeof doc.steps !== "object") throw Error("The draft needs a steps map.");
    const action = p[0], id = p[2];
    if (stepEdit) {
      if (action === "add") {
        if (!v.id) throw Error("Supply --id.");
        if (Object.hasOwn(doc.steps, v.id)) throw Error("That step already exists.");
        if ((doc.format === "method/3" || doc.format === "method/3.1")) {
          if (v["value-file"] || v.json) doc.steps[v.id] = CurrentStepSchema.parse(value());
          else {
            const kind = v.kind ?? "agent";
            const execution = kind === "run" ? { kind, runtime: v.runtime, entrypoint: v.entrypoint } : { kind, model: v.model ?? "default", prompt: v["instructions-file"] ? readFileSync(authoringPath(v["instructions-file"]), "utf8") : undefined, ...(kind === "agent" ? { tools: [] } : {}) };
            doc.steps[v.id] = CurrentStepSchema.parse({ ...(v.name ? { name: v.name } : {}), ...(v.purpose ? {purpose: v.purpose} : {}), do: execution, limits: { ...(v["timeout-ms"] ? { timeout_ms: Number(v["timeout-ms"])} : {}), ...(v["max-agent-turns"] ? { max_agent_turns: Number(v["max-agent-turns"]) } : {}), ...(v["max-model-requests"] ? { max_model_requests: Number(v["max-model-requests"]) } : {}) } });
          }
        } else {
          if (!v["instructions-file"]) throw Error("Supply --instructions-file.");
          doc.steps[v.id] = StepSchema.parse({ ...(v.name ? { name: v.name } : {}), do: readFileSync(authoringPath(v["instructions-file"]), "utf8") });
        }
      } else {
        if (!id || !Object.hasOwn(doc.steps, id)) throw Error("Step not found.");
        if (action === "remove") delete doc.steps[id];
        else if (action === "update") { const patch = value(); if (!patch || Array.isArray(patch) || typeof patch !== "object") throw Error("Supply step fields."); doc.steps[id] = ((doc.format === "method/3" || doc.format === "method/3.1") ? CurrentStepSchema : StepSchema).parse({ ...doc.steps[id], ...patch }); }
        else {
          if (!v.before || !Object.hasOwn(doc.steps, v.before)) throw Error("Supply --before with a step ID.");
          if (v.before !== id) { const entries = Object.entries(doc.steps).filter(([key]) => key !== id); const at = entries.findIndex(([key]) => key === v.before); entries.splice(at, 0, [id, doc.steps[id]]); doc.steps = Object.fromEntries(entries); }
        }
      }
    } else {
      if (!id || !Object.hasOwn(doc.steps, id)) throw Error("Step not found.");
      if (action === "remove") delete doc.steps[id].check;
      else if (action === "set") doc.steps[id].check = ((doc.format === "method/3" || doc.format === "method/3.1") ? CurrentCheckSchema : CheckSchema).parse(value());
      else throw Error("Use check set or check remove.");
    }
    return doc;
  });
  print({ file: resolve(file), workflow: result }); return true;
}
