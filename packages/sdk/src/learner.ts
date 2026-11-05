import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { methodIssues } from '@withmethod/runtime/document.js';
import { loadWorkflow, parseDocumentValue } from '../../workflow-language/src/validate.js';
import { authoringGuide, renderCommand } from './method-help.js';
import { methodContent } from './versions.js';
import { removeTree, writePrivateJson } from './files.js';
import type { CorrectionOutcome, CouldNotTestReason, TestedOutput } from './fix-lines.js';
import { correctionName } from './fix-lines.js';
import { textDiff } from './text-diff.js';
import { addedLines, checkCopies, checkInputs, inputLookups, lookupFailure, type Lookup } from './generalize.js';

// Method's learner. A person corrected a run; one agent session (Claude Code, or Codex when that is the Method's agent,
// on the person's own subscription, on the model and effort of the Method's own agent steps) works in a private copy
// of the Method's folder, as a person who builds Methods with the Method CLI would: it writes the check of the
// correction, changes whatever the Method needs, and runs method validate and method test on its new check. The
// session reads only what this correction needs, so its cost does not grow with the corrections before it: the
// correction, its run (each step output cut to OUTPUT_CHARS, the whole value in a file), one line for each earlier
// correction, and the parts of the guide that a fix uses. The checks of earlier corrections are not in its copy; a check
// that its change breaks comes back with the failure, so the next try can read and test it. Then a
// gate in this code, which the agent cannot skip, decides: the new check fails on the Method as it was and passes on
// the new one, every earlier check that passed still passes, the person's own words are unchanged unless they approved
// the change, and the Method is valid. The gate tests the new check first (3 runs in 3 when a model step runs live),
// and every earlier check only when it passes, all at once: one run each, and 3 runs that must all pass when the first
// passes only narrowly. A test runs again only the steps that the change touched and the steps after them; the others
// give the outputs that they gave when the check last passed. The old version runs an earlier check only when the new
// one fails it. A failed gate goes
// back to the agent with the exact failure, at most MAX_TRIES times in all. Corrections that wait together go to one
// session; a failed gate splits them in halves.

/** The time that the learner (or a comparison's plain builder) has for one correction, in all its tries: 2 hours. */
export const FIX_LIMIT_MS = 7_200_000;
/** The sessions that the learner has for one correction: the first, and two more after a failed gate. */
export const MAX_TRIES = 3;
/** The largest Method folder that the learner copies. */
const COPY_LIMIT = { files: 5000, bytes: 200_000_000 };

/** The agent, model and effort of the learner's session. */
export type LearnerModel = { agent: 'claude' | 'codex'; model?: string | undefined; reasoning_effort?: string | undefined };
/** A correction as the learner reads it. */
export type LearnerCorrection = {
  id: string; run_dir: string; note: string | null; corrected?: unknown; noted_by?: string | null; created_at?: string;
  /** The question that an earlier try asked about this correction, and the person's answer. */
  question?: string | null; answer?: string | null;
  /** An earlier check that a later change broke (found by a full check): the correction is its words, and its check stays. */
  check?: string;
};
/** An earlier correction of the Method, with what happened to it. */
export type EarlierCorrection = { id: string; note: string | null; noted_by?: string | null; created_at?: string; outcome?: string | null; detail?: string | null; answer?: string | null };
/** What the agent's session did: completed, timed out, or failed with a message. */
export type SessionResult = { status: 'completed' | 'timeout' | 'failed'; final_text?: string; message?: string; run_dir?: string };
/** Runs cases as method test does (quality.ts runCases); tests replace it. */
export type CaseRunner = (file: string, flags: Record<string, never>, options: { casesDir?: string; ids?: string[]; baseline?: string; newIds?: string[]; gate?: boolean; once?: boolean }) => Promise<any>;

/** The agent session of the learner. Tests replace session with a stub agent that edits the room. */
export const learnerAgent = {
  async session(input: { room: string; prompt: string; model: LearnerModel; timeoutMs: number; workDir: string }): Promise<SessionResult> {
    const file = join(input.workDir, 'learner.method'), runDir = join(input.workDir, 'run');
    writePrivateJson(file, learnerMethod(input.model, input.timeoutMs));
    const { runMethod } = await import('@withmethod/runtime/runner.js');
    const result: any = await runMethod(file, { allow_local_processes: true }, { runDir, inputs: { prompt: input.prompt, room: input.room }, fresh: true });
    if (result.status === 'completed') return { status: 'completed', final_text: String(result.result?.final_text ?? ''), run_dir: runDir };
    const failure = result.failure ?? {};
    // A usage limit of the person's plan is a plain error: the fix stops, and the correction waits for the next one.
    if (failure.code === 'usage_limit') throw Object.assign(Error(failure.headline ?? 'The agent reached the usage limit of your plan.'), { code: 'usage_limit' });
    if (failure.code === 'timeout') return { status: 'timeout', message: failure.headline, run_dir: runDir };
    return { status: 'failed', message: failure.headline ?? failure.details ?? `The learner's session ended ${result.status}.`, run_dir: runDir };
  },
};

/** The Method of the learner's session: one session step in the room, with the prompt as an input. */
export function learnerMethod(model: LearnerModel, timeoutMs: number) {
  const tools = ['read', 'write', 'edit', 'search', 'shell'];
  return {
    format: 'method/3.4', name: "Method's learner", goal: 'Change a Method so that it follows a correction, and write the check of the correction.',
    inputs: { prompt: { type: 'text', description: 'What the learner does.' }, room: { type: 'text', description: 'The private copy of the Method folder.' } },
    limits: { timeout_ms: timeoutMs + 60_000, step: { timeout_ms: timeoutMs } },
    steps: { learn: { name: 'Learn from the correction', in: { prompt: 'inputs.prompt', room: 'inputs.room' }, out: 'session',
      do: { kind: 'session', agent: model.agent, ...(model.model ? { model: model.model } : {}), ...(model.reasoning_effort ? { reasoning_effort: model.reasoning_effort } : {}), prompt: '{{prompt}}', tools, room: 'room' } } },
    result: 'session',
  };
}

// ---------- The person's own words ----------

// Every paragraph of the Method's instructions is the person's: the goal, each step's prompt, classify question and
// options, ask text and check prompt, and each .md and .txt file in the Method's folder. Only the paragraphs that
// Method's learner wrote itself are not: it records them, by place, in .method/written.json, so a later fix may change
// them. A paragraph that a person edits afterwards has another hash, so it is theirs again. learned.json is Method's.
// The learner may add text anywhere, and move a paragraph of the person's, unchanged, to any other place (another
// step's prompt, or another .md or .txt file), so it can split and rebuild steps. It changes or removes one only when
// the person answered a question of this correction that quotes it.

