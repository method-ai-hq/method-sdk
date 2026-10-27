import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isAgentRecord } from '@withmethod/runtime/cases.js';
import { MethodPackageSchema, packageDigest, packagePath } from '../../contracts/src/method-package.js';
import { loadWorkflow } from '../../workflow-language/src/validate.js';
import { readDocument } from './authoring.js';
import type { MethodClient } from './method-client.js';
import { fileHash } from './method-files.js';
import { methodCache } from './prepare.js';
import { writePrivateJson } from './files.js';
import { currentVersion, methodContent, methodIdPattern } from './versions.js';
import { localRuns, saveLocalProposal, writeMethodFile } from './proposals.js';
import { changedSteps } from './merge.js';
import { localJudgments, runFolderIndex, type LocalJudgment } from './local-judgments.js';
import type { CorrectionOutcome, OutcomeKind } from './fix-lines.js';
import { fixFolder, readFixState, saveError, saveNotice, saveOutcome, setWorker, storedOutcome, writeFixState } from './fix-outcomes.js';
import { recordChange, saveVersion, snapshot, undoLast, undoRecords } from './undo.js';
import { fixUndoneLine, ruleBackLine } from './fix-lines.js';

// The improvement loop on this computer. method judge starts it in its own process for a wrong judgment, and method
// run starts it for corrections that wait (from the dashboard, an answer, or a fix that stopped). It makes a
// regression case from each correction, runs improve.method on this computer with the user's own Claude Code or Codex,
// and applies what it decided for each correction: a tested fix, a learned rule, or nothing. A change is saved as a new
// version, and method undo restores the file as it was before.

/** A judgment as improve.method reads it. new marks the corrections to fix now; run is the account record of a run with no folder here. */
export type ImproveJudgment = {
  id: string; run_id: string; run_dir?: string; step_id: string | null; verdict: 'right' | 'wrong'; note: string | null; corrected?: unknown;
  case_id?: string; source: string; created_at: string; new?: boolean; run?: unknown; noted_by?: string | null;
  /** The question that an earlier fix asked about this correction, and the person's answer. */
  question?: string; answer?: string;
};
type AccountJudgment = { id: string; run_id: string; step_id: string | null; verdict: 'right' | 'wrong'; note: string | null; corrected: unknown; source: string; created_at: string; pending: boolean;
  noted_by?: string | null; outcome?: string | null; handled_by?: string | null; held_with?: string | null; question?: string | null; answer?: string | null };
export type { CorrectionOutcome };
type SavedImprove = { workflow_id: string; version_id: string; workflow: any; package?: unknown };
/** Runs a local Method file; the default is the runtime that `method run FILE` uses. */
export type RunFile = (file: string, flags: Record<string, unknown>, syncFactory: undefined, onEvent: undefined, client: MethodClient, baseConfig: undefined, secrets: Record<string, string>) => Promise<{ status: string; result?: unknown; failure?: any }>;
/** The SubmitProposal that improve.method returns, read from its result. */
export type ImproveProposal = { cause: string; workflow: unknown | null; files: { path: string; sha256: string; content_base64: string }[]; evidence: { kind: 'change' | 'none'; steps?: string[]; [key: string]: unknown } };
export type ImproveResult = ImproveProposal & { capped: string; outcomes: CorrectionOutcome[]; background_cases: string[]; summary: string };
export type FixOutcome = {
  file: string; judgments: string[]; kind: 'change' | 'none'; applied: boolean; cause: string; steps: string[];
  cases: { made: string[]; not_made: { id: string; reason: string }[] }; version?: { version_id: string; url: string } | undefined;
  usage: { model_calls: number; usd: number | null; minutes: number } | null; capped: string; log: string; outcomes: CorrectionOutcome[];
  /** The cases that run after an applied change, and the undo record of that change. */
  background_cases: string[]; undo_id?: string | undefined;
  /** The corrections that the applied change answered, with their notes. */
  fixed: { id: string; note: string | null }[];
};

const outcomeKinds: OutcomeKind[] = ['fixed', 'no_fix_found', 'could_not_test', 'question', 'held', 'not_reproduced', 'not_fixable_here'];
const reasons = ['missing_file', 'can_send', 'too_large', 'no_live_step'];
const plainText = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
/**
 * One outcome of improve.method in the form the lines read: {id, outcome, detail, reason?, question?, held_with?,
 * learned_rule?, again?, tests?: {case, base, candidate: {passes, runs}, guards: []}, tried?}. A fixed outcome's detail
 * says what is different now; a held outcome's detail is about the loop, so the line names only the other person.
 */
export function loopOutcome(o: any): CorrectionOutcome {
  if (typeof o?.id !== 'string' || !outcomeKinds.includes(o.outcome)) throw Error('The improvement run has no outcome for each correction.');
  const out: CorrectionOutcome = { id: o.id, outcome: o.outcome };
  const detail = plainText(o.detail);
  if (o.outcome === 'fixed') { if (detail) out.summary = detail; }
  else if (o.outcome !== 'held' && detail) out.detail = detail;
  if (o.outcome === 'could_not_test') out.reason = reasons.includes(o.reason) ? o.reason : 'missing_file';
  if (out.reason === 'missing_file' && typeof o.path === 'string' && o.path) out.path = o.path;
  if (o.outcome === 'question') out.question = plainText(o.question) ?? 'What should the result have said instead?';
  if (o.outcome === 'held' && plainText(o.held_with)) out.by = plainText(o.held_with)!;
  if (typeof o.learned_rule === 'string' && o.learned_rule) out.rule_added = true;
  if (Number.isSafeInteger(o.tried) && o.tried > 0) out.tried = o.tried;
  const passes = o.tests?.candidate?.passes;
  if (o.outcome === 'fixed' && Number.isSafeInteger(passes) && passes > 0) out.tested = { times: passes, earlier: Array.isArray(o.tests?.guards) ? o.tests.guards.length : 0 };
  if (o.again === true) out.again = true;
  // Optional words for the lines, when the loop gives them: the plain noun of what the Method works on, and the tested output.
  if (plainText(o.subject)) out.subject = plainText(o.subject)!;
  if (o.tested_output && typeof o.tested_output === 'object') out.tested_output = o.tested_output;
  return out;
}

