import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { loadWorkflow } from '../../workflow-language/src/validate.js';
import { authoringPath, readDocument, writeDocument } from './authoring.js';
import { DEFAULT_SERVER, type MethodClient } from './method-client.js';
import { writePrivateJson } from './files.js';
import { currentVersion, methodContent, methodIdPattern } from './versions.js';
import { localMethodFolder } from './local-judgments.js';

/** A change to a Method: from the account (a change Method made there), or from the improvement loop on this computer. */
export type ProposalRecord = {
  id: string;
  source: 'account' | 'local';
  method_id: string | null;
  base_version_id: string | null;
  status: string;
  cause: string;
  evidence: any;
  created_at: string;
  base_workflow: unknown;
  proposed_workflow: unknown | null;
};
export type MergeConflict = { path: string; base: unknown; ours: unknown; theirs: unknown };
export type MergeResult = { clean: true; workflow: any } | { clean: false; conflicts: MergeConflict[] };

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Keys of ours in their order; a key that only theirs has goes after the key before it in theirs. */
function keyOrder(ours: Record<string, unknown>, theirs: Record<string, unknown>) {
  const keys = Object.keys(ours), theirKeys = Object.keys(theirs);
  theirKeys.forEach((key, index) => {
    if (keys.includes(key)) return;
    const before = theirKeys.slice(0, index).reverse().find(other => keys.includes(other));
    keys.splice(before === undefined ? 0 : keys.indexOf(before) + 1, 0, key);
  });
  return keys;
}
/**
 * Three-way merge of Method documents, per step and per top-level key. base is the version the proposal started from,
 * ours is the local file, and theirs is the proposed version. A part that only one side changed takes that change; a part
 * that both sides changed in different ways is a conflict.
 */
export function mergeMethod(base: any, ours: any, theirs: any): MergeResult {
  if (isDeepStrictEqual(ours, base)) return { clean: true, workflow: theirs };
  if (isDeepStrictEqual(theirs, base) || isDeepStrictEqual(ours, theirs)) return { clean: true, workflow: ours };
  const conflicts: MergeConflict[] = [];
  const pick = (path: string, b: unknown, o: unknown, t: unknown) => {
    if (isDeepStrictEqual(o, t) || isDeepStrictEqual(b, t)) return o;
    if (isDeepStrictEqual(b, o)) return t;
    conflicts.push({ path, base: b, ours: o, theirs: t });
    return o;
  };
  const merge = (path: string, b: any, o: any, t: any, nested: (key: string) => boolean) => {
    const result: Record<string, unknown> = {};
    for (const key of keyOrder(o, t)) {
      const at = path ? `${path}.${key}` : key;
      const value = nested(key) && isObject(o[key]) && isObject(t[key]) && isObject(b?.[key] ?? {})
        ? merge(at, b?.[key] ?? {}, o[key], t[key], () => false) : pick(at, b?.[key], o[key], t[key]);
      if (value !== undefined) result[key] = value;
    }
    return result;
  };
  const workflow = merge('', isObject(base) ? base : {}, ours, theirs, key => key === 'steps');
  return conflicts.length ? { clean: false, conflicts } : { clean: true, workflow };
}

/** The steps whose definition differs between two documents. */
export function changedSteps(before: any, after: any) {
  return [...new Set([...Object.keys(before?.steps ?? {}), ...Object.keys(after?.steps ?? {})])].filter(id => !isDeepStrictEqual(before?.steps?.[id], after?.steps?.[id]));
}