/** The record of the paragraphs that Method's learner wrote, by place. */
export const writtenFile = (folder: string) => join(folder, '.method', 'written.json');
export type Written = { format: 'method-written/1'; places: Record<string, string[]> };
const emptyWritten = (): Written => ({ format: 'method-written/1', places: {} });
export function readWritten(folder: string): Written {
  try { const value = JSON.parse(readFileSync(writtenFile(folder), 'utf8')); return value?.format === 'method-written/1' && value.places && typeof value.places === 'object' ? value : emptyWritten(); }
  catch { return emptyWritten(); }
}

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const hashOf = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** The paragraphs of a text: parts between blank lines, with their spaces made single. */
export const paragraphs = (text: string) => text.split(/\n[ \t]*\n/).map(normalize).filter(Boolean);
/** Folders that hold no instructions of the Method. */
const notMethod = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.method-runs', '.method', '.fix', 'cases']);

/** The instruction texts of a Method, by place: goal, steps.ID.do.prompt (and the other prompts), file:PATH. */
export function textPlaces(document: any, folder: string): Map<string, string> {
  const places = new Map<string, string>();
  const put = (place: string, value: unknown) => { if (typeof value === 'string' && value.trim()) places.set(place, value); };
  put('goal', document?.goal);
  for (const [id, step] of Object.entries<any>(document?.steps ?? {})) {
    put(`steps.${id}.do.prompt`, step?.do?.prompt);
    put(`steps.${id}.do.question`, step?.do?.question);
    for (const [name, text] of Object.entries<any>(step?.do?.options ?? {})) put(`steps.${id}.do.options.${name}`, typeof text === 'string' ? text : text?.description);
    put(`steps.${id}.check.prompt`, step?.check?.prompt);
    put(`steps.${id}.ask`, typeof step?.ask === 'string' ? step.ask : step?.ask?.question);
  }
  const walk = (dir: string) => {
    let entries: import('node:fs').Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (!notMethod.has(entry.name)) walk(path); }
      else if (entry.isFile() && /\.(md|txt)$/i.test(entry.name)) put(`file:${relative(folder, path).split(sep).join('/')}`, readFileSync(path, 'utf8'));
    }
  };
  walk(folder);
  return places;
}

/** A place in the person's words: "the prompt of step write", "the file guide.md". */
export function placeName(place: string) {
  if (place === 'goal') return 'the goal of the Method';
  if (place.startsWith('file:')) return `the file ${place.slice(5)}`;
  const [, id, rest] = /^steps\.([^.]+)\.(.+)$/.exec(place) ?? [];
  const what = rest === 'do.prompt' ? 'the prompt' : rest === 'do.question' ? 'the question' : rest?.startsWith('do.options.') ? `the option ${rest.slice(11)}` : rest === 'check.prompt' ? 'the check' : 'the question to a person';
  return `${what} of step ${id}`;
}

/** Whether a question quotes a paragraph: it holds the paragraph, or its first 80 characters for a longer one. */
const quotes = (question: string, paragraph: string) => normalize(question).toLowerCase().includes(paragraph.slice(0, 80).toLowerCase());

/** The person's paragraphs of a Method: every paragraph of each place that Method's learner did not write there. */
function personParagraphs(places: Map<string, string>, written: Written) {
  const found = new Set<string>();
  for (const [place, text] of places) {
    const mine = new Set(written.places[place] ?? []);
    for (const paragraph of paragraphs(text)) if (!mine.has(hashOf(paragraph))) found.add(paragraph);
  }
  return found;
}

/**
 * The person's paragraphs that a change removed or changed, by place. before and after are the text places of the
 * Method as it was and as it is now; written is what Method's learner wrote; approved is the question of this
 * correction that the person answered (its quoted paragraphs may change). A paragraph that is still in any place, word
 * for word, is kept: it may move to another step or file.
 */
export function changedUserText(before: Map<string, string>, after: Map<string, string>, written: Written, approved?: string | null) {
  const changed: { place: string; paragraph: string }[] = [];
  const now = new Set([...after.values()].flatMap(paragraphs));
  for (const [place, text] of before) {
    const mine = new Set(written.places[place] ?? []);
    for (const paragraph of paragraphs(text)) {
      if (mine.has(hashOf(paragraph)) || now.has(paragraph)) continue;
      if (approved && quotes(approved, paragraph)) continue;
      changed.push({ place, paragraph });
    }
  }
  return changed;
}

/**
 * The record of what Method's learner wrote after a change: every paragraph that is not the person's. A paragraph of
 * the person's stays theirs in the place it moved to.
 */
export function nextWritten(before: Map<string, string>, after: Map<string, string>, written: Written): Written {
  const theirs = personParagraphs(before, written);
  const places: Record<string, string[]> = {};
  for (const [place, text] of after) {
    const hashes = [...new Set(paragraphs(text).filter(p => !theirs.has(p)).map(hashOf))];
    if (hashes.length) places[place] = hashes;
  }
  return { format: 'method-written/1', places };
}

// ---------- The private copy ----------

/** Copy the Method folder without run records, secrets or Method's private files; link its dependencies. */
export function copyMethod(source: string, target: string) {
  let files = 0, bytes = 0;
  const skip = (name: string) => ['.git', '__pycache__', '.method-runs', '.method', '.fix'].includes(name) || name.startsWith('.env');
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip(entry.name) || ['node_modules', '.venv'].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) { files++; bytes += statSync(path).size; }
      if (files > COPY_LIMIT.files || bytes > COPY_LIMIT.bytes) throw Object.assign(Error('The Method folder is too large to copy for a safe test.'), { code: 'too_large' });
    }
  };
  walk(source);
  cpSync(source, target, { recursive: true, verbatimSymlinks: true, filter: path => {
    const parts = relative(source, path).split(sep);
    return !parts.some(skip) && !(parts.length === 1 && ['node_modules', '.venv'].includes(parts[0]!));
  } });
  // Scripts that need the Method's installed packages find them through a link.
  for (const name of ['node_modules', '.venv']) if (existsSync(join(source, name))) symlinkSync(join(source, name), join(target, name));
}

/** Every file of a folder by its path inside it, with its hash, leaving out Method's private and run folders. */
function fileHashes(folder: string) {
  const found = new Map<string, string>();
  const walk = (dir: string) => {
    let entries: import('node:fs').Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (['.git', 'node_modules', '.venv', '__pycache__', '.method-runs', '.method', '.fix'].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) found.set(relative(folder, path).split(sep).join('/'), hashOf(readFileSync(path)));
    }
  };
  walk(folder);
  return found;
}