/**
 * Read the result of improve.method: {proposal: <SubmitProposal as JSON text>, kind, proposal_id, outcomes: <JSON text,
 * one outcome per new correction>, background_cases: [case ids], summary: one plain line}. A change has the tested
 * workflow and the changed package files (a script, learned.json). A pruning sweep (mode prune) has no outcomes; its
 * summary says what it removed, and what it left because nothing checks it.
 */
export function readImproveResult(result: unknown, options: { prune?: boolean } = {}): ImproveResult {
  const value = result as { proposal?: unknown; kind?: unknown; capped?: unknown; outcomes?: unknown; background_cases?: unknown; summary?: unknown } | null;
  if (!value || typeof value.proposal !== 'string') throw Error('The improvement run gave no proposal.');
  let proposal: any;
  try { proposal = JSON.parse(value.proposal); } catch { throw Error('The improvement run gave a proposal that is not JSON.'); }
  if (typeof proposal?.cause !== 'string' || !proposal.cause.trim()) throw Error('The improvement proposal has no cause.');
  const evidence = proposal.evidence;
  if (!evidence || typeof evidence !== 'object' || !['change', 'none'].includes(evidence.kind)) throw Error('The improvement proposal has no known kind.');
  if (value.kind !== undefined && value.kind !== evidence.kind) throw Error(`The improvement run says kind ${String(value.kind)}, but its proposal is kind ${evidence.kind}.`);
  if (evidence.kind === 'change' && (!proposal.workflow || typeof proposal.workflow !== 'object')) throw Error('The improvement proposal is a change without a workflow.');
  let outcomes: unknown = [];
  if (!options.prune) {
    try { outcomes = typeof value.outcomes === 'string' ? JSON.parse(value.outcomes) : undefined; } catch { outcomes = undefined; }
    if (!Array.isArray(outcomes)) throw Error('The improvement run has no outcome for each correction.');
  }
  const background = Array.isArray(value.background_cases) ? value.background_cases.filter((c): c is string => typeof c === 'string' && !!c) : [];
  return { cause: proposal.cause.trim(), workflow: evidence.kind === 'change' ? proposal.workflow : null, files: Array.isArray(proposal.files) ? proposal.files : [], evidence,
    capped: typeof value.capped === 'string' ? value.capped : '', outcomes: (outcomes as unknown[]).map(loopOutcome), background_cases: [...new Set(background)], summary: plainText(value.summary) ?? '' };
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
 * Run improve.method on this computer (mode prune: the pruning pass). Its model steps and its scripts' model requests follow the rule of every run:
 * the user's own Claude Code or Codex first, hosted models only without one. The run gets the signed-in key and server
 * as its IMPROVE_API_KEY and IMPROVE_SERVER secrets, for this run only. Its output goes to a log file.
 */
export async function runImprovement(client: MethodClient, file: string, judgments: ImproveJudgment[], runFolders: string[], run?: RunFile, mode?: 'prune') {
  const token = client.token();
  if (!token) throw Error('Sign in with method login, then run method judge again.');
  const improve = await cachedImproveMethod(client);
  const runDir = join(methodCache(), 'runs', randomUUID());
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const judgmentsFile = join(runDir, 'judgments.json'), inputs = join(runDir, 'improve-inputs.json'), log = join(runDir, 'improve.log');
  // The judgments with their notes go in a private file of this run; they stay on this computer.
  writePrivateJson(judgmentsFile, judgments);
  writePrivateJson(inputs, { method_file: file, grant_id: '', judgment_id: '', judgments_file: judgmentsFile, run_folders: runFolders, ...(mode ? { mode } : {}) });
  const runFile: RunFile = run ?? (await import('./current-runtime.js')).runCurrentFile as unknown as RunFile;
  // The run prints its own result and progress; they go to the log, so the person reads one line.
  const out = process.stdout.write, err = process.stderr.write;
  const toLog = ((chunk: any, ...rest: any[]) => { try { appendFileSync(log, typeof chunk === 'string' ? chunk : Buffer.from(chunk)); } catch { /* the log is best effort */ } const done = rest.find(r => typeof r === 'function'); done?.(); return true; }) as typeof process.stdout.write;
  process.stdout.write = toLog; process.stderr.write = toLog;
  let result: Awaited<ReturnType<RunFile>>;
  try { result = await runFile(improve.file, { inputs, 'run-dir': join(runDir, 'run'), workspace: improve.root, server: client.server }, undefined, undefined, client, undefined, { IMPROVE_API_KEY: token, IMPROVE_SERVER: client.server }); }
  finally { process.stdout.write = out; process.stderr.write = err; }
  if (result.status !== 'completed') throw Object.assign(Error(stopCause(result)), { log });
  return { ...readImproveResult(result.result, { prune: mode === 'prune' }), log };
}

/**
 * Why improve.method stopped, in the words of the cause: the last line that its failing script wrote (the script's own
 * error, such as "Claude Code is not signed in on this computer."), else the error itself, else the failure's headline.
 * The names of its steps and scripts stay in the log.
 */
export function stopCause(result: { status: string; failure?: { headline?: string; details?: string; diagnostics?: string } | null }) {
  const said = String(result.failure?.diagnostics ?? '').split('\n').map(line => line.trim()).filter(Boolean).at(-1);
  const error = result.failure?.details && !/^Process exited with code/.test(result.failure.details) ? result.failure.details : undefined;
  return said ?? error ?? result.failure?.headline ?? `The improvement stopped with status ${result.status}.`;
}

/** The ID of the regression case that a correction makes: one per judgment, so a later loop finds it. */
export const correctionCaseId = (judgmentId: string) => `correction-${judgmentId.replace(/^jdg_/, '').slice(0, 12)}`;
const caseSchema = { type: 'object', properties: {
  criteria: { type: 'array', items: { type: 'object', properties: {
    text: { type: 'string', description: 'One plain sentence that a right result meets.' },
    ref: { type: 'string', description: 'The name, from "What the person saw", of the thing the sentence is about.' } } } },
  check_script: { type: 'string', description: 'A Node.js script that checks the form or the action, or an empty text.' },
  check_says: { type: 'string', description: 'One plain sentence: what the script checks. Empty when there is no script.' },
} };

/** One thing that the person saw: the result, a step output, a file the run wrote, or a call or effect it made. */
type Seen = { ref: string; label: string; value: unknown };
const textOf = (path: string) => {
  const bytes = readFileSync(path);
  return bytes.subarray(0, 8192).includes(0) ? `[a binary file of ${bytes.length} bytes]` : bytes.toString('utf8');
};
/** What the person saw of a run, with the ref that a case uses for each thing (runtime 0.16.0 refs). */
export function seenOfRun(outcome: any): Seen[] {
  const seen: Seen[] = [];
  if (outcome.result !== undefined && outcome.result !== null) seen.push({ ref: 'result', label: 'The result', value: outcome.result });
  for (const [name, value] of Object.entries(outcome.outputs ?? {})) seen.push({ ref: `outputs.${name}`, label: `The output ${name}`, value });
  const files: Seen[] = [];
  const walk = (dir: string, prefix: string) => {
    let entries: import('node:fs').Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= 20 || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name), name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path, name);
      // The runtime's own records of an agent attempt (prompt, events, transcript) are not what the run wrote.
      else if (entry.isFile() && !isAgentRecord(name) && statSync(path).size <= 2_000_000) files.push({ ref: `file:${name}`, label: `The file ${name}, which the run wrote`, value: textOf(path) });
    }
  };
  if (typeof outcome.artifacts === 'string') walk(outcome.artifacts, '');
  for (const [path, copy] of Object.entries(outcome.files ?? {}) as [string, string][]) {
    if (files.length >= 20) break;
    try { if (statSync(copy).isFile()) files.push({ ref: `file:${path}`, label: `The file ${path}, which the run wrote`, value: textOf(copy) }); } catch { /* the copy is gone */ }
  }
  seen.push(...files);
  const calls = new Map<string, unknown[]>();
  for (const call of outcome.tool_calls ?? []) calls.set(call.tool, [...(calls.get(call.tool) ?? []), call.arguments]);
  for (const [tool, args] of calls) seen.push({ ref: `effect:${tool}`, label: `The calls of ${tool} (their arguments)`, value: args });
  for (const effect of outcome.effect_inputs ?? []) seen.push({ ref: `effect:${effect.effect}`, label: `What ${effect.effect} sent or changed`, value: effect.inputs });
  return seen;
}

