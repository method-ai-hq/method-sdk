import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { methodIssues } from '@withmethod/runtime/document.js';
import { packagePath } from '../../contracts/src/method-package.js';
import { loadWorkflow, parseDocumentValue } from '../../workflow-language/src/validate.js';
import { authoringPath, readDocument } from './authoring.js';
import { DEFAULT_SERVER, type MethodClient } from './method-client.js';
import { removeTree, writePrivateJson } from './files.js';
import { methodContent, methodIdPattern } from './versions.js';
import { saveLocalProposal, writeMethodFile } from './proposals.js';
import { changedSteps } from './merge.js';
import { localMethodFolder } from './local-judgments.js';
import { fixFolder } from './fix-outcomes.js';
import { recordChange, saveVersion, snapshot } from './undo.js';
import { authoringGuide } from './method-help.js';
import { cliBin } from './prepare.js';
import { checkInputs, lookupFailure } from './generalize.js';
import { FIX_LIMIT_MS, MAX_TRIES, broken, unconfirmedChecks, changeLookups, reportTokens, sessionTokens, changeDiff, changedFiles, changedUserText, copyMethod, learnerAgent, nextWritten, paragraphs, placeName, readWritten, textPlaces, writeRun, writtenFile,
  type CaseRunner, type LearnerModel, type Written } from './learner.js';

// Method's redesign. One agent session (the learner's agent, on the model of the Method's own agent steps) rewrites a
// Method A from the problem into B, as Ryan did with the Promex invoice Method: it reads the guide (with "Design from the
// problem"), the Method, the corrections with their runs, and the saved checks that it may see, writes the design first,
// and may replace, split, add or remove any step, prompt, script or data file. The saved checks are numbered oldest
// first: the session sees the odd ones (with their corrections); the even ones are held back, and it never sees, writes
// or edits them. Its gate is the learner's on the checks that it sees: each one that passed still passes, the person's
// own words stay word for word (a paragraph may move, unchanged), and the Method is valid. Then code runs A and B once
// on the input of each held-back check, with every model step live, and counts the held-back checks that each passes
// and the tokens and time that each used. B must complete every test and preserve each case A passed. It must also
// improve accuracy within KEEP_TOKENS times A's tokens or reduce tokens at equal accuracy. Otherwise A stays, with
// both counts. A kept B is applied with an undo record and saved as a new version. No check is added: the saved checks
// are the person's corrections. A Method with fewer than 2 saved checks has nothing to hold back: no session runs.

/** A correction that the redesign reads: the person's words, what happened to it, and its run when it is here. */
export type RedesignCorrection = { id: string; note: string | null; noted_by?: string | null; created_at?: string; outcome?: string | null; detail?: string | null; answer?: string | null; run_dir?: string | undefined };
/** What one version did on the held-back checks: how many passed, and the tokens and seconds of its runs. */
export type HeldBackRun = { passed: number; tokens: number; seconds: number; results: Record<string, 'pass' | 'fail' | 'unconfirmed'> };
/** The held-back test of a redesign: the number of held-back checks, and what A (the Method as it was) and B (the redesign) did on them. */
export type HeldBack = { checks: number; a: HeldBackRun; b: HeldBackRun };
export type Redesigned = { outcome: 'redesigned' | 'discarded' | 'no_change_needed' | 'no_redesign_found' | 'not_tried'; summary?: string; detail?: string; room?: string; base?: string; changed: string[]; diff: string; written?: Written; tries: number; log: string; checks: number; tokens: number; held_back?: HeldBack };

/** Even an accuracy improvement must stay within this cost multiplier. */
export const KEEP_TOKENS = 1.2;
/** A measured improvement cannot trade away an earlier passing check or hide a check that did not run. */
export function keepRedesign(held: HeldBack) {
  const ids = Object.keys(held.a.results);
  if (!held.checks || ids.length !== held.checks || Object.keys(held.b.results).length !== held.checks) return false;
  if (ids.some(id => !['pass', 'fail'].includes(held.a.results[id]!) || !['pass', 'fail'].includes(held.b.results[id]!)
    || (held.a.results[id] === 'pass' && held.b.results[id] !== 'pass'))) return false;
  if (![held.a.tokens, held.b.tokens].every(n => Number.isFinite(n) && n >= 0)) return false;
  const a = ids.filter(id => held.a.results[id] === 'pass').length, b = ids.filter(id => held.b.results[id] === 'pass').length;
  return b > a ? held.b.tokens <= KEEP_TOKENS * held.a.tokens : b === a && held.b.tokens < held.a.tokens;
}

