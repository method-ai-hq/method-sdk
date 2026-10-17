import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { MethodPackageSchema, packageDigest, packagePath } from '../../contracts/src/method-package.js';
import { loadWorkflow } from '../../workflow-language/src/validate.js';
import { readDocument } from './authoring.js';
import type { MethodClient } from './method-client.js';
import { fileHash } from './method-files.js';
import { methodCache } from './prepare.js';
import { writePrivateJson } from './files.js';
import { currentVersion, methodContent, methodIdPattern } from './versions.js';
import { changedSteps, localRuns, saveLocalProposal, writeMethodFile } from './proposals.js';
import { localJudgments, runFolderIndex, type LocalJudgment } from './local-judgments.js';

// The improvement loop on this computer. method judge runs it at once for a wrong judgment, and method run and method
// judge run it first for corrections that wait (from the dashboard, or a loop that stopped). It makes a regression case
// from each correction, runs improve.method on this computer with the user's own Claude Code or Codex, and applies the
// best change only when it fixes the corrected runs and breaks no earlier correction or case. A change is saved as a new
// version, so the person can restore the version before it.

/** A judgment as improve.method reads it. new marks the corrections to fix now; run is the account record of a run with no folder here. */
export type ImproveJudgment = {
  id: string; run_id: string; run_dir?: string; step_id: string | null; verdict: 'right' | 'wrong'; note: string | null; corrected?: unknown;
  case_id?: string; source: string; created_at: string; new?: boolean; run?: unknown;
};
type AccountJudgment = { id: string; run_id: string; step_id: string | null; verdict: 'right' | 'wrong'; note: string | null; corrected: unknown; source: string; created_at: string; pending: boolean };
type SavedImprove = { workflow_id: string; version_id: string; workflow: any; package?: unknown };
/** Runs a local Method file; the default is the runtime that `method run FILE` uses. */
export type RunFile = (file: string, flags: Record<string, unknown>, syncFactory: undefined, onEvent: undefined, client: MethodClient, baseConfig: undefined, secrets: Record<string, string>) => Promise<{ status: string; result?: unknown; failure?: any }>;
/** The SubmitProposal that improve.method returns, read from its result. */
export type ImproveProposal = { cause: string; workflow: unknown | null; files: { path: string; sha256: string; content_base64: string }[]; evidence: { kind: 'change' | 'none'; steps?: string[]; [key: string]: unknown } };
export type FixOutcome = {
  file: string; corrections: number; from_dashboard: number; kind: 'change' | 'none'; line: string; cause: string; steps: string[];
  cases: { made: string[]; not_made: { id: string; reason: string }[] }; earlier_passed: number; version?: { version_id: string; url: string; undo: string } | undefined;
  usage: { model_calls: number; usd: number | null; minutes: number } | null; capped: string; log: string; changed?: string;
};

/**
 * Read the result of improve.method: {proposal: <SubmitProposal as JSON text>, kind, proposal_id, capped}. A change has
 * the tested workflow (and a changed package file for a script change); none has no workflow.
 */