/**
 * Make the regression case of a correction, even from vague words such as "it's not even redlined". A model reads what
 * the person saw (the result, the files the run wrote, and the calls and effects it made) and writes 1 to 3 plain
 * sentences, each about one of those things and decidable from it alone, that a right result can meet with the
 * information the run had; for a note about form or a missing action, also a small check script. A
 * sentence is kept only when it fails on the corrected run and passes on every approved run of the same part, with two
 * judges when both Claude Code and Codex are signed in. Sentences that do not fail get one more try with the reason.
 */
export async function caseFromCorrection(file: string, judgment: { id: string; note: string | null; corrected?: unknown; noted_by?: string | null; answer?: string | null }, runDir: string, options: { approvedRuns?: string[] } = {}) {
  const id = correctionCaseId(judgment.id), folder = dirname(resolve(file));
  if (existsSync(join(folder, 'cases', id, 'case.json'))) return { id, made: false };
  const { outcomeOfRun, createCase } = await import('@withmethod/runtime/cases.js');
  const outcome: any = await outcomeOfRun(runDir);
  const approved: any[] = [];
  for (const dir of options.approvedRuns ?? []) { try { approved.push(await outcomeOfRun(dir)); } catch { /* not a finished run */ } }
  const seen = seenOfRun(outcome), refs = new Set(seen.map(s => s.ref));
  const fallback = refs.has('result') ? 'result' : seen[0]?.ref ?? 'result';
  const method = readDocument(file) as any;
  const note = [judgment.note?.trim() || 'The person marked this result wrong.', judgment.answer?.trim() ? `Asked what they meant, the person answered: ${judgment.answer.trim()}` : ''].filter(Boolean).join('\n');
  const { callModel } = await import('./model-call.js');
  const { preparedConfig, judgeProfiles, evaluateWithJudges } = await import('./quality.js');
  const prepared = await preparedConfig(file, {}, { judge: true });
  const profiles = await judgeProfiles(prepared.config);
  const runOptions = { processPath: prepared.processPath, ...(prepared.hostedModels ? { hostedModels: prepared.hostedModels } : {}) };
  let budget = 60_000;
  const shown = seen.map(s => { const text = clip(typeof s.value === 'string' ? s.value : JSON.stringify(s.value, null, 2), Math.max(500, Math.min(20_000, budget))); budget -= text.length; return `[${s.ref}] ${s.label}:\n${text}`; });
  const user = [`The person's correction, in their words:\n${note}`,
    judgment.corrected !== undefined && judgment.corrected !== null ? `The result the person says is right:\n${clip(typeof judgment.corrected === 'string' ? judgment.corrected : JSON.stringify(judgment.corrected, null, 2), 20_000)}` : '',
    `The Method's goal: ${String(method.goal ?? '')}`, `What the person saw (each with its name in brackets):\n\n${shown.join('\n\n')}`].filter(Boolean).join('\n\n');
  const system = [
    'A person corrected the result of a run of a Method. Write 1 to 3 plain sentences that a right result of this run meets and that this result does not meet, so a later version can be checked against the correction.',
    'The person\'s words may be vague, such as "the Ashby one\'s wrong" or "it\'s not even redlined": use what the person saw to find what they mean.',
    'Each sentence is about one thing the person saw: give its name in brackets as ref (result, outputs.NAME, file:PATH or effect:NAME). Judge a file or a message by the file or the message itself, not by a summary of it.',
    'Each sentence names one checkable thing, without names or numbers that only this run has unless the correction is about them. Do not ask for anything that the correction does not ask for.',
    'A judge decides each sentence from the thing it is about and nothing else: it does not see the run\'s inputs, sources or materials. So when a sentence checks facts, write the facts in the sentence (from the correction or from what the person saw), not "agrees with the report".',
    'A right result must be able to meet each sentence and the check script with the information the run had: do not require a detail, such as a telephone number, an address, a name or a date, that neither the correction nor what the person saw gives. Where such a detail is not known, a clear placeholder for it is right.',
    'When the correction is about form or a missing action (a document with no tracked changes, a message with no attachment, a message that was not sent, a missing field), also write check_script: a Node.js ES module that reads JSON from standard input with result, outputs, tool_calls (a list of {tool, arguments, standin}), effect_inputs (a list of {effect, inputs}) and files (an object: each file the run wrote, by the name in brackets after file:, mapped to an absolute path the script can read, for example a .docx to unzip), and prints {"pass": true or false, "reason": "one sentence"}. It must fail on this result, pass on a right one, and fail when the thing it checks is missing. In check_says, say in one plain sentence what it checks. Otherwise leave both empty.',
  ].join(' ');
  let reason = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await callModel({ schema: caseSchema, system, user: reason ? `${user}\n\nYour last answer could not be used: ${reason}` : user });
    const written = (Array.isArray(answer.value?.criteria) ? answer.value.criteria : [])
      .map((c: any) => typeof c === 'string' ? { text: c.trim(), ref: fallback } : { text: String(c?.text ?? '').trim(), ref: refs.has(String(c?.ref ?? '').trim()) ? String(c.ref).trim() : fallback })
      .filter((c: { text: string }) => c.text).slice(0, 3);
    const script = typeof answer.value?.check_script === 'string' ? answer.value.check_script.trim() : '';
    if (!written.length && !script) { reason = 'There were no sentences.'; continue; }
    // The sentences grouped by what they judge, with IDs that stay the same when the case is saved.
    const expect: any[] = [];
    written.forEach((c: { text: string; ref: string }, i: number) => {
      const item = expect.find(e => e.ref === c.ref) ?? (expect.push({ kind: 'rubric', ref: c.ref, criteria: [] }), expect.at(-1));
      item.criteria.push({ id: `c${i + 1}`, text: c.text });
    });
    // A check script is written next to the Method file for createCase to copy into the case, then removed.
    const entrypoint = `check-${id}.mjs`, scriptPath = join(folder, entrypoint);
    if (script) { writeFileSync(scriptPath, script + '\n', { mode: 0o600 }); expect.push({ kind: 'predicate', runtime: 'node', entrypoint, ...(answer.value?.check_says ? { text: String(answer.value.check_says).trim() } : {}) }); }
    try {
      const context = { caseDir: folder, config: prepared.config, options: { runOptions } };
      const kept = await keptExpectations(expect, outcome, approved, context, profiles, evaluateWithJudges);
      if (!kept.expect.length) { reason = kept.reason; continue; }
      await createCase({ methodFile: file, runDir, id, note, author: judgment.noted_by ?? null, expect: kept.expect, acceptConflict: note, config: prepared.config, options: { runOptions } });
      return { id, made: true };
    } catch (error: any) {
      if (!['case_not_red', 'case_vacuous', 'case_invalid'].includes(error.code)) throw error;
      reason = error.message;
    } finally { rmSync(scriptPath, { force: true }); }
  }
  throw Object.assign(Error(reason), { code: 'case_not_made' });
}
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;