/** The files that differ between two copies: added, changed and removed paths. */
export function changedFiles(before: string, after: string) {
  const a = fileHashes(before), b = fileHashes(after), paths: string[] = [];
  for (const [path, hash] of b) if (a.get(path) !== hash) paths.push(path);
  for (const path of a.keys()) if (!b.has(path)) paths.push(path);
  return paths.sort();
}

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;
const show = (value: unknown, max = 20_000) => clip(typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'null', max);
const day = (at?: string | null) => at ? at.slice(0, 10) : 'date unknown';

/** The folder in .fix/ of the run of the k-th of n corrections (from 1): .fix/run for one correction. */
const runName = (k: number, n: number) => n === 1 ? 'run' : `run-${k}`;
const correctedName = (k: number, n: number) => n === 1 ? 'corrected.txt' : `corrected-${k}.txt`;

/** The characters of one step output in .fix/NAME.md; a longer output is cut there and is whole in .fix/NAME-outputs/. */
export const OUTPUT_CHARS = 4000;

/**
 * What a reader needs from a run: its inputs, result, step outputs, transcripts and files, in .fix/NAME.md. A step
 * output longer than OUTPUT_CHARS is cut, and its whole value is in .fix/NAME-outputs/KEY.json.
 */
export async function writeRun(room: string, correction: Pick<LearnerCorrection, 'run_dir'>, name: string) {
  const fix = join(room, '.fix');
  // The run as it is: its folder for method case new, and what a reader needs from it.
  cpSync(correction.run_dir, join(fix, name), { recursive: true, verbatimSymlinks: true });
  const { outcomeOfRun } = await import('@withmethod/runtime/cases.js');
  const outcome: any = await outcomeOfRun(join(fix, name));
  const transcripts: string[] = [], written_files: string[] = [];
  const walk = (dir: string) => {
    let entries: import('node:fs').Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === 'transcript.jsonl') transcripts.push(relative(room, path));
      else if (entry.isFile() && !/^(events\.jsonl|mcp\.json|prompt\.md|result\.json|schema\.json|stderr\.log|last-message\.txt)$/.test(entry.name)) written_files.push(relative(room, path));
    }
  };
  walk(join(fix, name, 'artifacts'));
  const output = (key: string, value: unknown) => {
    const text = show(value, Infinity);
    if (text.length <= OUTPUT_CHARS) return [`### ${key}`, '', '```', text, '```', ''];
    const whole = `.fix/${name}-outputs/${key.replace(/[^\w.-]+/g, '_')}.json`;
    mkdirSync(join(room, dirname(whole)), { recursive: true });
    writeFileSync(join(room, whole), JSON.stringify(value, null, 2) + '\n');
    return [`### ${key}`, '', `The first ${OUTPUT_CHARS} of ${text.length} characters; the whole value is in ${whole}.`, '', '```', clip(text, OUTPUT_CHARS), '```', ''];
  };
  writeFileSync(join(fix, `${name}.md`), ['# The run that the person corrected', '', `Its folder is .fix/${name} (give it to method case new as --run .fix/${name}).`, '',
    '## Inputs', '', '```json', show(outcome.inputs), '```', '', '## Result', '', '```', show(outcome.result), '```', '',
    '## Step outputs', '', ...Object.entries(outcome.outputs ?? {}).flatMap(([key, value]) => output(key, value)),
    '## What its agent steps did (transcripts)', '', ...(transcripts.length ? transcripts.map(t => `- ${t}`) : ['None.']), '',
    '## Files it wrote', '', ...(written_files.length ? written_files.map(f => `- ${f}`) : ['None.']), ''].join('\n'));
}

/**
 * The parts of the guide that a fix uses: building a Method, its concepts and recipes, and the commands of a fix. Not
 * the comparisons, the execution setup or the reference of every command.
 */
export function learnerGuide() {
  return [authoringGuide('start'), authoringGuide('concepts'), authoringGuide('recipes'),
    '# The commands of a fix', '', ...['case new', 'test', 'validate', 'learned'].map(name => renderCommand(name, false))].join('\n\n');
}

/**
 * Write what the session may read in .fix/ of the room: each corrected run (.fix/run.md and .fix/run/, or run-K for
 * several), the result that the person gave as right, and the guide of a fix. The person's words and the earlier
 * corrections are in the prompt itself.
 */
async function writeBrief(room: string, corrections: LearnerCorrection[]) {
  const fix = join(room, '.fix'), n = corrections.length;
  mkdirSync(fix, { recursive: true, mode: 0o700 });
  for (const [i, correction] of corrections.entries()) {
    if (correction.corrected !== undefined && correction.corrected !== null) writeFileSync(join(fix, correctedName(i + 1, n)), show(correction.corrected, 1_000_000) + '\n');
    await writeRun(room, correction, runName(i + 1, n));
  }
  writeFileSync(join(fix, 'guide.md'), `${learnerGuide()}\n`);
}

const quoted = (text: string | null | undefined, none: string) => text?.trim() ? `"${text.trim()}"` : none;

/**
 * The prompt of the learner's session: a direct instruction, as a person gives an agent that improves a Method ("Improve
 * this Method based on this correction"), with the person's words, the run that got the correction, and the earlier
 * corrections with their words. The guide is a file that the agent reads when it needs it. The rules that Method
 * enforces are not in the prompt: the gate checks them after the session, and a failure comes back as one message.
 */
