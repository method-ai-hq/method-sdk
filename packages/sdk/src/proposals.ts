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
const skipAutoApply = new Set(['apply', 'proposals', 'improve', 'init', 'new-id', 'diff', 'help', 'authoring', 'schema', '__worker', '__checks', 'worker', 'keys', 'secret', 'models', 'login', 'logout', 'sync', 'progress']);
/**
 * Before a command that takes a .method FILE: when this computer is signed in and the Method has an accepted proposal,
 * merge it into the file and print one line. A conflict prints what the coding agent must resolve; the command goes on.
 * Offline, signed out, or on any error, it does nothing.
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
      if (result.steps.length || result.warning) process.stderr.write(`Applied accepted proposal ${proposal.id} to ${target}: ${proposal.cause}${result.steps.length ? ` Changed steps: ${result.steps.join(', ')}.` : ''} Not published.${result.warning ? ` ${result.warning}` : ''}\n`);
    } else process.stderr.write(result.status === 'conflict'
      ? `Accepted proposal ${proposal.id} conflicts with your edits of ${target} in ${result.conflicts.map(c => c.path).join(', ')}. The file is not changed. Run method apply ${target} ${proposal.id} to see both versions, merge them in the file, then run method apply ${target} ${proposal.id} --resolved.\n`
      : `Accepted proposal ${proposal.id} does not merge into a valid Method: ${result.error} The file is not changed. Run method apply ${target} ${proposal.id} to see it.\n`);
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

/** What the coding agent does for a proposal that is not a change to the Method document. runFolder is the folder of the suggested case's run, when it is on this computer. */
function manualStep(file: string, proposal: ProposalRecord, runFolder?: string) {
  const evidence = proposal.evidence ?? {};
  if (evidence.case_suggestion) {
    const c = evidence.case_suggestion, quote = (value: string) => JSON.stringify(value);
    return `Record the case: method case new ${file} --id ${c.id} --note ${quote(c.note)} --run ${runFolder ? quote(runFolder) : 'RUN_FOLDER'}${(c.rubric ?? []).map((r: string) => ` --rubric ${quote(r)}`).join('')}${runFolder ? '' : ', where RUN_FOLDER is the folder of the run that went wrong'}. Then run method improve ${file} --case ${c.id}, show the proposal, apply it, and run again.`;
  }
  if (evidence.script_change) return `Change the script, then run method test ${file}: ${evidence.script_change}`;
  return 'This proposal has no change to apply.';
}

const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
function summary(p: ProposalRecord) {
  return { id: p.id, source: p.source, status: p.status, kind: p.evidence?.kind ?? null, cause: p.cause, steps: p.evidence?.steps ?? [], base_version_id: p.base_version_id, created_at: p.created_at };
}