/**
 * The expectations that capture the correction: each sentence that fails on the corrected run and passes on every
 * approved run, and the check script when it does the same. A sentence the judges disagree on does not fail and is dropped.
 */
async function keptExpectations(expect: any[], bad: any, approved: any[], context: { caseDir: string; config: any; options: any }, profiles: any[],
  judge: (expect: any[], outcome: any, context: any, profiles: any[]) => Promise<{ status: string; results: any[] }>) {
  const onBad = await judge(expect, bad, context, profiles);
  const onGood = await Promise.all(approved.map(outcome => judge(expect, outcome, context, profiles)));
  const reasons: string[] = [];
  const kept = expect.flatMap((item, i) => {
    const badResult = onBad.results[i], goodResults = onGood.map(r => r.results[i]);
    if (item.kind === 'predicate') {
      if (badResult?.status !== 'fail') { reasons.push('The check script passes on the corrected run.'); return []; }
      if (goodResults.some(r => r?.status !== 'pass')) { reasons.push('The check script fails on a run the person approved.'); return []; }
      return [item];
    }
    if (badResult?.status === 'unverifiable') { reasons.push(`${item.ref} is not in the corrected run.`); return []; }
    const criteria = item.criteria.filter((c: any) => {
      const failsBad = badResult?.criteria?.find((x: any) => x.id === c.id)?.pass === false && !badResult.criteria.find((x: any) => x.id === c.id)?.unsure;
      if (!failsBad) { reasons.push(`"${c.text}" does not fail on the corrected run.`); return false; }
      if (goodResults.some(r => r?.status === 'unverifiable' || r?.criteria?.find((x: any) => x.id === c.id)?.pass !== true)) { reasons.push(`"${c.text}" fails on a run the person approved.`); return false; }
      return true;
    });
    return criteria.length ? [{ ...item, criteria }] : [];
  });
  return { expect: kept, reason: reasons.join(' ') || 'Nothing could be checked.' };
}

/** The Method's judgments: the account's, with the notes and answers that stay on this computer for a device Method. */
async function methodJudgments(client: MethodClient, file: string, methodId: string, waitMs?: number) {
  const { judgments } = await client.request<{ judgments: AccountJudgment[] }>(`/api/cli/methods/${encodeURIComponent(methodId)}/judgments`, 'GET', undefined, true,
    waitMs ? { signal: AbortSignal.timeout(waitMs), stallMs: waitMs } : {});
  const local = new Map(localJudgments(file).map(j => [j.id, j] as [string, LocalJudgment]));
  const folders = runFolderIndex();
  return judgments.map(j => {
    const kept = local.get(j.id);
    return { ...j, note: j.note ?? kept?.note ?? null, corrected: j.corrected ?? kept?.corrected ?? null, answer: j.answer ?? kept?.answer ?? null,
      run_dir: kept?.run_dir && existsSync(kept.run_dir) ? kept.run_dir : folders.get(j.run_id) };
  });
}
/** The corrections of a Method that wait for a fix. */
export async function waitingCorrections(client: MethodClient, file: string, methodId: string, waitMs?: number) {
  return (await methodJudgments(client, file, methodId, waitMs)).filter(j => j.pending && j.verdict === 'wrong');
}

/**
 * Fix the pending corrections of a Method file on this computer: one pass of the loop. Returns undefined when nothing
 * waits. It takes the pending corrections in the account first, so two computers never fix one correction twice, and
 * gives them back when the loop stops before it decides. Each correction gets its own outcome. A subscription limit or
 * another failure of the model service is a plain error.
 */