export function readImproveResult(result: unknown): ImproveProposal & { capped: string } {
  const value = result as { proposal?: unknown; kind?: unknown; capped?: unknown } | null;
  if (!value || typeof value.proposal !== 'string') throw Error('The improvement run gave no proposal.');
  let proposal: any;
  try { proposal = JSON.parse(value.proposal); } catch { throw Error('The improvement run gave a proposal that is not JSON.'); }
  if (typeof proposal?.cause !== 'string' || !proposal.cause.trim()) throw Error('The improvement proposal has no cause.');
  const evidence = proposal.evidence;
  if (!evidence || typeof evidence !== 'object' || !['change', 'none'].includes(evidence.kind)) throw Error('The improvement proposal has no known kind.');
  if (value.kind !== undefined && value.kind !== evidence.kind) throw Error(`The improvement run says kind ${String(value.kind)}, but its proposal is kind ${evidence.kind}.`);
  if (evidence.kind === 'change' && (!proposal.workflow || typeof proposal.workflow !== 'object')) throw Error('The improvement proposal is a change without a workflow.');
  return { cause: proposal.cause.trim(), workflow: evidence.kind === 'change' ? proposal.workflow : null, files: Array.isArray(proposal.files) ? proposal.files : [], evidence,
    capped: typeof value.capped === 'string' ? value.capped : '' };
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
 * Run improve.method on this computer. Its model steps and its scripts' model requests follow the rule of every run:
 * the user's own Claude Code or Codex first, hosted models only without one. The run gets the signed-in key and server
 * as its IMPROVE_API_KEY and IMPROVE_SERVER secrets, for this run only. Its output goes to a log file.
 */
export async function runImprovement(client: MethodClient, file: string, judgments: ImproveJudgment[], runFolders: string[], run?: RunFile) {
  const token = client.token();
  if (!token) throw Error('Sign in with method login, then run method judge again.');
  const improve = await cachedImproveMethod(client);
  const runDir = join(methodCache(), 'runs', randomUUID());
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const judgmentsFile = join(runDir, 'judgments.json'), inputs = join(runDir, 'improve-inputs.json'), log = join(runDir, 'improve.log');
  // The judgments with their notes go in a private file of this run; they stay on this computer.
  writePrivateJson(judgmentsFile, judgments);
  writePrivateJson(inputs, { method_file: file, grant_id: '', judgment_id: '', judgments_file: judgmentsFile, run_folders: runFolders });
  const runFile: RunFile = run ?? (await import('./current-runtime.js')).runCurrentFile as unknown as RunFile;
  // The run prints its own result and progress; they go to the log, so the person reads one line.
  const out = process.stdout.write, err = process.stderr.write;
  const toLog = ((chunk: any, ...rest: any[]) => { try { appendFileSync(log, typeof chunk === 'string' ? chunk : Buffer.from(chunk)); } catch { /* the log is best effort */ } const done = rest.find(r => typeof r === 'function'); done?.(); return true; }) as typeof process.stdout.write;
  process.stdout.write = toLog; process.stderr.write = toLog;
  let result: Awaited<ReturnType<RunFile>>;
  try { result = await runFile(improve.file, { inputs, 'run-dir': join(runDir, 'run'), workspace: improve.root, server: client.server }, undefined, undefined, client, undefined, { IMPROVE_API_KEY: token, IMPROVE_SERVER: client.server }); }
  finally { process.stdout.write = out; process.stderr.write = err; }
  if (result.status !== 'completed') throw Object.assign(Error(result.failure?.headline ?? `The improvement stopped with status ${result.status}.`), { log });
  const summary = (() => { try { return JSON.parse(readFileSync(join(runDir, 'run', 'summary.json'), 'utf8')); } catch { return {}; } })();
  return { ...readImproveResult(result.result), log, summary };
}

/** The ID of the regression case that a correction makes: one per judgment, so a later loop finds it. */
export const correctionCaseId = (judgmentId: string) => `correction-${judgmentId.replace(/^jdg_/, '').slice(0, 12)}`;
const caseSchema = { type: 'object', properties: { criteria: { type: 'array', items: { type: 'string', description: 'One plain sentence that a right result meets.' } } } };

/**
 * Make the regression case of a correction, even from vague words such as "it's not even redlined": a model writes 1 to
 * 3 plain sentences from the note and the run's result, and method case new keeps them only when they fail on the run.
 * A rule that fails nothing gets one more try with the reason. The person's words decide a conflict with an instruction.
 */
export async function caseFromCorrection(file: string, judgment: { id: string; note: string | null; corrected?: unknown }, runDir: string) {
  const id = correctionCaseId(judgment.id);
  if (existsSync(join(dirname(file), 'cases', id, 'case.json'))) return { id, made: false };
  const { outcomeOfRun, createCase } = await import('@withmethod/runtime/cases.js');
  const outcome: any = await outcomeOfRun(runDir);
  const method = readDocument(file) as any;
  const ref = typeof method.result === 'string' ? method.result.split('.')[0] : undefined;
  if (!ref) throw Error('The Method has a result with several values, so the case needs an output to judge.');
  const value = outcome.outputs?.[ref] ?? outcome.result;
  const note = judgment.note?.trim() || 'The person marked this result wrong.';
  const { callModel } = await import('./model-call.js');
  const { preparedConfig } = await import('./quality.js');
  const prepared = await preparedConfig(file, {}, { judge: true });
  const user = [`The person's correction, in their words:\n${note}`,
    judgment.corrected !== undefined && judgment.corrected !== null ? `The result the person says is right:\n${clip(typeof judgment.corrected === 'string' ? judgment.corrected : JSON.stringify(judgment.corrected, null, 2), 20_000)}` : '',
    `The Method's goal: ${String(method.goal ?? '')}`, `The result of the run (${ref}):\n${clip(typeof value === 'string' ? value : JSON.stringify(value, null, 2), 40_000)}`].filter(Boolean).join('\n\n');
  let reason = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await callModel({ schema: caseSchema, user: reason ? `${user}\n\nYour last sentences could not be used: ${reason}` : user,
      system: 'A person corrected the result of a run of a Method. Write 1 to 3 plain sentences that a right result of this run meets and that this result does not meet, so a later version can be checked against the correction. The person\'s words may be vague, such as "the Ashby one\'s wrong" or "it\'s not even redlined": use the result to find what they mean. Each sentence names one checkable thing in the result, without names or numbers that only this run has unless the correction is about them. Do not ask for anything that the correction does not ask for.' });
    if ('unavailable' in answer) throw Error(answer.reason);
    const criteria = (Array.isArray(answer.value?.criteria) ? answer.value.criteria : []).map((c: unknown) => String(c).trim()).filter(Boolean).slice(0, 3);
    if (!criteria.length) { reason = 'There were no sentences.'; continue; }
    try {
      await createCase({ methodFile: file, runDir, id, note, rubric: criteria, ref: `outputs.${ref}`, acceptConflict: note, config: prepared.config,
        options: { runOptions: { processPath: prepared.processPath, ...(prepared.hostedModels ? { hostedModels: prepared.hostedModels } : {}) } } });
      return { id, made: true };
    } catch (error: any) {
      if (!['case_not_red', 'case_vacuous', 'case_invalid'].includes(error.code)) throw error;
      reason = error.message;
    }
  }
  throw Object.assign(Error(reason), { code: 'case_not_made' });
}
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;

