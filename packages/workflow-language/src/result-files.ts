import { z } from "zod";
// Bound both decoded content and compressed transfer size.
export const MAX_RESULT_FILES = 20_000;
export const MAX_RESULT_BYTES = 100_000_000;
export const MAX_RESULT_TRANSFER_BYTES = 20_000_000;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ResultPathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path
        .split("/")
        .some(
          (part) =>
            !part || part === "." || part === "..",
        ) &&
      !/[?#%\x00-\x1f]/.test(path),
    "Use a relative file path without parent directories.",
  );
export const WebsiteFileSchema = z.strictObject({
  path: ResultPathSchema,
  sha256: hash,
  media_type: z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/),
});
/** A declared file output with format: method-website contains this manifest. */
export const WebsiteManifestSchema = z
  .strictObject({
    schema: z.literal("method-website/1"),
    title: z.string().min(1).max(160),
    entrypoint: ResultPathSchema,
    files: z.array(WebsiteFileSchema).min(1).max(MAX_RESULT_FILES),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.files.map((file) => file.path)).size !== value.files.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Website paths must be unique.",
      });
    if (
      !value.files.some(
        (file) =>
          file.path === value.entrypoint && file.media_type === "text/html",
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "The start page must be an HTML file in the file list.",
      });
  });
export const AttachedFileSchema = z.strictObject({
  path: z.string(),
  sha256: z.string(),
  status: z.enum(["verified", "unavailable"]),
  observed_at: z.string(),
  text: z.string().optional(),
  bytes: z.number().optional(),
  reason: z.string().optional(),
  title: z.string().max(160).optional(),
  media_type: z.string().optional(),
  data: z.string().max(MAX_RESULT_TRANSFER_BYTES * 4 / 3).optional(),
  encoding: z.literal("gzip").optional(),
  stored: z.boolean().optional(),
  website: z
    .strictObject({
      entrypoint: z.string(),
      files: z
        .array(
          z.strictObject({
            path: z.string(),
            sha256: hash,
            media_type: z.string(),
          }),
        )
        .max(MAX_RESULT_FILES),
    })
    .optional(),
});
export type AttachedFile = z.infer<typeof AttachedFileSchema>;

/**
 * A step value too large for the run record. The record keeps this reference in the value's place, and the value's JSON
 * is a stored result file. A run page reads the value when a person opens it.
 */
export const STORED_VALUE = "$method_stored_value";
export type StoredValue = { [STORED_VALUE]: { sha256: string; bytes: number } };
const StoredValueSchema = z.strictObject({ [STORED_VALUE]: z.strictObject({ sha256: hash, bytes: z.number().int().min(0) }) });
/** The stored file of a value that the record keeps as a reference, or undefined for a recorded value. */
export function storedValue(value: unknown): StoredValue[typeof STORED_VALUE] | undefined {
  if (!value || typeof value !== "object" || !Object.hasOwn(value, STORED_VALUE)) return undefined;
  const parsed = StoredValueSchema.safeParse(value);
  return parsed.success ? parsed.data[STORED_VALUE] : undefined;
}
/** Each stored value that a run record refers to, once. Only step inputs and outputs are stored this way. */
export function storedValues(run: { invocations: Record<string, { inputs?: Record<string, unknown> | undefined; outputs?: Record<string, unknown> | undefined }> }) {
  const found = new Map<string, { sha256: string; bytes: number }>();
  for (const row of Object.values(run.invocations))
    for (const value of [...Object.values(row.inputs ?? {}), ...Object.values(row.outputs ?? {})]) {
      const stored = storedValue(value);
      if (stored) found.set(stored.sha256, stored);
    }
  return [...found.values()];
}
