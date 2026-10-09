import { existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { semanticDigest, workflowDocumentDigest } from '../../contracts/src/identity.js';
import { loadWorkflow } from '../../workflow-language/src/validate.js';
import { MethodClient } from './method-client.js';
import { collectPackage } from './method-files.js';
import { writePrivateJson } from './files.js';
import { authoringPath, readDocument } from './authoring.js';

export type SavedVersion = { workflow_id: string; version_id: string; version_number?: number; url: string; unchanged: boolean; cases?: string };
// Creating a version can take longer than a quick request when the package has many files.
const saveTimeoutMs = 120_000;

/** Name the steps that differ from the previous version, for a version made by a run. */
function changeReason(before: any, after: any) {
  const ids = [...new Set([...Object.keys(before?.steps ?? {}), ...Object.keys(after.steps)])];
  const changed = ids.filter(id => !isDeepStrictEqual(before?.steps?.[id], after.steps[id]));
  return changed.length ? `Changed ${changed.join(', ')}.` : 'Changed the Method outside its steps.';
}

/**
 * Save the draft as a version when it differs from the linked version. FILE.method.json links the draft to its Method.
 * publish runs the case gate; a run saves without it, so that each run belongs to the version it ran.
 */
export async function saveVersion(client: MethodClient, file: string, options: { gate?: { accepted: string[]; reason?: string }; reason?: string } = {}): Promise<SavedVersion> {
  const metaFile = authoringPath(`${file}.method.json`);
  const meta = existsSync(metaFile) ? readDocument(metaFile) : {};
  if (meta.server && meta.server !== client.server) throw Error('This draft belongs to another server. Use method get from the intended server into a new file.');
  const lock = authoringPath(`${file}.lock`);
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o600); } catch { throw Error('The draft is locked. Wait for the other command.'); }
  try {
    const workflow = loadWorkflow(readDocument(file));
    const gate = options.gate ? await (await import('./quality.js')).caseGate(authoringPath(file), options.gate.accepted, meta.pending?.reason ?? options.gate.reason) : { line: '' };
    const pack = await collectPackage(file, workflow, client);
    const digest = workflowDocumentDigest(workflow);
    const url = (id: string, version: string) => `${client.server}/methods/${id}?version=${version}`;
    const confirm = async (id: string, version: string) => {
      const stored = await client.request<any>(`/api/cli/methods/${encodeURIComponent(id)}?version=${encodeURIComponent(version)}`);
      if (stored.version_id !== version || workflowDocumentDigest(loadWorkflow(stored.workflow)) !== digest || stored.package?.digest !== pack?.digest) throw Error('The saved version does not match this draft. Keep the draft and its sidecar; retry before making changes.');
      return stored;
    };
    if (!meta.pending && meta.digest === digest && meta.package_digest === pack?.digest && meta.workflow_id) {
      await confirm(meta.workflow_id, meta.base_version);
      return { workflow_id: meta.workflow_id, version_id: meta.base_version, url: url(meta.workflow_id, meta.base_version), unchanged: true, ...(gate.line ? { cases: gate.line } : {}) };
    }
    if (meta.pending && ((meta.pending.digest !== digest && (meta.digest_format || meta.pending.digest !== semanticDigest(workflow))) || meta.pending.package_digest !== pack?.digest)) throw Error('A previous save has no confirmed response. Restore that draft and retry before changing it.');
    let reason = meta.pending?.reason ?? options.reason;
    if (meta.workflow_id && !reason) reason = changeReason((await client.request<any>(`/api/cli/methods/${encodeURIComponent(meta.workflow_id)}?version=${encodeURIComponent(meta.base_version)}`)).workflow, workflow);
    if (reason && gate.line) reason = `${reason} ${gate.line}`;
    const requestId = meta.pending?.request_id ?? randomUUID();
    writePrivateJson(metaFile, { ...meta, digest_format: 'document/1', server: client.server, pending: { digest, package_digest: pack?.digest, request_id: requestId, reason } });
    const saved = meta.workflow_id
      ? await client.request<any>(`/api/cli/methods/${encodeURIComponent(meta.workflow_id)}`, 'POST', { workflow, package: pack, base_version: meta.base_version, reason }, true, { timeoutMs: saveTimeoutMs })
      : await client.request<any>('/api/cli/methods', 'POST', { workflow, package: pack, request_id: requestId }, true, { timeoutMs: saveTimeoutMs });
    const workflowId = meta.workflow_id ?? saved.workflow_id;
    const stored = await confirm(workflowId, saved.version_id);
    writePrivateJson(metaFile, { server: client.server, workflow_id: workflowId, base_version: saved.version_id, digest, package_digest: pack?.digest, digest_format: 'document/1' });
    return { workflow_id: workflowId, version_id: saved.version_id, version_number: stored.version_number, url: url(workflowId, saved.version_id), unchanged: false, ...(gate.line ? { cases: gate.line } : {}) };
  } finally { closeSync(fd); unlinkSync(lock); }
}

/** Check the cases, save the version if needed, and mark it published with a reason. */
export async function publish(client: MethodClient, file: string, reason = 'Published.', accepted: string[] = []) {
  const { explain, waitForExplain } = await import('./explain.js');
  await waitForExplain(file);
  const saved = await saveVersion(client, file, { gate: { accepted, reason }, reason });
  // Script cards come before publishing. A failed check shows on its card and never blocks the publish.
  try { await explain(client, file, { write: line => process.stderr.write(`Script card: ${line}\n`) }); }
  catch (error) { process.stderr.write(`Script cards not made: ${(error as Error).message}\n`); }
  const published = await client.request<any>(`/api/cli/methods/${encodeURIComponent(saved.workflow_id)}/versions/${encodeURIComponent(saved.version_id)}/publish`, 'POST', { reason });
  return { ...saved, published_at: published.published_at, publish_reason: published.publish_reason };
}
