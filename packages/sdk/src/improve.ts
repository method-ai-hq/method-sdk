import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { packagePath } from '../../contracts/src/method-package.js';
import { loadWorkflow, parseDocumentValue } from '../../workflow-language/src/validate.js';
import { readDocument } from './authoring.js';
import type { MethodClient } from './method-client.js';
import { removeTree, writePrivateJson } from './files.js';
import { currentVersion, methodContent, methodIdPattern } from './versions.js';
import { localProposals, saveLocalProposal, writeMethodFile } from './proposals.js';
import { changedSteps } from './merge.js';
import { localJudgments, localMethodFolder, runFolderIndex, type LocalJudgment } from './local-judgments.js';
import type { CorrectionOutcome } from './fix-lines.js';
import { conflictQuestion } from './fix-lines.js';
import { fixFolder, markWorking, saveError, saveNotice, saveOutcome, storedOutcome } from './fix-outcomes.js';
import { recordChange, restoreSnapshot, saveVersion, snapshot } from './undo.js';
import { learnCorrection, writtenFile, type CaseRunner, type LearnerModel, type Learned } from './learner.js';

// The fix loop on this computer. method judge starts it in its own process for a wrong judgment, and method run starts
// it for corrections that wait (from the dashboard, an answer, or a fix that stopped). Each correction goes to Method's
// learner (learner.ts): one agent session on the person's own Claude Code or Codex, checked by a gate in code; the
// corrections that wait together go to one session. A tested change is applied to the Method's folder, saved as a new
// version, and recorded with its corrections, its summary and its diff; method undo restores the folder as it was
// before.

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
export async function methodJudgments(client: MethodClient, file: string, methodId: string, waitMs?: number) {
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
 * gives back those it did not decide when it stops. The corrections go to the learner together, in one session; when
 * they find no change together, each half goes again, oldest first, so each one learns on the Method that the one
 * before it left. Each outcome is saved for method wait when it is decided. A usage limit or another failure of the
 * agent is a plain error.
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
  // An outcome is saved for method wait as soon as it is decided.
  const decide = (decided: CorrectionOutcome[]) => { for (const o of decided) { outcomes.push(o); if (o.outcome !== 'retry') saveOutcome(methodId, file, o, log); } };
  try {
    restoreUnfinished(file);
    // A fix of a correction that ended here and saved its change: its outcome stands, and it does not run again.
    for (const j of claimed) {
      const ended = endedFix(file, j.id);
      if (!ended) continue;
      const { path: _path, source: _source, file: _file, ...record } = ended;
      if (!record.applied_version_id) await saveFixVersion(client, file, record);
      decide([record.outcomes.find((o: CorrectionOutcome) => o.id === j.id)]);
    }
    // A correction of a step whose text changed since its run is not fixed: the change may already answer it.
    decide(await changedSinceRun(client, methodId, claimed.filter(j => !outcomes.some(c => c.id === j.id)), methodContent(readDocument(file))));
    const fresh = claimed.filter(j => !outcomes.some(c => c.id === j.id));
    if (fresh.length) process.stderr.write(`Testing fixes for ${fresh.length} correction${fresh.length === 1 ? '' : 's'} of ${file}.\n`);
    const runCases = options.runCases ?? ((await import('./quality.js')).runCases as unknown as CaseRunner);
    decide(fresh.filter(j => !j.run_dir).map(j => ({ id: j.id, outcome: 'could_not_test', reason: 'missing_file', detail: 'The run is not on this computer.' })));
    const ready = fresh.filter(j => j.run_dir);
    // The corrections that wait go together.
    const batches: (typeof ready)[] = ready.length ? [ready] : [];
    while (batches.length) {
      const batch = batches.shift()!;
      const base = methodContent(readDocument(file)), ids = new Set(batch.map(j => j.id)), newest = batch.at(-1)!.created_at;
      const earlier = all.filter(e => e.verdict === 'wrong' && !ids.has(e.id) && e.created_at <= newest)
        .map(e => ({ id: e.id, note: e.note, noted_by: e.noted_by ?? null, created_at: e.created_at, outcome: outcomes.find(o => o.id === e.id)?.outcome ?? e.outcome ?? null, detail: e.outcome_detail ?? null, answer: e.answer ?? null }));
      const learned = await learnCorrection(file, batch.map(j => ({ id: j.id, run_dir: j.run_dir!, note: j.note, corrected: j.corrected, noted_by: j.noted_by ?? null, created_at: j.created_at, question: j.question ?? null, answer: j.answer ?? null })),
        { earlier, caseIds: batch.map(j => correctionCaseId(j.id)), model: await learnerModel(readDocument(file)), workDir: join(fixFolder(methodId), 'learn', batch[0]!.id.replace(/[^A-Za-z0-9_-]/g, '_')), runCases });
      log = learned.log;
      if (learned.split) { cleanRoom(learned); const half = Math.ceil(batch.length / 2); batches.unshift(batch.slice(0, half), batch.slice(half)); continue; }
      if (learned.outcomes.some(o => o.outcome === 'fixed' || o.outcome === 'no_change_needed')) {
        // The file must be the one the learner started from; a change made meanwhile is not overwritten.
        if (!isDeepStrictEqual(methodContent(readDocument(file)), base)) { decide(batch.map(j => ({ id: j.id, outcome: 'retry' }))); cleanRoom(learned); continue; }
        if (await applyLearned(client, file, methodId, batch, learned)) { applied++; countFix(file); }
      }
      decide(learned.outcomes);
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
  for (const dir of [learned.room, learned.base]) if (dir) removeTree(dir);
}

/**
 * Apply what the learner left in its room. fixed: every changed file of the Method, its new checks and the record of
 * the words Method wrote, with an undo record, a new version, and a local record of the change with its corrections,
 * summary and diff. no_change_needed alone: only the new checks, so later changes keep them. Returns true when the
 * Method changed.
 */
async function applyLearned(client: MethodClient, file: string, methodId: string, batch: AccountJudgment[], learned: Learned) {
  const folder = dirname(resolve(file)), name = basename(file);
  const inFolder = (path: string) => { const full = resolve(folder, packagePath(path)); if (!full.startsWith(folder + sep)) throw Error(`The change names a file outside the Method folder: ${path}`); return full; };
  const copy = (path: string) => {
    const from = join(learned.room!, path), to = inFolder(path);
    if (existsSync(from) && statSync(from).isFile()) { mkdirSync(dirname(to), { recursive: true }); cpSync(from, to); } else rmSync(to, { force: true });
  };
  const fixed = learned.outcomes.filter(o => o.outcome === 'fixed');
  if (!fixed.length) { for (const path of learned.changed) copy(path); return false; }
  const before = snapshot(file, [...learned.changed.filter(p => p !== name), '.method/written.json']);
  const baseWorkflow = methodContent(readDocument(file));
  const content = methodContent(parseDocumentValue(readFileSync(join(learned.room!, name), 'utf8')) as any);
  loadWorkflow(content);
  const baseVersion = await currentVersion(file).catch(() => undefined);
  // Until the change and its record are written, the folder can go back to this snapshot (restoreUnfinished).
  localMethodFolder(file);
  writePrivateJson(unfinishedPath(file), { judgments: batch.map(j => j.id), before });
  for (const path of learned.changed) if (path !== name) copy(path);
  if (!isDeepStrictEqual(content, baseWorkflow)) writeMethodFile(file, methodId, content);
  writePrivateJson(writtenFile(folder), learned.written);
  const summary = fixed.map(o => o.summary?.trim()).filter(Boolean).join(' ') || 'Method changed the agent from a correction.';
  const notes = batch.filter(j => fixed.some(o => o.id === j.id)).map(j => j.note?.trim()).filter((n): n is string => !!n);
  const undo = recordChange(file, 'fix', summary, notes.length ? `the fix for ${notes.map(n => `"${n.slice(0, 300)}"`).join(' and ')}` : 'the last fix', before);
  // The fix has ended when its change is recorded with its outcomes: a later fix of these corrections takes this record.
  const j = batch[0]!;
  const record = { id: `lp_${randomBytes(8).toString('hex')}`, method_id: methodId, base_version_id: baseVersion?.version_id ?? null, status: 'applied', cause: summary,
    evidence: { kind: 'change', steps: changedSteps(baseWorkflow, content), judgment: j.id, ...(batch.length > 1 ? { judgments: batch.map(b => b.id) } : {}), note: j.note, summary, diff: learned.diff, files: learned.changed, tries: learned.tries },
    created_at: new Date().toISOString(), applied_at: new Date().toISOString(), base_workflow: baseWorkflow, proposed_workflow: content, judgments: batch.map(b => b.id), outcomes: learned.outcomes,
    undo_id: undo.id };
  saveLocalProposal(file, record);
  rmSync(unfinishedPath(file), { force: true });
  await saveFixVersion(client, file, record);
  return true;
}
/** Save the version of a recorded change and keep its ID in the record. Nothing when the version cannot be saved now. */
async function saveFixVersion(client: MethodClient, file: string, record: any) {
  const version = await saveVersion(client, file, `Method fixed it from a correction: ${record.cause}`.slice(0, 500));
  if (version) saveLocalProposal(file, { ...record, applied_version_id: version.version_id });
}

// A fix stops in one of two places. Before its change is recorded (unfinished.json), the folder goes back to the snapshot
// and the correction is fixed again. After it, the change stays and its recorded outcome is the correction's outcome:
// the same correction is never applied twice.
const unfinishedPath = (file: string) => join(dirname(resolve(file)), '.method', 'fix-unfinished.json');
/** Put the folder back as it was before a change that a stopped fix did not finish writing. */
function restoreUnfinished(file: string) {
  let unfinished: any;
  try { unfinished = JSON.parse(readFileSync(unfinishedPath(file), 'utf8')); } catch { return; }
  if (unfinished?.before) restoreSnapshot(file, unfinished.before);
  rmSync(unfinishedPath(file), { force: true });
}
/** The recorded change of a fix of this correction that ended on this computer, or undefined. */
function endedFix(file: string, judgmentId: string) {
  return localProposals(file).find((p: any) => p.status === 'applied' && Array.isArray(p.judgments) && p.judgments.includes(judgmentId) && p.outcomes?.some((o: any) => o.id === judgmentId)) as any;
}

// One fix at a time per Method on this computer. A correction that arrives while a fix runs joins it: the running fix
// takes every waiting correction in one more pass before it finishes, and writes the outcome of each correction for
// method wait and the next method run.

const fileMethodId = (file: string) => { const id = (readDocument(file) as any).id; return typeof id === 'string' && methodIdPattern.test(id) ? id : undefined; };

/** Take the Method's lock: a file with this process ID. A lock whose process has stopped is taken over. */
export function takeLock(path: string) {
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
 * corrections that arrive during a pass join the next. Each correction's outcome is saved for method wait when the
 * pass decides it. Returns
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
      fixes.push(fix);
    }
    if (fixes.some(f => f.applied)) await afterFixes(client, file, methodId, options);
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
        // The account keeps a conflict as the question it is, so the person's answer (method answer) reaches the next fix.
        ...(o.outcome === 'conflict' ? { outcome: 'question', question: `${conflictQuestion(o).replace(/^./, c => c.toUpperCase())}`.slice(0, 1000) } : {}),
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

// ---------- The full check and the redesign at set points ----------
//
// Each fix tests its new check, the earlier checks most related to its change and a few more at random (learner.ts
// chooseEarlier). Every FULL_EVERY applied fixes, and before a comparison's checkpoint, the full check tests every
// earlier check. A check that passed at the last full check (or was saved since) and fails now goes back to the learner
// as a correction, in the words of its own correction, and its repair is tested on every earlier check. So every
// earlier correction holds at each full check, unless the learner found no repair (then Method says which one), and a
// break is found within FULL_EVERY fixes. When REDESIGN_EVERY more checks were saved since the last redesign, the fix
// loop tries a redesign that is kept only when it passes the held-back checks (redesign.ts).

/** Applied fixes between two full checks of every earlier check. */
export const FULL_EVERY = 5;
/** Saved checks between two redesigns that the fix loop tries. */
export const REDESIGN_EVERY = 8;

/** The fix loop's count, in .method/checks.json: applied fixes since the last full check, the checks that it found broken and could not repair, and the number of checks at the last redesign. */
type CheckState = { format: 'method-checks/1'; fixes: number; broken: string[]; redesigned_at: number };
const checksFile = (file: string) => join(dirname(resolve(file)), '.method', 'checks.json');
export function readChecks(file: string): CheckState {
  try { const v = JSON.parse(readFileSync(checksFile(file), 'utf8')); if (v?.format === 'method-checks/1') return { format: v.format, fixes: Number(v.fixes) || 0, broken: Array.isArray(v.broken) ? v.broken : [], redesigned_at: Number(v.redesigned_at) || 0 }; } catch { /* none yet */ }
  return { format: 'method-checks/1', fixes: 0, broken: [], redesigned_at: 0 };
}
const writeChecks = (file: string, state: CheckState) => { localMethodFolder(file); writePrivateJson(checksFile(file), state); };
function countFix(file: string) { const state = readChecks(file); writeChecks(file, { ...state, fixes: state.fixes + 1 }); }

/** The active checks of a Method, oldest first. */
export async function activeChecks(file: string) {
  const { listCases } = await import('@withmethod/runtime/cases.js');
  return (await listCases(file)).filter((c: any) => c.status === 'active').sort((a: any, b: any) => String(a.created ?? '').localeCompare(String(b.created ?? '')) || a.id.localeCompare(b.id)) as any[];
}

/** The fix loop tries its next redesign when REDESIGN_EVERY more checks are saved than now. */
export async function markRedesigned(file: string) { writeChecks(file, { ...readChecks(file), redesigned_at: (await activeChecks(file)).length }); }

/** What a full check found: how many checks it tested, which broke since the last one, and which of those the learner repaired. */
export type FullCheck = { checked: number; broke: string[]; repaired: string[]; still: string[]; line: string };

/**
 * Test every earlier check of a Method, and give each one that broke since the last full check to the learner as a
 * correction. Holds no lock itself: the caller holds the Method's fix lock.
 */
export async function fullCheck(client: MethodClient, file: string, methodId: string, options: { runCases?: CaseRunner } = {}): Promise<FullCheck> {
  const runCases = options.runCases ?? ((await import('./quality.js')).runCases as unknown as CaseRunner);
  const state = readChecks(file), checks = await activeChecks(file), ids = checks.map(c => c.id as string);
  const result: FullCheck = { checked: ids.length, broke: [], repaired: [], still: [], line: '' };
  if (ids.length) {
    const keepDir = join(fixFolder(methodId), 'full-check');
    removeTree(keepDir);
    // The Method is its own baseline: a check serves the outputs that it kept when it last passed, so only the steps
    // that changed since then run again.
    const report = await runCases(file, {}, { ids, baseline: file, gate: true, keepDir } as any);
    const failing = ((report.cases ?? []) as any[]).filter(r => r.verdict === 'fail');
    result.broke = failing.map(r => r.id).filter(id => !state.broken.includes(id));
    result.still = failing.map(r => r.id).filter(id => state.broken.includes(id));
    for (const id of result.broke) {
      const made = checks.find(c => c.id === id), row = failing.find(r => r.id === id);
      const runDir = row?.candidate?.attempts?.find((a: any) => a.status === 'fail' && a.run_dir)?.run_dir;
      if (!runDir || !existsSync(runDir)) { result.still.push(id); continue; }
      const earlier = checks.filter(c => c.id !== id).map(c => ({ id: c.id, note: c.note ?? null, noted_by: c.author ?? null, created_at: c.created, outcome: 'fixed' }));
      const learned = await learnCorrection(file, [{ id: `check-${id}`, run_dir: runDir, note: made?.note ?? null, noted_by: made?.author ?? null, created_at: made?.created, check: id }],
        { earlier, caseIds: [id], model: await learnerModel(readDocument(file)), workDir: join(fixFolder(methodId), 'learn', `check-${id}`), runCases, allEarlier: true });
      const outcome = learned.outcomes[0];
      if (outcome?.outcome === 'fixed' && await applyLearned(client, file, methodId, [{ id: `check-${id}`, note: made?.note ?? null } as AccountJudgment], learned)) result.repaired.push(id);
      else result.still.push(id);
      cleanRoom(learned);
    }
  }
  const note = (id: string) => { const made = checks.find(c => c.id === id); return made?.note ? `"${String(made.note).slice(0, 200)}"` : id; };
  result.line = !result.broke.length && !result.still.length ? `Checked every earlier correction (${ids.length}): each one still holds.`
    : [`Checked every earlier correction (${ids.length}).`, ...result.repaired.map(id => `A later change had broken ${note(id)}; Method fixed it again.`),
      ...result.still.map(id => `${note(id)} does not hold now, and Method found no change that fixes it without breaking another one.`)].join(' ');
  writeChecks(file, { ...readChecks(file), fixes: 0, broken: result.still });
  return result;
}

/** After a pass of the fix loop: the full check when FULL_EVERY fixes were applied since the last one, and a tested redesign when REDESIGN_EVERY more checks were saved since the last one. */
async function afterFixes(client: MethodClient, file: string, methodId: string, options: { runCases?: CaseRunner }) {
  if (readChecks(file).fixes >= FULL_EVERY) {
    const checked = await fullCheck(client, file, methodId, options);
    saveNotice(methodId, file, 'full_check', checked.line);
  }
  const count = (await activeChecks(file)).length;
  if (count - readChecks(file).redesigned_at < REDESIGN_EVERY) return;
  const { redesignHere, redesignLine } = await import('./redesign.js');
  const result = await redesignHere(client, file, options);
  saveNotice(methodId, file, 'redesign', redesignLine(basename(file), result));
}