/** The saved checks of a Method, numbered oldest first from 1: the redesign sees the odd ones; the even ones are held back. */
export async function splitChecks(file: string, casesDir: string) {
  const { listCases } = await import('@withmethod/runtime/cases.js');
  const ids = (await listCases(file, casesDir)).filter((c: any) => c.status === 'active')
    .sort((a: any, b: any) => String(a.created ?? '').localeCompare(String(b.created ?? '')) || a.id.localeCompare(b.id)).map((c: any) => c.id as string);
  return { seen: ids.filter((_, i) => i % 2 === 0), held: ids.filter((_, i) => i % 2 === 1) };
}

const MODEL_KINDS = new Set(['call', 'agent', 'classify', 'session']);
/**
 * Run one version once on the input of each held-back check (in casesDir), with every model step live, so that its
 * tokens are what a run costs, not what a replay serves. Counts the checks that pass, the tokens and the seconds.
 */
async function heldBackRun(runCases: CaseRunner, file: string, casesDir: string, ids: string[]): Promise<HeldBackRun> {
  const document = parseDocumentValue(readFileSync(file, 'utf8')) as any;
  const live = Object.entries<any>(document.steps ?? {}).filter(([, step]) => MODEL_KINDS.has(step?.do?.kind)).map(([id]) => id);
  const report = await runCases(file, {}, { casesDir, ids, once: true, ...(live.length ? { live } : {}) } as any);
  const rows = (report.cases ?? []) as any[];
  const results: HeldBackRun['results'] = Object.fromEntries(ids.map(id => {
    const matches = rows.filter(row => row.id === id), status = matches.length === 1 ? matches[0].candidate?.status : undefined;
    return [id, status === 'pass' || status === 'fail' ? status : 'unconfirmed'];
  }));
  return { passed: Object.values(results).filter(status => status === 'pass').length, results, tokens: reportTokens(report),
    seconds: Math.round(rows.reduce((sum, r) => sum + (r.candidate?.attempts ?? []).reduce((s: number, a: any) => s + (Number(a?.duration_ms) || 0), 0), 0) / 1000) };
}

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');
const day = (at?: string | null) => at ? at.slice(0, 10) : 'date unknown';
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;