/** Write Method content to a file and keep its id: line. A JSON file stays JSON. */
export function writeMethodFile(file: string, id: string | undefined, content: any) {
  const { format, ...rest } = content;
  const document = { ...(format !== undefined ? { format } : {}), ...(id ? { id } : {}), ...rest };
  if (/^\s*\{/.test(readFileSync(file, 'utf8'))) {
    const temporary = `${file}.${process.pid}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(document, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temporary, file); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  } else writeDocument(file, document);
}

export const localProposalFolder = (file: string) => join(dirname(file), '.method', 'proposals');
/** Record what the improvement loop on this computer did (applied, or none) as a private file in the .method folder: it can hold run content. */
export function saveLocalProposal(file: string, record: Omit<ProposalRecord, 'source'> & Record<string, unknown>) {
  localMethodFolder(file);
  const path = join(localProposalFolder(file), `${record.id}.json`);
  writePrivateJson(path, { ...record, source: 'local', file: basename(file) });
  return path;
}
export function localProposals(file: string): (ProposalRecord & { path: string })[] {
  const folder = localProposalFolder(file);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter(name => /^lp_[a-f0-9]{16}\.json$/.test(name)).map(name => {
    const path = join(folder, name), record = JSON.parse(readFileSync(path, 'utf8'));
    return { ...record, proposed_workflow: record.proposed_workflow ?? null, path };
  }).filter(record => record.file === basename(file)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

type RequestOptions = { signal?: AbortSignal; stallMs?: number };
async function accountProposal(client: MethodClient, id: string, options: RequestOptions = {}): Promise<ProposalRecord> {
  const { proposal } = await client.request<{ proposal: any }>(`/api/proposals/${encodeURIComponent(id)}`, 'GET', undefined, true, options);
  return { ...proposal, source: 'account', proposed_workflow: proposal.proposed_workflow ?? null };
}
async function newestAccepted(client: MethodClient, methodId: string, options: RequestOptions = {}) {
  const { proposals } = await client.request<{ proposals: any[] }>(`/api/methods/${encodeURIComponent(methodId)}/proposals?status=accepted`, 'GET', undefined, true, options);
  const accepted = (proposals ?? []).filter(p => p?.status === 'accepted').sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return accepted[0] ? accountProposal(client, accepted[0].id, options) : undefined;
}

type Applied = { status: 'applied'; steps: string[]; version_id: string | undefined; warning?: string } | { status: 'conflict'; conflicts: MergeConflict[] } | { status: 'invalid'; error: string };
/** Merge a change Method made in the account into the file. A clean merge writes the file and records the change as applied. Never publishes. */
async function applyProposal(client: MethodClient, file: string, proposal: ProposalRecord, options: RequestOptions = {}): Promise<Applied> {
  const document = readDocument(file), ours = methodContent(document);
  const merged = mergeMethod(proposal.base_workflow, ours, proposal.proposed_workflow);
  if (!merged.clean) return { status: 'conflict', conflicts: merged.conflicts };
  try { loadWorkflow(merged.workflow); } catch (error) { return { status: 'invalid', error: (error as Error).message }; }
  if (!isDeepStrictEqual(merged.workflow, ours)) writeMethodFile(file, typeof document.id === 'string' ? document.id : undefined, merged.workflow);
  return { status: 'applied', steps: changedSteps(ours, merged.workflow), ...await markApplied(client, file, proposal, options) };
}
async function markApplied(client: MethodClient, file: string, proposal: ProposalRecord, options: RequestOptions = {}) {
  const version_id = (await currentVersion(file).catch(() => undefined))?.version_id;
  try { await client.request(`/api/proposals/${encodeURIComponent(proposal.id)}/applied`, 'POST', version_id ? { version_id } : {}, true, options); return { version_id }; }
  catch (error) { return { version_id, warning: `The file is changed, but Method did not record the proposal as applied: ${(error as Error).message}` }; }
}

const serverFlag = (args: string[]) => { const at = args.findIndex(arg => arg === '--server' || arg.startsWith('--server=')); return at < 0 ? undefined : args[at]!.startsWith('--server=') ? args[at]!.slice(9) : args[at + 1]; };
const skipAutoApply = new Set(['changes', 'judge', 'init', 'new-id', 'diff', 'help', 'authoring', 'schema', '__worker', '__checks', '__model', 'worker', 'keys', 'secret', 'models', 'login', 'logout', 'sync', 'progress']);
/**
 * Before a command that takes a .method FILE: when this computer is signed in and Method changed the Method in the
 * account (keeping run data in the account, or a fix of a Method that had not run on a computer), merge the change into
 * the file and print one line. A conflict leaves the file unchanged and writes both versions of each conflicting part
 * to a file for the coding agent to merge; the command goes on. Offline, signed out, or on any error, it does nothing.
 */
export async function autoApply(args: string[], clientFactory: (server: string) => MethodClient) {
  if (!args[0] || skipAutoApply.has(args[0]) || args.includes('--help') || process.env.METHOD_RUN_WORKER === '1') return;
  const target = args.slice(1).find(arg => !arg.startsWith('-') && /\.method$/i.test(arg));
  if (!target || !existsSync(target)) return;
  try {
    const file = authoringPath(target), id = readDocument(file).id;
    if (typeof id !== 'string' || !methodIdPattern.test(id)) return;
    const client = clientFactory(serverFlag(args) ?? DEFAULT_SERVER);
    if (!client.token()) return;
    const options = { signal: AbortSignal.timeout(3000), stallMs: 3000 };
    const proposal = await newestAccepted(client, id, options);
    if (!proposal?.proposed_workflow) return;
    const result = await applyProposal(client, file, proposal, options);
    if (result.status === 'applied') {
      if (result.steps.length || result.warning) process.stderr.write(`Method changed ${target} (${proposal.id}): ${proposal.cause}${result.steps.length ? ` Changed steps: ${result.steps.join(', ')}.` : ''}${result.warning ? ` ${result.warning}` : ''}\n`);
      return;
    }
    // The agent merges by hand from the saved versions; the change is recorded as applied, so it is not merged again.
    localMethodFolder(file);
    const path = join(dirname(file), '.method', `conflict-${proposal.id}.json`);
    writePrivateJson(path, { proposal_id: proposal.id, cause: proposal.cause, ...(result.status === 'conflict' ? { conflicts: result.conflicts } : { error: result.error }), proposed_workflow: proposal.proposed_workflow });
    await markApplied(client, file, proposal, options).catch(() => undefined);
    process.stderr.write(result.status === 'conflict'
      ? `Method's change ${proposal.id} (${proposal.cause}) conflicts with your edits of ${target} in ${result.conflicts.map(c => c.path).join(', ')}. The file is not changed. Both versions of each part are in ${path}: edit ${target} so each part keeps both changes.\n`
      : `Method's change ${proposal.id} does not merge into a valid Method: ${result.error} The file is not changed. The changed version is in ${path}.\n`);
  } catch { /* offline or signed out: the command goes on without the change. */ }
}

