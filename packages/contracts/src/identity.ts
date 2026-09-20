import { createHash } from "node:crypto";
import { z } from "zod";

export const StableIdSchema = z.string().regex(
  /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/,
  "stable IDs use lowercase letters, numbers, dots, underscores, and hyphens"
);

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const ConfidenceSchema = z.number().min(0).max(1);

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function semanticDigest(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** Document identity preserves authored step and classifier option order. */
export function workflowDocumentDigest(value: { steps: Record<string, unknown> }): string {
  return semanticDigest({ ...value, steps: Object.entries(value.steps).map(([id, raw]) => {
    const step = raw as {do?: {kind?: string; options?: Record<string, unknown>}} | null;
    return [id, step?.do?.kind === 'classify'
      ? {...step, do: {...step.do, options: Object.entries(step.do.options ?? {})}}
      : raw];
  }) });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonicalize(child)])
  );
}
