import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { MethodPackageSchema, packageDigest, packagePath } from '../../contracts/src/method-package.js';
import { loadWorkflow } from '../../workflow-language/src/validate.js';
import { authoringPath, readDocument } from './authoring.js';
import { DEFAULT_SERVER, type MethodClient } from './method-client.js';
import { fileHash } from './method-files.js';
import { methodCache } from './prepare.js';
import { writePrivateJson } from './files.js';
import { currentVersion, methodContent } from './versions.js';
import { localRuns, saveLocalProposal } from './proposals.js';
import { localJudgments } from './local-judgments.js';

/**
 * run_id: the run folder on this computer that the note is about. judgments: the judgments that method judge kept on
 * this computer for the Method. run_folders: the Method's run folders on this computer, the judged runs first.
 */
export type ImproveRequest = { step_id?: string; note?: string; run_id?: string; judgments?: ReturnType<typeof localJudgments>; run_folders?: string[] };
type SavedImprove = { workflow_id: string; version_id: string; workflow: any; package?: unknown };
/** Runs a local Method file; the default is the runtime that `method run FILE` uses. */
export type RunFile = (file: string, flags: Record<string, unknown>, syncFactory: undefined, onEvent: undefined, client: MethodClient, baseConfig: undefined, secrets: Record<string, string>, options: { accountModels: true }) => Promise<{ status: string; result?: unknown }>;
/** The SubmitProposal that improve.method returns, read from its result. */
export type ImproveProposal = { cause: string; workflow: unknown | null; evidence: { kind: ProposalKind; steps?: string[]; [key: string]: unknown } };
type ProposalKind = 'change' | 'none';
const kinds: ProposalKind[] = ['change', 'none'];

/**
 * Read the result of improve.method: {proposal: <SubmitProposal as JSON text>, kind, proposal_id}. A change has the
 * tested workflow; none has no workflow.
 */
export function readImproveResult(result: unknown): ImproveProposal {
  const value = result as { proposal?: unknown; kind?: unknown } | null;
  if (!value || typeof value.proposal !== 'string') throw Error('The improvement run gave no proposal.');
  let proposal: any;
  try { proposal = JSON.parse(value.proposal); } catch { throw Error('The improvement run gave a proposal that is not JSON.'); }
  if (typeof proposal?.cause !== 'string' || !proposal.cause.trim()) throw Error('The improvement proposal has no cause.');
  const evidence = proposal.evidence;
  if (!evidence || typeof evidence !== 'object' || !kinds.includes(evidence.kind)) throw Error('The improvement proposal has no known kind.');
  if (value.kind !== undefined && value.kind !== evidence.kind) throw Error(`The improvement run says kind ${String(value.kind)}, but its proposal is kind ${evidence.kind}.`);
  if (evidence.kind === 'change' && (!proposal.workflow || typeof proposal.workflow !== 'object')) throw Error('The improvement proposal is a change without a workflow.');
  return { cause: proposal.cause.trim(), workflow: evidence.kind === 'change' ? proposal.workflow : null, evidence };
}

const nextStep = (file: string, id: string, kind: ProposalKind) => ({
  change: `Read the change, then run method apply ${file} ${id}. It does not publish.`,
  none: 'No change passed the tests.',
})[kind];

const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

export const judgmentsLine = 'Method fixes this Method from your judgments. Record the person\'s reaction: method judge RUN_ID wrong --note "...".';

/**
 * `method improve FILE`. A Method that keeps run content in the account is fixed from the person's judgments
 * (method judge), so this prints that and starts nothing. A Method with device run data (run_data: device, or an
 * organization that keeps run content on devices) runs improve.method on this computer, so its run content stays here,
 * and saves a local proposal.
 */
export async function improveCommand(args: string[], clientFactory: (server: string) => MethodClient, run?: RunFile) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { note: { type: 'string' }, step: { type: 'string' }, server: { type: 'string' } } });
  if (positionals.length !== 1) throw Error('Use method improve FILE [--note TEXT] [--step ID].');
  const file = authoringPath(positionals[0]!), document = readDocument(file), workflow = loadWorkflow(methodContent(document));
  if (values.step && !Object.hasOwn(workflow.steps, values.step)) throw Error(`Step ${values.step} is not in ${positionals[0]}.`);
  if (values.note !== undefined && !values.note.trim()) throw Error('Write the correction after --note.');
  const request: ImproveRequest = { ...(values.step ? { step_id: values.step } : {}), ...(values.note ? { note: values.note.trim() } : {}) };
  const client = clientFactory(values.server ?? DEFAULT_SERVER);
  if (!client.token()) await client.login();
  if (document.run_data !== 'device' && !await (await import('./method-sync.js')).organizationKeepsContent(client)) { process.stdout.write(judgmentsLine + '\n'); return; }
  // Every judgment kept on this computer counts, and a note is about the newest run of the Method on this computer.
  const runs = await localRuns(file), judgments = localJudgments(file);
  const folders = [...new Set([...judgments.map(j => j.run_dir).filter(dir => typeof dir === 'string' && existsSync(dir)), ...runs.map(r => r.dir)])];
  const newest = request.note ? runs[0] : undefined;
  return print(await improveOnDevice(client, file, { ...request, ...(newest ? { run_id: newest.dir } : {}), judgments, run_folders: folders }, run));
}

