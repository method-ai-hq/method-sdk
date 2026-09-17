import { isCurrentWorkflow } from "./schema.js";
import { validateSemantics } from '@withmethod/runtime/semantics.js';
import { parseDocument, stringify } from "yaml";
import { WorkflowSchema, type Workflow, type LegacyWorkflow, type CurrentWorkflow, type Step, type Shape, type Json } from "./schema.js";

export function parseDocumentValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const document = parseDocument(value, { uniqueKeys: true, strict: true });
  if (document.errors.length) throw Error(document.errors.map(e => e.message).join("\n"));
  return document.toJS({ maxAliasCount: 0 });
}
export function serializeWorkflow(value: unknown): string { return stringify(value, { lineWidth: 0 }); }
export function shapeObject(shape: Shape): Exclude<Shape, string> { return typeof shape === "string" ? { type: shape } : shape; }
export function validateShape(shape: Shape, label: string): void {
  const s = shapeObject(shape);
  if (s.type === "record" && !s.fields) throw Error(`${label}: record needs fields.`);
  if (s.type === "list" && (!!s.fields === !!s.items)) throw Error(`${label}: list needs either fields or items.`);
  if (s.fields && !["record", "list"].includes(s.type)) throw Error(`${label}: fields require a record or list.`);
  if (s.items && s.type !== "list") throw Error(`${label}: items require a list.`);
  if (s.format && s.type !== "file") throw Error(`${label}: format describes a file.`);
  Object.entries(s.fields ?? {}).forEach(([key, child]) => validateShape(child, `${label}.${key}`));
  if (s.items) validateShape(s.items, `${label}.items`);
}
export function shapeErrors(shape: Shape, value: unknown, label = "value"): string[] {
  const s = shapeObject(shape);
  if (s.type === "text") return typeof value === "string" ? [] : [`${label}: expected text.`];
  if (s.type === "number") return typeof value === "number" && Number.isFinite(value) ? [] : [`${label}: expected a number.`];
  if (s.type === "boolean") return typeof value === "boolean" ? [] : [`${label}: expected true or false.`];
  if (s.type === "file") return value && typeof value === "object" && !Array.isArray(value) && typeof (value as any).path === "string" ? [] : [`${label}: expected a saved file.`];
  if (s.type === "list") return Array.isArray(value) ? value.flatMap((v, i) => shapeErrors(s.fields ? { type: "record", fields: s.fields } : s.items!, v, `${label}[${i}]`)) : [`${label}: expected a list.`];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [`${label}: expected a record.`];
  return [...Object.entries(s.fields ?? {}).flatMap(([k, child]) => shapeErrors(child, (value as any)[k], `${label}.${k}`)), ...Object.keys(value).filter(k => !Object.hasOwn(s.fields ?? {}, k)).map(k => `${label}.${k}: unexpected field.`)];
}
export function outputSchema(definitions: Record<string, Shape>): Record<string, unknown> {
  function schema(shape: Shape): any {
    const s = shapeObject(shape), description = s.description ? { description: s.description } : {};
    if (["text", "number", "boolean"].includes(s.type)) return { type: s.type === "text" ? "string" : s.type, ...description };
    if (s.type === "file") return { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false, ...description };
    if (s.type === "list") return { type: "array", items: schema(s.fields ? { type: "record", fields: s.fields } : s.items!), ...description };
    return { ...outputSchema(s.fields ?? {}), ...description };
  }
  return { type: "object", properties: Object.fromEntries(Object.entries(definitions).map(([k, v]) => [k, schema(v)])), required: Object.keys(definitions), additionalProperties: false };
}
export function references(step: Step): string[] { return [...Object.values(step.in ?? {}), ...Object.values(step.each ?? {}), ...(step.when ? [step.when] : [])]; }
export function producers(workflow: Workflow): Map<string, string> {
  const result = new Map<string, string>();
  for (const [id, step] of Object.entries(workflow.steps)) for (const name of Object.keys(step.out ?? {})) {
    if (["inputs", "state", "environment", "run"].includes(name) || result.has(name)) throw Error(`Output ${name} must have one unique name.`);
    result.set(name, id);
  }
  return result;
}
export function referenceShape(workflow: Workflow, reference: string): Shape | undefined {
  const parts = reference.split("."), root = parts.shift()!;
  let shape: Shape | undefined;
  if (root === "environment") { if (parts.length !== 1 || !workflow.environment?.[parts[0]!]) throw Error(`Unknown connection ${reference}.`); return undefined; }
  if (root === "run") { if (parts.join(".") !== "started_at") throw Error(`Unknown run value ${reference}.`); return "text"; }
  if (root === "inputs" || root === "state") shape = workflow[root]?.[parts.shift()!];
  else {
    const producer = producers(workflow).get(root), step = producer ? workflow.steps[producer] : undefined;
    shape = step?.out?.[root];
    if (shape && step?.each) shape = { type: "list", items: shape };
  }
  if (!shape) throw Error(`Unknown data ${reference}.`);
  for (const part of parts) {
    const s = shapeObject(shape);
    if (s.type === "list" && /^(0|[1-9][0-9]*)$/.test(part)) shape = s.fields ? { type: "record", fields: s.fields } : s.items;
    else if (s.type === "record") shape = s.fields?.[part];
    else shape = undefined;
    if (!shape) throw Error(`Unknown field ${reference}.`);
  }
  return shape;
}
export function stepDependencies(workflow: Workflow, id: string): string[] {
  const step = workflow.steps[id]!, outputProducers = producers(workflow);
  return [...new Set([...(typeof step.after === "string" ? [step.after] : step.after ?? []), ...references(step).flatMap(ref => { const producer = outputProducers.get(ref.split(".")[0]!); return producer ? [producer] : []; })])];
}
export function loadWorkflow(value: LegacyWorkflow): LegacyWorkflow;
export function loadWorkflow(value: CurrentWorkflow): CurrentWorkflow;
export function loadWorkflow(value: unknown): Workflow;
export function loadWorkflow(value: unknown): Workflow {
  const raw = parseDocumentValue(value);
  if (raw && typeof raw === "object" && (raw as any).schema === "workflow/1") throw Error("WORKFLOW_FORMAT: this document uses workflow/1. Keep it as a reference and author a method/2 document before running it.");
  const workflow = WorkflowSchema.parse(raw);
  if (isCurrentWorkflow(workflow)) {
    validateSemantics(workflow, (def: Shape, value: unknown) => { const errors = shapeErrors(def, value); if (errors.length) throw Error(errors.join("\n")); });
    return workflow;
  }
  if (!Object.keys(workflow.steps).length) throw Error("A method needs at least one step.");
  producers(workflow);
  for (const [name, definition] of [...Object.entries(workflow.inputs ?? {}), ...Object.entries(workflow.state ?? {})]) {
    validateShape(definition, name);
    if ("default" in definition && definition.default !== undefined) { const errors = shapeErrors(definition, definition.default, name); if (errors.length) throw Error(errors.join("\n")); }
  }
  const files = new Set<string>();
  for (const [name, state] of Object.entries(workflow.state ?? {})) {
    if (state.file.startsWith("/") || state.file.includes("\\") || state.file.includes(":") || state.file.split("/").some(p => ["", ".", "..", "sensitive", ".method"].includes(p))) throw Error(`state.${name}: use a relative data file.`);
    if (files.has(state.file)) throw Error(`State files must be distinct: ${state.file}.`); files.add(state.file);
  }
  for (const [id, step] of Object.entries(workflow.steps)) {
    if (!!step.do === !!step.ask) throw Error(`${id}: supply either do or ask.`);
    if (step.changes?.some(t => t.startsWith("environment.")) && !step.check) throw Error(`${id}: an external change needs an independent check.`);
    if (step.ask && step.changes?.length) throw Error(`${id}: collect human decisions, then apply changes in a do step.`);
    if (step.each && Object.keys(step.each).length !== 1) throw Error(`${id}: each needs one item name and collection.`);
    const local: Record<string, Shape | undefined> = {};
    for (const [alias, ref] of Object.entries(step.each ?? {})) { const shape = referenceShape(workflow, ref); if (!shape || shapeObject(shape).type !== "list") throw Error(`${id}: each requires a list.`); const s = shapeObject(shape); local[alias] = s.fields ? { type: "record", fields: s.fields } : s.items; }
    for (const [alias, ref] of Object.entries(step.in ?? {})) { if (Object.hasOwn(local, alias)) throw Error(`${id}: duplicate input ${alias}.`); local[alias] = referenceShape(workflow, ref); }
    if (step.when && shapeObject(referenceShape(workflow, step.when) ?? "text").type !== "boolean") throw Error(`${id}: when must name a boolean.`);
    for (const [name, definition] of Object.entries(step.out ?? {})) { if (Object.hasOwn(local, name)) throw Error(`${id}: output ${name} conflicts with an input.`); validateShape(definition, `${id}.${name}`); }
    for (const target of step.changes ?? []) {
      if (!/^(state|environment)\.[a-z][a-z0-9_]*$/.test(target)) throw Error(`${id}: changes must name state or an environment target.`);
      referenceShape(workflow, target);
    }
    if (new Set(step.changes).size !== (step.changes?.length ?? 0)) throw Error(`${id}: duplicate change target.`);
    for (const dep of stepDependencies(workflow, id)) if (!workflow.steps[dep] || dep === id) throw Error(`${id}: invalid dependency ${dep}.`);
    const context = { ...local, ...step.out };
    for (const match of (step.do ?? step.ask ?? "").matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) checkLocalReference(local, match[1]!, id);
    if (typeof step.check === "object") {
      const c = step.check;
      for (const ref of "equals" in c ? [c.equals.actual, c.equals.expected] : "count" in c ? [c.count.value] : "present" in c ? [c.present] : [c.file]) checkLocalReference(context, ref, id);
      if ("count" in c && (c.count.min === undefined && c.count.max === undefined || (c.count.min ?? 0) > (c.count.max ?? Infinity))) throw Error(`${id}: invalid count range.`);
    }
  }
  const visited = new Set<string>(), active = new Set<string>();
  function visit(id: string) { if (active.has(id)) throw Error(`Dependency cycle at ${id}.`); if (visited.has(id)) return; active.add(id); stepDependencies(workflow, id).forEach(visit); active.delete(id); visited.add(id); }
  Object.keys(workflow.steps).forEach(visit);
  for (const ref of typeof workflow.result === "string" ? [workflow.result] : Object.values(workflow.result)) { if (ref.startsWith("environment.")) throw Error("The result must be data."); referenceShape(workflow, ref); }
  return workflow;
}
function checkLocalReference(context: Record<string, Shape | undefined>, ref: string, id: string) {
  const [root, ...parts] = ref.trim().split(".");
  if (!root || !Object.hasOwn(context, root)) throw Error(`${id}: unknown local name ${ref}.`);
  let shape = context[root];
  for (const part of parts) { const s = shape && shapeObject(shape); shape = s?.type === "record" ? s.fields?.[part] : s?.type === "list" && /^(0|[1-9][0-9]*)$/.test(part) ? s.fields ? { type: "record", fields: s.fields } : s.items : undefined; if (!shape) throw Error(`${id}: unknown local field ${ref}.`); }
}
