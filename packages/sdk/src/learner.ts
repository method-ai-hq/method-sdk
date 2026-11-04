import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { methodIssues } from '@withmethod/runtime/document.js';
import { loadWorkflow, parseDocumentValue } from '../../workflow-language/src/validate.js';
import { authoringGuide } from './method-help.js';
import { methodContent } from './versions.js';
import { removeTree, writePrivateJson } from './files.js';
import type { CorrectionOutcome, CouldNotTestReason, TestedOutput } from './fix-lines.js';
import { correctionName } from './fix-lines.js';
import { textDiff } from './text-diff.js';

// Method's learner. A person corrected a run; one agent session (Claude Code, or Codex when that is the Method's agent,
// on the person's own subscription, on the model and effort of the Method's own agent steps) works in a private copy
// of the Method's folder, as a person who builds Methods with the Method CLI would: it writes the check of the
// correction, changes whatever the Method needs, and runs method validate and method test on its new check. Then a
// gate in this code, which the agent cannot skip, decides: the new check fails on the Method as it was and passes on
// the new one, every earlier check that passed still passes, the person's own words are unchanged unless they approved
// the change, and the Method is valid. The gate tests the new check first, and every earlier check only when it
// passes, all runs at once; the old version runs an earlier check only when the new one fails it. A failed gate goes
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
};
/** An earlier correction of the Method, with what happened to it. */
export type EarlierCorrection = { id: string; note: string | null; noted_by?: string | null; created_at?: string; outcome?: string | null; detail?: string | null; answer?: string | null };
/** What the agent's session did: completed, timed out, or failed with a message. */
export type SessionResult = { status: 'completed' | 'timeout' | 'failed'; final_text?: string; message?: string; run_dir?: string };
/** Runs cases as method test does (quality.ts runCases); tests replace it. */
export type CaseRunner = (file: string, flags: Record<string, never>, options: { casesDir?: string; ids?: string[]; baseline?: string; newIds?: string[]; gate?: boolean; firstRun?: boolean; moreRuns?: number }) => Promise<any>;

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

/** What a reader needs from a run: its inputs, outputs, result, transcripts and files, in .fix/NAME.md. */
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
  writeFileSync(join(fix, `${name}.md`), ['# The run that the person corrected', '', `Its folder is .fix/${name} (give it to method case new as --run .fix/${name}).`, '',
    '## Inputs', '', '```json', show(outcome.inputs), '```', '', '## Result', '', '```', show(outcome.result), '```', '',
    '## Step outputs', '', ...Object.entries(outcome.outputs ?? {}).flatMap(([key, value]) => [`### ${key}`, '', '```', show(value), '```', '']),
    '## What its agent steps did (transcripts)', '', ...(transcripts.length ? transcripts.map(t => `- ${t}`) : ['None.']), '',
    '## Files it wrote', '', ...(written_files.length ? written_files.map(f => `- ${f}`) : ['None.']), ''].join('\n'));
}

