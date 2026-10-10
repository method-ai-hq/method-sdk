import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { versionIdFor } from '../../contracts/src/identity.js';
import { loadWorkflow, parseDocumentValue, serializeWorkflow } from '../../workflow-language/src/validate.js';
import type { MethodClient } from './method-client.js';
import { buildPackage } from './method-files.js';
import { authoringPath, readDocument } from './authoring.js';
import { Outbox, lastSaved, savedVersions } from './outbox.js';

export const methodIdPattern = /^wf_[a-f0-9]{32}$/;
/** A new account Method ID, made on this computer. The first save of this ID creates the Method. */
export const newMethodId = () => `wf_${randomBytes(16).toString('hex')}`;
export { versionIdFor };
/** The Method without its `id:` line: the content that a version holds. */
export function methodContent<T extends object>(document: T): Omit<T, 'id'> { const { id: _id, ...content } = document as T & { id?: unknown }; return content; }

const newerFormat = (format: unknown) => typeof format === 'string' && /^method\/3\.[0-3]$/.test(format) ? 'method/3.4' : format;
/**
 * Write `id: METHOD_ID` as the second line of a Method file (after `format:`), and declare method/3.4, the format that
 * has `id`. A JSON file stays JSON. The rest of the file is unchanged.
 */
export function writeMethodId(file: string, id: string) {
  if (!methodIdPattern.test(id)) throw Error('Use a Method ID: wf_ and 32 lowercase hexadecimal characters.');
  const path = authoringPath(file), text = readFileSync(path, 'utf8');
  let next: string;
  if (/^\s*\{/.test(text)) {
    const { format, id: _old, ...rest } = JSON.parse(text);
    next = JSON.stringify({ format: newerFormat(format), id, ...rest }, null, /\n {2}"/.test(text) ? 2 : undefined) + (text.endsWith('\n') ? '\n' : '');
  } else {
    const lines = text.split('\n').filter(line => !/^id:/.test(line));
    const at = lines.findIndex(line => /^format:/.test(line));
    if (at < 0) { const document = parseDocumentValue(text); next = serializeWorkflow({ format: newerFormat(document?.format), id, ...methodContent(document) }); }
    else {
      lines[at] = lines[at]!.replace(/method\/3\.[0-3]\b/, 'method/3.4');
      lines.splice(at + 1, 0, `id: ${id}`);
      next = lines.join('\n');
    }
  }
  const temporary = `${path}.${process.pid}.tmp`;
  try { writeFileSync(temporary, next, { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
/** The file's Method ID; writes a new one when the file has none. */
export function ensureMethodId(file: string): string {
  const id = readDocument(file).id;
  if (id !== undefined) { if (typeof id !== 'string' || !methodIdPattern.test(id)) throw Error(`The id: line of ${file} is not a Method ID. Run method new-id ${file}.`); return id; }
  // The id: line needs format 3.4. A file that 3.4 refuses stays unchanged and is not saved; the run continues.
  const original = readFileSync(authoringPath(file), 'utf8');
  const created = newMethodId(); writeMethodId(file, created);
  try { loadWorkflow(methodContent(readDocument(file))); }
  catch (error) {
    writeFileSync(authoringPath(file), original, { mode: 0o600 });
    throw Error(`Saving writes an id: line, which needs format method/3.4, and 3.4 finds: ${(error as Error).message} Fix it, then run again to save.`);
  }
  return created;
}

/** Name the steps that differ from the previous version. */
function changeReason(before: any, after: any) {
  if (!before) return 'Created with Method CLI.';
  const ids = [...new Set([...Object.keys(before?.steps ?? {}), ...Object.keys(after.steps)])];
  const changed = ids.filter(id => !isDeepStrictEqual(before?.steps?.[id], after.steps[id]));
  return changed.length ? `Changed ${changed.join(', ')}.` : 'Changed the Method outside its steps.';
}

/** The Method ID and version ID of a file's current content, computed on this computer; undefined without an id: line. */
export async function currentVersion(file: string) {
  const document = readDocument(file);
  if (typeof document.id !== 'string' || !methodIdPattern.test(document.id)) return undefined;
  const { pack } = await buildPackage(file, loadWorkflow(methodContent(document)));
  return { method_id: document.id, version_id: versionIdFor(document.id, pack.digest) };
}

export type PreparedVersion = { method_id: string; version_id: string; url: string; unchanged: boolean; workflow: any };
/**
 * Prepare the save of the current file. It sends no request: it computes the version ID from the content and, when
 * this computer has not saved that version yet, puts the files and the version save in the outbox.
 */
export async function prepareVersion(client: MethodClient, outbox: Outbox, file: string, reason?: string): Promise<PreparedVersion> {
  const id = ensureMethodId(file);
  const workflow = loadWorkflow(methodContent(readDocument(file)));
  const { pack, sources } = await buildPackage(file, workflow);
  const versionId = versionIdFor(id, pack.digest);
  const url = `${client.server}/methods/${id}?version=${versionId}`;
  if (savedVersions(client.server)[versionId]) return { method_id: id, version_id: versionId, url, unchanged: true, workflow };
  const previous = lastSaved(client.server, id);
  for (const f of pack.files) outbox.add({ kind: 'file', server: client.server, sha256: f.sha256, size: f.size }, sources[f.sha256]);
  outbox.add({ kind: 'version', server: client.server, method_id: id, version_id: versionId, file: authoringPath(file), body: {
    workflow, package: pack, ...(previous && previous.version_id !== versionId ? { parent_version_id: previous.version_id } : {}),
    reason: reason ?? changeReason(previous?.workflow, workflow),
  } });
  return { method_id: id, version_id: versionId, url, unchanged: false, workflow };
}

/** The one line a run prints about its version. */
export function savedLine(client: MethodClient, outbox: Outbox, version: PreparedVersion) {
  const known = savedVersions(client.server)[version.version_id];
  if (known) return `Saved as version ${known.version_number}: ${version.url}`;
  const failure = outbox.failure(version.version_id);
  return failure ? `Not saved to your Method account: ${failure}` : 'Will save when online.';
}

/**
 * Publish the current file: save its version (waiting for the upload, with no fixed time limit), check the cases,
 * then mark that version published with the reason.
 */
export async function publish(client: MethodClient, file: string, reason?: string, accepted: string[] = []) {
  if (accepted.length && !reason) throw Error('Give --reason with --accept-failing-case. The reason is saved with the published version.');
  const { explain, waitForExplain } = await import('./explain.js');
  await waitForExplain(file);
  // Only errors block a publish; the open warnings and notes are listed with the result.
  const { publishIssues } = await import('./method-issues.js');
  const issues = await publishIssues(client, file);
  const outbox = new Outbox(client);
  const version = await prepareVersion(client, outbox, file, reason);
  await outbox.drain();
  if (!await outbox.whenSaved(version.version_id)) throw Error(`${outbox.failure(version.version_id) ?? 'Method cannot be reached, so the version is not uploaded yet.'} Nothing was published. Run method publish again.`);
  const gate = await (await import('./quality.js')).caseGate(authoringPath(file), accepted, reason);
  // Script cards come before publishing. A failed check shows on its card and never blocks the publish.
  try { await explain(client, file, { write: line => process.stderr.write(`Script card: ${line}\n`) }); }
  catch (error) { process.stderr.write(`Script cards not made: ${(error as Error).message}\n`); }
  const publishReason = [reason ?? 'Published.', gate.line].filter(Boolean).join(' ');
  const published = await client.request<any>(`/api/cli/methods/${encodeURIComponent(version.method_id)}/versions/${encodeURIComponent(version.version_id)}/publish`, 'POST', { reason: publishReason });
  return { workflow_id: version.method_id, version_id: version.version_id, version_number: published.version_number ?? savedVersions(client.server)[version.version_id]?.version_number,
    url: version.url, unchanged: version.unchanged, ...(gate.line ? { cases: gate.line } : {}), ...issues, published_at: published.published_at, publish_reason: published.publish_reason };
}