export function learnerPrompt(file: string, corrections: LearnerCorrection[], caseIds: string[], earlier: EarlierCorrection[], failure?: string) {
  const n = corrections.length;
  const one = (c: LearnerCorrection, i: number) => {
    const run = runName(i + 1, n), id = caseIds[i]!;
    return [`${n === 1 ? 'Improve this Method based on this correction' : `Correction ${i + 1}`}: ${quoted(c.note, '(the person marked the result wrong, without words)')}`,
      `The run that got it: .fix/${run} (its inputs, step outputs and result are in .fix/${run}.md).`,
      ...(c.corrected !== undefined && c.corrected !== null ? [`The result that the person says is right: .fix/${correctedName(i + 1, n)}.`] : []),
      ...(c.answer?.trim() ? [`Asked "${c.question?.trim() ?? ''}", the person answered: ${quoted(c.answer, '')}`] : []),
      c.check ? `This correction held before, and a later change broke it. Its check is cases/${id}: make it pass again, and do not change it. Test it with method test ${file} --case ${id}.`
        : `Save its check: method case new ${file} --run .fix/${run} --id ${id} --note "THE PERSON'S WORDS" and what the correction says. Test it with method test ${file} --case ${id}.`].join('\n');
  };
  const outcome = `{"outcome": "fixed", "summary": "WHAT THE AGENT DOES DIFFERENTLY NOW, IN ONE PLAIN SENTENCE FOR THE PERSON"}; or "no_change_needed" with a "detail" when the Method already does what the correction asks (save the check anyway, with --passing-run in place of --run when the run already meets it); "question" with a "question" when only a change of the person's own words would fix it; or "no_fix_found" with a "detail" when the cause is outside the Method`;
  return [
    ...(failure ? [`Your earlier try is in this folder. Method checked it, and it did not pass:\n${failure}\nFix this, and write .fix/result.json again.`, ''] : []),
    ...(n === 1 ? [one(corrections[0]!, 0)] : [`Improve this Method based on these ${n} corrections, with one change.`, '', ...corrections.flatMap((c, i) => [one(c, i), ''])]),
    '',
    `Earlier corrections of this Method, oldest first:${earlier.length ? '' : ' none.'}`,
    ...earlier.map((c, i) => `${i + 1}. ${quoted(c.note, '(no words)')}${c.answer?.trim() ? ` Their answer to a question: ${quoted(c.answer, '')}` : ''} (${c.outcome ?? 'not decided yet'})`),
    '',
    `The Method is ${file}. Method's guide is in .fix/guide.md: read the parts that you need.`,
    `When you finish, write .fix/result.json: ${n === 1 ? outcome : `{"outcomes": {"CHECK ID": OUTCOME}} with one OUTCOME for each check: ${outcome}`}. Write for the person, about their work.`,
  ].join('\n');
}

// ---------- The gate ----------

type AgentResult = { outcome: 'fixed' | 'no_change_needed' | 'question' | 'no_fix_found'; summary?: string; detail?: string; question?: string };
/** One outcome as the agent wrote it, or what is wrong with it. */
function readOutcome(value: any, where: string): AgentResult | string {
  const text = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : undefined;
  if (value?.outcome === 'fixed') return text(value.summary) ? { outcome: 'fixed', summary: text(value.summary)! } : `${where} says fixed, but has no summary for the person.`;
  if (value?.outcome === 'question') return text(value.question) ? { outcome: 'question', question: text(value.question)! } : `${where} asks a question, but has no question.`;
  if (value?.outcome === 'no_change_needed' || value?.outcome === 'no_fix_found') return { outcome: value.outcome, ...(text(value.detail) ? { detail: text(value.detail)! } : {}) };
  return `${where} must have outcome fixed, no_change_needed, question or no_fix_found.`;
}
/** The agent's outcome for each check ID, or what is wrong with .fix/result.json. */
function readResult(room: string, caseIds: string[]): Map<string, AgentResult> | string {
  let value: any;
  try { value = JSON.parse(readFileSync(join(room, '.fix', 'result.json'), 'utf8')); }
  catch { return 'There is no .fix/result.json with your outcome, or it is not JSON. Write it as the instructions say.'; }
  if (caseIds.length === 1) { const one = readOutcome(value, '.fix/result.json'); return typeof one === 'string' ? one : new Map([[caseIds[0]!, one]]); }
  const found = new Map<string, AgentResult>(), problems: string[] = [];
  for (const id of caseIds) {
    const one = readOutcome(value?.outcomes?.[id], `The outcome of ${id} in .fix/result.json`);
    if (typeof one === 'string') problems.push(value?.outcomes?.[id] === undefined ? `.fix/result.json has no outcome for ${id}: write {"outcomes": {"${id}": …}}.` : one); else found.set(id, one);
  }
  return problems.length ? problems.join('\n') : found;
}

const REASONS = ['missing_file', 'can_send', 'too_large', 'no_live_step'] as const;
/** Why a case could not run safely, as a could_not_test reason. */
function unverifiableReason(result: any): CouldNotTestReason {
  const attempt = (result?.attempts ?? []).find((a: any) => a.status === 'unverifiable') ?? result ?? {};
  const code = [attempt.reason, attempt.code, attempt.failure?.code].find((c: unknown) => (REASONS as readonly unknown[]).includes(c));
  if (code) return code as CouldNotTestReason;
  const text = JSON.stringify(attempt.reason ?? attempt.failure ?? '').toLowerCase();
  if (/too large/.test(text)) return 'too_large';
  if (/\b(send|sends|effects?|changes|service|browser|desktop|asks?|shell|web)\b/.test(text)) return 'can_send';
  return 'missing_file';
}
/** Why a case failed, from its first failing run. */
const failReasons = (result: any) => ((result?.attempts ?? []).find((a: any) => a.status === 'fail')?.results ?? []).filter((r: any) => r.status !== 'pass').slice(0, 5).map((r: any) => String(r.reason ?? r.status ?? 'it failed')).join('; ') || (result?.unreliable ?? 'it failed');
/** What a passing run of the new check gave: the result, the files it wrote, and what it held back. */
function testedOutput(result: any): TestedOutput | undefined {
  const shown = (result?.attempts ?? []).find((a: any) => a.status === 'pass' && a.output);
  return shown ? { result: shown.output.result ?? null, files: shown.output.files ?? {}, held_back: (shown.standins ?? []).map((c: any) => ({ tool: c.tool, args: c.arguments })) } : undefined;
}
const caseAuthor = (dir: string) => { try { const made = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8')); return { author: typeof made.author === 'string' ? made.author : null, note: String(made.note ?? '') }; } catch { return { author: null, note: '' }; } };

/**
 * The new check as the person's: it names them (so a later change that breaks it is held for them), and its source
 * is the run that they corrected, not the session's copy of it in .fix/.
 */
function settleCase(path: string, correction: LearnerCorrection) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    const real = (dir: unknown) => typeof dir === 'string' && /(^|[\\/])\.fix[\\/]run(-\d+)?$/.test(dir) ? resolve(correction.run_dir) : dir;
    const source = value.source && typeof value.source === 'object' ? { ...value.source, run_dir: real(value.source.run_dir), ...(value.source.passing_run_dir ? { passing_run_dir: real(value.source.passing_run_dir) } : {}) } : value.source;
    writeFileSync(path, JSON.stringify({ ...value, source, ...(correction.noted_by ? { author: correction.noted_by } : {}) }, null, 2) + '\n');
  } catch { /* the gate refuses a check that it cannot read */ }
}