/** Run folders of this Method on this computer, newest first, with the account run ID of each run that was saved to the account. */
export async function localRuns(file: string) {
  const { recentRuns } = await import('./current-runtime.js');
  const document = readDocument(file), runs: { dir: string; account_run_id: string | null }[] = [];
  for (const dir of recentRuns(file, Infinity)) {
    try {
      const method = JSON.parse(readFileSync(join(dir, 'method.json'), 'utf8'));
      if (typeof document.id === 'string' ? method.id !== document.id : method.name !== document.name) continue;
      const sync = existsSync(join(dir, 'method-sync.json')) ? JSON.parse(readFileSync(join(dir, 'method-sync.json'), 'utf8')) : {};
      runs.push({ dir, account_run_id: typeof sync.dashboard_id === 'string' ? sync.dashboard_id : null });
    } catch { /* not a finished run folder */ }
  }
  return runs;
}

const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
type Change = { id: string; source: 'account' | 'local'; cause: string; date: string; version_id: string | null; steps: string[] };
const changeLine = (change: Change) => `${change.date.slice(0, 10)}  ${change.version_id ?? 'not saved as a version'}  ${change.cause}`;

/** `method changes FILE`: the changes that Method applied in the account and on this computer, newest first. */
async function changesCommand(file: string, target: string, methodId: string | null, client: MethodClient, json: boolean) {
  const local: Change[] = localProposals(file).filter(p => p.status === 'applied').map((p: any) => ({ id: p.id, source: 'local', cause: p.cause, date: String(p.applied_at ?? p.created_at), version_id: p.applied_version_id ?? null, steps: p.evidence?.steps ?? [] }));
  let account: Change[] = [];
  if (methodId) {
    const { proposals } = await client.request<{ proposals: any[] }>(`/api/methods/${encodeURIComponent(methodId)}/proposals?status=accepted`);
    account = (proposals ?? []).map(p => ({ id: p.id, source: 'account', cause: String(p.cause ?? ''), date: String(p.created_at ?? ''), version_id: p.published_version_id ?? null, steps: p.evidence?.steps ?? [] }));
  } else if (!local.length) throw Error(`${target} has no id: line, so Method has not changed it. Run it once while signed in.`);
  const changes = [...account, ...local].sort((a, b) => b.date.localeCompare(a.date));
  if (json) return print({ file, method_id: methodId, changes });
  process.stdout.write(changes.length ? changes.map(changeLine).join('\n') + '\n' : `Method has not changed ${target} yet.\n`);
}

/** `method changes FILE [--json]`. */
export async function changesMain(args: string[], clientFactory: (server: string) => MethodClient) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { server: { type: 'string' }, json: { type: 'boolean' } } });
  const [target] = positionals;
  if (!target || positionals.length !== 1) throw Error('Use method changes FILE [--json].');
  const file = authoringPath(target), id = readDocument(file).id;
  const methodId = typeof id === 'string' && methodIdPattern.test(id) ? id : null;
  const client = clientFactory(values.server ?? DEFAULT_SERVER);
  if (methodId && !client.token()) await client.login();
  return changesCommand(file, target, methodId, client, !!values.json);
}
