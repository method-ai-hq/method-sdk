import { canonicalJson } from "../../contracts/src/identity.js";
import { loadWorkflow, serializeWorkflow } from "../../workflow-language/src/validate.js";
import { z } from "zod";
import { WorkflowSchema, JsonSchema, type Workflow } from "../../workflow-language/src/schema.js";

const ReportItemSchema = z.strictObject({
  source_id: z.string(), result: z.enum(["covered", "missing", "ambiguous"]),
  locations: z.array(z.string()), explanation: z.string().min(1)
});
export const ConversionReportSchema = z.strictObject({
  schema: z.literal("workflow-conversion/1"), source_sha256: z.string(), workflow_sha256: z.string(),
  references: z.array(z.strictObject({ name: z.string(), sha256: z.string() })),
  status: z.enum(["ready", "needs_review"]), attempts: z.number().int().positive(),
  selected_attempt: z.number().int().positive(),
  coverage: z.array(ReportItemSchema), concerns: z.array(z.string()),
  review_method: z.enum(["independent_model_review", "format_validation"]),
  editor: z.strictObject({ agent: z.literal("Method Editing Agent"), summary: z.string(), elapsed_ms: z.number().nonnegative(), changed_paths: z.array(z.string()) }).optional(),
  requirement_coverage: z.array(ReportItemSchema).optional(),
  builder: z.strictObject({ definition: JsonSchema, sha256: z.string(), run_id: z.string(), status: z.string(), error: z.string().optional(), inputs: z.record(JsonSchema), steps: z.record(JsonSchema) }).optional()
});
export type ConversionReport = z.infer<typeof ConversionReportSchema>;
export function sourceSegments(source: string): Array<{ id: string; text: string }> {
  return source.split(/\n\s*\n/).filter(text => text.trim()).map((text, index) => ({ id: `source_${index + 1}`, text }));
}

export function renderPrompt(workflow: Workflow): string {
  loadWorkflow(workflow);
  return serializeWorkflow(workflow);
}
