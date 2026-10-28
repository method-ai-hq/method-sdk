import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { packagePath } from '../../contracts/src/method-package.js';
import { loadWorkflow, parseDocumentValue } from '../../workflow-language/src/validate.js';
import { readDocument } from './authoring.js';
import type { MethodClient } from './method-client.js';
import { writePrivateJson } from './files.js';
import { currentVersion, methodContent, methodIdPattern } from './versions.js';
import { saveLocalProposal, writeMethodFile } from './proposals.js';
import { changedSteps } from './merge.js';
import { localJudgments, runFolderIndex, type LocalJudgment } from './local-judgments.js';
import type { CorrectionOutcome } from './fix-lines.js';
import { fixFolder, markWorking, saveError, saveOutcome, storedOutcome } from './fix-outcomes.js';
import { recordChange, saveVersion, snapshot } from './undo.js';
import { learnCorrection, writtenFile, type CaseRunner, type LearnerModel, type Learned } from './learner.js';

// The fix loop on this computer. method judge starts it in its own process for a wrong judgment, and method run starts
// it for corrections that wait (from the dashboard, an answer, or a fix that stopped). Each correction goes to Method's
// learner (learner.ts): one agent session on the person's own Claude Code or Codex, checked by a gate in code. A tested
// change is applied to the Method's folder, saved as a new version, and recorded with its correction, its summary and
// its diff; method undo restores the folder as it was before.

type AccountJudgment = { id: string; run_id: string; step_id: string | null; verdict: 'right' | 'wrong'; note: string | null; corrected: unknown; source: string; created_at: string; pending: boolean;
  noted_by?: string | null; outcome?: string | null; outcome_detail?: string | null; handled_by?: string | null; held_with?: string | null; question?: string | null; answer?: string | null };
export type { CorrectionOutcome };
/** What one pass of the loop did: the outcome of each correction it took, and how many changes it applied. */
export type FixOutcome = { file: string; judgments: string[]; outcomes: CorrectionOutcome[]; applied: number; log: string };

export { ownAgentModel } from './quality.js';
import { ownAgentModel } from './quality.js';

/** The ID of the check (case) that a correction makes: one per judgment, so a later fix finds it. */
export const correctionCaseId = (judgmentId: string) => `correction-${judgmentId.replace(/^jdg_/, '').slice(0, 12)}`;

/**
 * The agent of the learner: the model and effort of the Method's own agent steps (Claude Code or Codex), so a fix
 * thinks as well as the agent; else the person's own agent on its default model.
 */