/** The prompt of the redesign session. The same text for every Method: it names no task. */
export function redesignPrompt(file: string) {
  const cli = `'${join(cliBin(), 'method').replace(/'/g, `'\\''`)}'`;
  return `You are given a Method (a workflow of steps) in this folder, in the file ${file}, Method's guide in .fix/guide.md, and what the people who use it said, in .fix/corrections.md, with each corrected run in .fix/. First write in .fix/design.md the observed failure, its cause, and the smallest design change that addresses it. Use only the corrections, their runs and the checks in cases/. Preserve working behavior, the model and the complete source context. Prefer one model call when the task fits in context. Do not split a task into separate agents, add an audit, or select source passages by keywords merely because there are several output fields. Add such a stage only when the observed failure requires it and the validation demonstrates an improvement. You may replace, split, add or remove any step, prompt, script or data file. State the conditions under which a learned rule applies and when it does not. An unexplained label for one example does not justify a rule for every input. Never store a file name or an answer lookup for one input.

Keep the person's own words word for word: every paragraph of the goal and the prompts in ${file}, and of the .md and .txt files in this folder, except the paragraphs in .fix/method-text.md. You may move one of their paragraphs, unchanged, to another prompt or another .md or .txt file, and you may pass a file of theirs whole to every step that applies it; do not reword, shorten or drop one.

Use ${cli} for every Method command. Run ${cli} validate ${file}. Leave model test runs to Method's independent gate; it tests the change after you write .fix/result.json. Change no file in cases/. Send nothing and change no real service. Do not look for other inputs of this task outside this folder.

Then write .fix/result.json, one of:
   {"outcome": "redesigned", "summary": "ONE PLAIN SENTENCE FOR THE PERSON: what the agent does differently now"}
   {"outcome": "no_change_needed", "detail": "WHY, IN PLAIN WORDS FOR THE PERSON"}: the Method already follows this design.
Write for the person about their work: no names of steps, files, checks or Method's parts.

When you finish, Method checks your work, and gives you the exact failure when it does not pass: the person's words are kept, no line that you add holds 80 or more letters and digits of the input of only one check or the file name of a check's input, validation gives no errors, and every check in cases/ that passed before still passes. A separate validation compares both versions on the same saved cases withheld from this rewrite. It must preserve each earlier passing case, complete every test, and improve accuracy within the cost limit or reduce cost at the same accuracy. A tie alone is not an improvement. These are previously taught cases, not proof of performance on new inputs.`;
}

/** Write what the session reads in .fix/: the guide, every correction with its run, and the paragraphs Method wrote. */
async function writeBrief(room: string, name: string, corrections: RedesignCorrection[], written: Written, held: string[]) {
  const fix = join(room, '.fix');
  mkdirSync(fix, { recursive: true, mode: 0o700 });
  writeFileSync(join(fix, 'guide.md'), `${authoringGuide('all')}\n`);
  const lines: string[] = ['# The corrections of this Method, oldest first', ''];
  let k = 0;
  // A correction whose check is held back is held back too: its words and its run.
  for (const c of corrections.filter(c => !held.includes(`correction-${c.id.replace(/^jdg_/, '').slice(0, 12)}`))) {
    k++;
    let run = 'its run is not on this computer';
    if (c.run_dir && existsSync(c.run_dir)) { await writeRun(room, { run_dir: c.run_dir }, `run-${k}`); run = `its run is .fix/run-${k} (.fix/run-${k}.md)`; }
    const check = `correction-${c.id.replace(/^jdg_/, '').slice(0, 12)}`;
    lines.push(`${k}. ${day(c.created_at)}${c.noted_by ? `, ${c.noted_by}` : ''}: ${c.note?.trim() || '(no words)'}`,
      ...(c.answer?.trim() ? [`   Their answer to a question: ${c.answer.trim()}`] : []),
      `   What happened: ${c.outcome ?? 'not decided yet'}${c.detail ? ` (${c.detail})` : ''}; ${run}; its check: ${existsSync(join(room, 'cases', check, 'case.json')) ? `cases/${check}` : 'none'}.`, '');
  }
  if (!corrections.length) lines.push('None.', '');
  writeFileSync(join(fix, 'corrections.md'), lines.join('\n'));
  const document = parseDocumentValue(readFileSync(join(room, name), 'utf8'));
  const mine = [...textPlaces(document, room)].flatMap(([place, text]) => {
    const own = paragraphs(text).filter(p => (written.places[place] ?? []).includes(hashOf(p)));
    return own.length ? [`## ${placeName(place)}`, '', ...own.map(p => `- ${p}`), ''] : [];
  });
  writeFileSync(join(fix, 'method-text.md'), ['# Paragraphs that Method wrote', '', 'You may change or remove these. Every other paragraph of the instructions is the person\'s.', '', ...(mine.length ? mine : ['None.', ''])].join('\n'));
}

