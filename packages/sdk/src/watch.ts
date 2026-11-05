import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { MethodClient } from './method-client.js';
import { readDocument } from './authoring.js';
import { methodIdPattern } from './versions.js';
import { correctionCaseId } from './improve.js';
import { saveNotice, storedOutcomes } from './fix-outcomes.js';
import { cameBackLine } from './fix-lines.js';
import { activeRules, readLearned } from './learned.js';

// Watching fixes: after a normal run of the same inputs as a correction's case, the output that the run already made
// is judged against the corrections that fixes and learned rules of the last 30 days answered. Nothing runs again. The account gets {held, run_id} per
// correction and opens a correction again when its problem came back on 2 runs; the next run of the Method says so.

const watchDays = 30;
export type Watched = { judgment: string; caseId: string };

/** The corrections to watch: those that a fix answered, and those whose note became a learned rule, in the last 30 days. */
export function watchedCorrections(file: string, now = Date.now()): Watched[] {
  const id = readDocument(file).id;
  if (typeof id !== 'string' || !methodIdPattern.test(id)) return [];
  const since = now - watchDays * 86_400_000, found = new Map<string, Watched>();
  for (const record of storedOutcomes(id)) {
    const o = record.outcome;
    if (record.status !== 'done' || !o || Date.parse(record.finished_at ?? record.started_at) < since) continue;
    if (o.outcome === 'fixed') found.set(o.id, { judgment: o.id, caseId: correctionCaseId(o.id) });
  }
  try {
    for (const { rule } of activeRules(readLearned(file))) {
      const judgment = rule.from?.judgment;
      if (judgment && Date.parse(rule.created) >= since) found.set(judgment, { judgment, caseId: rule.from?.case ?? correctionCaseId(judgment) });
    }
  } catch { /* no readable learned rules */ }
  const cases = join(dirname(file), 'cases');
  return [...found.values()].filter(w => existsSync(join(cases, w.caseId, 'case.json')));
}

type Judge = (expect: any[], outcome: any, caseDir: string, file: string) => Promise<{ status: string }>;
/** Judge with the prepared judges of the Method, two when both Claude Code and Codex are signed in. */
const defaultJudge: Judge = async (expect, outcome, caseDir, file) => {
  const { preparedConfig, judgeProfiles, evaluateWithJudges } = await import('./quality.js');
  const prepared = await preparedConfig(file, {}, { judge: true });
  return evaluateWithJudges(expect, outcome, { caseDir, config: prepared.config, options: { runOptions: { processPath: prepared.processPath, ...(prepared.hostedModels ? { hostedModels: prepared.hostedModels } : {}) } } }, await judgeProfiles(prepared.config));
};

/** Compare the immutable files each run read, not the working folder or its path. Unknown inputs cannot show a repeat failure. */
function sameFileInputs(recorded: any, made: any, caseDir: string, runDir: string) {
  const read = (path: string) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; } };
  const folders = read(join(runDir, 'input-folders.json'));
  const runMethod = read(join(runDir, 'method.json'));
  const names = (method: any) => {
    const written = new Set(Object.values(method?.steps ?? {}).flatMap((s: any) => s.changes ?? []));
    return Object.entries(method?.environment ?? {}).filter(([name, def]: [string, any]) => def.type === 'files' && !written.has(`environment.${name}`)).map(([name]) => name);
  };
  const before = [...new Set([...names(recorded.method), ...Object.keys(recorded.input_folders ?? {})])].sort();
  const after = [...new Set([...names(runMethod), ...Object.keys(folders ?? {})])].sort();
  if (!isDeepStrictEqual(before, after)) return false;
  for (const name of before) {
    const copy = `snapshot/env/${name}`;
    if (!recorded.input_folders?.[name]?.copy || !made.snapshots?.some((s: any) => s.kind === 'env' && s.copy === copy)) return false;
    const saved = inputHash(caseDir, copy), current = inputHash(runDir, folders?.[name]?.copy);
    if (saved === null || current === null || saved !== current) return false;
  }
  return true;
}

/** Bounded, byte-for-byte identity, including file names. Never follow a link to a mutable or external file. */
function inputHash(root: string, copy: unknown): string | null {
  if (typeof copy !== 'string' || !copy || isAbsolute(copy)) return null;
  const path = resolve(root, copy), inside = relative(resolve(root), path);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return null;
  const hash = createHash('sha256');
  let files = 0, bytes = 0;
  const walk = (path: string, name: string) => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      hash.update(JSON.stringify(['directory', name]));
      for (const entry of readdirSync(path).sort()) walk(join(path, entry), `${name}/${entry}`);
    } else if (stat.isFile()) {
      if (++files > 5000 || (bytes += stat.size) > 100_000_000) throw Error('Input exceeds the snapshot limit.');
      hash.update(JSON.stringify(['file', name, stat.size]));
      hash.update(readFileSync(path));
    } else throw Error('Input is not an immutable file or directory.');
  };
  try { walk(path, ''); return hash.digest('hex'); } catch { return null; }
}

/**
 * Judge one finished run against the watched corrections and send {held, run_id} for each. When the account reopens a
 * correction (its problem came back on 2 runs), the next run of the Method says so and offers undo. A correction that
 * the run cannot show (its output is missing) is skipped.
 */
export async function watchRun(client: MethodClient, file: string, runDir: string, judge: Judge = defaultJudge) {
  const methodId = readDocument(file).id as string;
  const watched = watchedCorrections(file);
  if (!watched.length || !client.token()) return [];
  const { outcomeOfRun } = await import('@withmethod/runtime/cases.js');
  const outcome = await outcomeOfRun(runDir);
  const results: { judgment: string; held: boolean }[] = [];
  const runId = (() => { try { return JSON.parse(readFileSync(join(runDir, 'run-id.json'), 'utf8')).id as string; } catch { return undefined; } })();
  for (const w of watched) {
    const caseDir = join(dirname(file), 'cases', w.caseId);
    const made = JSON.parse(readFileSync(join(caseDir, 'case.json'), 'utf8'));
    // A case speaks for runs of its own inputs: a run of other inputs may be right where the corrected rule does not apply.
    let recorded: any;
    try { recorded = JSON.parse(readFileSync(join(caseDir, 'recording.json'), 'utf8')); } catch { continue; }
    if (!isDeepStrictEqual(recorded.inputs ?? {}, outcome.inputs ?? {}) || !sameFileInputs(recorded, made, caseDir, runDir)) continue;
    let judged: { status: string };
    try { judged = await judge(made.expect ?? [], outcome, caseDir, file); } catch { continue; }
    if (judged.status === 'unverifiable') continue;
    const held = judged.status === 'pass';
    results.push({ judgment: w.judgment, held });
    // The account counts the runs where the problem came back; on the second it opens the correction again.
    let reply: { reopened?: boolean } | undefined;
    try { reply = await client.request(`/api/cli/judgments/${encodeURIComponent(w.judgment)}/watch`, 'POST', { held, ...(runId ? { run_id: runId } : {}) }); } catch { /* the next run sends its own */ }
    if (reply?.reopened) saveNotice(methodId, file, 'came_back', cameBackLine(made.note));
  }
  return results;
}

