import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { loadWorkflow } from '../../workflow-language/src/validate.js';
import { authoringPath, readDocument, writeDocument } from './authoring.js';
import { DEFAULT_SERVER, type MethodClient } from './method-client.js';
import { writePrivateJson } from './files.js';
import { currentVersion, methodContent, methodIdPattern } from './versions.js';

/** A proposed change to a Method, from the account (a server proposal) or from `method improve` on this computer. */
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
function writeMethodFile(file: string, id: string | undefined, content: any) {
  const { format, ...rest } = content;
  const document = { ...(format !== undefined ? { format } : {}), ...(id ? { id } : {}), ...rest };
  if (/^\s*\{/.test(readFileSync(file, 'utf8'))) {
    const temporary = `${file}.${process.pid}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(document, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temporary, file); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  } else writeDocument(file, document);
}

export const localProposalFolder = (file: string) => join(dirname(file), '.method', 'proposals');
/** Save a local proposal as a private file. The .method folder is not for Git: its proposals can hold run content. */
export function saveLocalProposal(file: string, record: Omit<ProposalRecord, 'source'> & Record<string, unknown>) {
  const folder = localProposalFolder(file), ignore = join(dirname(folder), '.gitignore');
  const path = join(folder, `${record.id}.json`);
  writePrivateJson(path, { ...record, source: 'local', file: basename(file) });
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n', { mode: 0o600 });
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
/** Merge a proposal into the file. A clean merge writes the file and marks the proposal applied. Never publishes. */
export async function applyProposal(client: MethodClient | undefined, file: string, proposal: ProposalRecord, options: RequestOptions = {}): Promise<Applied> {
  const document = readDocument(file), ours = methodContent(document);
  const merged = mergeMethod(proposal.base_workflow, ours, proposal.proposed_workflow);
  if (!merged.clean) return { status: 'conflict', conflicts: merged.conflicts };
  try { loadWorkflow(merged.workflow); } catch (error) { return { status: 'invalid', error: (error as Error).message }; }
  if (!isDeepStrictEqual(merged.workflow, ours)) writeMethodFile(file, typeof document.id === 'string' ? document.id : undefined, merged.workflow);
  return { status: 'applied', steps: changedSteps(ours, merged.workflow), ...await markApplied(client, file, proposal, options) };
}
async function markApplied(client: MethodClient | undefined, file: string, proposal: ProposalRecord, options: RequestOptions = {}) {
  const version_id = (await currentVersion(file).catch(() => undefined))?.version_id;
  if (proposal.source === 'local') {
    const path = join(localProposalFolder(file), `${proposal.id}.json`), record = JSON.parse(readFileSync(path, 'utf8'));
    writePrivateJson(path, { ...record, status: 'applied', applied_at: new Date().toISOString(), ...(version_id ? { applied_version_id: version_id } : {}) });
    return { version_id };
  }
  try { await client!.request(`/api/proposals/${encodeURIComponent(proposal.id)}/applied`, 'POST', version_id ? { version_id } : {}, true, options); return { version_id }; }
  catch (error) { return { version_id, warning: `The file is changed, but Method did not record the proposal as applied: ${(error as Error).message}` }; }
}

const serverFlag = (args: string[]) => { const at = args.findIndex(arg => arg === '--server' || arg.startsWith('--server=')); return at < 0 ? undefined : args[at]!.startsWith('--server=') ? args[at]!.slice(9) : args[at + 1]; };
const skipAutoApply = new Set(['apply', 'changes', 'judge', 'improve', 'init', 'new-id', 'diff', 'help', 'authoring', 'schema', '__worker', '__checks', 'worker', 'keys', 'secret', 'models', 'login', 'logout', 'sync', 'progress']);
/**
 * Before a command that takes a .method FILE: when this computer is signed in and Method applied a change to the Method
 * (an accepted proposal, from the person's judgments), merge it into the file and print one line. A conflict prints
 * what the coding agent must resolve; the command goes on. Offline, signed out, or on any error, it does nothing.
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
    } else process.stderr.write(result.status === 'conflict'
      ? `Method's change ${proposal.id} conflicts with your edits of ${target} in ${result.conflicts.map(c => c.path).join(', ')}. The file is not changed. Run method apply ${target} ${proposal.id} to see both versions, merge them in the file, then run method apply ${target} ${proposal.id} --resolved.\n`
      : `Method's change ${proposal.id} does not merge into a valid Method: ${result.error} The file is not changed. Run method apply ${target} ${proposal.id} to see it.\n`);
  } catch { /* offline or signed out: the command goes on without the proposal. */ }
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

/** `method changes FILE`: the changes that Method applied to the Method, newest first, and those applied on this computer. */
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

/** `method improve`, `method changes`, and `method apply`. */
export async function proposalCommand(args: string[], clientFactory: (server: string) => MethodClient) {
  if (args[0] === 'improve') return (await import('./improve.js')).improveCommand(args.slice(1), clientFactory);
  const { values, positionals } = parseArgs({ args: args.slice(1), allowPositionals: true, options: { server: { type: 'string' }, resolved: { type: 'boolean' }, json: { type: 'boolean' } } });
  const [target, wanted] = positionals;
  if (!target || positionals.length > (args[0] === 'apply' ? 2 : 1)) throw Error(args[0] === 'apply' ? 'Use method apply FILE [PROPOSAL_ID] [--resolved].' : 'Use method changes FILE [--json].');
  const file = authoringPath(target), id = readDocument(file).id;
  const methodId = typeof id === 'string' && methodIdPattern.test(id) ? id : null;
  const client = clientFactory(values.server ?? DEFAULT_SERVER);
  const signedIn = !!client.token();
  if (args[0] === 'changes') return changesCommand(file, target, methodId, client, !!values.json);
  const local = localProposals(file);
  let proposal: ProposalRecord | undefined = wanted ? local.find(p => p.id === wanted) : undefined;
  if (!proposal && wanted) {
    if (!signedIn) await client.login();
    proposal = await accountProposal(client, wanted);
    if (methodId && proposal.method_id !== methodId) throw Error(`Proposal ${wanted} is for another Method.`);
  }
  proposal ??= local.find(p => p.status === 'open');
  if (!proposal) throw Error(`${target} has no open proposal. Run method improve ${target} --note TEXT first.`);
  if (proposal.status === 'applied') return print({ status: 'applied', file, proposal_id: proposal.id, next: 'This proposal is already applied.' });
  if (proposal.source === 'account' && proposal.status !== 'accepted') throw Error(`Change ${proposal.id} is ${proposal.status}, so it has nothing to merge.`);
  if (proposal.source === 'local' && proposal.status !== 'open') throw Error(`Proposal ${proposal.id} is ${proposal.status}.`);
  if (values.resolved) return print({ status: 'applied', file, proposal_id: proposal.id, ...await markApplied(client, file, proposal), next: `Run method test ${target}. Publish it when it is right.` });
  if (!proposal.proposed_workflow) return print({ status: 'none', file, proposal_id: proposal.id, cause: proposal.cause, next: 'No change passed the tests; there is nothing to apply.' });
  const result = await applyProposal(client, file, proposal);
  if (result.status === 'applied') return print({ ...result, file, proposal_id: proposal.id, cause: proposal.cause, next: `Run method test ${target}. Publish it when it is right.` });
  process.exitCode = 1;
  if (result.status === 'invalid') return print({ status: 'invalid', file, proposal_id: proposal.id, error: result.error, next: 'The file is not changed. Merge the proposed version by hand.' });
  print({ status: 'conflict', file, proposal_id: proposal.id, cause: proposal.cause, conflicts: result.conflicts,
    next: `The file is not changed. Your edits and the proposal both change each listed part. Edit ${target} so that each part keeps both changes, then run method apply ${target} ${proposal.id} --resolved.` });
}