/** The gate: the exact failure for the next try, or undefined when the redesign passes. */
async function gate(file: string, base: string, room: string, written: Written, runCases: CaseRunner, held: string[]): Promise<{ failure: string } | { said: { outcome: 'redesigned' | 'no_change_needed'; summary?: string; detail?: string }; checks: number }> {
  const name = basename(file), baseFile = join(base, name), roomFile = join(room, name);
  let said: any;
  try { said = JSON.parse(readFileSync(join(room, '.fix', 'result.json'), 'utf8')); }
  catch { return { failure: 'There is no .fix/result.json with your outcome, or it is not JSON. Write it as the instructions say.' }; }
  if (said?.outcome === 'no_change_needed') return { said: { outcome: 'no_change_needed', ...(typeof said.detail === 'string' && said.detail.trim() ? { detail: said.detail.trim() } : {}) }, checks: 0 };
  if (said?.outcome !== 'redesigned' || typeof said.summary !== 'string' || !said.summary.trim()) return { failure: '.fix/result.json must have outcome redesigned with a summary for the person, or outcome no_change_needed.' };
  const problems: string[] = [];
  for (const path of changedFiles(base, room).filter(p => p.startsWith('cases/') && !held.some(id => p.startsWith(`cases/${id}/`)))) problems.push(`You changed ${path}, a file of a saved check. Put it back as it was.`);
  let document: any;
  try { document = parseDocumentValue(readFileSync(roomFile, 'utf8')); loadWorkflow(methodContent(document)); }
  catch (error) { return { failure: [...problems, `${name} is not a valid Method: ${(error as Error).message}`].join('\n') }; }
  for (const issue of (methodIssues(readFileSync(roomFile, 'utf8')) as any[]).filter(i => i.level === 'error')) problems.push(`method validate: ${issue.step ? `step ${issue.step}: ` : ''}${issue.message}${issue.fix ? ` ${issue.fix}` : ''}`);
  for (const { place, paragraph } of changedUserText(textPlaces(parseDocumentValue(readFileSync(baseFile, 'utf8')), base), textPlaces(document, room), written))
    problems.push(`You changed the person's own words in ${placeName(place)}: "${clip(paragraph, 200)}". Put the paragraph back word for word; you may move it, unchanged, to another prompt or file.`);
  const lookups = changeLookups(base, room, changedFiles(base, room).filter(p => !p.startsWith('cases/')), checkInputs(join(room, 'cases')), document);
  if (lookups.length) problems.push(lookupFailure(lookups));
  if (problems.length) return { failure: problems.join('\n') };
  const casesDir = join(room, 'cases');
  const { listCases } = await import('@withmethod/runtime/cases.js');
  const ids = existsSync(casesDir) ? (await listCases(roomFile, casesDir)).filter((c: any) => c.status === 'active').map((c: any) => c.id as string) : [];
  const rows: any[] = ids.length ? (await runCases(roomFile, {}, { casesDir, ids, baseline: baseFile, gate: true })).cases ?? [] : [];
  const { problems: broke } = broken(rows, casesDir, undefined);
  if (broke.length) return { failure: broke.join('\n') };
  const unconfirmed = unconfirmedChecks(ids, rows);
  if (unconfirmed.length) return { failure: unconfirmed.join('\n') };
  return { said: { outcome: 'redesigned', summary: said.summary.trim() }, checks: rows.filter(r => ['pass', 'fixed'].includes(r.verdict)).length };
}

/**
 * Rewrite a Method from the problem in a private copy of its folder, in workDir: up to MAX_TRIES sessions, each checked
 * by the gate. A redesigned outcome leaves its work in room, with its diff and the record of the words Method wrote.
 */