export async function learnerModel(document: any): Promise<LearnerModel> {
  const own = await ownAgentModel(document);
  if (own) return { agent: own.backend, model: own.model, ...(own.reasoning_effort ? { reasoning_effort: own.reasoning_effort } : {}) };
  const { localAgent } = await import('@withmethod/runtime/agents.js');
  return { agent: (await localAgent()) === 'codex' ? 'codex' : 'claude' };
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
 * gives back those it did not decide when it stops. The corrections go to the learner one at a time, oldest first, so
 * each one learns on the Method that the one before it left. A usage limit or another failure of the agent is a plain
 * error.
 */
export async function fixCorrections(client: MethodClient, file: string, options: { runCases?: CaseRunner; waitMs?: number } = {}): Promise<FixOutcome | undefined> {
  const document = readDocument(file) as any;
  const methodId = typeof document.id === 'string' && methodIdPattern.test(document.id) ? document.id : undefined;
  if (!methodId || !client.token()) return undefined;
  const all = await methodJudgments(client, file, methodId, options.waitMs);
  // What an earlier fix here took and could not give back or report: the report is sent now, and a correction that it
  // did not decide is this fix's again. The account shows each as taken, with no outcome.
  const left = takenHere(methodId), mine = all.filter(j => j.id in left && j.verdict === 'wrong' && !j.pending && !j.outcome);
  const unsent = mine.flatMap(j => left[j.id] ? [left[j.id]!] : []), kept = mine.filter(j => !left[j.id]);
  saveTaken(methodId, Object.fromEntries(mine.map(j => [j.id, left[j.id] ?? null])));
  if (unsent.length && await reportOutcomes(client, methodId, unsent)) saveTaken(methodId, Object.fromEntries(kept.map(j => [j.id, null])));
  const waiting = all.filter(j => j.pending && j.verdict === 'wrong');
  if (!waiting.length && !kept.length) return undefined;
  const handled = (ids: string[], value: boolean) => client.request<{ changed: string[] }>(`/api/cli/methods/${encodeURIComponent(methodId)}/judgments/handled`, 'POST', { ids, handled: value });
  const taken = new Set([...kept.map(j => j.id), ...waiting.length ? (await handled(waiting.map(j => j.id), true)).changed : []]);
  const claimed = [...kept, ...waiting].filter(j => taken.has(j.id)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (!claimed.length) return undefined;
  // Until the account has each one back or has its outcome, this computer keeps it.
  saveTaken(methodId, { ...takenHere(methodId), ...Object.fromEntries([...taken].map(id => [id, null])) });
  // Give corrections back to the account; those it did not get stay taken here, and the next fix takes them again.
  const giveBack = async (ids: string[]) => {
    if (!ids.length) return;
    try { await handled(ids, false); } catch { return; }
    saveTaken(methodId, Object.fromEntries(Object.entries(takenHere(methodId)).filter(([id]) => !ids.includes(id))));
  };
  // Send outcomes to the account; those it did not get are sent by the next fix.
  const report = async (decided: CorrectionOutcome[]) => {
    const sent = await reportOutcomes(client, methodId, decided);
    saveTaken(methodId, Object.fromEntries(Object.entries(takenHere(methodId)).flatMap(([id, o]) => {
      const outcome = decided.find(d => d.id === id);
      return !outcome ? [[id, o]] : sent ? [] : [[id, outcome]];
    })));
  };
  const outcomes: CorrectionOutcome[] = [];
  let applied = 0, log = '';
  try {
    // A correction of a step whose text changed since its run is not fixed: the change may already answer it.
    outcomes.push(...await changedSinceRun(client, methodId, claimed, methodContent(document)));
    const fresh = claimed.filter(j => !outcomes.some(c => c.id === j.id));
    if (fresh.length) process.stderr.write(`Testing fixes for ${fresh.length} correction${fresh.length === 1 ? '' : 's'} of ${file}.\n`);
    const runCases = options.runCases ?? ((await import('./quality.js')).runCases as unknown as CaseRunner);
    for (const j of fresh) {
      if (!j.run_dir) { outcomes.push({ id: j.id, outcome: 'could_not_test', reason: 'missing_file', detail: 'The run is not on this computer.' }); continue; }
      const base = methodContent(readDocument(file));
      const earlier = all.filter(e => e.verdict === 'wrong' && e.id !== j.id && e.created_at <= j.created_at)
        .map(e => ({ id: e.id, note: e.note, noted_by: e.noted_by ?? null, created_at: e.created_at, outcome: outcomes.find(o => o.id === e.id)?.outcome ?? e.outcome ?? null, detail: e.outcome_detail ?? null, answer: e.answer ?? null }));
      const learned = await learnCorrection(file, { id: j.id, run_dir: j.run_dir, note: j.note, corrected: j.corrected, noted_by: j.noted_by ?? null, created_at: j.created_at, question: j.question ?? null, answer: j.answer ?? null },
        { earlier, caseId: correctionCaseId(j.id), model: await learnerModel(readDocument(file)), workDir: join(fixFolder(methodId), 'learn', j.id.replace(/[^A-Za-z0-9_-]/g, '_')), runCases });
      log = learned.log;
      if (learned.outcome.outcome === 'fixed' || learned.outcome.outcome === 'no_change_needed') {
        // The file must be the one the learner started from; a change made meanwhile is not overwritten.
        if (!isDeepStrictEqual(methodContent(readDocument(file)), base)) { outcomes.push({ id: j.id, outcome: 'retry' }); continue; }
        const change = await applyLearned(client, file, methodId, j, learned);
        if (change) applied++;
      }
      outcomes.push(learned.outcome);
      cleanRoom(learned);
    }
    await giveBack(outcomes.filter(o => o.outcome === 'retry').map(o => o.id));
    await report(outcomes.filter(o => o.outcome !== 'retry' && o.outcome !== 'elsewhere'));
    return { file, judgments: claimed.map(j => j.id), outcomes, applied, log };
  } catch (error) {
    // Stopped before it decided them (or with one to fix again): those corrections wait for the next loop; the decided
    // ones keep their outcome.
    const undecided = [...taken].filter(id => !outcomes.some(o => o.id === id && o.outcome !== 'retry'));
    await giveBack(undecided);
    await report(outcomes.filter(o => o.outcome !== 'retry'));
    for (const outcome of outcomes) if (outcome.outcome !== 'retry') saveOutcome(methodId, file, outcome, log);
    throw Object.assign(error instanceof Error ? error : Error(String(error)), { judgments: undecided, ...(log ? { log } : {}) });
  }
}

/**
 * The corrections that this computer took from the account and has not given back or reported yet: null for one it
 * has not decided, else its outcome. fixes/<methodId>/taken.json.
 */
function takenHere(methodId: string): Record<string, CorrectionOutcome | null> {
  try { return JSON.parse(readFileSync(join(fixFolder(methodId), 'taken.json'), 'utf8')); } catch { return {}; }
}
function saveTaken(methodId: string, taken: Record<string, CorrectionOutcome | null>) {
  const path = join(fixFolder(methodId), 'taken.json');
  if (!Object.keys(taken).length) { rmSync(path, { force: true }); return; }
  mkdirSync(fixFolder(methodId), { recursive: true, mode: 0o700 });
  writePrivateJson(path, taken);
}

/** Remove the learner's copies of the Method; its tries (sessions, transcripts and gate failures) stay for the log. */
function cleanRoom(learned: Learned) {
  for (const dir of [learned.room, learned.base]) if (dir) rmSync(dir, { recursive: true, force: true });
}

/**
 * Apply what the learner left in its room. fixed: every changed file of the Method, its new check and the record of
 * the words Method wrote, with an undo record, a new version, and a local record of the change with its correction,
 * summary and diff. no_change_needed: only the new check, so later changes keep it. Returns whether the Method changed.
 */
async function applyLearned(client: MethodClient, file: string, methodId: string, j: AccountJudgment, learned: Learned) {
  const folder = dirname(resolve(file)), name = basename(file);
  const inFolder = (path: string) => { const full = resolve(folder, packagePath(path)); if (!full.startsWith(folder + sep)) throw Error(`The change names a file outside the Method folder: ${path}`); return full; };
  const copy = (path: string) => {
    const from = join(learned.room!, path), to = inFolder(path);
    if (existsSync(from) && statSync(from).isFile()) { mkdirSync(dirname(to), { recursive: true }); cpSync(from, to); } else rmSync(to, { force: true });
  };
  if (learned.outcome.outcome === 'no_change_needed') { for (const path of learned.changed) copy(path); return false; }
  const before = snapshot(file, [...learned.changed.filter(p => p !== name), '.method/written.json']);
  const baseWorkflow = methodContent(readDocument(file));
  const content = methodContent(parseDocumentValue(readFileSync(join(learned.room!, name), 'utf8')) as any);
  loadWorkflow(content);
  for (const path of learned.changed) if (path !== name) copy(path);
  if (!isDeepStrictEqual(content, baseWorkflow)) writeMethodFile(file, methodId, content);
  writePrivateJson(writtenFile(folder), learned.written);
  const summary = learned.outcome.summary ?? 'Method changed the agent from a correction.';
  recordChange(file, 'fix', summary, j.note?.trim() ? `the fix for "${j.note.trim().slice(0, 300)}"` : 'the last fix', before);
  const baseVersion = await currentVersion(file).catch(() => undefined);
  const version = await saveVersion(client, file, `Method fixed it from a correction: ${summary}`.slice(0, 500));
  saveLocalProposal(file, { id: `lp_${randomBytes(8).toString('hex')}`, method_id: methodId, base_version_id: baseVersion?.version_id ?? null, status: 'applied', cause: summary,
    evidence: { kind: 'change', steps: changedSteps(baseWorkflow, content), judgment: j.id, note: j.note, summary, diff: learned.diff, files: learned.changed, tries: learned.tries },
    created_at: new Date().toISOString(), applied_at: new Date().toISOString(), base_workflow: baseWorkflow, proposed_workflow: content, judgments: [j.id], outcomes: [learned.outcome],
    ...(version ? { applied_version_id: version.version_id } : {}) });
  return true;
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

/**
 * Fix the waiting corrections of a Method file while holding its lock, pass after pass until none waits, so the
 * corrections that arrive during a pass join the next. Each correction's outcome is saved for method wait. Returns
 * undefined when another fix of the Method holds the lock.
 */
export async function fixWaiting(client: MethodClient, file: string, options: { runCases?: CaseRunner; waitMs?: number } = {}): Promise<FixOutcome[] | undefined> {
  const methodId = fileMethodId(file);
  if (!methodId || !client.token()) return [];
  const lock = join(fixFolder(methodId), 'lock');
  if (!takeLock(lock)) return undefined;
  const fixes: FixOutcome[] = [];
  try {
    for (;;) {
      let fix: FixOutcome | undefined;
      try { fix = await fixCorrections(client, file, options); }
      catch (error: any) {
        for (const id of error.judgments ?? []) saveError(methodId, file, id, error.message, error.log);
        throw error;
      }
      if (!fix) break;
      for (const outcome of fix.outcomes) if (outcome.outcome !== 'retry') saveOutcome(methodId, file, outcome, fix.log);
      fixes.push(fix);
    }
    return fixes;
  } finally { rmSync(lock, { force: true }); }
}

/**
 * Fix the Method for one correction: run the fix, or, when a fix of the Method already runs on this computer, wait for
 * the fix that takes this correction. Returns the stored outcome, or undefined when no fix here took it.
 */
export async function fixCorrection(client: MethodClient, file: string, judgmentId: string, options: { runCases?: CaseRunner; pollMs?: number } = {}) {
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
 * `method __fix FILE --judgment ID...`: the fix of method judge, method answer and method run, in its own process.
 * Every correction it was started for ends with a stored outcome or error.
 */
export async function backgroundFix(client: MethodClient, file: string, ids: string[], options: { runCases?: CaseRunner; pollMs?: number } = {}) {
  const methodId = fileMethodId(file);
  if (!methodId) return;
  // The corrections it was started for wait for it, also when it is started again for a correction that stopped.
  markWorking(methodId, file, ids, process.pid);
  for (const id of ids) {
    try { if (!await fixCorrection(client, file, id, options)) saveOutcome(methodId, file, { id, outcome: 'elsewhere' }); }
    catch (error: any) { if (storedOutcome(methodId, id)?.status === 'working') saveError(methodId, file, id, error.message, error.log); }
  }
}

/** Send what the loop did with each correction, with the reason or the question. Returns whether the account got it. */
async function reportOutcomes(client: MethodClient, methodId: string, outcomes: CorrectionOutcome[]) {
  if (!outcomes.length) return true;
  try {
    await client.request(`/api/cli/methods/${encodeURIComponent(methodId)}/judgments/outcomes`, 'POST', { outcomes: outcomes.map(o => {
      const detail = o.outcome === 'held' ? [o.by ?? 'Someone', o.detail].filter(Boolean).join(': ') : o.outcome === 'already_changed' ? (o.by ? `${o.by} changed it after this run.` : undefined) : o.summary ?? o.detail;
      return { id: o.id, outcome: o.outcome, ...(o.outcome === 'could_not_test' && o.reason ? { reason: o.reason } : {}), ...(o.outcome === 'question' && o.question ? { question: o.question.slice(0, 1000) } : {}),
        ...(detail?.trim() ? { detail: detail.trim().slice(0, 500) } : {}) };
    }) });
    return true;
  } catch (error: any) { process.stderr.write(`The account did not record what happened to the corrections: ${error.message}. The next fix sends it again.\n`); return false; }
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
