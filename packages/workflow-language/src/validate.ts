import { stringify } from "yaml";
import { validateMethod } from '@withmethod/runtime/document.js';
export { parseDocumentValue, shapeErrors, MethodValidationError } from '@withmethod/runtime/document.js';
export { outputSchema } from '@withmethod/runtime/semantics.js';
import { type Workflow, type Step, type Shape } from "./schema.js";

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
export function loadWorkflow(value: unknown): Workflow {
  return validateMethod(value).method as Workflow;
}
