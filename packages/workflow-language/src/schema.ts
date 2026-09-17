import { z } from "zod";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const JsonSchema: z.ZodType<Json> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(JsonSchema), z.record(JsonSchema)]));
export const NameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/).max(80).refine(name => !["constructor", "prototype", "__proto__"].includes(name), "Reserved name.");
export const ReferenceSchema = z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*|\.[0-9]+)*$/);
const Text = z.string().trim().min(1).max(16000);
export const TypeSchema = z.enum(["text", "number", "boolean", "record", "list", "file"]);
export type ValueType = z.infer<typeof TypeSchema>;
export type Shape = ValueType | { type: ValueType; description?: string | undefined; fields?: Record<string, Shape> | undefined; items?: Shape | undefined; format?: string | undefined };
export const ShapeSchema: z.ZodType<Shape> = z.lazy(() => z.union([TypeSchema, z.strictObject({ type: TypeSchema, description: Text.optional(), fields: z.record(NameSchema, ShapeSchema).optional(), items: ShapeSchema.optional(), format: Text.optional() })]));
export const DataSchema = z.strictObject({ type: TypeSchema, description: Text.optional(), fields: z.record(NameSchema, ShapeSchema).optional(), items: ShapeSchema.optional(), format: Text.optional() });
export const InputSchema = DataSchema.extend({ default: JsonSchema.optional() });
export const StateSchema = InputSchema.extend({ file: z.string().min(1).max(500) });
export const EnvironmentSchema = z.strictObject({ type: z.enum(["browser", "service", "desktop", "files", "tool"]), description: Text });
export const CheckSchema = z.union([
  Text,
  z.strictObject({ equals: z.strictObject({ actual: ReferenceSchema, expected: ReferenceSchema }) }),
  z.strictObject({ count: z.strictObject({ value: ReferenceSchema, min: z.number().int().nonnegative().optional(), max: z.number().int().nonnegative().optional() }) }),
  z.strictObject({ present: ReferenceSchema }),
  z.strictObject({ file: ReferenceSchema }),
]);
export const StepSchema = z.strictObject({
  name: Text.optional(), in: z.record(NameSchema, ReferenceSchema).optional(), do: Text.optional(), ask: Text.optional(),
  out: z.record(NameSchema, DataSchema).optional(), check: CheckSchema.optional(),
  each: z.record(NameSchema, ReferenceSchema).optional(), when: ReferenceSchema.optional(),
  after: z.union([NameSchema, z.array(NameSchema)]).optional(), changes: z.array(ReferenceSchema).optional(),
});
export const LegacyWorkflowSchema = z.strictObject({
  format: z.enum(["method/2", "workflow/2"]), name: Text, goal: Text,
  inputs: z.record(NameSchema, InputSchema).optional(), environment: z.record(NameSchema, EnvironmentSchema).optional(),
  state: z.record(NameSchema, StateSchema).optional(), steps: z.record(NameSchema, StepSchema),
  result: z.union([ReferenceSchema, z.record(NameSchema, ReferenceSchema)]),
});
export type LegacyWorkflow = z.infer<typeof LegacyWorkflowSchema>;
export type LegacyStep = z.infer<typeof StepSchema>;
export type LegacyCheck = z.infer<typeof CheckSchema>;
export type DataDefinition = z.infer<typeof DataSchema>;
export const FileArtifactSchema = z.strictObject({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) });

/** JSON Pointer remains a private editing/JSON utility, never a workflow binding. */
export function pointer(value: Json | undefined, path: string): Json | undefined {
  if (path === "") return value;
  if (!/^(?:\/(?:[^~]|~[01])*)*$/.test(path)) throw Error("Invalid JSON Pointer.");
  let current = value;
  for (const segment of path.slice(1).split("/")) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    if (Array.isArray(current) && !/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
    current = (current as Record<string, Json>)[key];
  }
  return current;
}

// Current shape validation comes from the runtime's single JSON Schema.
import { methodShape, stepShape, checkShape } from "@withmethod/runtime/document-validators.js";
import { methodSchema } from "@withmethod/runtime/schema.js";
import { zodToJsonSchema } from "zod-to-json-schema";
export type RunExecution = { kind: "run"; runtime: string; entrypoint: string; args?: string[] };
export type AgentExecution = { kind: "agent"; model: string; prompt: string; tools: string[] };
export type Execution = RunExecution | AgentExecution | { kind: "call"; model: string; prompt: string };
export type CurrentCheck = Exclude<LegacyCheck, string> | RunExecution | AgentExecution;
export type CurrentStep = Omit<LegacyStep, "do" | "check"> & {
  purpose?: string; do?: Execution; check?: CurrentCheck;
  reading?: { inputs?: string; outputs?: string; output_name?: string; condition?: string; check?: string; check_name?: string };
  repeat?: { max_iterations: number; until?: string };
  limits?: { timeout_ms?: number; max_agent_turns?: number; max_model_requests?: number };
};
export type CurrentWorkflow = Omit<LegacyWorkflow, "format" | "state" | "steps"> & {
  format: "method/3" | "method/3.1"; run_prompt?: string; files?: string[];
  state?: Record<string, z.infer<typeof InputSchema>>; steps: Record<string, CurrentStep>;
};
function currentShape<T>(validate: any): z.ZodType<T> {
  return z.any().superRefine((value, context) => {
    if (!validate(value)) for (const error of validate.errors ?? []) context.addIssue({
      code: z.ZodIssueCode.custom, message: `${error.instancePath || "/"}: ${error.message}`,
    });
  }) as z.ZodType<T>;
}
export const CurrentStepSchema = currentShape<CurrentStep>(stepShape);
export const CurrentCheckSchema = currentShape<CurrentCheck>(checkShape);
export const CurrentWorkflowSchema = currentShape<CurrentWorkflow>(methodShape).transform(value => value.run_prompt === undefined ? value : {...value, run_prompt: value.run_prompt.trim()});
export function documentSchema(format = "method/3.1") {
  return ["method/3", "method/3.1"].includes(format) ? methodSchema : zodToJsonSchema(LegacyWorkflowSchema);
}
export const WorkflowSchema = z.union([CurrentWorkflowSchema, LegacyWorkflowSchema]);
export type Workflow = z.infer<typeof WorkflowSchema>;
export function isCurrentWorkflow(workflow: Workflow): workflow is CurrentWorkflow { return workflow.format === "method/3" || workflow.format === "method/3.1"; }
export type Step = Workflow["steps"][string];
export type Check = NonNullable<Step["check"]>;
export function executionText(step: Step): string {
  if (!step.do) return step.ask ?? "";
  if (typeof step.do === "string") return step.do;
  return step.do.kind === "run" ? [step.do.runtime, step.do.entrypoint, ...(step.do.args ?? [])].join(" ") : step.do.prompt;
}
export function executionLabel(step: Step): string {
  return step.ask ? "Human input" : typeof step.do === "object" ? ({ run: "Script", call: "Model call", agent: "Agent" }[step.do.kind]) : "Agent";
}
