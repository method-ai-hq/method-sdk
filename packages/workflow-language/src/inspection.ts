import { AttachedFileSchema, MAX_RESULT_FILES } from "./result-files.js";
import { z } from "zod";
import { JsonSchema, WorkflowSchema, effectiveOutputs, executionText, type Json, type Step, type Workflow, type Shape } from "./schema.js";
import { producers, references, referenceShape } from "./validate.js";
export const FailureOwnerSchema = z.enum(["method_code", "agent_work", "outside_service", "limit", "setup", "needs_you", "method_platform"]);
export type FailureOwner = z.infer<typeof FailureOwnerSchema>;
/** The runtime's failure record of a run that stopped: whose problem it is, where in the Method, and the next action. */
export const FailureSchema = z.strictObject({
  owner: FailureOwnerSchema, code: z.string(), headline: z.string(),
  step: z.string().nullable(), step_name: z.string().nullable(),
  iteration: z.number().int().nonnegative().nullable(), failed_iterations: z.array(z.number().int().nonnegative()), total: z.number().int().nonnegative().nullable(),
  phase: z.enum(["action", "check", "effect", "tool", "setup"]).nullable(), check_name: z.string().nullable(),
  next: z.strictObject({ action: z.enum(["fix_method", "run_again", "raise_limit", "fix_setup", "answer", "report_bug"]), text: z.string(), command: z.string().optional() }),
  // Run content. The device form of a run record (deviceOnly) has no evidence, details, or diagnostics.
  evidence: z.array(z.string()).optional(), details: z.string().optional(), diagnostics: z.string().optional(),
});
export type RunFailure = z.infer<typeof FailureSchema>;
const ownerTexts: Record<FailureOwner, string> = {
  method_code: "Problem in the Method's code", agent_work: "The agent's work did not pass", outside_service: "A service outside Method",
  limit: "A limit was reached", setup: "Your setup", needs_you: "Needs your answer", method_platform: "A problem in Method",
};
/** Whose problem a failure is, in a few plain words. */
export function ownerText(owner: FailureOwner): string { return ownerTexts[owner]; }
export const RunStatusSchema = z.enum(["running", "waiting_for_you", "succeeded", "unconfirmed", "failed"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;
// What a script process was seen to do (runtime observed_effects): hosts, paths, variable names, and program names.
const observedList = z.array(z.string()).max(200);
export const ObservedEffectsSchema = z.union([
  z.strictObject({ network: observedList, reads: observedList, writes: observedList, env: observedList, runs: observedList, truncated: z.literal(true).optional() }),
  z.strictObject({ unavailable: z.string() }),
]);
export type ObservedEffects = z.infer<typeof ObservedEffectsSchema>;
export const RunEventSchema = z.strictObject({
  provider: z.string().optional(), model: z.string().optional(), kind: z.literal('classify').optional(),
  request_id: z.string().optional(), operation_id: z.string().optional(), confidence: z.number().finite().min(0).max(1).nullable().optional(),
  usage: z.strictObject({input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(), cost: z.number().finite().nonnegative().optional()}).nullable().optional(),
  duration_ms: z.number().finite().nonnegative().optional(),
  at: z.string(), type: z.string(), detail: z.string().optional(),
  sequence: z.number().int().nonnegative().optional(), phase: z.enum(["action", "check"]).optional(),
  tool: z.string().optional(), call_id: z.string().optional(), command: z.string().optional(),
  exit_code: z.number().int().nullable().optional(), diagnostics: z.string().optional(),
  child: z.string().max(100).optional(), completed: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(), unit: z.string().max(50).optional(),
  // Notice events: key is the same for each repeat of one problem, so a newer notice replaces an older one.
  key: z.string().max(500).optional(), attempt: z.number().int().positive().optional(), attempts: z.number().int().positive().optional(),
});
export const InspectionSchema = z.strictObject({
  started_at: z.string().optional(), device_name: z.string().optional(),
  local_run_directory: z.string().optional(),
  // run_data: device. The run's content stays on the device that ran it.
  content: z.literal("device").optional(),
  schema: z.literal("workflow-inspection/2"), workflow: WorkflowSchema, run_id: z.string(), status: RunStatusSchema, failure: FailureSchema.optional(),
  inputs: z.record(JsonSchema), state: z.record(JsonSchema).optional(), resources: z.record(z.strictObject({ description: z.string(), setup: z.string().optional(), path: z.string().optional() })),
  environment: z.record(z.object({ result: z.enum(["pass", "fail", "ambiguous"]), summary: z.string(), evidence: z.array(z.string()) })).optional(),
  files: z.array(AttachedFileSchema).max(MAX_RESULT_FILES).optional(),
  events: z.array(RunEventSchema).optional(),
  invocations: z.record(z.strictObject({
    step_id: z.string(), status: z.enum(["running", "returned", "passed", "skipped", "waiting_for_you", "failed", "stopped"]), verification: z.enum(["checked", "unchecked"]).optional(), inputs: z.record(JsonSchema).optional(), outputs: z.record(JsonSchema).optional(),
    checks: z.array(z.object({ id: z.string(), result: z.enum(["pass", "fail", "ambiguous"]), summary: z.string(), evidence: z.array(z.string()), method: z.string() })), changes: z.record(JsonSchema),
    prompts: z.array(z.strictObject({ sequence: z.number().int(), phase: z.enum(["action", "check"]), template: z.string(), rendered: z.string() })).optional(),
    events: z.array(RunEventSchema),
    observed_effects: ObservedEffectsSchema.optional(),
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
    const definition = root === "environment" ? workflow.environment?.[parts[1]!] : root === "inputs" ? workflow.inputs?.[parts[1]!] : root === "state" ? workflow.state?.[parts[1]!] : effectiveOutputs(workflow.steps[producer.get(root) ?? ""] ?? {})[root];
    const shape = referenceShape(workflow, ref);
    const item: InspectItem = { id: ref, name: label(parts.at(-1)!), description: definition?.description ?? "The time this run started.", kind: root === "environment" ? `${definition?.type} connection` : typeof shape === "string" ? shape : shape?.type ?? "connection", ...(shape ? { shape } : {}), createdBy: producer.has(root) ? [producer.get(root)!] : [], usedBy: [], checkedBy: [], changedBy: [] };
    items.set(ref, item); return item;
  }
  for (const section of ["inputs", "state", "environment"] as const) for (const name of Object.keys(workflow[section] ?? {})) itemFor(`${section}.${name}`);
  for (const name of producer.keys()) itemFor(name);
  for (const [id, step] of Object.entries(workflow.steps)) {
    for (const ref of references(step)) { const item = itemFor(ref); item.usedBy.push(id); if (step.check) item.checkedBy.push(id); }
    for (const name of Object.keys(effectiveOutputs(step))) if (step.check) itemFor(name).checkedBy.push(id);
    for (const target of step.changes ?? []) { itemFor(target).changedBy.push(id); if (step.check) itemFor(target).checkedBy.push(id); }
  }
  for (const item of items.values()) { item.usedBy = [...new Set(item.usedBy)]; item.checkedBy = [...new Set(item.checkedBy)]; item.changedBy = [...new Set(item.changedBy)]; }
  return { items, itemFor };
}
export function copyInstructions(step: Step, inputs?: Record<string, Json>, resources?: Record<string, unknown>): string {
  return [executionText(step), inputs ? `Inputs:\n${JSON.stringify(inputs, null, 2)}` : `Supply these named inputs before running:\n${JSON.stringify({ ...step.in, ...step.each }, null, 2)}`, `Return:\n${JSON.stringify(effectiveOutputs(step), null, 2)}`, ...(resources ? [`Connections:\n${JSON.stringify(resources, null, 2)}`] : [])].join("\n\n");
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

/**
 * The device form of a run record (run_data: device). Keep step status, kinds, names, timing, task counts, and the failure record without its
 * evidence, details, and diagnostics. Remove inputs, outputs, prompts, files, event text, and other free text. The server accepts only this
 * form when an organization keeps run content on devices.
 */
export function deviceOnly(inspection: RunInspection): RunInspection {
  const failure = inspection.failure ? (({ evidence, details, diagnostics, ...kept }) => ({ failure: kept }))(inspection.failure) : {};
  const event = ({ at, type, sequence, phase, duration_ms, usage, provider, model, kind, exit_code, completed, total, key, attempt, attempts }: any) =>
    Object.fromEntries(Object.entries({ at, type, sequence, phase, duration_ms, usage, provider, model, kind, exit_code, completed, total, key, attempt, attempts }).filter(([, value]) => value !== undefined)) as any;
  return {
    schema: inspection.schema, content: 'device', workflow: inspection.workflow, run_id: inspection.run_id, status: inspection.status, ...failure,
    ...(inspection.started_at ? { started_at: inspection.started_at } : {}), ...(inspection.device_name ? { device_name: inspection.device_name } : {}),
    inputs: {}, resources: Object.fromEntries(Object.entries(inspection.resources).map(([name, value]) => [name, { description: value.description }])),
    ...(inspection.events ? { events: inspection.events.map(event) } : {}),
    invocations: Object.fromEntries(Object.entries(inspection.invocations).map(([id, value]) => [id, {
      step_id: value.step_id, status: value.status, ...(value.verification ? { verification: value.verification } : {}),
      checks: value.checks.map(check => ({ id: check.id, result: check.result, summary: '', evidence: [], method: check.method })), changes: {}, events: value.events.map(event),
    }])),
  } as RunInspection;
}