/** The Method's judgments: the account's, with the notes that stay on this computer for a device Method. */
async function methodJudgments(client: MethodClient, file: string, methodId: string, waitMs?: number) {
  const { judgments } = await client.request<{ judgments: AccountJudgment[] }>(`/api/cli/methods/${encodeURIComponent(methodId)}/judgments`, 'GET', undefined, true,
    waitMs ? { signal: AbortSignal.timeout(waitMs), stallMs: waitMs } : {});
  const local = new Map(localJudgments(file).map(j => [j.id, j] as [string, LocalJudgment]));
  const folders = runFolderIndex();
  return judgments.map(j => {
    const kept = local.get(j.id);
    return { ...j, note: j.note ?? kept?.note ?? null, corrected: j.corrected ?? kept?.corrected ?? null, run_dir: kept?.run_dir && existsSync(kept.run_dir) ? kept.run_dir : folders.get(j.run_id) };
  });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Fix the pending corrections of a Method file on this computer: the loop. Returns undefined when nothing waits. It
 * takes the pending corrections in the account first, so two computers never fix one correction twice, and gives them
 * back when the loop stops before it decides. A subscription limit or another failure of the model service is a plain
 * error.
 */
export async function fixCorrections(client: MethodClient, file: string, options: { run?: RunFile; waitMs?: number } = {}): Promise<FixOutcome | undefined> {
  const document = readDocument(file) as any;
  const methodId = typeof document.id === 'string' && methodIdPattern.test(document.id) ? document.id : undefined;
  if (!methodId || !client.token()) return undefined;
  const all = await methodJudgments(client, file, methodId, options.waitMs);
  const waiting = all.filter(j => j.pending && j.verdict === 'wrong');
  if (!waiting.length) return undefined;
  const handled = (ids: string[], value: boolean) => client.request<{ changed: string[] }>(`/api/cli/methods/${encodeURIComponent(methodId)}/judgments/handled`, 'POST', { ids, handled: value });
  const taken = new Set((await handled(waiting.map(j => j.id), true)).changed);
  const fresh = waiting.filter(j => taken.has(j.id));
  if (!fresh.length) return undefined;
  const fromDashboard = fresh.filter(j => j.source === 'dashboard').length;
  process.stderr.write(`Fixing ${basename(file)} from ${plural(fresh.length, 'correction')} on this computer. This takes a few minutes.\n`);
  const base = methodContent(document), baseVersion = await currentVersion(file).catch(() => undefined);
  let decided = false;
  try {
    // A regression case per correction, so every later change is checked against it.
    const cases: FixOutcome['cases'] = { made: [], not_made: [] };
    for (const j of fresh) {
      if (!j.run_dir) { cases.not_made.push({ id: j.id, reason: 'The run is not on this computer.' }); continue; }
      try { const made = await caseFromCorrection(file, j, j.run_dir); if (made.made) cases.made.push(made.id); }
      catch (error: any) { if (error.code !== 'case_not_made' && error.owner !== 'agent_work') throw error; cases.not_made.push({ id: j.id, reason: error.message }); }
    }
    // A judged run with no folder here (a cloud run) comes as its account record.
    const freshIds = new Set(fresh.map(j => j.id));
    const judgments: ImproveJudgment[] = [];
    for (const j of all) {
      const caseId = correctionCaseId(j.id);
      const run = !j.run_dir && (freshIds.has(j.id) || j.verdict === 'wrong') ? await client.request<{ run: any }>(`/api/workspace/runs/${encodeURIComponent(j.run_id)}`).then(r => r.run).catch(() => undefined) : undefined;
      judgments.push({ id: j.id, run_id: j.run_id, ...(j.run_dir ? { run_dir: j.run_dir } : {}), step_id: j.step_id, verdict: j.verdict, note: j.note, ...(j.corrected !== null ? { corrected: j.corrected } : {}),
        ...(existsSync(join(dirname(file), 'cases', caseId, 'case.json')) ? { case_id: caseId } : {}), source: j.source, created_at: j.created_at, ...(freshIds.has(j.id) ? { new: true } : {}),
        ...(run ? { run: { id: run.id, status: run.status, created_at: run.created_at, version_id: run.workflow_version_id, inspection: run.inspection } } : {}) });
    }
    const runFolders = (await localRuns(file)).map(r => r.dir);
    const improved = await runImprovement(client, file, judgments, runFolders, options.run);
    decided = true;
    const evidence: any = improved.evidence;
    const earlier = (evidence.cases ?? []).filter((c: any) => !c.target && c.after === 'pass').length;
    const usage = evidence.budget ?? null;
    const used = usage ? ` (${plural(usage.model_calls, 'model call')}, ${usage.minutes < 1 ? 'under a minute' : `${Math.round(usage.minutes)} min`}${typeof usage.usd === 'number' ? `, $${usage.usd.toFixed(2)}` : ''})` : '';
    const outcome = { file, corrections: fresh.length, from_dashboard: fromDashboard, cause: improved.cause, cases, earlier_passed: earlier, usage, capped: improved.capped, log: improved.log };
    const record = (kind: 'applied' | 'none', extra: Record<string, unknown> = {}) => saveLocalProposal(file, { id: `lp_${randomBytes(8).toString('hex')}`, method_id: methodId, base_version_id: baseVersion?.version_id ?? null,
      status: kind, cause: improved.cause, evidence, created_at: new Date().toISOString(), base_workflow: base, proposed_workflow: improved.workflow, judgments: [...freshIds], ...extra });
    if (evidence.kind !== 'change') {
      record('none');
      const why = improved.cause.replace(/^No safe change was found\.\s*/, '').split('\n')[0]!.slice(0, 300);
      return { ...outcome, kind: 'none', steps: evidence.steps ?? [], line: `No safe change found: ${why}${used}` };
    }
    // The file must be the one the loop started from; a change made meanwhile is not overwritten.
    if (!isDeepStrictEqual(methodContent(readDocument(file)), base)) {
      record('none', { reason: 'The file changed while Method fixed it.' });
      return { ...outcome, kind: 'none', steps: evidence.steps ?? [], line: `No change applied: ${basename(file)} changed while Method fixed it. Run method judge again to fix it on the new file.` };
    }
    // The version before the change is saved too, so the Method's history has it to restore.
    const { Outbox } = await import('./outbox.js');
    const outbox = new Outbox(client);
    const before = await (await import('./versions.js')).prepareVersion(client, outbox, file).catch(() => undefined);
    const steps = applyChange(file, methodId, improved);
    const version = await saveFixedVersion(client, outbox, file, methodId, improved.cause, before?.version_id);
    record('applied', { applied_at: new Date().toISOString(), ...(version ? { applied_version_id: version.version_id } : {}) });
    const changed = `Changed ${steps.length ? `step ${steps.join(', ')}` : 'its files'} of ${basename(file)}: ${improved.cause}`, undo = version ? ` ${version.undo}` : '';
    return { ...outcome, kind: 'change', steps, version, changed: `${changed}${undo}${used}`,
      line: `${changed} It fixes the corrected run and passes ${plural(earlier, 'earlier correction')}.${undo}${used}` };
  } catch (error) {
    // Stopped before it decided: the corrections wait for the next loop.
    if (!decided) await handled([...taken], false).catch(() => undefined);
    throw error;
  }
}

/** Write the tested change: the Method content (its id: line kept) and a changed package file of a script change. */
function applyChange(file: string, methodId: string, improved: ImproveProposal) {
  const before = methodContent(readDocument(file));
  loadWorkflow(improved.workflow);
  if (!isDeepStrictEqual(improved.workflow, before)) writeMethodFile(file, methodId, improved.workflow);
  const folder = dirname(resolve(file));
  for (const changed of improved.files) {
    const path = resolve(folder, packagePath(changed.path));
    if (!path.startsWith(folder + sep)) throw Error(`The change names a file outside the Method folder: ${changed.path}`);
    const bytes = Buffer.from(changed.content_base64, 'base64');
    if (fileHash(bytes) !== changed.sha256) throw Error(`The changed file ${changed.path} does not match its sha256.`);
    writeFileSync(path, bytes);
  }
  return changedSteps(before, improved.workflow);
}

/**
 * Save the fixed file as a new version of the Method, with the cause as its reason. The version before stays in the
 * Method's history: restoring it on the Method page undoes the change.
 */
async function saveFixedVersion(client: MethodClient, outbox: import('./outbox.js').Outbox, file: string, methodId: string, cause: string, previous: string | undefined) {
  try {
    const { savedVersions } = await import('./outbox.js');
    const { prepareVersion } = await import('./versions.js');
    const version = await prepareVersion(client, outbox, file, `Method fixed it from a correction: ${cause}`.slice(0, 500));
    await outbox.drain();
    if (!await outbox.whenSaved(version.version_id)) return undefined;
    const number = previous && await outbox.whenSaved(previous) ? savedVersions(client.server)[previous]?.version_number : undefined;
    const undo = previous && number ? `To undo it, restore version ${number}: ${client.server}/methods/${methodId}?version=${previous}` : 'The version before it is in its history on the Method page.';
    return { version_id: version.version_id, url: version.url, undo };
  } catch { return undefined; }
}

/** The one line for corrections that waited, printed before method run or method judge goes on. */
export function waitingLine(outcome: FixOutcome) {
  const what = outcome.from_dashboard === outcome.corrections ? `${plural(outcome.corrections, 'correction')} from the dashboard` : plural(outcome.corrections, 'correction');
  return outcome.kind === 'change' ? `${what}: fixed, passes ${plural(outcome.earlier_passed, 'earlier correction')}. ${outcome.changed}` : `${what}: ${outcome.line}`;
}