/** The earlier checks that a change broke, as failures for the agent and the people whose checks they are. */
export function broken(rows: any[], casesDir: string, correction: LearnerCorrection | undefined) {
  const problems: string[] = [], others: { by: string; note: string }[] = [], checks: string[] = [];
  for (const row of rows) {
    const broke = row.verdict === 'regression' || (row.verdict === 'unverifiable' && row.baseline?.status !== 'unverifiable');
    if (!broke) continue;
    checks.push(row.id);
    const made = caseAuthor(join(casesDir, row.id));
    problems.push(`${row.verdict === 'regression' ? 'Your change breaks' : 'Your change makes it impossible to run safely'} the check ${row.id}, from ${correctionName({ author: made.author, note: made.note })}${row.verdict === 'regression' ? `: ${failReasons(row.candidate)}` : ''}.`);
    others.push(made.author && correction?.noted_by && made.author !== correction.noted_by ? { by: made.author, note: made.note } : { by: '', note: made.note });
  }
  const notRun = rows.filter(r => r.verdict === 'not_run').length;
  if (problems.length && notRun) problems.push(`Method stopped testing at ${problems.length === 1 ? 'this failure' : 'these failures'}: ${notRun} other earlier check${notRun === 1 ? '' : 's'} did not run yet.`);
  if (checks.length) problems.push(`${checks.length === 1 ? 'This check is' : 'These checks are'} now in cases/ for your next try: ${checks.map(id => `cases/${id}`).join(', ')}. Read ${checks.length === 1 ? 'it' : 'them'}, and test ${checks.length === 1 ? 'it' : 'each one'} with method test --case ID.`);
  return { problems, others, checks };
}

// ---------- A general fix ----------

/** The text that a change added to the Method's files (not its checks), with what it takes from one input. */
export function changeLookups(base: string, room: string, changed: string[], inputs: ReturnType<typeof checkInputs>, document?: any) {
  const read = (root: string, path: string) => { const full = join(root, path); try { const b = lstatSync(full).isFile() ? readFileSync(full) : null; return b && !b.subarray(0, 8192).includes(0) ? b.toString('utf8') : null; } catch { return null; } };
  const found: { path: string; lookup: Lookup }[] = [];
  const isMethod = methodPaths(document);
  for (const path of changed.filter(p => !p.startsWith('cases/') && isMethod(p))) {
    const after = read(room, path);
    if (after === null) continue;
    for (const lookup of inputLookups(addedLines(read(base, path) ?? '', after), inputs)) found.push({ path, lookup });
  }
  return found;
}

/**
 * The files that make up a Method, as the one-input test reads them: the .method file, learned.json, and each file or
 * folder that the Method names in files. Any other file of its folder, such as a result that a chat saved there (an
 * answers.json, a memo), is not what the Method does next time, so it is not a rule. Without the document: every file.
 */