export async function fixCorrections(client: MethodClient, file: string, options: { run?: RunFile; waitMs?: number; skip?: Set<string> } = {}): Promise<FixOutcome | undefined> {
  const document = readDocument(file) as any;
  const methodId = typeof document.id === 'string' && methodIdPattern.test(document.id) ? document.id : undefined;
  if (!methodId || !client.token()) return undefined;
  const all = await methodJudgments(client, file, methodId, options.waitMs);
  // skip: corrections that this process opened again after a later check undid their fix; the next method run takes them.
  const waiting = all.filter(j => j.pending && j.verdict === 'wrong' && !options.skip?.has(j.id));
  if (!waiting.length) return undefined;
  const handled = (ids: string[], value: boolean) => client.request<{ changed: string[] }>(`/api/cli/methods/${encodeURIComponent(methodId)}/judgments/handled`, 'POST', { ids, handled: value });
  const taken = new Set((await handled(waiting.map(j => j.id), true)).changed);
  const claimed = waiting.filter(j => taken.has(j.id));
  if (!claimed.length) return undefined;
  const base = methodContent(document), baseVersion = await currentVersion(file).catch(() => undefined);
  let decided = false;
  const outcomes: CorrectionOutcome[] = [];
  const empty = { file, judgments: claimed.map(j => j.id), cause: '', steps: [], cases: { made: [], not_made: [] }, usage: null, capped: '', log: '', outcomes, background_cases: [] as string[], fixed: [] as FixOutcome['fixed'] };
  try {
    // A correction of a step whose text changed since its run is not fixed: the change may already answer it.
    outcomes.push(...await changedSinceRun(client, methodId, claimed, base));
    const fresh = claimed.filter(j => !outcomes.some(c => c.id === j.id));
    if (!fresh.length) { decided = true; await reportOutcomes(client, methodId, outcomes); return { ...empty, kind: 'none', applied: false }; }
    process.stderr.write(`Testing fixes for ${fresh.length} correction${fresh.length === 1 ? '' : 's'} of ${file}.\n`);
    // A regression case per correction, so every later change is checked against it; approved runs of the same step must still pass it.
    const cases: FixOutcome['cases'] = { made: [], not_made: [] };
    const approved = all.filter(j => j.verdict === 'right' && j.run_dir);
    for (const j of fresh) {
      if (!j.run_dir) { cases.not_made.push({ id: j.id, reason: 'The run is not on this computer.' }); continue; }
      const approvedRuns = approved.filter(a => !j.step_id || !a.step_id || a.step_id === j.step_id).map(a => a.run_dir!);
      try { const made = await caseFromCorrection(file, j, j.run_dir, { approvedRuns }); if (made.made) cases.made.push(made.id); }
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
        ...(j.noted_by ? { noted_by: j.noted_by } : {}), ...(j.question ? { question: j.question } : {}), ...(j.answer ? { answer: j.answer } : {}),
        ...(run ? { run: { id: run.id, status: run.status, created_at: run.created_at, version_id: run.workflow_version_id, inspection: run.inspection } } : {}) });
    }
    const runFolders = (await localRuns(file)).map(r => r.dir);
    const improved = await runImprovement(client, file, judgments, runFolders, options.run);
    decided = true;
    const evidence: any = improved.evidence;
    const fromLoop = new Map(improved.outcomes.map(o => [o.id, o]));
    // again: another correction's fix changed the same part; this one waits for the next pass, on the changed file.
    const decidedNow: CorrectionOutcome[] = fresh.map(j => { const o = fromLoop.get(j.id); return o?.again ? { id: j.id, outcome: 'retry' as const, again: true } : { ...(o ?? { outcome: 'no_fix_found' as const }), id: j.id }; });
    const changes = (o: CorrectionOutcome) => o.outcome === 'fixed' || (o.outcome === 'could_not_test' && !!o.rule_added);
    const result = { ...empty, cause: improved.cause, cases, usage: evidence.budget ?? null, capped: improved.capped, log: improved.log, steps: evidence.steps ?? [] };
    const record = (kind: 'applied' | 'none', extra: Record<string, unknown> = {}) => saveLocalProposal(file, { id: `lp_${randomBytes(8).toString('hex')}`, method_id: methodId, base_version_id: baseVersion?.version_id ?? null,
      status: kind, cause: improved.cause, evidence, created_at: new Date().toISOString(), base_workflow: base, proposed_workflow: improved.workflow, judgments: [...freshIds], outcomes: decidedNow, ...extra });
    // Nothing is applied: the corrections that the change would have answered wait for the next pass.
    const notApplied = (why: CorrectionOutcome[]) => decidedNow.map(o => why.find(h => h.id === o.id) ?? (changes(o) ? { id: o.id, outcome: 'retry' as const } : o));
    // A change that passes only by breaking another person's case is held: two people want different results.
    const held = heldBy(file, fresh.filter(j => changes(fromLoop.get(j.id) ?? { id: j.id, outcome: 'no_fix_found' })), evidence);
    let final: CorrectionOutcome[], applied = false, version: FixOutcome['version'], undoId: string | undefined;
    if (held.length) { record('none', { reason: 'held' }); final = notApplied(held); }
    else if (evidence.kind !== 'change') { record('none'); final = decidedNow.map(o => changes(o) ? { ...o, rule_added: false } : o); }
    else if (!isDeepStrictEqual(methodContent(readDocument(file)), base)) {
      // The file must be the one the loop started from; a change made meanwhile is not overwritten.
      record('none', { reason: 'The file changed while Method fixed it.' }); final = notApplied([]);
    } else {
      const before = snapshot(file, improved.files.map(f => f.path));
      applyChange(file, methodId, improved);
      const notes = fresh.filter(j => changes(decidedNow.find(o => o.id === j.id)!)).map(j => j.note?.trim()).filter(Boolean) as string[];
      undoId = recordChange(file, 'fix', improved.cause, notes.length ? `the fix for "${notes.join('" and "').slice(0, 300)}"` : 'the last fix', before).id;
      version = await saveVersion(client, file, `Method fixed it from a correction: ${improved.cause}`.slice(0, 500));
      record('applied', { applied_at: new Date().toISOString(), ...(version ? { applied_version_id: version.version_id } : {}) });
      final = decidedNow; applied = true;
    }
    outcomes.push(...final);
    const retry = outcomes.filter(o => o.outcome === 'retry').map(o => o.id);
    if (retry.length) await handled(retry, false).catch(() => undefined);
    await reportOutcomes(client, methodId, outcomes.filter(o => o.outcome !== 'retry' && o.outcome !== 'elsewhere'));
    const fixed = applied ? fresh.filter(j => changes(final.find(o => o.id === j.id) ?? { id: j.id, outcome: 'no_fix_found' })).map(j => ({ id: j.id, note: j.note })) : [];
    return { ...result, kind: applied ? 'change' : 'none', applied, ...(version ? { version } : {}), background_cases: applied ? improved.background_cases : [], fixed, ...(undoId ? { undo_id: undoId } : {}) };
  } catch (error) {
    // Stopped before it decided: the corrections wait for the next loop.
    if (!decided) await handled([...taken].filter(id => !outcomes.some(o => o.id === id)), false).catch(() => undefined);
    if (!decided && outcomes.length) await reportOutcomes(client, methodId, outcomes);
    throw Object.assign(error instanceof Error ? error : Error(String(error)), { judgments: [...taken] });
  }
}

