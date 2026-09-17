import { z } from 'zod';
import { canonicalJson, sha256, workflowDocumentDigest } from './identity.js';

export const packagePath = (path: string) => {
  if (!path || path.length > 500 || path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path) || path.split('/').some(p => !p || ['.', '..', 'sensitive', '.git', 'node_modules', '.venv', '.codex', '.claude'].includes(p) || p.startsWith('.env') || p === 'secrets.env')) throw Error(`Invalid package path: ${path}`);
  return path;
};
export const PackageFileSchema = z.strictObject({ path: z.string().refine(p => { try { packagePath(p); return true; } catch { return false; } }), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().min(0).max(20_000_000) });
export const MethodPackageSchema = z.strictObject({
  schema: z.literal('method-package/1'), runtime: z.string().regex(/^\d+\.\d+\.\d+$/),
  files: z.array(PackageFileSchema).max(10000), digest: z.string().regex(/^[a-f0-9]{64}$/),
}).superRefine((p, ctx) => { if (new Set(p.files.map(f => f.path)).size !== p.files.length) ctx.addIssue({ code: 'custom', message: 'Duplicate package paths' }); });
export type MethodPackage = z.infer<typeof MethodPackageSchema>;
export function packageDigest(workflow: unknown, value: Pick<MethodPackage, 'runtime' | 'files'>) {
  return sha256(canonicalJson({ document: workflowDocumentDigest(workflow as { steps: Record<string, unknown> }), runtime: value.runtime, files: [...value.files].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) }));
}