export function methodPaths(document: any): (path: string) => boolean {
  if (!document) return () => true;
  const clean = (p: string) => p.replace(/^\.\//, '').replace(/\/+$/, '');
  const listed = (Array.isArray(document.files) ? document.files : []).filter((f: unknown): f is string => typeof f === 'string').map(clean);
  return path => /\.method$/.test(path) || path === 'learned.json' || listed.some((f: string) => path === f || path.startsWith(`${f}/`));
}

/** The earlier checks on whose inputs a new rule for every input is judged: the newest that passed, at most this many. */
export const HELD_OUT = 8;
/**
 * Leave-one-out within the corrections: each rule for every input (scope every_input) of a new check is judged on the
 * inputs of the earlier checks that the change was not taught on, on the changed Method. The case runs serve the step
 * outputs that the passing earlier runs kept, so the cost is the judge's. A rule that holds on the input it was taught
 * on but not on another input is a rule for one input. Each failure as a sentence for the learner.
 */
export async function heldOut(runCases: CaseRunner, roomFile: string, room: string, fixed: string[], rows: any[]) {
  const casesDir = join(room, 'cases');
  const read = (id: string) => { try { return JSON.parse(readFileSync(join(casesDir, id, 'case.json'), 'utf8')); } catch { return null; } };
  const rules = fixed.flatMap(id => ((read(id)?.expect ?? []) as any[]).filter(item => item?.scope === 'every_input').map(item => ({ id, item })));
  if (!rules.length) return [];
  const passed = rows.filter(r => ['pass', 'fixed'].includes(r.verdict)).map(r => ({ id: r.id as string, made: read(r.id) })).filter(r => r.made)
    .sort((a, b) => String(b.made.created ?? '').localeCompare(String(a.made.created ?? ''))).slice(0, HELD_OUT);
  if (!passed.length) return [];
  // A copy of each earlier check whose only expectations are the new rules.
  const dir = join(room, '..', 'held-out');
  removeTree(dir);
  for (const { id, made } of passed) {
    const to = join(dir, id);
    cpSync(join(casesDir, id), to, { recursive: true, verbatimSymlinks: true });
    const expect = rules.map(({ id: from, item }, i) => {
      if (item.kind !== 'predicate') return item;
      const entrypoint = `held-out-${i}-${basename(item.entrypoint)}`;
      cpSync(join(casesDir, from, item.entrypoint), join(to, entrypoint));
      return { ...item, entrypoint };
    });
    writeFileSync(join(to, 'case.json'), JSON.stringify({ ...made, expect, runs: null, min_pass: null }, null, 2) + '\n');
  }
  // The changed Method is its own baseline, so each step that the earlier runs kept is served, not run again.
  const report = await runCases(roomFile, {}, { casesDir: dir, ids: passed.map(p => p.id), baseline: roomFile, gate: true, once: true });
  const problems: string[] = [];
  for (const row of report.cases ?? []) {
    if (row.candidate?.status !== 'fail') continue;
    const made = caseAuthor(join(casesDir, row.id));
    problems.push(`Your rule for every input does not hold on the input of the check ${row.id}, from ${correctionName({ author: made.author, note: made.note })}, which your change was not taught on: ${failReasons(row.candidate)}. Make the change follow the rule on every input (not by the text, file name or answers of one input), or write the rule so that it holds there too. When that correction and this one disagree, ask (outcome question).`);
  }
  removeTree(dir);
  return problems;
}

type Final = Omit<CorrectionOutcome, 'id'>;
/** A failed gate: the failure for the next try, the people whose checks broke, and the IDs of those checks. */
type Checked = { pass: true; finals: Map<string, Final> } | { pass: false; failure: string; others?: { by: string; note: string }[]; checks?: string[] };

/**
 * The gate: what the agent's work comes to for each correction, or the exact failure for its next try. Method tests
 * the new checks first; only when they pass does it test every earlier check, once per fix.
 */
async function gate(ctx: { file: string; base: string; room: string; caseIds: string[]; corrections: LearnerCorrection[]; written: Written; runCases: CaseRunner; earlierChecks: EarlierChecks }): Promise<Checked> {
  const { file, base, room, caseIds } = ctx;
  const name = basename(file), baseFile = join(base, name), roomFile = join(room, name);
  const said = readResult(room, caseIds);
  if (typeof said === 'string') return { pass: false, failure: said };
  const finals = new Map<string, Final>();
  for (const [id, one] of said) {
    if (one.outcome === 'question') finals.set(id, { outcome: 'question', question: one.question! });
    if (one.outcome === 'no_fix_found') finals.set(id, { outcome: 'no_fix_found', ...(one.detail ? { detail: one.detail } : {}) });
  }
  const tested = caseIds.filter(id => !finals.has(id));
  if (!tested.length) return { pass: true, finals };
  const problems: string[] = [];
  // The checks of earlier corrections stay as they are; the new ones are there.
  const changed = changedFiles(base, room);
  for (const path of changed.filter(p => p.startsWith('cases/') && !caseIds.some(id => p.startsWith(`cases/${id}/`)))) problems.push(`You changed ${path}, a file of an earlier check. Put it back as it was.`);
  for (const id of tested) {
    if (!existsSync(join(room, 'cases', id, 'case.json'))) problems.push(`There is no check cases/${id}. Write it with method case new ${name} --run .fix/${runName(caseIds.indexOf(id) + 1, caseIds.length)} --id ${id} ….`);
    else if (!ctx.corrections[caseIds.indexOf(id)]!.check) settleCase(join(room, 'cases', id, 'case.json'), ctx.corrections[caseIds.indexOf(id)]!);
  }
  // The Method is valid.
  let document: any;
  try { document = parseDocumentValue(readFileSync(roomFile, 'utf8')); loadWorkflow(methodContent(document)); }
  catch (error) { return { pass: false, failure: [...problems, `${name} is not a valid Method: ${(error as Error).message}`].join('\n') }; }
  const errors = (methodIssues(readFileSync(roomFile, 'utf8')) as any[]).filter(issue => issue.level === 'error');
  for (const issue of errors) problems.push(`method validate: ${issue.step ? `step ${issue.step}: ` : ''}${issue.message}${issue.fix ? ` ${issue.fix}` : ''}`);
  // The person's words.
  const approved = ctx.corrections.filter(c => c.answer?.trim() && c.question).map(c => c.question!).join('\n') || null;
  for (const { place, paragraph } of changedUserText(textPlaces(parseDocumentValue(readFileSync(baseFile, 'utf8')), base), textPlaces(document, room), ctx.written, approved))
    problems.push(`You changed the person's own words in ${placeName(place)}: "${clip(paragraph, 200)}". Put the paragraph back word for word. To change it, ask the person first (outcome question) and quote it in the question.`);
  // A general fix: each new check tests what its correction says, and the change looks up no one input.
  const inputs = checkInputs(join(room, 'cases'));
  for (const id of tested) problems.push(...checkCopies(join(room, 'cases', id), inputs));
  const lookups = changeLookups(base, room, changed, inputs, document);
  if (lookups.length) problems.push(lookupFailure(lookups));
  if (problems.length) return { pass: false, failure: problems.join('\n') };
  const casesDir = join(room, 'cases');
  // no_change_needed: the check passes on the Method as it is.
  const unchanged = tested.filter(id => said.get(id)!.outcome === 'no_change_needed');
  if (unchanged.length) {
    const report = await ctx.runCases(baseFile, {}, { casesDir, ids: unchanged });
    for (const id of unchanged) {
      const result = report.cases?.find((c: any) => c.id === id)?.candidate, detail = said.get(id)!.detail;
      if (result?.status === 'pass') finals.set(id, { outcome: 'no_change_needed', ...(detail ? { detail } : {}) });
      else if (result?.status === 'unverifiable') finals.set(id, { outcome: 'could_not_test', reason: unverifiableReason(result), detail: 'The check of this correction cannot run safely.' });
      else problems.push(`You said no change is needed, but the check ${id} fails on the Method as it is: ${failReasons(result)}. Change the Method, or write a check that the run meets.`);
    }
  }
  if (problems.length) return { pass: false, failure: problems.join('\n') };
  // fixed: first the new checks, which fail before and pass now; only then every earlier check that passed before.
  const fixed = tested.filter(id => said.get(id)!.outcome === 'fixed');
  if (!fixed.length) return { pass: true, finals };
  const first = await ctx.runCases(roomFile, {}, { casesDir, ids: fixed, baseline: baseFile, newIds: fixed, gate: true });
  const mine = new Map<string, any>((first.cases ?? []).map((r: any) => [r.id, r]));
  for (const id of fixed) {
    const row = mine.get(id);
    if (!row) problems.push(`method test did not run the check ${id}. Make sure that it is an active check of ${name}.`);
    else if (row.verdict === 'unverifiable') {
      const path = row.candidate?.attempts?.find((a: any) => a.path)?.path;
      finals.set(id, { outcome: 'could_not_test', reason: unverifiableReason(row.candidate), detail: 'The check of this correction cannot run safely on the changed Method.', ...(path ? { path } : {}) });
    }
    else if (row.verdict === 'not_red') problems.push(`The check ${id} passes on the Method as it was, so it does not show the mistake. Write a check that fails on this run.`);
    else if (row.verdict === 'not_run') problems.push(`Method stopped testing the check ${id} at another failure.`);
    else if (row.verdict !== 'fixed') problems.push(`The check ${id} does not pass on your version: ${failReasons(row.candidate)}.`);
  }
  // A change that cannot be tested for this correction is not applied, as for one correction alone.
  if (fixed.some(id => finals.get(id)?.outcome === 'could_not_test')) {
    if (caseIds.length === 1) return { pass: true, finals };
    problems.push(...fixed.filter(id => finals.get(id)?.outcome === 'could_not_test').map(id => `The check ${id} cannot run safely on your version.`));
  }
  if (problems.length) return { pass: false, failure: problems.join('\n') };
  const { listCases } = await import('@withmethod/runtime/cases.js');
  const active = (await listCases(roomFile, casesDir)).filter((c: any) => c.status === 'active' && !fixed.includes(c.id)).map((c: any) => c.id as string);
  const earlierIds = await chooseEarlier(active, { roomFile, baseFile, casesDir, fixed, plan: ctx.earlierChecks });
  const rows: any[] = earlierIds.length ? (await ctx.runCases(roomFile, {}, { casesDir, ids: earlierIds, baseline: baseFile, gate: true })).cases ?? [] : [];
  const { problems: broke, others, checks } = broken(rows, casesDir, ctx.corrections.length === 1 ? ctx.corrections[0] : undefined);
  if (broke.length) return { pass: false, failure: broke.join('\n'), others, checks };
  // The new rules for every input hold on the inputs of earlier checks, which the change was not taught on.
  const astray = await heldOut(ctx.runCases, roomFile, room, fixed, rows);
  if (astray.length) return { pass: false, failure: astray.join('\n') };
  const earlier = rows.filter(r => ['pass', 'fixed'].includes(r.verdict)).length;
  for (const id of fixed) {
    const row = mine.get(id), shown = testedOutput(row.candidate);
    finals.set(id, { outcome: 'fixed', summary: said.get(id)!.summary!, tested: { times: row.candidate?.passes ?? 1, earlier }, ...(shown ? { tested_output: shown } : {}) });
  }
  return { pass: true, finals };
}

// ---------- The earlier checks ----------

/** The steps that a change touched, for each earlier check (the runtime's step keys); tests replace it. */
export type Toucher = (file: string, baseline: string, options: { casesDir: string; ids: string[] }) => Promise<Record<string, string[]>>;
/**
 * Which earlier checks a fix tests. all: every one (a repair of a broken check, and the full check). Sampled (the
 * default): the RELATED checks most related to the change, and SAMPLE more at random. A check is related when the
 * change touched a step that it needs (the step keys of the two versions differ); a check that the change did not touch
 * serves every step from the outputs that it kept when it last passed, so the change cannot break it. Among related
 * checks, more touched steps come first, then more corrected parts shared with the new check (the same part keys of
 * their parts checks), then the newest. Every FULL_EVERY fixes, and before a comparison's checkpoint, the full check
 * tests every earlier check (improve.ts fullCheck).
 */
export type EarlierChecks = { all: true } | { all?: false; touched: Toucher; random?: () => number };
export const RELATED = 3, SAMPLE = 3;

/** The part keys that the parts checks of a check corrected (exact keys from its case.json). */
function correctedParts(casesDir: string, id: string) {
  try { return new Set(((JSON.parse(readFileSync(join(casesDir, id, 'case.json'), 'utf8')).expect ?? []) as any[]).filter(e => e?.kind === 'parts').flatMap(e => Object.keys(e.corrected ?? {}))); }
  catch { return new Set<string>(); }
}
const createdAt = (casesDir: string, id: string) => { try { return String(JSON.parse(readFileSync(join(casesDir, id, 'case.json'), 'utf8')).created ?? ''); } catch { return ''; } };

export async function chooseEarlier(active: string[], ctx: { roomFile: string; baseFile: string; casesDir: string; fixed: string[]; plan: EarlierChecks }) {
  const { plan } = ctx;
  if (plan.all || active.length <= RELATED + SAMPLE) return active;
  const touched = await plan.touched(ctx.roomFile, ctx.baseFile, { casesDir: ctx.casesDir, ids: active });
  const mine = new Set(ctx.fixed.flatMap(id => [...correctedParts(ctx.casesDir, id)]));
  const shared = (id: string) => [...correctedParts(ctx.casesDir, id)].filter(part => mine.has(part)).length;
  const reached = active.filter(id => (touched[id] ?? []).length > 0)
    .sort((a, b) => touched[b]!.length - touched[a]!.length || shared(b) - shared(a) || createdAt(ctx.casesDir, b).localeCompare(createdAt(ctx.casesDir, a)));
  const related = reached.slice(0, RELATED), rest = reached.slice(RELATED), random = plan.random ?? Math.random;
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [rest[i], rest[j]] = [rest[j]!, rest[i]!]; }
  return [...related, ...rest.slice(0, SAMPLE)];
}