export async function redesignMethod(file: string, options: { corrections: RedesignCorrection[]; model: LearnerModel; workDir: string; runCases: CaseRunner; limitMs?: number; now?: () => number }): Promise<Redesigned> {
  const now = options.now ?? Date.now, deadline = now() + (options.limitMs ?? FIX_LIMIT_MS);
  const folder = dirname(resolve(file)), name = basename(file);
  const base = join(options.workDir, 'base'), room = join(options.workDir, 'room');
  removeTree(options.workDir);
  mkdirSync(options.workDir, { recursive: true, mode: 0o700 });
  // The tokens of the redesign: each session and each test run of the gate.
  let tokens = 0;
  const runCases: CaseRunner = async (...args) => { const report = await options.runCases(...args); tokens += reportTokens(report); return report; };
  const done = (outcome: Redesigned['outcome'], tries: number, extra: Partial<Redesigned> = {}): Redesigned => ({ outcome, changed: [], diff: '', tries, log: options.workDir, checks: 0, ...extra, tokens });
  copyMethod(folder, base);
  // Fewer than 2 saved checks: nothing to hold back, so a redesign could not be tested against the Method as it is.
  const { seen, held } = await splitChecks(join(base, name), join(base, 'cases'));
  if (!held.length) { removeTree(base); return done('not_tried', 0, { detail: `a redesign is tested on the checks that it does not see, and ${name} has ${seen.length ? 'only 1 saved check' : 'no saved checks'}; it needs at least 2` }); }
  copyMethod(folder, room);
  for (const id of held) removeTree(join(room, 'cases', id));
  const written = readWritten(folder);
  await writeBrief(room, name, options.corrections, written, held);
  const prompt = redesignPrompt(name);
  let failure = '';
  for (let tries = 1; tries <= MAX_TRIES; tries++) {
    const left = deadline - now();
    if (left < 60_000) return done('no_redesign_found', tries - 1, { detail: 'the time for a redesign ran out' });
    rmSync(join(room, '.fix', 'result.json'), { force: true });
    const tryDir = join(options.workDir, 'tries', String(tries));
    mkdirSync(tryDir, { recursive: true, mode: 0o700 });
    const text = tries === 1 ? prompt : `${prompt}\n\nThis is try ${tries} of ${MAX_TRIES}. Your earlier work is still in this folder. Method checked it, and it did not pass:\n${failure}\nFix this and write .fix/result.json again. Method runs the tests.`;
    const session = await learnerAgent.session({ room, prompt: text, model: options.model, timeoutMs: left, workDir: tryDir });
    tokens += sessionTokens(session.run_dir);
    if (session.status === 'timeout') return done('no_redesign_found', tries, { detail: 'the time for a redesign ran out' });
    if (session.status === 'failed') throw Error(session.message ?? 'The redesign session stopped.');
    const checked = await gate(file, base, room, written, runCases, held);
    if ('said' in checked) {
      if (checked.said.outcome === 'no_change_needed') return done('no_change_needed', tries, checked.said.detail ? { detail: checked.said.detail } : {});
      const changed = changedFiles(base, room).filter(p => !p.startsWith('cases/'));
      const next = nextWritten(textPlaces(parseDocumentValue(readFileSync(join(base, name), 'utf8')), base), textPlaces(parseDocumentValue(readFileSync(join(room, name), 'utf8')), room), written);
      // A and B, once each, on the inputs of the held-back checks (the checks are base's: the session never had them).
      const [a, b] = await Promise.all([heldBackRun(runCases, join(base, name), join(base, 'cases'), held), heldBackRun(runCases, join(room, name), join(base, 'cases'), held)]);
      const held_back: HeldBack = { checks: held.length, a, b };
      const result = { summary: checked.said.summary!, room, base, changed, diff: changeDiff(base, room, changed), written: next, checks: checked.checks, held_back };
      return done(keepRedesign(held_back) ? 'redesigned' : 'discarded', tries, result);
    }
    failure = checked.failure;
    writeFileSync(join(tryDir, 'gate.txt'), failure + '\n');
  }
  return done('no_redesign_found', MAX_TRIES, { detail: `none of ${MAX_TRIES} new designs kept every earlier correction and your own words` });
}

/** Apply a redesign that passed: its files, the Method, the record of Method's words, an undo record and a version. */
async function applyRedesign(client: MethodClient, file: string, methodId: string | undefined, result: Redesigned) {
  const folder = dirname(resolve(file)), name = basename(file);
  const inFolder = (path: string) => { const full = resolve(folder, packagePath(path)); if (!full.startsWith(folder + sep)) throw Error(`The change names a file outside the Method folder: ${path}`); return full; };
  const before = snapshot(file, [...result.changed.filter(p => p !== name), '.method/written.json']);
  const baseWorkflow = methodContent(readDocument(file));
  const content = methodContent(parseDocumentValue(readFileSync(join(result.room!, name), 'utf8')) as any);
  loadWorkflow(content);
  localMethodFolder(file);
  for (const path of result.changed) {
    if (path === name) continue;
    const from = join(result.room!, path), to = inFolder(path);
    if (existsSync(from) && statSync(from).isFile()) { mkdirSync(dirname(to), { recursive: true }); cpSync(from, to); } else rmSync(to, { force: true });
  }
  if (!isDeepStrictEqual(content, baseWorkflow)) writeMethodFile(file, methodId, content);
  writePrivateJson(writtenFile(folder), result.written);
  const undo = recordChange(file, 'fix', result.summary!, 'the redesign', before);
  if (methodId) saveLocalProposal(file, { id: `lp_${randomBytes(8).toString('hex')}`, method_id: methodId, base_version_id: null, status: 'applied', cause: result.summary!,
    evidence: { kind: 'redesign', steps: changedSteps(baseWorkflow, content), summary: result.summary, diff: result.diff, files: result.changed, tries: result.tries },
    created_at: new Date().toISOString(), applied_at: new Date().toISOString(), base_workflow: baseWorkflow, proposed_workflow: content, judgments: [], outcomes: [], undo_id: undo.id });
  await saveVersion(client, file, `Method rewrote it from the problem: ${result.summary}`.slice(0, 500));
}

