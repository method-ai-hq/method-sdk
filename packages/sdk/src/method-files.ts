import { existsSync, readFileSync, realpathSync, mkdirSync, writeFileSync, renameSync, readdirSync, lstatSync, statSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { MethodPackageSchema, packageDigest, packagePath, type MethodPackage } from '../../contracts/src/method-package.js';
import { readDocument } from './authoring.js';
import type { MethodClient } from './method-client.js';
import { lockDependencies } from './prepare.js';

export const runtimeVersion: string = createRequire(import.meta.url)('@withmethod/runtime/package.json').version;
export const fileHash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
export function contained(root: string, name: string) {
  packagePath(name);
  const path = realpathSync(resolve(root, name)), rel = relative(realpathSync(root), path);
  if (isAbsolute(rel) || rel.startsWith('..')) throw Error(`File leaves the Method folder: ${name}`);
  return path;
}
/** The files that a saved package holds: declared files, script entrypoints, and dependency lockfiles. */
export function packageFileNames(root: string, workflow: any): string[] {
  const executions = [...Object.values(workflow.steps).flatMap((s: any) => [s.do, s.check, ...Object.values(s.effects ?? {}).flatMap((e: any) => [e.observe, e.judge])]),
    ...Object.values(workflow.tools ?? {}).map((t: any) => t.run)].filter(Boolean) as any[];
  return [...new Set<string>([...(workflow.files ?? []), ...executions.filter(e => e.kind === 'run').map(e => e.entrypoint),
    ...['package.json', 'package-lock.json', 'pyproject.toml', 'uv.lock'].filter(name => existsSync(resolve(root, name)))])].sort();
}
/**
 * The files of the Method's cases/ folder. A Method with account run data saves its cases with each version; a Method
 * with device run data keeps them on this computer. Hidden files and links are not included. A file over the package
 * limit of 20 MB is not included; its name goes to tooLarge, so the save can say so.
 */
export const maxPackageFileBytes = 20_000_000;
export function caseFileNames(root: string, tooLarge: string[] = []): string[] {
  const names: string[] = [];
  const walk = (relativeDir: string) => {
    const folder = resolve(root, relativeDir);
    if (!existsSync(folder) || !lstatSync(folder).isDirectory()) return;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const name = `${relativeDir}/${entry.name}`;
      if (entry.name.startsWith('.')) continue;
      try { packagePath(name); } catch { continue; }
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) (statSync(resolve(root, name)).size <= maxPackageFileBytes ? names : tooLarge).push(name);
    }
  };
  walk('cases');
  return names;
}
/**
 * The saved package of a local Method: its declared files, script entrypoints, and dependency lockfiles. Reads files on
 * this computer only; the outbox uploads them later.
 */
export async function buildPackage(file: string, workflow: any): Promise<{ pack: MethodPackage; sources: Record<string, string>; tooLarge: string[] }> {
  const root = dirname(resolve(file));
  await lockDependencies(root);
  const tooLarge: string[] = [];
  const names = [...new Set([...packageFileNames(root, workflow), ...(workflow.run_data === 'device' ? [] : caseFileNames(root, tooLarge))])].sort();
  const sources: Record<string, string> = {};
  const files = names.map(path => { const source = contained(root, path), bytes = readFileSync(source), sha256 = fileHash(bytes); sources[sha256] = source; return {path, sha256, size: bytes.length}; });
  const pack = MethodPackageSchema.parse({schema:'method-package/1', runtime:runtimeVersion, files, digest:packageDigest(workflow, {runtime:runtimeVersion, files})});
  return { pack, sources, tooLarge };
}
export async function restorePackage(saved: {workflow_id:string; version_id:string; workflow:any; package?:MethodPackage|null}, root: string, client:MethodClient) {
  if (!saved.package) return false;
  const pack = MethodPackageSchema.parse(saved.package);
  if (packageDigest(saved.workflow, pack) !== pack.digest) throw Error('Saved Method package checksum does not match.');
  mkdirSync(root, {recursive:true, mode:0o700});
  for (const f of pack.files) {
    const path = resolve(root, packagePath(f.path));
    mkdirSync(dirname(path), {recursive:true, mode:0o700});
    const parent = relative(realpathSync(root), realpathSync(dirname(path)));
    if (parent.startsWith('..') || isAbsolute(parent)) throw Error('Package destination leaves its folder.');
    if (existsSync(path)) { if (fileHash(readFileSync(contained(root, f.path))) === f.sha256) continue; throw Error(`Saved file conflicts with a local file: ${f.path}`); }
    const bytes = await client.transfer(`/api/cli/methods/${encodeURIComponent(saved.workflow_id)}/files/${f.sha256}?version=${encodeURIComponent(saved.version_id)}`);
    if (bytes.length !== f.size || fileHash(bytes) !== f.sha256) throw Error(`Saved file checksum does not match: ${f.path}`);
    writeFileSync(`${path}.download`, bytes, {mode:0o600}); renameSync(`${path}.download`, path);
  }
  return true;
}
