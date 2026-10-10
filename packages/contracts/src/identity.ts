import { createHash } from "node:crypto";
import { z } from "zod";
import { documentForDigest } from "@withmethod/runtime/document.js";

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

/**
 * Document identity preserves authored step and classifier option order. The Method ID (`id:`) names the account
 * Method and is not content: a copy with another ID has the same digest.
 */
export function workflowDocumentDigest(value: { steps: Record<string, unknown> }): string {
  const content = documentForDigest(value) as { steps: Record<string, unknown> };
  return semanticDigest({ ...content, steps: Object.entries(value.steps).map(([id, raw]) => {
    const step = raw as {do?: {kind?: string; options?: Record<string, unknown>}} | null;
    return [id, step?.do?.kind === 'classify'
      ? {...step, do: {...step.do, options: Object.entries(step.do.options ?? {})}}
      : raw];
  }) });
}

/** A version ID: the same content (package digest) of a Method is always the same version. */
export function versionIdFor(methodId: string, packageDigest: string): string {
  return `v_${sha256(`${methodId}:${packageDigest}`).slice(0, 32)}`;
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