/**
 * Redesign a Method file and apply the change when it passes: the corrections come from the account (with their runs
 * on this computer). Waits while a fix of the Method runs here, and holds the fix lock, so no fix runs meanwhile.
 */
export async function redesignFile(client: MethodClient, file: string, options: { runCases?: CaseRunner; pollMs?: number } = {}): Promise<Redesigned> {
  const document = readDocument(file) as any;
  const methodId = typeof document.id === 'string' && methodIdPattern.test(document.id) ? document.id as string : undefined;
  const { takeLock } = await import('./improve.js');
  const lock = methodId ? join(fixFolder(methodId), 'lock') : undefined;
  if (lock) while (!takeLock(lock)) await new Promise(wait => setTimeout(wait, options.pollMs ?? 2000));
  try { return await redesignHere(client, file, options); } finally { if (lock) rmSync(lock, { force: true }); }
}

/** Redesign a Method file and apply the change when it is kept. The caller holds the Method's fix lock. */
export async function redesignHere(client: MethodClient, file: string, options: { runCases?: CaseRunner } = {}): Promise<Redesigned> {
  const document = readDocument(file) as any;
  const methodId = typeof document.id === 'string' && methodIdPattern.test(document.id) ? document.id as string : undefined;
  const { learnerModel, methodJudgments, markRedesigned } = await import('./improve.js');
  const corrections: RedesignCorrection[] = methodId && client.token() ? (await methodJudgments(client, file, methodId)).filter(j => j.verdict === 'wrong').sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map(j => ({ id: j.id, note: j.note, noted_by: j.noted_by ?? null, created_at: j.created_at, outcome: j.outcome ?? null, detail: j.outcome_detail ?? null, answer: j.answer ?? null, run_dir: j.run_dir })) : [];
  const runCases = options.runCases ?? ((await import('./quality.js')).runCases as unknown as CaseRunner);
  const workDir = join(methodId ? fixFolder(methodId) : join(dirname(resolve(file)), '.method'), 'redesign');
  const result = await redesignMethod(file, { corrections, model: await learnerModel(document), workDir, runCases });
  if (result.outcome === 'redesigned') await applyRedesign(client, file, methodId, result);
  for (const dir of [result.room, result.base]) if (dir) removeTree(dir);
  if (result.outcome !== 'not_tried') await markRedesigned(file);
  return result;
}

/** The line that the person reads. */
export function redesignLine(name: string, result: Redesigned) {
  const held = result.held_back, counts = held ? ` On ${held.checks} held-back check${held.checks === 1 ? '' : 's'} that the rewrite did not see, the new version passed ${held.b.passed} with ${held.b.tokens} tokens in ${held.b.seconds} s, and the version before passed ${held.a.passed} with ${held.a.tokens} tokens in ${held.a.seconds} s.` : '';
  if (result.outcome === 'redesigned') return `Rewrote ${name} from the problem: ${result.summary}${result.checks ? ` Every correction that it saw still holds (${result.checks} checked).` : ''}${counts}`;
  if (result.outcome === 'discarded') return `Redesign tried and discarded: ${name} is unchanged.${counts}`;
  if (result.outcome === 'not_tried') return `Redesign not tried: ${result.detail}.`;
  if (result.outcome === 'no_change_needed') return `${name} already works this way${result.detail ? `: ${result.detail}` : '.'}`;
  return `${name} is unchanged: ${result.detail ?? 'no new design kept every earlier correction and your own words'}.`;
}

/** `method redesign FILE [--json]`: rewrite a Method from the problem, keeping every earlier correction. */
export async function redesignCommand(args: string[], clientFactory: (server: string) => MethodClient) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' }, server: { type: 'string' } } });
  if (positionals.length !== 1) throw Error('Use method redesign FILE.');
  const file = authoringPath(positionals[0]!);
  process.stderr.write(`Rewriting ${basename(file)} from the problem. This takes a while: the new design is tested against every earlier correction.\n`);
  const result = await redesignFile(clientFactory(values.server ?? DEFAULT_SERVER), file);
  const line = redesignLine(basename(file), result);
  process.stdout.write(values.json ? JSON.stringify({ outcome: result.outcome, line, changed: result.changed, tokens: result.tokens, ...(result.held_back ? { held_back: result.held_back } : {}) }, null, 2) + '\n' : line + '\n');
}