/** The checks in the cases/ folder of a copy, by ID. */
function checkIds(folder: string) {
  try { return readdirSync(join(folder, 'cases'), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return []; }
}
/**
 * Take the checks of earlier corrections out of the room, except keep: the session reads only what this correction
 * needs, so its cost does not grow with the corrections before it. base keeps every check.
 */
export function hideEarlier(room: string, keep: string[]) {
  for (const id of checkIds(room)) if (!keep.includes(id)) removeTree(join(room, 'cases', id));
}
/** Put every earlier check back in the room from base, for the gate. A check that the session wrote stays, so the gate sees a change to it. */
export function restoreEarlier(base: string, room: string) {
  for (const id of checkIds(base)) if (!existsSync(join(room, 'cases', id))) cpSync(join(base, 'cases', id), join(room, 'cases', id), { recursive: true, verbatimSymlinks: true });
}

// ---------- One correction, or several together ----------

/**
 * What the learner did with its corrections, one outcome for each, in their order. A fixed or no_change_needed
 * outcome leaves its work in room. split: several corrections found no change together; each half is fixed again on its
 * own.
 */
export type Learned = { outcomes: CorrectionOutcome[]; room?: string; base?: string; changed: string[]; diff: string; written?: Written; tries: number; log: string; split?: boolean };

/**
 * Learn from corrections in a private copy of the Method's folder, in workDir: up to MAX_TRIES sessions of the agent
 * for one correction, each checked by the gate, or one session for several corrections together (a failed gate splits
 * them). Returns the outcomes; for a fixed one, the room holds the change, with its diff.
 */
export async function learnCorrection(file: string, corrections: LearnerCorrection[], options: { earlier: EarlierCorrection[]; caseIds: string[]; model: LearnerModel; workDir: string; runCases: CaseRunner; limitMs?: number; now?: () => number;
  /** all: the gate tests every earlier check (a repair). Else the related ones and a sample (chooseEarlier). */
  allEarlier?: boolean; touched?: Toucher; random?: () => number }): Promise<Learned> {
  const now = options.now ?? Date.now, deadline = now() + (options.limitMs ?? FIX_LIMIT_MS);
  const folder = dirname(resolve(file)), name = basename(file), several = corrections.length > 1, maxTries = several ? 1 : MAX_TRIES;
  const base = join(options.workDir, 'base'), room = join(options.workDir, 'room');
  removeTree(options.workDir);
  mkdirSync(options.workDir, { recursive: true, mode: 0o700 });
  const each = (outcome: Final) => corrections.map(c => ({ id: c.id, ...outcome }) as CorrectionOutcome);
  // An agent that reports no usage (or a stub) leaves the count out.
  const withTokens = (outcomes: CorrectionOutcome[]) => tokens ? outcomes.map(o => ({ ...o, tokens: Math.round(tokens / corrections.length) })) : outcomes;
  const done = (outcomes: CorrectionOutcome[], tries: number, extra: Partial<Learned> = {}): Learned => ({ outcomes: withTokens(outcomes), changed: [], diff: '', tries, log: options.workDir, ...extra });
  try { copyMethod(folder, base); copyMethod(folder, room); }
  catch (error: any) { if (error.code === 'too_large') return done(each({ outcome: 'could_not_test', reason: 'too_large', detail: error.message }), 0); throw error; }
  const written = readWritten(folder);
  await writeBrief(room, corrections);
  // A repair of a broken check is tested on every earlier check, so after it every earlier correction holds again.
  const earlierChecks: EarlierChecks = options.allEarlier || corrections.some(c => c.check) ? { all: true }
    : { touched: options.touched ?? (await import('./quality.js')).touchedSteps, ...(options.random ? { random: options.random } : {}) };
  // The session gets the checks of earlier corrections only when one broke: the gate puts them all back.
  const given = new Set(options.caseIds);
  hideEarlier(room, [...given]);
  const prompt = learnerPrompt(name, corrections, options.caseIds, options.earlier);
  const noFix = (outcome: string) => ({ outcome: 'no_fix_found' as const, detail: outcome });
  // The tokens of the fix: each session and each test run of the gate.
  let tokens = 0;
  const runCases: CaseRunner = async (...args) => { const report = await options.runCases(...args); tokens += reportTokens(report); return report; };
  let failure = '', others: { by: string; note: string }[] | undefined;
  for (let tries = 1; tries <= maxTries; tries++) {
    const left = deadline - now();
    if (left < 60_000) return done(each(noFix(`the time for one correction (${FIX_LIMIT_MS / 3_600_000} hours) ran out`)), tries - 1);
    rmSync(join(room, '.fix', 'result.json'), { force: true });
    const tryDir = join(options.workDir, 'tries', String(tries));
    mkdirSync(tryDir, { recursive: true, mode: 0o700 });
    const text = tries === 1 ? prompt : learnerPrompt(name, corrections, options.caseIds, options.earlier, failure);
    const session = await learnerAgent.session({ room, prompt: text, model: options.model, timeoutMs: left, workDir: tryDir });
    tokens += sessionTokens(session.run_dir);
    if (session.status === 'timeout') return done(each(noFix(`the time for one correction (${FIX_LIMIT_MS / 3_600_000} hours) ran out`)), tries);
    if (session.status === 'failed') throw Error(session.message ?? 'The learner\'s session stopped.');
    restoreEarlier(base, room);
    const checked = await gate({ file, base, room, caseIds: options.caseIds, corrections, written, runCases, earlierChecks });
    if (checked.pass) {
      const outcomes = corrections.map((c, i) => ({ id: c.id, ...checked.finals.get(options.caseIds[i]!)! }) as CorrectionOutcome);
      const fixed = outcomes.some(o => o.outcome === 'fixed'), kept = outcomes.filter(o => o.outcome === 'no_change_needed').map(o => options.caseIds[outcomes.indexOf(o)]!);
      if (!fixed && !kept.length) return { outcomes: withTokens(outcomes), changed: [], diff: '', tries, log: options.workDir };
      const all = changedFiles(base, room);
      const changed = fixed ? all : all.filter(p => kept.some(id => p.startsWith(`cases/${id}/`)));
      const diff = fixed ? changeDiff(base, room, changed.filter(p => !p.startsWith('cases/'))) : '';
      for (const o of outcomes) if (o.outcome === 'fixed') o.diff = diff;
      const next = nextWritten(textPlaces(parseDocumentValue(readFileSync(join(base, name), 'utf8')), base), textPlaces(parseDocumentValue(readFileSync(join(room, name), 'utf8')), room), written);
      return { outcomes: withTokens(outcomes), room, base, changed, diff, written: next, tries, log: options.workDir };
    }
    failure = checked.failure; others = checked.others;
    writeFileSync(join(tryDir, 'gate.txt'), failure + '\n');
    // The next try reads and tests only the earlier checks that a change broke.
    for (const id of checked.checks ?? []) given.add(id);
    hideEarlier(room, [...given]);
  }
  // Several corrections that found no change together: each half is fixed again on its own.
  if (several) return done([], maxTries, { split: true });
  // Two people want different results: a fix for this one breaks only checks that other people made.
  if (others?.length && others.every(o => o.by)) return done(each({ outcome: 'held', by: others[0]!.by, detail: clip(others[0]!.note, 200) }), MAX_TRIES);
  // The exact failures stay in the work folder (tries/N/gate.txt); the person reads one plain line.
  return done(each(noFix(`I tried ${MAX_TRIES} changes, and none fixed this result without breaking another one or your own words`)), MAX_TRIES);
}

/** The tokens that the case runs of a test report used: every run of every case, the changed version's and the old one's. */
export const reportTokens = (report: any) => ((report?.cases ?? []) as any[]).reduce((sum, row) => sum + [row.candidate, row.baseline].flatMap(r => r?.attempts ?? []).reduce((s: number, a: any) => s + (Number(a?.tokens) || 0), 0), 0);
/** The tokens that one agent session reported, from its run's events. */
export function sessionTokens(runDir: string | undefined) {
  if (!runDir) return 0;
  try {
    const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    return events.filter(e => ['codex.completed', 'agent.completed'].includes(e.event)).flatMap(e => Array.isArray(e.usage) ? e.usage : e.usage ? [e.usage] : [])
      .reduce((sum: number, u: any) => sum + ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((t, k) => t + (Number(u?.[k]) || 0), 0), 0);
  } catch { return 0; }
}

/** The diff of a change: each changed text file, as unified lines. */
export function changeDiff(base: string, room: string, paths: string[]) {
  const read = (root: string, path: string) => { const full = join(root, path); try { return lstatSync(full).isFile() ? readFileSync(full) : null; } catch { return null; } };
  return paths.map(path => {
    const before = read(base, path), after = read(room, path);
    const binary = (b: Buffer | null) => !!b && b.subarray(0, 8192).includes(0);
    if (binary(before) || binary(after)) return `--- ${path}\n+++ ${path}\n(a binary file changed)`;
    return textDiff(before?.toString('utf8') ?? '', after?.toString('utf8') ?? '', before ? path : '/dev/null', after ? path : '/dev/null');
  }).join('\n');
}