// One fix at a time per Method on this computer. A correction that arrives while a fix runs joins it: the running fix
// takes every waiting correction in one more pass before it finishes, and writes the outcome of each correction for
// method wait and the next method run.

const fileMethodId = (file: string) => { const id = (readDocument(file) as any).id; return typeof id === 'string' && methodIdPattern.test(id) ? id : undefined; };

/** Take the Method's lock: a file with this process ID. A lock whose process has stopped is taken over. */
function takeLock(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { writeFileSync(path, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); return true; }
    catch (error: any) { if (error.code !== 'EEXIST') throw error; }
    let pid: number | undefined;
    try { pid = JSON.parse(readFileSync(path, 'utf8')).pid; } catch { /* written now, or gone */ }
    if (pid === undefined) { try { if (Date.now() - statSync(path).mtimeMs < 10_000) return false; } catch { continue; } }
    else { try { process.kill(pid, 0); return false; } catch (error: any) { if (error.code !== 'ESRCH') return false; } }
    rmSync(path, { force: true });
  }
  return false;
}
/** Whether a fix of the Method runs on this computer now. */
export function fixRunning(methodId: string) {
  try { const pid = JSON.parse(readFileSync(join(fixFolder(methodId), 'lock'), 'utf8')).pid; process.kill(pid, 0); return true; } catch { return false; }
}

/** After 5 applied fixes, or when the agent that runs the fixes changed, the loop prunes the Method. */
const pruneEvery = 5;

/**
 * Fix the waiting corrections of a Method file while holding its lock, pass after pass until none waits, so the
 * corrections that arrive during a pass join the next. Each correction's outcome is saved for method wait. After a pass
 * that changed the file, the other cases run (improve.method's background_cases): a failure undoes that change. Then a
 * pruning pass runs when it is due. Returns undefined when another fix of the Method holds the lock.
 */
export async function fixWaiting(client: MethodClient, file: string, options: { run?: RunFile; waitMs?: number; runCases?: RunCases } = {}): Promise<FixOutcome[] | undefined> {
  const methodId = fileMethodId(file);
  if (!methodId || !client.token()) return [];
  const lock = join(fixFolder(methodId), 'lock');
  if (!takeLock(lock)) return undefined;
  const fixes: FixOutcome[] = [], skip = new Set<string>();
  try {
    for (;;) {
      let fix: FixOutcome | undefined;
      try { fix = await fixCorrections(client, file, { ...options, skip }); }
      catch (error: any) {
        for (const id of error.judgments ?? []) saveError(methodId, file, id, error.message, error.log);
        throw error;
      }
      if (!fix) break;
      // A correction given back with again stays "working": the next pass fixes it on the changed file.
      for (const outcome of fix.outcomes) if (!outcome.again) saveOutcome(methodId, file, outcome, fix.log);
      fixes.push(fix);
      if (fix.applied && fix.background_cases.length) {
        const checked = await checkBackground(client, file, fix, options).catch(error => { process.stderr.write(`The later check stopped: ${error.message}\n`); return undefined; });
        for (const id of checked?.reopened ?? []) skip.add(id);
      }
    }
    const { localAgent } = await import('@withmethod/runtime/agents.js');
    const state = readFixState(methodId), agent = (await localAgent().catch(() => undefined)) ?? null;
    // Every 5 corrections that a change answered, the loop prunes the Method.
    const count = state.fixes_since_prune + fixes.filter(f => f.applied).reduce((n, f) => n + f.fixed.length, 0);
    const due = count >= pruneEvery || (!!fixes.length && !!state.agent && !!agent && agent !== state.agent);
    writeFixState(methodId, { fixes_since_prune: due ? 0 : count, agent: fixes.length ? agent : state.agent });
    if (due) await pruneMethod(client, file, options).catch(error => process.stderr.write(`The pruning pass stopped: ${error.message}\n`));
    return fixes;
  } finally { rmSync(lock, { force: true }); }
}

/** Runs cases of a Method file (quality.ts runCases); tests replace it. */
export type RunCases = (file: string, flags: Record<string, never>, options: { ids: string[]; casesDir?: string }) => Promise<{ cases: { id: string; verdict: string }[] }>;

/**
 * The cases among ids that pass on the Method as it was before the change undoId: a copy of the Method's folder with
 * the file and the changed files from the undo record, tested with the Method's own cases. Without the record, every
 * case counts as passing before.
 */
async function passedBefore(file: string, undoId: string | undefined, ids: string[], run: RunCases) {
  const record = undoRecords(file).find(r => r.id === undoId);
  if (!record || !ids.length) return new Set(ids);
  const folder = dirname(resolve(file)), copy = mkdtempSync(join(tmpdir(), 'method-before-'));
  try {
    cpSync(folder, copy, { recursive: true, filter: source => !/^(cases|\.method)(\/|$)/.test(relative(folder, source)) });
    const before = join(copy, basename(file));
    writeFileSync(before, record.before.text);
    for (const [path, content] of Object.entries(record.before.files)) {
      const full = join(copy, packagePath(path));
      if (content === null) rmSync(full, { force: true }); else { mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, Buffer.from(content, 'base64')); }
    }
    const report = await run(before, {}, { ids, casesDir: join(folder, 'cases') });
    return new Set(report.cases.filter(c => c.verdict === 'pass').map(c => c.id));
  } finally { rmSync(copy, { recursive: true, force: true }); }
}

/**
 * The later check of an applied change: the Method's other cases (improve.method's background_cases) run on the changed
 * file. A failing case that belongs to a retired learned rule (its from.case) brings that rule back. Any other case that
 * fails now and passed before the change (a correction that no fix answered yet fails on both) undoes the change, saves the restored file as a new version, and opens the corrections it answered again, so the next
 * method run fixes them anew. Each of these says one line on the next method run or method wait.
 */
