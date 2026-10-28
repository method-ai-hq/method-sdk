import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { methodIssues } from '@withmethod/runtime/document.js';
import { loadWorkflow, parseDocumentValue } from '../../workflow-language/src/validate.js';
import { authoringGuide } from './method-help.js';
import { methodContent } from './versions.js';
import { writePrivateJson } from './files.js';
import type { CorrectionOutcome, CouldNotTestReason, TestedOutput } from './fix-lines.js';
import { correctionName } from './fix-lines.js';
import { textDiff } from './text-diff.js';

// Method's learner. A person corrected a run; one agent session (Claude Code, or Codex when that is the Method's agent,
// on the person's own subscription, on the model and effort of the Method's own agent steps) works in a private copy
// of the Method's folder, as a person who builds Methods with the Method CLI would: it writes the check of the
// correction, changes whatever the Method needs, and runs method validate and method test. Then a gate in this code,
// which the agent cannot skip, decides: the new check fails on the Method as it was and passes on the new one, every
// earlier check that passed still passes, the person's own words are unchanged unless they approved the change, and
// the Method is valid. A failed gate goes back to the agent with the exact failure, at most MAX_TRIES times in all.

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
export type CaseRunner = (file: string, flags: Record<string, never>, options: { casesDir?: string; ids?: string[]; baseline?: string; newIds?: string[] }) => Promise<any>;

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
// The learner may add text anywhere; it changes or removes a paragraph of the person's only when the person answered
// a question of this correction that quotes it.

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

/**
 * The person's paragraphs that a change removed or changed, by place. before and after are the text places of the
 * Method as it was and as it is now; written is what Method's learner wrote; approved is the question of this
 * correction that the person answered (its quoted paragraphs may change).
 */
export function changedUserText(before: Map<string, string>, after: Map<string, string>, written: Written, approved?: string | null) {
  const changed: { place: string; paragraph: string }[] = [];
  for (const [place, text] of before) {
    const mine = new Set(written.places[place] ?? []);
    const now = new Set(paragraphs(after.get(place) ?? ''));
    for (const paragraph of paragraphs(text)) {
      if (mine.has(hashOf(paragraph)) || now.has(paragraph)) continue;
      if (approved && quotes(approved, paragraph)) continue;
      changed.push({ place, paragraph });
    }
  }
  return changed;
}

/** The record of what Method's learner wrote after a change: what it wrote before and still stands, and every new paragraph. */
export function nextWritten(before: Map<string, string>, after: Map<string, string>, written: Written): Written {
  const places: Record<string, string[]> = {};
  for (const [place, text] of after) {
    const old = new Set(paragraphs(before.get(place) ?? '')), mine = new Set(written.places[place] ?? []);
    const hashes = [...new Set(paragraphs(text).filter(p => !old.has(p) || mine.has(hashOf(p))).map(hashOf))];
    if (hashes.length) places[place] = hashes;
  }
  return { format: 'method-written/1', places };
}

// ---------- The private copy ----------

