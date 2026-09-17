import { z } from "zod";
import { JsonSchema, type Json, type LegacyStep as Step, type DataDefinition } from "../../workflow-language/src/schema.js";
export type Connection = { description: string; setup?: string | undefined; path?: string | undefined };
export type Connections = Record<string, Connection>;
export const ObservationSchema = z.strictObject({ target: z.string(), status: z.enum(["applied", "not_applied", "unknown"]), evidence: z.array(z.string()) });
export const StepResultSchema = z.strictObject({ outputs: z.record(JsonSchema), updates: z.record(JsonSchema).optional(), observations: z.array(ObservationSchema).optional(), note: z.string().optional() });
export type StepResult = z.infer<typeof StepResultSchema>;
export type StepRequest = {
  run_id: string; invocation: string; attempt: number; timeout_ms: number; directory: string; workspace: string;
  step: Step & { id: string }; instructions: string; inputs: Record<string, Json>; resources: Connections;
  outputs: Record<string, DataDefinition>; files: Record<string, string>;
  changes: Record<string, { description: string; path?: string | undefined; before?: Json; definition?: DataDefinition }>;
  previous_failure?: string;
};
export interface Executor { name: string; execute(request: StepRequest): Promise<StepResult> }
export const DecisionSchema = z.strictObject({ result: z.enum(["pass", "fail", "ambiguous"]), summary: z.string().min(1), evidence: z.array(z.string()) });
export type Decision = z.infer<typeof DecisionSchema>;
export type CheckRequest = {
  run_id: string; invocation: string; directory: string; run_directory: string; workspace: string;
  instructions: string; inputs: Record<string, Json>; outputs: Record<string, Json>; resources: Connections;
  changes: Record<string, { description: string; path?: string | undefined; before?: Json; after?: Json }>;
  timeout_ms: number;
};
export interface Verifier { name: string; verify(request: CheckRequest): Promise<Decision> }
export type CheckResult = Decision & { id: string; method: "schema" | "assert" | "agent" | "human" };
export type Event = { at: string; type: string; step?: string; detail?: string };
export type Failure = { phase: "environment" | "input" | "action" | "check" | "change"; expected: string; observed: string; evidence: string[] };
export type RunResult = { schema: "workflow-run/2"; run_id: string; status: "succeeded" | "failed" | "needs_attention"; outputs: Record<string, Json>;
  steps: Record<string, { status: "passed" | "skipped" | "failed" | "needs_attention"; verification?: "checked" | "unchecked"; checks: CheckResult[]; attempts: number; outputs?: Record<string, Json>; failure?: Failure }>;
  error?: string; failure?: Failure;
};
