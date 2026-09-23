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
export const EnvironmentSchema = z.strictObject({ type: z.enum(["browser", "service", "desktop", "files", "tool"]), description: Text });
export type ExactCheck = {equals:{actual:string;expected:string}} | {count:{value:string;min?:number;max?:number}} | {present:string} | {file:string};
export type BaseStep = {name?:string; in?:Record<string,string>; ask?:string; out?:string|Record<string,z.infer<typeof DataSchema>>; each?:Record<string,string>; when?:string; after?:string|string[]; changes?:string[]};
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
export type RunExecution = { kind: "run"; runtime: string; entrypoint: string; args?: string[] };
export type AgentExecution = { kind: "agent"; model: string; prompt: string; tools?: string[]; browser?: string };
export type ClassifyExecution = { kind: "classify"; question: string; options: Record<string, string> };
export type Execution = ClassifyExecution | RunExecution | AgentExecution | { kind: "call"; model: string; prompt: string };
export type CurrentCheck = ExactCheck | RunExecution | AgentExecution;
export type CurrentStep = BaseStep & {
  purpose?: string; do?: Execution; check?: CurrentCheck;
  reading?: { inputs?: string; outputs?: string; output_name?: string; condition?: string; check?: string; check_name?: string };
  repeat?: { max_iterations: number; until?: string };
  limits?: { timeout_ms?: number; max_agent_turns?: number; max_model_requests?: number };
};
export type CurrentWorkflow = {
  name: string; goal: string; inputs?: Record<string,z.infer<typeof InputSchema>>; environment?: Record<string,z.infer<typeof EnvironmentSchema>>; result: string | Record<string,string>;
  format: "method/3.1" | "method/3.2"; run_prompt?: string; run_label_input?: string; files?: string[];
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
export const CurrentWorkflowSchema = currentShape<CurrentWorkflow>(methodShape);
export const WorkflowSchema = CurrentWorkflowSchema;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type Step = Workflow["steps"][string];
export type Check = NonNullable<Step["check"]>;
export function executionText(step: Step): string {
  if (!step.do) return step.ask ?? "";
  return step.do.kind === "run" ? (step.purpose ?? "No script description was recorded.") : step.do.kind === "classify" ? step.do.question : step.do.prompt;
}
export function executionLabel(step: Step): string {
  return step.ask ? "Human input" : typeof step.do === "object" ? ({ run: "Script", call: "Model call", agent: "Agent", classify: "Classification" }[step.do.kind]) : "Agent";
}

import { effectiveOutputs as runtimeOutputs } from '@withmethod/runtime/semantics.js';
export function effectiveOutputs(step: Step): Record<string, DataDefinition> { return runtimeOutputs(step); }

export function executionCommand(execution: RunExecution): string {
  return [execution.runtime, execution.entrypoint, ...(execution.args ?? [])].join(' ');
}