/**
 * Download the published improve.method and its files into the Method cache, once per version. For developers of
 * improve.method: METHOD_IMPROVE_METHOD=PATH runs that local improve.method file instead, from its own folder.
 */
export async function cachedImproveMethod(client: MethodClient) {
  const local = process.env.METHOD_IMPROVE_METHOD;
  if (local) {
    const file = resolve(local);
    if (!existsSync(file)) throw Error(`METHOD_IMPROVE_METHOD names ${file}, which does not exist.`);
    return { file, root: dirname(file), version_id: 'local' };
  }
  const saved = await client.request<SavedImprove>('/api/cli/improve/method');
  if (!/^v_[a-f0-9]{32}$/.test(saved.version_id)) throw Error('Method sent an improvement Method without a version ID.');
  const root = join(methodCache(), 'improve', saved.version_id);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (saved.package) {
    const pack = MethodPackageSchema.parse(saved.package);
    if (packageDigest(saved.workflow, pack) !== pack.digest) throw Error('The improvement Method package checksum does not match.');
    for (const f of pack.files) {
      const path = resolve(root, packagePath(f.path));
      if (existsSync(path) && fileHash(readFileSync(path)) === f.sha256) continue;
      const bytes = await client.transfer(`/api/cli/improve/files/${f.sha256}`);
      if (bytes.length !== f.size || fileHash(bytes) !== f.sha256) throw Error(`The improvement Method file checksum does not match: ${f.path}`);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(`${path}.download`, bytes, { mode: 0o600 }); renameSync(`${path}.download`, path);
    }
  }
  const file = join(root, 'improve.method');
  writePrivateJson(file, saved.workflow);
  return { file, root, version_id: saved.version_id };
}

/**
 * Run improve.method on this computer and save its result as a local proposal of the file. The run gets the signed-in
 * key and server as its IMPROVE_API_KEY and IMPROVE_SERVER secrets, for this run only: they stay in memory. Its model
 * steps run on the models that improve.method declares, through the account, never on this computer's own model key.
 */
export async function improveOnDevice(client: MethodClient, file: string, request: ImproveRequest, run?: RunFile) {
  const token = client.token();
  if (!token) throw Error('Sign in with method login, then run method improve again.');
  const secrets = { IMPROVE_API_KEY: token, IMPROVE_SERVER: client.server };
  const improve = await cachedImproveMethod(client);
  const runDir = join(methodCache(), 'runs', randomUUID());
  const inputs = join(runDir, 'improve-inputs.json');
  // The judgments with their notes go in a private file of this run; they stay on this computer.
  const judgments = request.judgments?.length ? join(runDir, 'judgments.json') : '';
  if (judgments) writePrivateJson(judgments, request.judgments!.map(j => ({ id: j.id, run_id: j.run_id, run_dir: j.run_dir, step_id: j.step_id, verdict: j.verdict,
    note: j.note, ...(j.corrected !== undefined ? { corrected: j.corrected } : {}), created_at: j.created_at })));
  writePrivateJson(inputs, { method_file: file, note: request.note ?? '', step_id: request.step_id ?? '', grant_id: '', judgment_id: '', run_id: request.run_id ?? '',
    judgments_file: judgments, run_folders: request.run_folders ?? [] });
  if (request.judgments?.length) process.stderr.write(`Using ${request.judgments.length} judgment${request.judgments.length === 1 ? '' : 's'} kept on this computer.\n`);
  const runFile: RunFile = run ?? (await import('./current-runtime.js')).runCurrentFile as unknown as RunFile;
  process.stderr.write(`Improving ${file} on this computer. Its run content stays here.\n`);
  // The run prints its own result; send it to stderr so that stdout holds only the proposal.
  const write = process.stdout.write;
  process.stdout.write = ((chunk: any, ...rest: any[]) => (process.stderr.write as any)(chunk, ...rest)) as typeof process.stdout.write;
  let result: Awaited<ReturnType<RunFile>>;
  // improve.method runs on the models that it declares, with Method's key through the signed-in account.
  try { result = await runFile(improve.file, { inputs, 'run-dir': runDir, workspace: improve.root, server: client.server }, undefined, undefined, client, undefined, secrets, { accountModels: true }); }
  finally { process.stdout.write = write; }
  if (result.status !== 'completed') throw Error(`The improvement run stopped with status ${result.status}. Its records are in ${runDir}.`);
  let submitted: ImproveProposal;
  try { submitted = readImproveResult(result.result); }
  catch (error) { throw Error(`${(error as Error).message} Its records are in ${runDir}.`); }
  const id = `lp_${randomBytes(8).toString('hex')}`, document = readDocument(file);
  const path = saveLocalProposal(file, {
    id, method_id: typeof document.id === 'string' ? document.id : null, base_version_id: (await currentVersion(file))?.version_id ?? null,
    status: 'open', cause: submitted.cause, evidence: submitted.evidence, created_at: new Date().toISOString(),
    base_workflow: methodContent(document), proposed_workflow: submitted.workflow,
    improvement: { version_id: improve.version_id, run_dir: runDir },
  });
  const kind = submitted.evidence.kind;
  return { proposal_id: id, source: 'local', file, kind, cause: submitted.cause, steps: submitted.evidence.steps ?? [], proposal_file: path, next: nextStep(file, id, kind) };
}
