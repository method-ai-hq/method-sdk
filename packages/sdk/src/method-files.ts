import { existsSync, readFileSync, realpathSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
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
  if (isAbsolute(rel) || rel.startsWith('..') || path.split(/[\\/]/).includes('sensitive')) throw Error(`File leaves the Method folder: ${name}`);
  return path;
}
export async function collectPackage(file: string, workflow: any, client: MethodClient): Promise<MethodPackage | undefined> {
  if (!['method/3', 'method/3.1'].includes(workflow.format)) return;
  const root = dirname(resolve(file));
  await lockDependencies(root);
  const config = existsSync(resolve(root, 'runtime.json')) ? readDocument(resolve(root, 'runtime.json')) : {};
  for (const p of Object.values(config.runtimes ?? {}) as any[]) if (p.command && isAbsolute(p.command)) throw Error('Use a portable runtime name in runtime.json before saving. Absolute interpreter paths stay local.');
  for (const value of Object.values(config.environment ?? {})) if (typeof value === 'string' && isAbsolute(value)) throw Error('Bind local input folders with method bind. Do not save absolute input paths in runtime.json.');
  const executions = Object.values(workflow.steps).flatMap((s: any) => [s.do, s.check]).filter(Boolean) as any[];
  for (const e of [...executions]) for (const tool of e.tools ?? []) { if (config.tools?.[tool]?.run) executions.push(config.tools[tool].run); }
  const names = [...new Set<string>([...(workflow.files ?? []), ...executions.filter(e => e.kind === 'run').map(e => e.entrypoint),
    ...['runtime.json', 'package.json', 'package-lock.json', 'pyproject.toml', 'uv.lock'].filter(name => existsSync(resolve(root, name)))])].sort();
  const files = names.map(path => { const bytes = readFileSync(contained(root, path)); return {path, sha256: fileHash(bytes), size: bytes.length}; });
  const pack = MethodPackageSchema.parse({schema:'method-package/1', runtime:runtimeVersion, files, digest:packageDigest(workflow, {runtime:runtimeVersion, files})});
  const found=files.length?await client.request<{present:string[]}>('/api/cli/files/check','POST',{hashes:files.map(f=>f.sha256)}):{present:[]};
  const present=new Set(found.present??[]);
  for (const f of files) if(!present.has(f.sha256))await client.transfer(`/api/cli/files/${f.sha256}`, readFileSync(contained(root, f.path)));
  return pack;
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
