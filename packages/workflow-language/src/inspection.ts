import { AttachedFileSchema, MAX_RESULT_FILES } from "./result-files.js";
import { z } from "zod";
import { JsonSchema, WorkflowSchema, executionText, type Json, type Step, type Workflow, type Shape } from "./schema.js";
import { producers, references, referenceShape } from "./validate.js";
export const FailureSchema = z.strictObject({ phase: z.enum(["environment", "input", "action", "check", "change"]), expected: z.string(), observed: z.string(), evidence: z.array(z.string()) });
export const RunEventSchema = z.strictObject({
  provider: z.string().optional(), model: z.string().optional(),
  at: z.string(), type: z.string(), detail: z.string().optional(),
  sequence: z.number().int().nonnegative().optional(), phase: z.enum(["action", "check"]).optional(),
  tool: z.string().optional(), call_id: z.string().optional(), command: z.string().optional(),
  exit_code: z.number().int().nullable().optional(), diagnostics: z.string().optional(),
  child: z.string().max(100).optional(), completed: z.number().int().nonnegative().optional(),
  total: z.number().int().positive().optional(), unit: z.string().max(50).optional(),
});
export const InspectionSchema = z.strictObject({
  local_run_directory: z.string().optional(),
  schema: z.literal("workflow-inspection/2"), workflow: WorkflowSchema, run_id: z.string(), status: z.string(), error: z.string().optional(), failure: FailureSchema.optional(),
  inputs: z.record(JsonSchema), state: z.record(JsonSchema).optional(), resources: z.record(z.strictObject({ description: z.string(), setup: z.string().optional(), path: z.string().optional() })),
  environment: z.record(z.object({ result: z.enum(["pass", "fail", "ambiguous"]), summary: z.string(), evidence: z.array(z.string()) })).optional(),
  files: z.array(AttachedFileSchema).max(MAX_RESULT_FILES).optional(),
  events: z.array(RunEventSchema).optional(),
  invocations: z.record(z.strictObject({
    step_id: z.string(), status: z.string(), verification: z.enum(["checked", "unchecked"]).optional(), error: z.string().optional(), failure: FailureSchema.optional(), inputs: z.record(JsonSchema).optional(), outputs: z.record(JsonSchema).optional(),
    checks: z.array(z.object({ id: z.string(), result: z.enum(["pass", "fail", "ambiguous"]), summary: z.string(), evidence: z.array(z.string()), method: z.string() })), changes: z.record(JsonSchema),
    prompts: z.array(z.strictObject({ sequence: z.number().int(), phase: z.enum(["action", "check"]), template: z.string(), rendered: z.string() })).optional(),
    events: z.array(RunEventSchema),
  }))
});
export type RunInspection = z.infer<typeof InspectionSchema>;
export function label(value: string): string { return value.replace(/[_-]+/g, " ").trim(); }
export function stepTitle(step: Step, id = "Step"): string { return step.name ?? label(id); }
export function canonical(value: unknown): string {
  const sort = (v: any): any => Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(value));
}
export type InspectItem = { id: string; name: string; description: string; kind: string; shape?: Shape; createdBy: string[]; usedBy: string[]; checkedBy: string[]; changedBy: string[] };
export function inspectCatalog(workflow: Workflow) {
  const items = new Map<string, InspectItem>();
  const producer = producers(workflow);
  function itemFor(ref: string): InspectItem {
    if (items.has(ref)) return items.get(ref)!;
    const parts = ref.split("."), root = parts[0]!;
    const definition = root === "environment" ? workflow.environment?.[parts[1]!] : root === "inputs" ? workflow.inputs?.[parts[1]!] : root === "state" ? workflow.state?.[parts[1]!] : workflow.steps[producer.get(root) ?? ""]?.out?.[root];
    const shape = referenceShape(workflow, ref);
    const item: InspectItem = { id: ref, name: label(parts.at(-1)!), description: definition?.description ?? "The time this run started.", kind: root === "environment" ? `${definition?.type} connection` : typeof shape === "string" ? shape : shape?.type ?? "connection", ...(shape ? { shape } : {}), createdBy: producer.has(root) ? [producer.get(root)!] : [], usedBy: [], checkedBy: [], changedBy: [] };
    items.set(ref, item); return item;
  }
  for (const section of ["inputs", "state", "environment"] as const) for (const name of Object.keys(workflow[section] ?? {})) itemFor(`${section}.${name}`);
  for (const name of producer.keys()) itemFor(name);
  for (const [id, step] of Object.entries(workflow.steps)) {
    for (const ref of references(step)) { const item = itemFor(ref); item.usedBy.push(id); if (step.check) item.checkedBy.push(id); }
    for (const name of Object.keys(step.out ?? {})) if (step.check) itemFor(name).checkedBy.push(id);
    for (const target of step.changes ?? []) { itemFor(target).changedBy.push(id); if (step.check) itemFor(target).checkedBy.push(id); }
  }
  for (const item of items.values()) { item.usedBy = [...new Set(item.usedBy)]; item.checkedBy = [...new Set(item.checkedBy)]; item.changedBy = [...new Set(item.changedBy)]; }
  return { items, itemFor };
}
export function copyInstructions(step: Step, inputs?: Record<string, Json>, resources?: Record<string, unknown>): string {
  return [executionText(step), inputs ? `Inputs:\n${JSON.stringify(inputs, null, 2)}` : `Supply these named inputs before running:\n${JSON.stringify({ ...step.in, ...step.each }, null, 2)}`, `Return:\n${JSON.stringify(step.out ?? {}, null, 2)}`, ...(resources ? [`Connections:\n${JSON.stringify(resources, null, 2)}`] : [])].join("\n\n");
}
export function observedValue(item: InspectItem, inspection: RunInspection, invocation?: string): Json | undefined {
  const [root, ...parts] = item.id.split(".");
  let value: any;
  if (root === "inputs") value = inspection.inputs;
  else if (root === "state") value = inspection.state;
  else if (root === "environment") value = inspection.resources;
  else {
    const rows = Object.entries(inspection.invocations).filter(([id, row]) => item.createdBy.includes(row.step_id) && (!invocation || id === invocation));
    if (!rows.length) return undefined;
    value = rows.length === 1 ? rows[0]![1].outputs?.[root!] : rows.map(([, row]) => row.outputs?.[root!] ?? null);
  }
  for (const part of parts) { if (!value || !Object.hasOwn(value, part)) return undefined; value = value[part]; }
  return value;
}
