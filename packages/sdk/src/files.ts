import { chmodSync, closeSync, openSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, fsyncSync, mkdirSync, lstatSync, realpathSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { FileArtifactSchema, type Json } from "../../workflow-language/src/schema.js";

export function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
  const parent = openSync(dirname(path), "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

/**
 * Remove a file or folder; every folder in it is made writable first, as an agent may make files read-only. A process
 * that has just ended (an agent's cache flush) can still add files while the folder is removed: then the removal
 * starts again and takes the new files too. (rmSync's own maxRetries only retries the last rmdir, so new files stay.)
 */
export function removeTree(path: string): void {
  const writable = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try { chmodSync(dir, 0o700); entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink()) writable(`${dir}/${e.name}`);
  };
  for (let attempt = 1; ; attempt++) {
    try { if (statSync(path).isDirectory()) writable(path); } catch { /* not there */ }
    try { rmSync(path, { recursive: true, force: true }); return; }
    catch (error: any) {
      // macOS can report a concurrent directory write as EACCES ("Directory not empty").
      if (!["ENOTEMPTY", "EBUSY", "EPERM", "EACCES"].includes(error.code) || attempt === 10) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * attempt);
    }
  }
}

export function checkedFile(value: unknown, roots: string[]): { path: string; sha256: string; bytes: Buffer } {
  const artifact = FileArtifactSchema.parse(value);
  if (!isAbsolute(artifact.path)) throw new Error("ARTIFACT_PATH: file paths must be absolute.");
  const path = realpathSync(artifact.path);
  if (!roots.some(root => {
    const rel = relative(realpathSync(resolve(root)), path);
    return rel === "" || !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
  })) throw new Error("ARTIFACT_PATH: file is outside the configured resources and run directory.");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 25_000_000) throw new Error("ARTIFACT_SIZE: expected a file no larger than 25 MB.");
  const bytes = readFileSync(path);
  if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("ARTIFACT_CHANGED: file bytes do not match the candidate hash.");
  return { ...artifact, bytes };
}

/** Discover only the documented file encoding. Ordinary objects are ordinary evidence. */
export function fileArtifacts(value: Json): Json[] {
  if (!value || typeof value !== "object") return [];
  if (FileArtifactSchema.safeParse(value).success) return [value];
  return Object.values(value).flatMap(fileArtifacts);
}