/** Write the brief of the corrections in .fix/ of the room. */
async function writeBrief(room: string, file: string, corrections: LearnerCorrection[], earlier: EarlierCorrection[], caseIds: string[], written: Written) {
  const fix = join(room, '.fix'), n = corrections.length;
  mkdirSync(fix, { recursive: true, mode: 0o700 });
  const words = (correction: LearnerCorrection, k: number) => [`${correction.noted_by ? `${correction.noted_by} wrote` : 'The person wrote'} (${day(correction.created_at)}):`, '', correction.note?.trim() || 'The person marked this result wrong, without words.', '',
    ...(correction.corrected !== undefined && correction.corrected !== null ? [`The result that the person says is right is in .fix/${correctedName(k, n)}.`, ''] : []),
    ...(correction.answer?.trim() ? [`Asked "${correction.question?.trim() ?? ''}", the person answered:`, '', correction.answer.trim(), ''] : [])];
  writeFileSync(join(fix, 'correction.md'), (n === 1 ? ['# The correction', '', ...words(corrections[0]!, 1), `The check of this correction has the ID ${caseIds[0]}.`, '']
    : [`# The corrections`, '', `People corrected ${n} runs. Fix them together, in one change.`, '',
      ...corrections.flatMap((c, i) => [`## Correction ${i + 1}`, '', ...words(c, i + 1), `Its run is .fix/${runName(i + 1, n)} (.fix/${runName(i + 1, n)}.md). Its check has the ID ${caseIds[i]}.`, ''])]).join('\n'));
  for (const [i, correction] of corrections.entries()) {
    if (correction.corrected !== undefined && correction.corrected !== null) writeFileSync(join(fix, correctedName(i + 1, n)), show(correction.corrected, 1_000_000) + '\n');
    await writeRun(room, correction, runName(i + 1, n));
  }
  const cases = join(room, 'cases');
  writeFileSync(join(fix, 'corrections.md'), ['# Earlier corrections of this Method, oldest first', '',
    ...(earlier.length ? earlier.map((c, i) => {
      const check = ['correction-' + c.id.replace(/^jdg_/, '').slice(0, 12)].find(id => existsSync(join(cases, id, 'case.json')));
      return [`${i + 1}. ${day(c.created_at)}${c.noted_by ? `, ${c.noted_by}` : ''}: ${c.note?.trim() || '(no words)'}`,
        ...(c.answer?.trim() ? [`   Their answer to a question: ${c.answer.trim()}`] : []),
        `   What happened: ${c.outcome ?? 'not decided yet'}${c.detail ? ` (${c.detail})` : ''}.`, `   Its check: ${check ? `cases/${check}` : 'none'}.`].join('\n');
    }) : ['None.']), ''].join('\n'));
  writeFileSync(join(fix, 'guide.md'), `${authoringGuide('all')}\n`);
  // The paragraphs that Method wrote itself; every other paragraph of the instructions is the person's.
  const document = parseDocumentValue(readFileSync(join(room, basename(file)), 'utf8'));
  const mine = [...textPlaces(document, room)].flatMap(([place, text]) => {
    const hashes = new Set(written.places[place] ?? []);
    const own = paragraphs(text).filter(p => hashes.has(hashOf(p)));
    return own.length ? [`## ${placeName(place)}`, '', ...own.map(p => `- ${p}`), ''] : [];
  });
  writeFileSync(join(fix, 'method-text.md'), ['# Paragraphs that Method wrote', '', 'You may change or remove these. Every other paragraph of the instructions is the person\'s.', '', ...(mine.length ? mine : ['None.', ''])].join('\n'));
}