export async function checkBackground(client: MethodClient, file: string, fix: Pick<FixOutcome, 'background_cases' | 'undo_id' | 'fixed' | 'cause'>, options: { runCases?: RunCases } = {}) {
  const methodId = fileMethodId(file)!;
  const { listCases } = await import('@withmethod/runtime/cases.js');
  const active = new Set((await listCases(file)).filter((c: any) => c.status === 'active').map((c: any) => c.id as string));
  const ids = fix.background_cases.filter(id => active.has(id));
  const done = { failed: [] as string[], restored: [] as string[], undone: false, reopened: [] as string[] };
  if (!ids.length) return done;
  const run = options.runCases ?? ((await import('./quality.js')).runCases as unknown as RunCases);
  const report = await run(file, {}, { ids });
  done.failed = report.cases.filter(c => c.verdict === 'fail' || c.verdict === 'regression').map(c => c.id);
  if (!done.failed.length) return done;
  const { readLearned, learnedFile, ruleText } = await import('./learned.js');
  const ruleCases = new Set<string>();
  try { for (const rules of Object.values(readLearned(file).steps)) for (const r of rules) if (r.status === 'retired' && r.from?.case) ruleCases.add(r.from.case); } catch { /* no readable learned rules */ }
  const others = done.failed.filter(id => !ruleCases.has(id));
  const passed = await passedBefore(file, fix.undo_id, others, run);
  const broken = others.filter(id => passed.has(id));
  if (broken.length && fix.undo_id) {
    try { undoLast(file, fix.undo_id); done.undone = true; }
    catch (error: any) { process.stderr.write(`The fix broke an earlier result, but it could not be undone: ${error.message}\n`); }
    if (done.undone) {
      await saveVersion(client, file, `Undid a fix that broke an earlier result: ${fix.cause}`.slice(0, 500));
      const answered = fix.fixed.map(f => f.id);
      if (answered.length) {
        try { done.reopened = (await client.request<{ changed: string[] }>(`/api/cli/methods/${encodeURIComponent(methodId)}/judgments/reopen`, 'POST', { ids: answered, detail: 'The fix changed a result that was right before, so it was undone. Method will fix it again.' })).changed; }
        catch (error: any) { process.stderr.write(`The account did not open the corrections again: ${error.message}\n`); }
      }
      for (const f of fix.fixed) saveNotice(methodId, file, 'came_back', fixUndoneLine(f.note ?? undefined));
    }
  }
  // A retired rule whose case fails again comes back (after the undo, which may have restored learned.json).
  const restoredRules: string[] = [];
  const learned = (() => { try { return readLearned(file); } catch { return undefined; } })();
  if (learned) {
    const before = snapshot(file, ['learned.json']);
    for (const rules of Object.values(learned.steps)) for (const rule of rules) {
      if (rule.status !== 'retired' || !rule.from?.case || !done.failed.includes(rule.from.case)) continue;
      Object.assign(rule, { status: 'active', retired_at: null, retired_reason: null });
      done.restored.push(rule.id); restoredRules.push(ruleText(rule));
    }
    if (done.restored.length) {
      writeFileSync(learnedFile(file), JSON.stringify(learned, null, 2) + '\n');
      recordChange(file, 'learned', `Put back ${done.restored.length} learned rule${done.restored.length === 1 ? '' : 's'}`, 'the rules that came back', before);
      await saveVersion(client, file, `Put back learned rules whose problem came back: ${restoredRules.join(' ')}`.slice(0, 500));
      for (const rule of restoredRules) saveNotice(methodId, file, 'came_back', ruleBackLine(rule));
    }
  }
  return done;
}

/**
 * The pruning pass (improve.method with mode prune): it retires learned rules and deletes prompt text that tests show
 * no longer change any result, and reports text that no test covers without deleting it. The change applies at once,
 * with undo; the next method run or method wait shows the sweep's summary line.
 */
export async function pruneMethod(client: MethodClient, file: string, options: { run?: RunFile } = {}) {
  const methodId = fileMethodId(file);
  if (!methodId || !client.token()) return undefined;
  const base = methodContent(readDocument(file));
  const all = await methodJudgments(client, file, methodId);
  const judgments: ImproveJudgment[] = all.map(j => ({ id: j.id, run_id: j.run_id, ...(j.run_dir ? { run_dir: j.run_dir } : {}), step_id: j.step_id, verdict: j.verdict, note: j.note,
    ...(existsSync(join(dirname(file), 'cases', correctionCaseId(j.id), 'case.json')) ? { case_id: correctionCaseId(j.id) } : {}), source: j.source, created_at: j.created_at,
    ...(j.noted_by ? { noted_by: j.noted_by } : {}) }));
  const improved = await runImprovement(client, file, judgments, (await localRuns(file)).map(r => r.dir), options.run, 'prune');
  const { prunedLine } = await import('./fix-lines.js');
  if (improved.evidence.kind !== 'change') {
    // Nothing removed; the summary can still say which instructions nothing checks.
    if (improved.summary) saveNotice(methodId, file, 'prune', improved.summary);
    return { changed: false };
  }
  if (!isDeepStrictEqual(methodContent(readDocument(file)), base)) return { changed: false };
  const before = snapshot(file, improved.files.map(f => f.path));
  applyChange(file, methodId, improved);
  recordChange(file, 'prune', improved.cause, 'the cleanup of rules and instructions that no longer changed any result', before);
  await saveVersion(client, file, `Method removed what no longer changed any result: ${improved.cause}`.slice(0, 500));
  if (improved.summary) saveNotice(methodId, file, 'prune', prunedLine(improved.summary));
  return { changed: true };
}

/**
 * Fix the Method for one correction: run the fix, or, when a fix of the Method already runs on this computer, wait for
 * the fix that takes this correction. Returns the stored outcome, or undefined when no fix here took it.
 */
export async function fixCorrection(client: MethodClient, file: string, judgmentId: string, options: { run?: RunFile; pollMs?: number } = {}) {
  const methodId = fileMethodId(file);
  if (!methodId || !client.token()) return undefined;
  const done = () => { const record = storedOutcome(methodId, judgmentId); return record && record.status !== 'working' ? record : undefined; };
  for (;;) {
    const saved = done();
    if (saved) return saved;
    const ran = await fixWaiting(client, file, options);
    if (ran) return done();
    await new Promise(wait => setTimeout(wait, options.pollMs ?? 500));
  }
}