/** `method improve`, `method proposals`, and `method apply`. */
export async function proposalCommand(args: string[], clientFactory: (server: string) => MethodClient) {
  if (args[0] === 'improve') return (await import('./improve.js')).improveCommand(args.slice(1), clientFactory);
  const { values, positionals } = parseArgs({ args: args.slice(1), allowPositionals: true, options: { server: { type: 'string' }, resolved: { type: 'boolean' }, wait: { type: 'boolean' } } });
  const [target, wanted] = positionals;
  if (!target || positionals.length > (args[0] === 'apply' ? 2 : 1)) throw Error(args[0] === 'apply' ? 'Use method apply FILE [PROPOSAL_ID] [--resolved].' : 'Use method proposals FILE.');
  const file = authoringPath(target), id = readDocument(file).id;
  const methodId = typeof id === 'string' && methodIdPattern.test(id) ? id : null;
  const client = clientFactory(values.server ?? DEFAULT_SERVER);
  const signedIn = !!client.token();
  if (args[0] === 'proposals') {
    const local = localProposals(file).map(summary);
    if (!methodId || !signedIn) return print({ file, method_id: methodId, proposals: local, ...(methodId ? { next: 'Run method login to see the proposals in your account too.' } : {}) });
    const read = async () => {
      const [{ proposals }, { improvements }] = await Promise.all([
        client.request<{ proposals: any[] }>(`/api/methods/${encodeURIComponent(methodId)}/proposals`),
        client.request<{ improvements: any[] }>(`/api/methods/${encodeURIComponent(methodId)}/improvements`)]);
      // The newest improvement that has no proposal yet: still running, or failed. The agent needs to know which.
      const latest = (improvements ?? []).find(i => !i.proposal_id);
      return { proposals, pending: latest && (latest.created_at ?? '') > String((proposals ?? [])[0]?.created_at ?? '') ? latest : undefined };
    };
    let { proposals, pending } = await read();
    // --wait: one line each time the improvement reaches a new step, until it ends.
    let shown = '';
    while (values.wait && pending && ['queued', 'running'].includes(pending.status)) {
      const step = pending.steps?.find((s: any) => s.status === 'running')?.step_id ?? pending.status;
      if (step !== shown) { process.stderr.write(`Improvement ${pending.id}: ${step}\n`); shown = step; }
      await new Promise(resolve => setTimeout(resolve, 5000));
      ({ proposals, pending } = await read());
    }
    const failedStep = pending?.steps?.find((s: any) => s.status === 'failed')?.step_id;
    const next = !pending ? undefined
      : ['queued', 'running'].includes(pending.status) ? `Improvement ${pending.id} is ${pending.status}. Run method proposals ${target} --wait: it returns when the proposal is ready.`
      : pending.status === 'failed' || pending.status === 'cancelled' ? `Improvement ${pending.id} ${pending.status}${failedStep ? ` at step ${failedStep}` : ''}${pending.error?.message ? `: ${pending.error.message}` : ''}. Run method improve ${target} again, or record the correction with method case new.`
      : undefined;
    return print({ file, method_id: methodId, proposals: [...(proposals ?? []).map(p => summary({ ...p, source: 'account' })), ...local].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
      ...(pending ? { improvement: { id: pending.id, status: pending.status, ...(failedStep ? { failed_step: failedStep } : {}), ...(pending.error ? { error: pending.error } : {}) } } : {}), ...(next ? { next } : {}) });
  }
  const local = localProposals(file);
  let proposal: ProposalRecord | undefined = wanted ? local.find(p => p.id === wanted) : undefined;
  if (!proposal && wanted) {
    if (!signedIn) await client.login();
    proposal = await accountProposal(client, wanted);
    if (methodId && proposal.method_id !== methodId) throw Error(`Proposal ${wanted} is for another Method.`);
  }
  if (!proposal && methodId && signedIn) proposal = await newestAccepted(client, methodId);
  proposal ??= local.find(p => p.status === 'open');
  if (!proposal) throw Error(`${target} has no accepted proposal. Run method proposals ${target}.`);
  if (proposal.status === 'applied') return print({ status: 'applied', file, proposal_id: proposal.id, next: 'This proposal is already applied.' });
  if (proposal.source === 'account' && proposal.status !== 'accepted') throw Error(`Proposal ${proposal.id} is ${proposal.status}. Accept it on the dashboard first: ${client.server}/methods/${proposal.method_id}`);
  if (proposal.source === 'local' && proposal.status !== 'open') throw Error(`Proposal ${proposal.id} is ${proposal.status}.`);
  if (values.resolved) return print({ status: 'applied', file, proposal_id: proposal.id, ...await markApplied(client, file, proposal), next: `Run method test ${target}. Publish it when it is right.` });
  if (!proposal.proposed_workflow) {
    // The suggested case's run is a local folder (a local improvement) or an account run ID (an account improvement).
    const runId = proposal.evidence?.case_suggestion?.run_id;
    const runFolder = runId ? (await localRuns(file)).find(run => run.dir === runId || run.account_run_id === runId)?.dir : undefined;
    process.exitCode = 1; return print({ status: 'manual', file, proposal_id: proposal.id, kind: proposal.evidence?.kind ?? null, cause: proposal.cause, next: manualStep(target, proposal, runFolder) });
  }
  const result = await applyProposal(client, file, proposal);
  if (result.status === 'applied') return print({ ...result, file, proposal_id: proposal.id, cause: proposal.cause, next: `Run method test ${target}. Publish it when it is right.` });
  process.exitCode = 1;
  if (result.status === 'invalid') return print({ status: 'invalid', file, proposal_id: proposal.id, error: result.error, next: 'The file is not changed. Merge the proposed version by hand.' });
  print({ status: 'conflict', file, proposal_id: proposal.id, cause: proposal.cause, conflicts: result.conflicts,
    next: `The file is not changed. Your edits and the proposal both change each listed part. Edit ${target} so that each part keeps both changes, then run method apply ${target} ${proposal.id} --resolved.` });
}
