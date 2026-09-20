import { effectiveOutputs } from '../../workflow-language/src/schema.js';
import { gzipSync, gunzipSync } from "node:zlib";
import { Buffer } from "node:buffer";
import { dirname, join, resolve, sep, extname } from "node:path";
import { checkedFile } from "./files.js";
import {
  WebsiteManifestSchema, MAX_RESULT_FILES, MAX_RESULT_BYTES, MAX_RESULT_TRANSFER_BYTES,
  type AttachedFile,
} from "../../workflow-language/src/result-files.js";
import {
  FileArtifactSchema,
  type Shape,
  type Workflow,
} from "../../workflow-language/src/schema.js";
import type { RunInspection } from "../../workflow-language/src/inspection.js";

const mediaTypes: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".woff2": "font/woff2",
};
/** Read only declared file outputs and explicitly listed website assets. Never scan a directory. */
export function attachResultFiles(
  workflow: Workflow,
  invocations: RunInspection["invocations"],
  roots: string[],
  artifactRoot?: string,
  referencesOnly = false,
): AttachedFile[] {
  const files: AttachedFile[] = [],
    seen = new Set<string>();
  let remaining = MAX_RESULT_BYTES, transferRemaining = MAX_RESULT_TRANSFER_BYTES;
  const observed_at = new Date().toISOString();
  const attach = (
    reference: { path: string; sha256: string },
    title: string,
    mediaType?: string,
  ): { file: AttachedFile; bytes?: Buffer } | undefined => {
    const identity = JSON.stringify(reference);
    if (seen.has(identity)) {
      const file = files.find(
        (file) =>
          file.path === reference.path && file.sha256 === reference.sha256,
      )!;
      return {
        file,
        ...(file.data !== undefined
          ? { bytes: file.encoding === "gzip" ? gunzipSync(Buffer.from(file.data, "base64"), {maxOutputLength: MAX_RESULT_BYTES}) : Buffer.from(file.data, "base64") }
          : {}),
      };
    }
    if (files.length >= MAX_RESULT_FILES) return;
    seen.add(identity);
    const file: AttachedFile = {
      ...reference,
      title: title.slice(0, 160),
      media_type:
        mediaType ??
        mediaTypes[extname(reference.path).toLowerCase()] ??
        "application/octet-stream",
      status: "unavailable",
      observed_at,
    };
    files.push(file);
    try {
      if (files.length > MAX_RESULT_FILES || remaining <= 0 || transferRemaining <= 0)
        throw Error(
          "The run attachment limit was reached (20,000 files, 100 MB decoded, or 20 MB transferred).",
        );
      const localPath = artifactRoot
        ? resolve(artifactRoot, reference.path)
        : reference.path;
      if (
        artifactRoot &&
        (!localPath.startsWith(artifactRoot + sep) ||
          reference.path.startsWith("/"))
      )
        throw Error("The output is outside the run artifacts folder.");
      const result = checkedFile({ ...reference, path: localPath }, roots);
      if (result.bytes.length > remaining)
        throw Error(
          "The file exceeds the remaining 100 MB run attachment limit.",
        );
      if (referencesOnly) {
        remaining -= result.bytes.length;
        file.status = "verified";
        file.bytes = result.bytes.length;
        return { file, bytes: result.bytes };
      }
      const compressed = gzipSync(result.bytes);
      const useGzip = compressed.length < result.bytes.length;
      const payload = useGzip ? compressed : result.bytes;
      if (payload.length > transferRemaining) throw Error("The file exceeds the remaining 20 MB transfer limit.");
      transferRemaining -= payload.length;
      remaining -= result.bytes.length;
      file.status = "verified";
      file.bytes = result.bytes.length;
      file.data = Buffer.from(payload).toString("base64");
      if (useGzip) file.encoding = "gzip";
      // Text is decoded by the reader from the attached bytes, avoiding duplicate payloads.
      return { file, bytes: result.bytes };
    } catch (error) {
      file.reason =
        error instanceof Error
          ? error.message
          : "The file could not be attached.";
      return { file };
    }
  };
  const visit = (shape: Shape, value: unknown, title: string) => {
    const def = typeof shape === "string" ? { type: shape } : shape;
    if (def.type === "file") {
      const ref = FileArtifactSchema.safeParse(value);
      if (!ref.success) return;
      const attached = attach(ref.data, title);
      if (!attached) return;
      if (
        "format" in def &&
        def.format === "method-website" &&
        attached.bytes
      ) {
        try {
          const manifest = WebsiteManifestSchema.parse(
            JSON.parse(new TextDecoder().decode(attached.bytes)),
          );
          const members = manifest.files.map((member) => ({
            ...member,
            path: join(dirname(ref.data.path), member.path),
          }));
          attached.file.title = manifest.title;
          attached.file.media_type = "application/vnd.method.website+json";
          attached.file.website = {
            entrypoint: join(dirname(ref.data.path), manifest.entrypoint),
            files: members,
          };
          for (const member of members) attach({ path: member.path, sha256: member.sha256 }, member.path, member.media_type);
        } catch (error) {
          attached.file.reason = "The website file list is invalid: " + (error instanceof Error ? error.message : String(error));
        }
      }
    } else if (
      def.type === "record" &&
      "fields" in def &&
      value &&
      typeof value === "object"
    ) {
      for (const [name, child] of Object.entries(def.fields ?? {}))
        visit(
          child,
          (value as Record<string, unknown>)[name],
          name.replaceAll("_", " "),
        );
    } else if (def.type === "list" && Array.isArray(value)) {
      for (const item of value)
        if ("fields" in def && def.fields)
          visit({ type: "record", fields: def.fields }, item, title);
        else if ("items" in def && def.items) visit(def.items, item, title);
    }
  };
  for (const row of Object.values(invocations))
    for (const [name, shape] of Object.entries(
      effectiveOutputs(workflow.steps[row.step_id] ?? {}),
    ))
      visit(shape, row.outputs?.[name], name.replaceAll("_", " "));
  return files;
}