/** The prompt of the learner's session, for one correction or several, with the ID of each one's check. */
export function learnerPrompt(file: string, caseIds: string[]) {
  const one = caseIds.length === 1, id = caseIds[0]!;
  const outcomes = `{"outcome": "fixed", "summary": "ONE PLAIN SENTENCE FOR THE PERSON: what the agent does differently now"}
   {"outcome": "no_change_needed", "detail": "WHY, IN PLAIN WORDS FOR THE PERSON"}: the run, or the Method as it is now, already does what the correction asks. Write the check anyway (with --passing-run ${one ? '.fix/run' : 'ITS RUN'} in place of --run when this run already meets it): it must pass on the Method as it is.
   {"outcome": "question", "question": "ONE SHORT QUESTION IN THE PERSON'S TERMS"}: only when the only fix is to change or remove a paragraph of the person's own words; quote it. When the correction is short or you are unsure how far it goes, do not ask: make the change that the correction's own words support, and keep what it left.
   {"outcome": "no_fix_found", "detail": "WHY, IN PLAIN WORDS FOR THE PERSON"}: the cause is outside the Method (the input, the data, a tool), or no change works.`;
  return `You are the learner of a Method: a workflow in this folder, in the file ${file}. ${one ? 'A person corrected one of its runs' : `People corrected ${caseIds.length} of its runs`}. Change the Method so that it does what ${one ? 'the person asks' : 'each correction asks'} on every later run, as a careful person who builds Methods with the Method CLI would.

Read these first:
- .fix/correction.md: ${one ? 'the correction in the person\'s words' : 'each correction in the person\'s words, with its run and the ID of its check'}.
- ${one ? '.fix/run.md and .fix/run/: the run that the person corrected' : '.fix/run-1.md and .fix/run-1/, .fix/run-2.md and .fix/run-2/, ...: each run that a person corrected'}: its inputs, its step outputs, its result, what its agent steps did, and the files it wrote.
- .fix/corrections.md: every earlier correction of this Method, with its check and what happened to it.
- .fix/guide.md: how to build a Method that just works, and the Method CLI.
- ${file}, the files it names, learned.json (rules learned from earlier corrections) and cases/ (the checks of earlier corrections).

Then:
1. Write the check of ${one ? 'this correction' : 'each correction'}: method case new ${file} --run ${one ? '.fix/run' : 'ITS RUN'} --id ${one ? id : 'ITS CHECK ID'} --note "THE PERSON'S WORDS" --rubric "ONE PLAIN SENTENCE THAT A RIGHT RESULT MEETS" (repeat --rubric; or --expect FILE, for example with a predicate script for an exact rule, a form or an action). It must fail on ${one ? 'this run' : 'its run'} and pass on a right result. Check what the correction asks for, and keep what it left: when the person names some parts of a result as wrong (some answers of several, some lines or fields), they read the rest and left it, so the check also requires each part that they did not correct to stay as it is in this run (a predicate script with --expect does this exactly). Leave a part out only when the correction says that it was not checked.
2. Find the cause and change the Method. You may change anything: a prompt, a learned rule in learned.json, a new run step with a data file, a check, a split of a step that does too much, examples. Put exact rules, values, dates and lists in code or data; use a model step only for judgement; one task per prompt; add a check on an output that matters.
3. Run method validate ${file} and ${one ? `method test ${file} --case ${id}` : `method test ${file} --case ID for each new check`}. You need not test the earlier checks: when you finish, Method tests every earlier check itself, and gives you any that your change breaks.
4. Write .fix/result.json, ${one ? `one of:
   ${outcomes}` : `with one outcome for each check ID: {"outcomes": {"CHECK ID": OUTCOME, ...}}, where each OUTCOME is one of:
   ${outcomes}`}
   Write for the person about their work: no names of steps, files, checks or Method's parts.

When you finish, Method checks your work, and gives you the exact failure when it does not pass:
- The person's own words stay word for word. Every paragraph of the goal and the prompts in ${file}, and of the .md and .txt files in this folder, was written by the person, except the paragraphs in .fix/method-text.md. Add text before, after or between their paragraphs as you need. You may move a paragraph of theirs, unchanged, to another prompt or another .md or .txt file, for example to split a step. To change or remove one of their paragraphs, ask first: give outcome question, and quote the paragraph in the question.
- The new check fails on the Method as it was, and passes on your version (3 runs in 3 when a model step runs live).
- Every earlier check that passed before still passes. Change no file in cases/ except your new check${one ? '' : 's'}.
- method validate ${file} gives no errors.
Send nothing and change no real service. A file that you delete stays in the folder: to stop using it, take it out of ${file}. Keep notes for a later try in .fix/notes.md.`;
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

/** A full test of the earlier checks that would take longer than this shows "Fixed" after one run of each. */
export const LATER_AFTER_MS = 180_000;
/** The case runs that run at once (the runtime's run places), for the estimate of a test's time. */
const RUNS_AT_ONCE = 12;

/** The earlier checks that a change broke, as failures for the agent and the people whose checks they are. */
export function broken(rows: any[], casesDir: string, correction: LearnerCorrection | undefined) {
  const problems: string[] = [], others: { by: string; note: string }[] = [];
  for (const row of rows) {
    const broke = row.verdict === 'regression' || (row.verdict === 'unverifiable' && row.baseline?.status !== 'unverifiable');
    if (!broke) continue;
    const made = caseAuthor(join(casesDir, row.id));
    problems.push(`${row.verdict === 'regression' ? 'Your change breaks' : 'Your change makes it impossible to run safely'} the check ${row.id}, from ${correctionName({ author: made.author, note: made.note })}${row.verdict === 'regression' ? `: ${failReasons(row.candidate)}` : ''}.`);
    others.push(made.author && correction?.noted_by && made.author !== correction.noted_by ? { by: made.author, note: made.note } : { by: '', note: made.note });
  }
  const notRun = rows.filter(r => r.verdict === 'not_run').length;
  if (problems.length && notRun) problems.push(`Method stopped testing at ${problems.length === 1 ? 'this failure' : 'these failures'}: ${notRun} other earlier check${notRun === 1 ? '' : 's'} did not run yet.`);
  return { problems, others };
}

type Final = Omit<CorrectionOutcome, 'id'>;
type Checked = { pass: true; finals: Map<string, Final>; later?: string[] } | { pass: false; failure: string; others?: { by: string; note: string }[] };

/**
 * The gate: what the agent's work comes to for each correction, or the exact failure for its next try. Method tests
 * the new checks first; only when they pass does it test every earlier check, once per fix. later: when that full
 * test would take longer than LATER_AFTER_MS, each earlier check makes one run now, and Checked.later names the checks
 * whose other runs finishLater makes after the change is applied.
 */
async function gate(ctx: { file: string; base: string; room: string; caseIds: string[]; corrections: LearnerCorrection[]; written: Written; runCases: CaseRunner; later: boolean }): Promise<Checked> {
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
    else settleCase(join(room, 'cases', id, 'case.json'), ctx.corrections[caseIds.indexOf(id)]!);
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
  const earlierIds = (await listCases(roomFile, casesDir)).filter((c: any) => c.status === 'active' && !fixed.includes(c.id)).map((c: any) => c.id as string);
  // The time of a full test: three runs of each earlier check, RUNS_AT_ONCE at a time, each as long as a run of the new check.
  const runs = fixed.flatMap(id => mine.get(id)?.candidate?.attempts ?? []);
  const times = runs.map((a: any) => a.duration_ms).filter((ms: unknown): ms is number => typeof ms === 'number').sort((a, b) => a - b);
  const live = runs.some((a: any) => a.live_model_steps?.length);
  const full = Math.ceil(3 * earlierIds.length / RUNS_AT_ONCE) * (times[Math.floor(times.length / 2)] ?? 0);
  const firstRun = ctx.later && live && full > LATER_AFTER_MS;
  const rows: any[] = earlierIds.length ? (await ctx.runCases(roomFile, {}, { casesDir, ids: earlierIds, baseline: baseFile, gate: true, ...(firstRun ? { firstRun: true } : {}) })).cases ?? [] : [];
  const { problems: broke, others } = broken(rows, casesDir, ctx.corrections.length === 1 ? ctx.corrections[0] : undefined);
  if (broke.length) return { pass: false, failure: broke.join('\n'), others };
  const earlier = rows.filter(r => ['pass', 'fixed'].includes(r.verdict)).length;
  const later = rows.filter(r => r.more).map(r => r.id as string);
  for (const id of fixed) {
    const row = mine.get(id), shown = testedOutput(row.candidate);
    finals.set(id, { outcome: 'fixed', summary: said.get(id)!.summary!, tested: { times: row.candidate?.passes ?? 1, earlier, ...(later.length ? { later: 2 } : {}) }, ...(shown ? { tested_output: shown } : {}) });
  }
  return { pass: true, finals, ...(later.length ? { later } : {}) };
}

/**
 * The rest of a test that showed "Fixed" after one run of each earlier check: the other runs of each check in later,
 * on the room (the version that was applied) against the base. Undefined when every run passed; else the failure for
 * the agent and the earlier corrections it broke, as people read them.
 */
export async function finishLater(learned: Learned, file: string, runCases: CaseRunner) {
  if (!learned.later?.length || !learned.room || !learned.base) return undefined;
  const name = basename(file), casesDir = join(learned.room, 'cases');
  const report = await runCases(join(learned.room, name), {}, { casesDir, ids: learned.later, baseline: join(learned.base, name), gate: true, moreRuns: 2 });
  const rows: any[] = report.cases ?? [];
  const { problems } = broken(rows, casesDir, undefined);
  if (!problems.length) return undefined;
  const names = rows.filter(r => r.verdict === 'regression' || r.verdict === 'unverifiable').map(r => correctionName(caseAuthor(join(casesDir, r.id))));
  return { failure: problems.join('\n'), broke: names };
}

// ---------- One correction, or several together ----------

/**
 * What the learner did with its corrections, one outcome for each, in their order. A fixed or no_change_needed
 * outcome leaves its work in room. later: earlier checks whose other runs finishLater makes. split: several
 * corrections found no change together; each half is fixed again on its own.
 */
export type Learned = { outcomes: CorrectionOutcome[]; room?: string; base?: string; changed: string[]; diff: string; written?: Written; tries: number; log: string; later?: string[]; split?: boolean };

/**
 * Learn from corrections in a private copy of the Method's folder, in workDir: up to MAX_TRIES sessions of the agent
 * for one correction, each checked by the gate, or one session for several corrections together (a failed gate splits
 * them). Returns the outcomes; for a fixed one, the room holds the change, with its diff. later: the gate may show
 * "Fixed" after one run of each earlier check when the full test is slow. failure: why an earlier change for these
 * corrections was undone, for the agent.
 */
export async function learnCorrection(file: string, corrections: LearnerCorrection[], options: { earlier: EarlierCorrection[]; caseIds: string[]; model: LearnerModel; workDir: string; runCases: CaseRunner; later?: boolean; failure?: string; limitMs?: number; now?: () => number }): Promise<Learned> {
  const now = options.now ?? Date.now, deadline = now() + (options.limitMs ?? FIX_LIMIT_MS);
  const folder = dirname(resolve(file)), name = basename(file), several = corrections.length > 1, maxTries = several ? 1 : MAX_TRIES;
  const base = join(options.workDir, 'base'), room = join(options.workDir, 'room');
  removeTree(options.workDir);
  mkdirSync(options.workDir, { recursive: true, mode: 0o700 });
  const each = (outcome: Final) => corrections.map(c => ({ id: c.id, ...outcome }) as CorrectionOutcome);
  const done = (outcomes: CorrectionOutcome[], tries: number, extra: Partial<Learned> = {}): Learned => ({ outcomes, changed: [], diff: '', tries, log: options.workDir, ...extra });
  try { copyMethod(folder, base); copyMethod(folder, room); }
  catch (error: any) { if (error.code === 'too_large') return done(each({ outcome: 'could_not_test', reason: 'too_large', detail: error.message }), 0); throw error; }
  const written = readWritten(folder);
  await writeBrief(room, name, corrections, options.earlier, options.caseIds, written);
  const prompt = learnerPrompt(name, options.caseIds) + (options.failure ? `\n\nAn earlier change for ${several ? 'these corrections' : 'this correction'} passed its first tests and was applied. Then Method tested the earlier checks again, and the change broke one, so Method undid it:\n${options.failure}\nFind a change that keeps every earlier check passing.` : '');
  const noFix = (outcome: string) => ({ outcome: 'no_fix_found' as const, detail: outcome });
  let failure = '', others: { by: string; note: string }[] | undefined;
  for (let tries = 1; tries <= maxTries; tries++) {
    const left = deadline - now();
    if (left < 60_000) return done(each(noFix(`the time for one correction (${FIX_LIMIT_MS / 3_600_000} hours) ran out`)), tries - 1);
    rmSync(join(room, '.fix', 'result.json'), { force: true });
    const tryDir = join(options.workDir, 'tries', String(tries));
    mkdirSync(tryDir, { recursive: true, mode: 0o700 });
    const text = tries === 1 ? prompt : `${prompt}\n\nThis is try ${tries} of ${maxTries}. Your earlier work is still in this folder. Method checked it, and it did not pass:\n${failure}\nFix this, test your new check again, and write .fix/result.json again.`;
    const session = await learnerAgent.session({ room, prompt: text, model: options.model, timeoutMs: left, workDir: tryDir });
    if (session.status === 'timeout') return done(each(noFix(`the time for one correction (${FIX_LIMIT_MS / 3_600_000} hours) ran out`)), tries);
    if (session.status === 'failed') throw Error(session.message ?? 'The learner\'s session stopped.');
    const checked = await gate({ file, base, room, caseIds: options.caseIds, corrections, written, runCases: options.runCases, later: !!options.later });
    if (checked.pass) {
      const outcomes = corrections.map((c, i) => ({ id: c.id, ...checked.finals.get(options.caseIds[i]!)! }) as CorrectionOutcome);
      const fixed = outcomes.some(o => o.outcome === 'fixed'), kept = outcomes.filter(o => o.outcome === 'no_change_needed').map(o => options.caseIds[outcomes.indexOf(o)]!);
      if (!fixed && !kept.length) return { outcomes, changed: [], diff: '', tries, log: options.workDir };
      const all = changedFiles(base, room);
      const changed = fixed ? all : all.filter(p => kept.some(id => p.startsWith(`cases/${id}/`)));
      const diff = fixed ? changeDiff(base, room, changed.filter(p => !p.startsWith('cases/'))) : '';
      for (const o of outcomes) if (o.outcome === 'fixed') o.diff = diff;
      const next = nextWritten(textPlaces(parseDocumentValue(readFileSync(join(base, name), 'utf8')), base), textPlaces(parseDocumentValue(readFileSync(join(room, name), 'utf8')), room), written);
      return { outcomes, room, base, changed, diff, written: next, tries, log: options.workDir, ...(checked.later ? { later: checked.later } : {}) };
    }
    failure = checked.failure; others = checked.others;
    writeFileSync(join(tryDir, 'gate.txt'), failure + '\n');
  }
  // Several corrections that found no change together: each half is fixed again on its own.
  if (several) return done([], maxTries, { split: true });
  // Two people want different results: a fix for this one breaks only checks that other people made.
  if (others?.length && others.every(o => o.by)) return done(each({ outcome: 'held', by: others[0]!.by, detail: clip(others[0]!.note, 200) }), MAX_TRIES);
  // The exact failures stay in the work folder (tries/N/gate.txt); the person reads one plain line.
  return done(each(noFix(`I tried ${MAX_TRIES} changes, and none fixed this result without breaking another one or your own words`)), MAX_TRIES);
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