/**
 * `method __fix FILE --judgment ID... [--prune]`: the fix of method judge, method answer and method run, in its own
 * process. Every correction it was started for ends with a stored outcome or error.
 */
export async function backgroundFix(client: MethodClient, file: string, ids: string[], options: { run?: RunFile; prune?: boolean; pollMs?: number } = {}) {
  const methodId = fileMethodId(file);
  if (!methodId) return;
  setWorker(methodId, ids, process.pid);
  if (options.prune) {
    const lock = join(fixFolder(methodId), 'lock');
    while (!takeLock(lock)) await new Promise(wait => setTimeout(wait, options.pollMs ?? 500));
    try { await pruneMethod(client, file, options); } finally { rmSync(lock, { force: true }); }
  }
  for (const id of ids) {
    try { if (!await fixCorrection(client, file, id, options)) saveOutcome(methodId, file, { id, outcome: 'elsewhere' }); }
    catch (error: any) { if (storedOutcome(methodId, id)?.status === 'working') saveError(methodId, file, id, error.message, error.log); }
  }
}

/** Send what the loop did with each correction, with the reason or the question. */
async function reportOutcomes(client: MethodClient, methodId: string, outcomes: CorrectionOutcome[]) {
  if (!outcomes.length) return;
  try {
    await client.request(`/api/cli/methods/${encodeURIComponent(methodId)}/judgments/outcomes`, 'POST', { outcomes: outcomes.map(o => {
      const detail = o.outcome === 'held' ? [o.by ?? 'Someone', o.detail].filter(Boolean).join(': ') : o.outcome === 'already_changed' ? (o.by ? `${o.by} changed it after this run.` : undefined) : o.summary ?? o.detail;
      return { id: o.id, outcome: o.outcome, ...(o.outcome === 'could_not_test' && o.reason ? { reason: o.reason } : {}), ...(o.outcome === 'question' && o.question ? { question: o.question.slice(0, 1000) } : {}),
        ...(detail?.trim() ? { detail: detail.trim().slice(0, 500) } : {}) };
    }) });
  } catch (error: any) { process.stderr.write(`The account did not record what happened to the corrections: ${error.message}\n`); }
}

/** The version that a judged run ran: from its run folder here, else from its account record. */
async function runVersion(client: MethodClient, j: { run_id: string; run_dir?: string | undefined }) {
  if (j.run_dir) { try { const sync = JSON.parse(readFileSync(join(j.run_dir, 'method-sync.json'), 'utf8')); if (typeof sync.version_id === 'string') return sync.version_id as string; } catch { /* no account link */ } }
  try { return (await client.request<{ run: { workflow_version_id?: string } }>(`/api/workspace/runs/${encodeURIComponent(j.run_id)}`)).run?.workflow_version_id; } catch { return undefined; }
}
/**
 * The corrections of a step whose text in the run's version differs from the file: outcome already_changed, with the
 * person who saved the newest version when that version has the file's text of the step.
 */
async function changedSinceRun(client: MethodClient, methodId: string, judgments: Array<AccountJudgment & { run_dir?: string | undefined }>, current: any) {
  const changed: CorrectionOutcome[] = [], versions = new Map<string, Promise<any>>();
  let file: any;
  try { file = loadWorkflow(current); } catch { return changed; }
  const saved = (version?: string) => {
    const key = version ?? '';
    if (!versions.has(key)) versions.set(key, client.request<any>(`/api/cli/methods/${encodeURIComponent(methodId)}${version ? `?version=${encodeURIComponent(version)}` : ''}`).catch(() => undefined));
    return versions.get(key)!;
  };
  for (const j of judgments) {
    if (!j.step_id || !Object.hasOwn(file.steps ?? {}, j.step_id)) continue;
    const version = await runVersion(client, j), ran = version ? await saved(version) : undefined;
    if (!ran?.workflow?.steps || isDeepStrictEqual(ran.workflow.steps[j.step_id], file.steps[j.step_id])) continue;
    const newest = await saved();
    const by = newest?.saved_by && isDeepStrictEqual(newest.workflow?.steps?.[j.step_id], file.steps[j.step_id]) ? newest.saved_by as string : undefined;
    changed.push({ id: j.id, outcome: 'already_changed', ...(by ? { by } : {}) });
  }
  return changed;
}

/**
 * The corrections whose tested change breaks a case that another person made (a case that passed before and fails
 * after), with the other person and what they asked for. A case or a correction with no name is not held.
 */
function heldBy(file: string, fresh: AccountJudgment[], evidence: any): CorrectionOutcome[] {
  const broken = (Array.isArray(evidence?.cases) ? evidence.cases : []).filter((c: any) => !c.target && c.before === 'pass' && c.after !== 'pass').map((c: any) => {
    try { const made = JSON.parse(readFileSync(join(dirname(file), 'cases', c.id, 'case.json'), 'utf8')); return { author: made.author as string | null, note: String(made.note ?? '') }; }
    catch { return undefined; }
  }).filter((c: any) => c?.author);
  return fresh.flatMap(j => {
    const other = j.noted_by ? broken.find((c: any) => c.author !== j.noted_by) : undefined;
    return other ? [{ id: j.id, outcome: 'held' as const, by: other.author!, detail: other.note.slice(0, 200) }] : [];
  });
}

/** Write the tested change: the Method content (its id: line kept) and the changed package files (a script, learned.json). */
function applyChange(file: string, methodId: string, improved: ImproveProposal) {
  const before = methodContent(readDocument(file));
  if (improved.workflow) { loadWorkflow(improved.workflow); if (!isDeepStrictEqual(improved.workflow, before)) writeMethodFile(file, methodId, improved.workflow); }
  const folder = dirname(resolve(file));
  for (const changed of improved.files) {
    const path = resolve(folder, packagePath(changed.path));
    if (!path.startsWith(folder + sep)) throw Error(`The change names a file outside the Method folder: ${changed.path}`);
    const bytes = Buffer.from(changed.content_base64, 'base64');
    if (fileHash(bytes) !== changed.sha256) throw Error(`The changed file ${changed.path} does not match its sha256.`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  return improved.workflow ? changedSteps(before, improved.workflow) : [];
}