/** Copy the Method folder without run records, secrets or Method's private files; link its dependencies. */
function copyMethod(source: string, target: string) {
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

/** Write the brief of the correction in .fix/ of the room. */
async function writeBrief(room: string, file: string, correction: LearnerCorrection, earlier: EarlierCorrection[], caseId: string, written: Written) {
  const fix = join(room, '.fix');
  mkdirSync(fix, { recursive: true, mode: 0o700 });
  const note = correction.note?.trim() || 'The person marked this result wrong, without words.';
  writeFileSync(join(fix, 'correction.md'), [`# The correction`, '', `${correction.noted_by ? `${correction.noted_by} wrote` : 'The person wrote'} (${day(correction.created_at)}):`, '', note, '',
    ...(correction.corrected !== undefined && correction.corrected !== null ? ['The result that the person says is right is in .fix/corrected.txt.', ''] : []),
    ...(correction.answer?.trim() ? [`Asked "${correction.question?.trim() ?? ''}", the person answered:`, '', correction.answer.trim(), ''] : []),
    `The check of this correction has the ID ${caseId}.`, ''].join('\n'));
  if (correction.corrected !== undefined && correction.corrected !== null) writeFileSync(join(fix, 'corrected.txt'), show(correction.corrected, 1_000_000) + '\n');
  // The run as it is: its folder for method case new, and what a reader needs from it.
  cpSync(correction.run_dir, join(fix, 'run'), { recursive: true, verbatimSymlinks: true });
  const { outcomeOfRun } = await import('@withmethod/runtime/cases.js');
  const outcome: any = await outcomeOfRun(join(fix, 'run'));
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
  walk(join(fix, 'run', 'artifacts'));
  writeFileSync(join(fix, 'run.md'), ['# The run that the person corrected', '', `Its folder is .fix/run (give it to method case new as --run .fix/run).`, '',
    '## Inputs', '', '```json', show(outcome.inputs), '```', '', '## Result', '', '```', show(outcome.result), '```', '',
    '## Step outputs', '', ...Object.entries(outcome.outputs ?? {}).flatMap(([name, value]) => [`### ${name}`, '', '```', show(value), '```', '']),
    '## What its agent steps did (transcripts)', '', ...(transcripts.length ? transcripts.map(t => `- ${t}`) : ['None.']), '',
    '## Files it wrote', '', ...(written_files.length ? written_files.map(f => `- ${f}`) : ['None.']), ''].join('\n'));
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

/** The prompt of the learner's session. */
export function learnerPrompt(file: string, caseId: string) {
  return `You are the learner of a Method: a workflow in this folder, in the file ${file}. A person corrected one of its runs. Change the Method so that it does what the person asks on every later run, as a careful person who builds Methods with the Method CLI would.

Read these first:
- .fix/correction.md: the correction in the person's words.
- .fix/run.md and .fix/run/: the run that the person corrected: its inputs, its step outputs, its result, what its agent steps did, and the files it wrote.
- .fix/corrections.md: every earlier correction of this Method, with its check and what happened to it.
- .fix/guide.md: how to build a Method that just works, and the Method CLI.
- ${file}, the files it names, learned.json (rules learned from earlier corrections) and cases/ (the checks of earlier corrections).

Then:
1. Write the check of this correction: method case new ${file} --run .fix/run --id ${caseId} --note "THE PERSON'S WORDS" --rubric "ONE PLAIN SENTENCE THAT A RIGHT RESULT MEETS" (repeat --rubric; or --expect FILE, for example with a predicate script for an exact rule, a form or an action). It must fail on this run and pass on a right result. Check only what the correction asks for.
2. Find the cause and change the Method. You may change anything: a prompt, a learned rule in learned.json, a new run step with a data file, a check, a split of a step that does too much, examples. Put exact rules, values, dates and lists in code or data; use a model step only for judgement; one task per prompt; add a check on an output that matters.
3. Run method validate ${file} and method test ${file}. Every check in cases/ must pass, the new one too.
4. Write .fix/result.json, one of:
   {"outcome": "fixed", "summary": "ONE PLAIN SENTENCE FOR THE PERSON: what the agent does differently now"}
   {"outcome": "no_change_needed", "detail": "WHY, IN PLAIN WORDS FOR THE PERSON"}: the run, or the Method as it is now, already does what the correction asks. Write the check anyway (with --passing-run .fix/run in place of --run when this run already meets it): it must pass on the Method as it is.
   {"outcome": "question", "question": "ONE SHORT QUESTION IN THE PERSON'S TERMS"}: the correction is not clear, or the fix needs a change to the person's own words.
   {"outcome": "no_fix_found", "detail": "WHY, IN PLAIN WORDS FOR THE PERSON"}: the cause is outside the Method (the input, the data, a tool), or no change works.
   Write for the person about their work: no names of steps, files, checks or Method's parts.

When you finish, Method checks your work, and gives you the exact failure when it does not pass:
- The person's own words stay word for word. Every paragraph of the goal and the prompts in ${file}, and of the .md and .txt files in this folder, was written by the person, except the paragraphs in .fix/method-text.md. Add text before, after or between their paragraphs as you need. To change or remove one of their paragraphs, ask first: give outcome question, and quote the paragraph in the question.
- The new check fails on the Method as it was, and passes on your version (3 runs in 3 when a model step runs live).
- Every earlier check that passed before still passes. Change no file in cases/ except your new check.
- method validate ${file} gives no errors.
Send nothing and change no real service. A file that you delete stays in the folder: to stop using it, take it out of ${file}. Keep notes for a later try in .fix/notes.md.`;
}

// ---------- The gate ----------

type AgentResult = { outcome: 'fixed' | 'no_change_needed' | 'question' | 'no_fix_found'; summary?: string; detail?: string; question?: string };
function readResult(room: string): AgentResult | string {
  let value: any;
  try { value = JSON.parse(readFileSync(join(room, '.fix', 'result.json'), 'utf8')); }
  catch { return 'There is no .fix/result.json with your outcome, or it is not JSON. Write it as the instructions say.'; }
  const text = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : undefined;
  if (value?.outcome === 'fixed') return text(value.summary) ? { outcome: 'fixed', summary: text(value.summary)! } : '.fix/result.json says fixed, but has no summary for the person.';
  if (value?.outcome === 'question') return text(value.question) ? { outcome: 'question', question: text(value.question)! } : '.fix/result.json asks a question, but has no question.';
  if (value?.outcome === 'no_change_needed' || value?.outcome === 'no_fix_found') return { outcome: value.outcome, ...(text(value.detail) ? { detail: text(value.detail)! } : {}) };
  return '.fix/result.json must have outcome fixed, no_change_needed, question or no_fix_found.';
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
 * is the run that they corrected, not the session's copy of it in .fix/run.
 */
function settleCase(path: string, correction: LearnerCorrection) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    const real = (dir: unknown) => typeof dir === 'string' && /(^|[\\/])\.fix[\\/]run$/.test(dir) ? resolve(correction.run_dir) : dir;
    const source = value.source && typeof value.source === 'object' ? { ...value.source, run_dir: real(value.source.run_dir), ...(value.source.passing_run_dir ? { passing_run_dir: real(value.source.passing_run_dir) } : {}) } : value.source;
    writeFileSync(path, JSON.stringify({ ...value, source, ...(correction.noted_by ? { author: correction.noted_by } : {}) }, null, 2) + '\n');
  } catch { /* the gate refuses a check that it cannot read */ }
}

type Final = Omit<CorrectionOutcome, 'id'>;
type Checked = { pass: true; final: Final } | { pass: false; failure: string; others?: { by: string; note: string }[] };

/** The gate: what the agent's work comes to, or the exact failure for its next try. */
async function gate(ctx: { file: string; base: string; room: string; caseId: string; correction: LearnerCorrection; written: Written; runCases: CaseRunner }): Promise<Checked> {
  const { file, base, room, caseId } = ctx;
  const name = basename(file), baseFile = join(base, name), roomFile = join(room, name);
  const said = readResult(room);
  if (typeof said === 'string') return { pass: false, failure: said };
  if (said.outcome === 'question') return { pass: true, final: { outcome: 'question', question: said.question! } };
  if (said.outcome === 'no_fix_found') return { pass: true, final: { outcome: 'no_fix_found', ...(said.detail ? { detail: said.detail } : {}) } };
  const problems: string[] = [];
  // The checks of earlier corrections stay as they are; the new one is there.
  const changed = changedFiles(base, room);
  for (const path of changed.filter(p => p.startsWith('cases/') && !p.startsWith(`cases/${caseId}/`))) problems.push(`You changed ${path}, a file of an earlier check. Put it back as it was.`);
  if (!existsSync(join(room, 'cases', caseId, 'case.json'))) problems.push(`There is no check cases/${caseId}. Write it with method case new ${name} --run .fix/run --id ${caseId} ….`);
  else settleCase(join(room, 'cases', caseId, 'case.json'), ctx.correction);
  // The Method is valid.
  let document: any;
  try { document = parseDocumentValue(readFileSync(roomFile, 'utf8')); loadWorkflow(methodContent(document)); }
  catch (error) { return { pass: false, failure: [...problems, `${name} is not a valid Method: ${(error as Error).message}`].join('\n') }; }
  const errors = (methodIssues(readFileSync(roomFile, 'utf8')) as any[]).filter(issue => issue.level === 'error');
  for (const issue of errors) problems.push(`method validate: ${issue.step ? `step ${issue.step}: ` : ''}${issue.message}${issue.fix ? ` ${issue.fix}` : ''}`);
  // The person's words.
  const approved = ctx.correction.answer?.trim() ? ctx.correction.question ?? null : null;
  for (const { place, paragraph } of changedUserText(textPlaces(parseDocumentValue(readFileSync(baseFile, 'utf8')), base), textPlaces(document, room), ctx.written, approved))
    problems.push(`You changed the person's own words in ${placeName(place)}: "${clip(paragraph, 200)}". Put the paragraph back word for word. To change it, ask the person first (outcome question) and quote it in the question.`);
  if (problems.length) return { pass: false, failure: problems.join('\n') };
  const casesDir = join(room, 'cases');
  if (said.outcome === 'no_change_needed') {
    const report = await ctx.runCases(baseFile, {}, { casesDir, ids: [caseId] });
    const result = report.cases?.find((c: any) => c.id === caseId)?.candidate;
    if (result?.status === 'pass') return { pass: true, final: { outcome: 'no_change_needed', ...(said.detail ? { detail: said.detail } : {}) } };
    if (result?.status === 'unverifiable') return { pass: true, final: { outcome: 'could_not_test', reason: unverifiableReason(result), detail: 'The check of this correction cannot run safely.' } };
    return { pass: false, failure: `You said no change is needed, but the check ${caseId} fails on the Method as it is: ${failReasons(result)}. Change the Method, or write a check that the run meets.` };
  }
  // fixed: the new check fails before and passes now; every earlier check that passed before still passes.
  const report = await ctx.runCases(roomFile, {}, { casesDir, baseline: baseFile, newIds: [caseId] });
  const rows: any[] = report.cases ?? [];
  const mine = rows.find(r => r.id === caseId);
  if (!mine) return { pass: false, failure: `method test did not run the check ${caseId}. Make sure that it is an active check of ${name}.` };
  if (mine.verdict === 'unverifiable') return { pass: true, final: { outcome: 'could_not_test', reason: unverifiableReason(mine.candidate), detail: 'The check of this correction cannot run safely on the changed Method.', ...(mine.candidate?.attempts?.find((a: any) => a.path)?.path ? { path: mine.candidate.attempts.find((a: any) => a.path).path } : {}) } };
  if (mine.verdict === 'not_red') problems.push(`The check ${caseId} passes on the Method as it was, so it does not show the mistake. Write a check that fails on this run.`);
  else if (mine.verdict !== 'fixed') problems.push(`The check ${caseId} does not pass on your version: ${failReasons(mine.candidate)}.`);
  const others: { by: string; note: string }[] = [];
  for (const row of rows.filter(r => r.id !== caseId)) {
    const broke = row.verdict === 'regression' || (row.verdict === 'unverifiable' && row.baseline?.status !== 'unverifiable');
    if (!broke) continue;
    const made = caseAuthor(join(casesDir, row.id));
    problems.push(`${row.verdict === 'regression' ? 'Your change breaks' : 'Your change makes it impossible to run safely'} the check ${row.id}, from ${correctionName({ author: made.author, note: made.note })}${row.verdict === 'regression' ? `: ${failReasons(row.candidate)}` : ''}.`);
    if (made.author && ctx.correction.noted_by && made.author !== ctx.correction.noted_by) others.push({ by: made.author, note: made.note });
    else others.push({ by: '', note: made.note });
  }
  if (problems.length) return { pass: false, failure: problems.join('\n'), others };
  const earlier = rows.filter(r => r.id !== caseId && ['pass', 'fixed'].includes(r.verdict)).length;
  const shown = testedOutput(mine.candidate);
  return { pass: true, final: { outcome: 'fixed', summary: said.summary!, tested: { times: mine.candidate?.passes ?? 1, earlier }, ...(shown ? { tested_output: shown } : {}) } };
}

// ---------- One correction ----------

/** What the learner did with one correction. A fixed or no_change_needed outcome leaves its work in room. */
export type Learned = { outcome: CorrectionOutcome; room?: string; base?: string; changed: string[]; diff: string; written?: Written; tries: number; log: string };

/**
 * Learn from one correction in a private copy of the Method's folder, in workDir: up to MAX_TRIES sessions of the
 * agent, each checked by the gate. Returns the outcome; for fixed, the room holds the change, with its diff.
 */
export async function learnCorrection(file: string, correction: LearnerCorrection, options: { earlier: EarlierCorrection[]; caseId: string; model: LearnerModel; workDir: string; runCases: CaseRunner; limitMs?: number; now?: () => number }): Promise<Learned> {
  const now = options.now ?? Date.now, deadline = now() + (options.limitMs ?? FIX_LIMIT_MS);
  const folder = dirname(resolve(file)), name = basename(file);
  const base = join(options.workDir, 'base'), room = join(options.workDir, 'room');
  rmSync(options.workDir, { recursive: true, force: true });
  mkdirSync(options.workDir, { recursive: true, mode: 0o700 });
  const done = (outcome: Omit<CorrectionOutcome, 'id'>, tries: number): Learned => ({ outcome: { id: correction.id, ...outcome } as CorrectionOutcome, changed: [], diff: '', tries, log: options.workDir });
  try { copyMethod(folder, base); copyMethod(folder, room); }
  catch (error: any) { if (error.code === 'too_large') return done({ outcome: 'could_not_test', reason: 'too_large', detail: error.message }, 0); throw error; }
  const written = readWritten(folder);
  await writeBrief(room, name, correction, options.earlier, options.caseId, written);
  const prompt = learnerPrompt(name, options.caseId);
  let failure = '', others: { by: string; note: string }[] | undefined;
  for (let tries = 1; tries <= MAX_TRIES; tries++) {
    const left = deadline - now();
    if (left < 60_000) return done({ outcome: 'no_fix_found', detail: `the time for one correction (${FIX_LIMIT_MS / 3_600_000} hours) ran out` }, tries - 1);
    rmSync(join(room, '.fix', 'result.json'), { force: true });
    const tryDir = join(options.workDir, 'tries', String(tries));
    mkdirSync(tryDir, { recursive: true, mode: 0o700 });
    const text = tries === 1 ? prompt : `${prompt}\n\nThis is try ${tries} of ${MAX_TRIES}. Your earlier work is still in this folder. Method checked it, and it did not pass:\n${failure}\nFix this, run method test ${name} again, and write .fix/result.json again.`;
    const session = await learnerAgent.session({ room, prompt: text, model: options.model, timeoutMs: left, workDir: tryDir });
    if (session.status === 'timeout') return done({ outcome: 'no_fix_found', detail: `the time for one correction (${FIX_LIMIT_MS / 3_600_000} hours) ran out` }, tries);
    if (session.status === 'failed') throw Error(session.message ?? 'The learner\'s session stopped.');
    const checked = await gate({ file, base, room, caseId: options.caseId, correction, written, runCases: options.runCases });
    if (checked.pass) {
      const outcome = { id: correction.id, ...checked.final } as CorrectionOutcome;
      if (outcome.outcome !== 'fixed' && outcome.outcome !== 'no_change_needed') return { outcome, changed: [], diff: '', tries, log: options.workDir };
      const changed = outcome.outcome === 'fixed' ? changedFiles(base, room) : changedFiles(base, room).filter(p => p.startsWith(`cases/${options.caseId}/`));
      const diff = outcome.outcome === 'fixed' ? changeDiff(base, room, changed.filter(p => !p.startsWith('cases/'))) : '';
      if (outcome.outcome === 'fixed') outcome.diff = diff;
      const next = nextWritten(textPlaces(parseDocumentValue(readFileSync(join(base, name), 'utf8')), base), textPlaces(parseDocumentValue(readFileSync(join(room, name), 'utf8')), room), written);
      return { outcome, room, base, changed, diff, written: next, tries, log: options.workDir };
    }
    failure = checked.failure; others = checked.others;
    writeFileSync(join(tryDir, 'gate.txt'), failure + '\n');
  }
  // Two people want different results: a fix for this one breaks only checks that other people made.
  if (others?.length && others.every(o => o.by)) return done({ outcome: 'held', by: others[0]!.by, detail: clip(others[0]!.note, 200) }, MAX_TRIES);
  // The exact failures stay in the work folder (tries/N/gate.txt); the person reads one plain line.
  return done({ outcome: 'no_fix_found', detail: `I tried ${MAX_TRIES} changes, and none fixed this result without breaking another one or your own words` }, MAX_TRIES);
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
