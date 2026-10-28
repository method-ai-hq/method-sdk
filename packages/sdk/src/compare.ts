/**
 * Comparisons: a NAME.compare file asks one question about two or more agents. `method run NAME.compare` checks the
 * file, compiles it into a generated Method and runs that Method. Its
 * steps are the stages: trial (with the noise check), approval (an ask step), treatment, full run, grades, decision.
 * Each cell (arm × learner × checkpoint × input) is one iteration of an each step, so the runtime's step cache reuses
 * every finished cell on a rerun, and a changed measure regrades without running any agent again. Each stage reports
 * to the comparison's page in the Method account (compare-account.ts); a cell is keyed by its content, so a cell that
 * two versions of the file share runs once.
 *
 * Method decides the rules that a writer could get wrong (methodRules): every arm on the same model, effort, task
 * prompt, deliverable file, tools and clean room; a plain arm with corrections is a builder that edits its own
 * instructions; runs count separate learners; corrections arrive one at a time; one Claude judge that reads every
 * source in full and scores "partly" as half; a noise check before approval; usage per correction.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod/v4';
import { loadWorkflow, parseDocumentValue } from '../../workflow-language/src/validate.js';
import { authoringPath, readDocument } from './authoring.js';
import { methodContent, methodIdPattern, newMethodId, writeMethodId } from './versions.js';
import { packageFileNames } from './method-files.js';
import { writePrivateJson } from './files.js';
import { configRoot } from './computer-settings.js';
import { linkCells, readAccount, readAnswers, saveComparison, sendPlan, sendStage, uploadSignedIn, uploadText, type PageAnswers, type PlannedCell } from './compare-account.js';
import { ensureLocalServer, registerLocalRun } from './local-server.js';
import { correctionCaseId } from './improve.js';
import { FIX_LIMIT_MS } from './learner.js';
import { textDiff } from './text-diff.js';

// ---------------------------------------------------------------------------------------------------------------
// The file

const text = z.string().trim().min(1);
const name = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use lowercase letters, digits and underscores, starting with a letter, at most 40 characters.');
/** The comparison's ID in the Method account: written into the file on its first run, like a Method's ID. */
export const comparisonIdPattern = /^cmp_[a-f0-9]{32}$/;
/** The parts of a comparison that can have notes. */
export const noteParts = ['question', 'arms', 'same_for_both', 'inputs', 'treatment', 'measure', 'other_measures', 'runs', 'rule', 'noise', 'run_rules', 'trial', 'assumptions'] as const;
const measureSchema = z.strictObject({
  name: text.describe('A short name for the number, for example "corrected items right".'),
  description: text.optional().describe('What the number is, in plain words, as the page shows it.'),
  code: text.optional().describe('A script (.mjs, .js or .py) that reads {input, output, expected, run_dir, artifacts} as JSON on stdin and prints {"score": NUMBER}.'),
  rubric: z.array(text).min(1).optional().describe('Sentences that must be true of the output. The judge marks each one met, partly or not met; the score is the mean (partly counts as half).'),
  checklist: z.literal('expected').optional().describe('expected: each input\'s checklist is its expected answer, a list of items. Each item is a criterion for that input only. The judge marks each one met, partly or not met.'),
  covered: z.boolean().optional().describe('With checklist: expected, true scores only the items that a correction given so far covers (an item names its events in covered_by).'),
  person: text.optional().describe('A question that a person answers with a number for each output, for example 1 for "would send" and 0 for "would not send".'),
}).describe('One number per run. Higher is better. Give exactly one of code, rubric, checklist or person.');
const armSchema = z.union([
  text.describe('A Method file (.method).'),
  z.strictObject({
    agent: z.enum(['claude', 'codex']).describe('Plain Claude Code or Codex.'),
    instructions: text.describe('A file with the instructions the agent gets.'),
    model: text.optional().describe('Only when the comparison tests the model (tested: model): the model of this arm. Otherwise a plain arm takes the Method arms\' model.'),
    effort: text.optional().describe('Only with tested: model: the reasoning effort of this arm.'),
  }),
]);
const eventSchema = z.strictObject({
  correction: text.optional().describe('The words of a correction, as the expert would say them: "It needs to be X because Y". The arm runs the input, and gets this correction about that run.'),
  feedback: name.optional().describe('Instead of correction: the name of a feedback writer (feedback_writers). The arm runs the input; the writer reads that arm\'s own output and the input\'s hidden expected answer, and writes the correction that the arm gets, or finds nothing wrong (the arm is told the output was right).'),
  input: text.optional().describe('The input (case ID or file) that the arm runs for this event.'),
  model: text.optional().describe('A new model for the arm from this point on.'),
  source: text.optional().describe('Where the correction\'s words come from, such as "her reply of 22 Oct, word for word" or "written by us: a rule kind she called realistic". When it says "written by us", the comparison page asks the expert whether they would give it. For a feedback event, say here what the writer\'s words are when the agent is wrong.'),
});
const feedbackWriterSchema = z.strictObject({
  code: text.optional().describe('A script (.mjs, .js or .py) that reads {input, values, output, expected} as JSON on stdin (output: the text of the file that the arm handed in, or null) and prints {"correction": TEXT or null, "checked": "all" or the part it checked}. correction is null when nothing that it checked is wrong. A null correction with checked "all" tells the arm its output was right; with a part, the arm gets no feedback.'),
  judge: text.optional().describe('A written instruction for one Claude judge, which reads the task, the output and the hidden expected answer and writes the correction, or none when nothing is wrong, and says what it checked.'),
}).describe('What writes the correction from an arm\'s own output. Give exactly one of code or judge.');
const assumptionSchema = z.union([text, z.strictObject({
  text: text.describe('What must be true for the answer to mean something.'),
  if_false: text.optional().describe('What the answer would show if it is false.'),
  check: text.optional().describe('How to check it.'),
  limit: z.literal(true).optional().describe('true for a known limit of the comparison, which needs no if_false or check.'),
})]);
export const comparisonSchema = z.strictObject({
  id: z.string().regex(comparisonIdPattern).optional().describe('The comparison\'s ID in your Method account. Method writes it on the first run; keep it.'),
  question: text.describe('One sentence in your words that names the treatment and the test.'),
  arms: z.record(name, armSchema).describe('Each agent under test, by a short name.'),
  difference: text.describe('The one thing that is different between the arms.'),
  other_differences: z.array(text).optional().describe('Any other difference between the arms.'),
  tested: z.enum(['model', 'tools']).optional().describe('When the difference is the model or the tools, say which. Without it every arm runs on the same model and effort, and no arm uses the web.'),
  inputs: z.array(text).min(1).describe('The inputs that each arm runs: case IDs (folders in cases/ beside this file) or JSON files of input values. The same for each arm. An input\'s own files (inputs/ID/ beside inputs/ID.json, or the case\'s snapshot/env/), one folder per files connection, replace the arms\' folders of those names for that input.'),
  deliverable: text.optional().describe('The file that each arm hands in for an input: a path in its room whose first folder is a files connection, such as work/reply.md. {{NAME}} takes the input\'s value NAME. Needed with a plain arm.'),
  measure: measureSchema.describe('The main measure: one number per run that decides.'),
  rule: z.strictObject({
    margin: z.number().describe('How far ahead an arm must be on the main measure (the mean per run). Above 0.'),
    min_runs: z.number().int().min(1).describe('The fewest learners behind each point.'),
    at: z.number().int().min(0).optional().describe('The checkpoint that decides, when there is a treatment over time.'),
    guard: z.strictObject({ measure: text, max_drop: z.number().min(0) }).optional().describe('Another measure on which the winning arm must not be more than max_drop below the other arm (with more than two arms, the best other arm), at the checkpoint that decides.'),
  }).describe('The decision rule. Anything that does not pass is "can\'t tell yet".'),
  runs: z.number().int().min(1).describe('How many separate learners each arm has. Each learner is its own copy of the arm and gets the full treatment; each point measures each learner once per input.'),
  treatment: z.strictObject({
    events: z.array(eventSchema).min(1).describe('What each arm gets, in order, one at a time.'),
    feedback_writers: z.record(name, feedbackWriterSchema).optional().describe('Feedback writers by name, for events with feedback: each writes the correction from the arm\'s own output and the hidden expected answer. Use one when the expert\'s feedback depends on what the agent did.'),
    checkpoints: z.array(z.number().int().min(0)).min(1).describe('The number of events after which the arms are measured.'),
    seed: z.number().int().optional().describe('Shuffle the events once with this seed: one order, the same for every arm. Without it the events come in the order given.'),
  }).optional().describe('A list of events that each arm gets in order, with checkpoints.'),
  about_inputs: z.strictObject({
    noun: text.optional().describe('What one input is, in one word, such as "task" or "ticket".'),
    description: text.optional().describe('What the measured inputs are, in one sentence.'),
    teaching_description: text.optional().describe('What the teaching inputs are, in one sentence.'),
    names: z.record(text, text).optional().describe('A short name for each input, by input ID.'),
  }).optional().describe('How the page names and describes the inputs. It changes no run.'),
  teaching: z.array(text).min(1).optional().describe('Inputs that the arms learn from (treatment events), kept apart from the measured inputs. A teaching input\'s own files (inputs/ID/ beside inputs/ID.json, or the case\'s snapshot/env/), one folder per files connection, replace the arms\' folders of those names for its training runs.'),
  other_measures: z.array(measureSchema).optional().describe('Numbers that are shown but do not decide.'),
  expected: z.record(text, text).optional().describe('For an input, a file with its correct output. The arms never see it; the measures do. For checklist: expected, a list of items: Markdown "- item" lines, or JSON [{text, covered_by: [EVENT, ...]}].'),
  assumptions: z.array(assumptionSchema).optional().describe('Statements that must be true for the answer to mean something: text, or {text, if_false, check}. Method shows its own checks as checked by Method; these are not checked.'),
  notes: z.strictObject(Object.fromEntries(noteParts.map(part => [part, z.array(text).min(1).optional()])) as Record<(typeof noteParts)[number], z.ZodOptional<z.ZodArray<typeof text>>>)
    .optional().describe(`Notes that the page shows with their part: ${noteParts.join(', ')}.`),
  decided_by_you: z.array(text).optional().describe('The parts or values that the user stated, such as question, rule.margin, arms.plain (which agent the arm is), arms.plain.instructions (its starting instructions) or notes.PART (the notes of a part). Mark a value only when the user stated it. The question counts as the user\'s only when it is in the user\'s own words; a question that the writer rephrased is the writer\'s. The page shows them as decided by you; every other value is the writer\'s choice for review.'),
}).describe('A comparison: one question about two or more agents.');
export type Comparison = z.infer<typeof comparisonSchema>;
type Measure = Comparison['measure'];
/** The JSON schema of a .compare file, for method schema compare. */
export const comparisonJsonSchema = () => z.toJSONSchema(comparisonSchema);

const requiredParts: Record<string, string> = {
  question: 'one sentence in your words',
  arms: 'each agent under test: a Method file, or {agent: claude|codex, instructions: FILE}',
  difference: 'the one thing that is different between the arms',
  inputs: 'the inputs that each arm runs (case IDs or JSON files)',
  measure: 'the main measure: {name, and one of code, rubric, checklist or person}',
  rule: 'the decision rule: {margin, min_runs, at?, guard?: {measure, max_drop}}',
  runs: 'how many separate learners each arm has',
};

const sha = (value: unknown) => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isFileInput = (id: string) => /\.json$/i.test(id);
/** Remove a folder that may hold read-only folders (an agent may make the files it got read-only): make it writable first. */
export function removeFolder(path: string) {
  const writable = (dir: string) => {
    let entries: import('node:fs').Dirent[];
    try { chmodSync(dir, 0o700); entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) writable(join(dir, entry.name));
  };
  writable(path);
  rmSync(path, { recursive: true, force: true });
}
/** The time that Method's learner or a plain builder has for one correction: the learner's own limit, 2 hours. */
export { FIX_LIMIT_MS };
/** How many learners of each arm the trial runs at the start, for the noise check. */
export const NOISE_LEARNERS = 2;

/** An input: a JSON file of input values, or a case ID (cases/ID/recording.json beside the comparison file). */
function inputValue(root: string, id: string): unknown {
  const path = isFileInput(id) ? resolve(root, id) : join(root, 'cases', id, 'recording.json');
  if (!existsSync(path)) throw Error(isFileInput(id) ? `The input file ${id} is not there.` : `The input ${id} is not a file and has no case folder cases/${id}/ beside the comparison.`);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  return isFileInput(id) ? value : value.inputs ?? {};
}
/** A treatment event that corrects the arm: fixed words, or the words that a feedback writer writes from the arm's own output. */
const isCorrection = (event: { correction?: string | undefined; feedback?: string | undefined }) => event.correction !== undefined || event.feedback !== undefined;
const armIsMethod = (arm: Comparison['arms'][string]): arm is string => typeof arm === 'string';
/**
 * The folder of an input's own files, or null: inputs/ID/ beside the file inputs/ID.json, or a case's recorded copy of
 * the folders its run read (cases/ID/snapshot/env/). Each folder in it is named after a files connection. Every arm gets
 * these folders for this input, in place of its own folders of those names.
 */
function inputRoom(root: string, id: string): string | null {
  const path = isFileInput(id) ? resolve(root, id).replace(/\.json$/i, '') : join(root, 'cases', id, 'snapshot', 'env');
  return existsSync(path) && statSync(path).isDirectory() ? path : null;
}

/** The deliverable of an input: the file's path with each {{NAME}} replaced by the input's value NAME. */
export function deliverableOf(template: string, value: unknown) {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, key: string) => {
    const found = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
    if (typeof found !== 'string' && typeof found !== 'number') throw Error(`The deliverable ${template} names {{${key}}}, which the input does not give as a text or a number.`);
    return String(found);
  });
}

/** One item of an input's checklist: a criterion for that input only, and the treatment events that cover it. */
export type ChecklistItem = { id: string; text: string; covered_by: number[] };
/**
 * The checklist of an expected answer: Markdown "- item" (or "1. item") lines, a JSON list of items (text, or
 * {text, covered_by}), or {items: [...]}. Each item is one criterion; nothing is added to it.
 */
export function checklistOf(value: unknown): ChecklistItem[] {
  const list: unknown[] = typeof value === 'string'
    ? value.split('\n').flatMap(line => { const m = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/.exec(line); return m ? [m[1]!] : []; })
    : Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray((value as any).items) ? (value as any).items : [];
  return list.flatMap((item: any, i) => {
    const words = typeof item === 'string' ? item : typeof item?.text === 'string' ? item.text : '';
    if (!words.trim()) return [];
    const covered = Array.isArray(item?.covered_by) ? item.covered_by : item?.covered_by !== undefined ? [item.covered_by] : [];
    return [{ id: `i${i + 1}`, text: words.trim(), covered_by: covered.filter((n: unknown) => Number.isInteger(n)) }];
  });
}
const expectedValue = (root: string, p: string) => { const raw = readFileSync(resolve(root, p), 'utf8'); try { return JSON.parse(raw); } catch { return raw; } };

/** The files connections of a Method arm. */
function connectionsOf(document: any) {
  return Object.entries(document.environment ?? {}).flatMap(([envName, definition]: [string, any]) => definition?.type === 'files' ? [envName] : []);
}

/**
 * Read and check a .compare file. Every problem is named in one error: a missing required part, more than one main
 * measure, a rule that cannot say "can't tell yet", arms that share a Method ID, and inputs or files that are not there.
 */
export function readComparison(file: string): Comparison {
  const path = authoringPath(file), root = dirname(path);
  let raw: any;
  try { raw = parseDocumentValue(readFileSync(path, 'utf8')); } catch (error) { throw Error(`${basename(path)} is not readable YAML or JSON: ${(error as Error).message}`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error(`${basename(path)} must hold the parts of a comparison. Read method authoring comparisons.`);
  const problems: string[] = [];
  for (const [part, what] of Object.entries(requiredParts)) if (raw[part] === undefined || raw[part] === null || raw[part] === '') problems.push(`It has no ${part}. Add ${part}: ${what}.`);
  if (Array.isArray(raw.measure)) problems.push('It has more than one main measure. Keep one under measure; put the others under other_measures.');
  if (problems.length) throw Error(`${basename(path)} cannot run. ${problems.join(' ')}`);
  const parsed = comparisonSchema.safeParse(raw);
  if (!parsed.success) throw Error(`${basename(path)} cannot run. ${parsed.error.issues.map(issue => issue.code === 'unrecognized_keys'
    ? `Unknown part${issue.keys.length === 1 ? '' : 's'} ${issue.keys.join(', ')}${issue.path.length ? ` in ${issue.path.join('.')}` : ''}.`
    : `${issue.path.join('.') || 'The file'}: ${issue.message}.`).join(' ')}`);
  const doc = parsed.data;
  const measures = [doc.measure, ...(doc.other_measures ?? [])];
  for (const m of measures) if ([m.code, m.rubric, m.checklist, m.person].filter(v => v !== undefined).length !== 1) problems.push(`The measure ${m.name} needs exactly one of code, rubric, checklist or person.`);
  for (const m of measures) if (m.covered !== undefined && !m.checklist) problems.push(`The measure ${m.name} has covered, which only a checklist: expected measure can have.`);
  const names = measures.map(m => m.name);
  for (const n of new Set(names)) if (names.filter(x => x === n).length > 1) problems.push(`Two measures are named ${n}. Give each its own name.`);
  for (const m of measures) if (m.code && !existsSync(resolve(root, m.code))) problems.push(`The code of the measure ${m.name} (${m.code}) is not there.`);
  for (const m of measures) if (m.code && !['.mjs', '.js', '.py'].includes(extname(m.code))) problems.push(`The code of the measure ${m.name} must be a .mjs, .js or .py file.`);
  const arms = Object.entries(doc.arms);
  if (arms.length < 2) problems.push('A comparison needs two or more arms.');
  const ids = new Map<string, string>(), connections = new Set<string>(), armConnections = new Map<string, string[]>();
  for (const [armName, arm] of arms) {
    if (!armIsMethod(arm)) {
      if (!existsSync(resolve(root, arm.instructions))) problems.push(`The instructions of the arm ${armName} (${arm.instructions}) are not there.`);
      if ((arm.model !== undefined || arm.effort !== undefined) && doc.tested !== 'model') problems.push(`The plain arm ${armName} names its model or effort. A plain arm takes the Method arms' model and effort; name them only when the model is the tested difference (tested: model).`);
      continue;
    }
    const armFile = resolve(root, arm);
    if (!/\.method$/i.test(arm)) { problems.push(`The arm ${armName} must be a .method file, or {agent: claude|codex, instructions: FILE}.`); continue; }
    if (!existsSync(armFile)) { problems.push(`The Method file of the arm ${armName} (${arm}) is not there.`); continue; }
    let document: any;
    try { document = readDocument(armFile); loadWorkflow(methodContent(document)); } catch (error) { problems.push(`The Method of the arm ${armName} does not load: ${(error as Error).message}`); continue; }
    armConnections.set(armName, connectionsOf(document));
    for (const envName of connectionsOf(document)) connections.add(envName);
    const key = typeof document.id === 'string' && methodIdPattern.test(document.id) ? document.id : armFile;
    const other = ids.get(key);
    if (other) problems.push(`The arms ${other} and ${armName} are the same Method${key.startsWith('wf_') ? ` (${key})` : ''}. Each arm needs its own Method ID: run method new-id ${arm}.`);
    else ids.set(key, armName);
  }
  if (!(doc.rule.margin > 0)) problems.push('The rule needs a margin above 0. With margin 0 any difference decides, so the rule could never say "can\'t tell yet".');
  if (doc.rule.guard && !names.includes(doc.rule.guard.measure)) problems.push(`The guard names the measure ${doc.rule.guard.measure}, which is not one of the measures (${names.join(', ')}).`);
  const inputs = doc.inputs, teaching = doc.teaching ?? [];
  for (const list of [inputs, teaching]) for (const id of new Set(list)) if (list.filter(x => x === id).length > 1) problems.push(`The input ${id} is listed twice.`);
  const values = new Map<string, unknown>();
  for (const id of [...inputs, ...teaching]) { try { values.set(id, inputValue(root, id)); } catch (error) { problems.push((error as Error).message); } }
  for (const id of teaching) if (inputs.includes(id)) problems.push(`The input ${id} is both a teaching input and a measured input. Keep them apart.`);
  // An expected answer is for a measured input, or the hidden answer of an input whose run a feedback writer reads.
  const feedbackInputs = (doc.treatment?.events ?? []).flatMap(event => event.feedback !== undefined && event.input !== undefined ? [event.input] : []);
  for (const [id, expected] of Object.entries(doc.expected ?? {})) {
    if (!inputs.includes(id) && !feedbackInputs.includes(id)) problems.push(`The expected answer for ${id} names no measured input and no input of a feedback event.`);
    if (!existsSync(resolve(root, expected))) problems.push(`The expected answer for ${id} (${expected}) is not there.`);
  }
  // An input's own folder (measured or teaching): each folder in it is named after a files connection, and no expected
  // answer is in it.
  for (const id of [...inputs, ...teaching]) {
    const room = inputRoom(root, id);
    if (!room) continue;
    for (const entry of readdirSync(room, { withFileTypes: true })) {
      if (!entry.isDirectory()) problems.push(`The folder of the input ${id} holds the file ${entry.name}. Put each file in a folder named after the files connection that holds it.`);
      else if (connections.size && !connections.has(entry.name)) problems.push(`The folder of the input ${id} holds ${entry.name}/, which is not a files connection of the Method arms (${[...connections].join(', ')}).`);
    }
    for (const expected of Object.values(doc.expected ?? {})) if (`${resolve(root, expected)}/`.startsWith(`${room}/`)) problems.push(`The expected answer ${expected} is in the folder of the input ${id}, which the arms get. Keep expected answers outside it.`);
  }
  // The deliverable: every arm hands in the same file. A plain agent's last message is no output.
  const plainArms = arms.filter(([, arm]) => !armIsMethod(arm)).map(([armName]) => armName);
  if (plainArms.length && !doc.deliverable) problems.push(`The plain arm ${plainArms[0]} hands in a file, not its last message. Add deliverable: the path of the file that each input asks for, such as work/reply.md, in the folder of one of its files connections.`);
  if (doc.deliverable) {
    const first = doc.deliverable.split('/')[0]!;
    if (!doc.deliverable.includes('/') || doc.deliverable.split('/').some(part => part === '..' || part === '')) problems.push(`The deliverable ${doc.deliverable} must be a path in the room whose first folder is a files connection, such as work/reply.md.`);
    else for (const [armName, own] of armConnections) if (!own.includes(first)) problems.push(`The deliverable ${doc.deliverable} is in ${first}/, which is not a files connection of the Method arm ${armName}${own.length ? ` (${own.join(', ')})` : ''}. A Method arm hands in its file in one of its files folders.`);
    for (const [id, value] of values) { try { deliverableOf(doc.deliverable, value); } catch (error) { problems.push(`For the input ${id}: ${(error as Error).message}`); } }
  }
  // A checklist measure: each measured input's expected answer is its checklist.
  const events = doc.treatment?.events ?? [];
  for (const m of measures.filter(m => m.checklist)) {
    for (const id of inputs) {
      const p = doc.expected?.[id];
      if (!p) { problems.push(`The measure ${m.name} takes each input's checklist from its expected answer, and the input ${id} has none. Add expected: {${id}: FILE}.`); continue; }
      if (!existsSync(resolve(root, p))) continue;
      const items = checklistOf(expectedValue(root, p));
      if (!items.length) problems.push(`The expected answer of ${id} (${p}) lists no items. Write one item per line ("- item"), or a JSON list of items.`);
      for (const item of items) for (const n of item.covered_by) if (!events[n - 1] || !isCorrection(events[n - 1]!)) problems.push(`An item of ${p} is covered by event ${n}, which is not a correction of the treatment.`);
    }
    if (m.covered && !doc.treatment) problems.push(`The measure ${m.name} scores the items that corrections cover, and there is no treatment over time.`);
  }
  if (doc.treatment) {
    const { checkpoints } = doc.treatment;
    const writers = doc.treatment.feedback_writers ?? {};
    for (const [writerName, writer] of Object.entries(writers)) {
      if ([writer.code, writer.judge].filter(v => v !== undefined).length !== 1) problems.push(`The feedback writer ${writerName} needs exactly one of code or judge.`);
      if (writer.code && !existsSync(resolve(root, writer.code))) problems.push(`The code of the feedback writer ${writerName} (${writer.code}) is not there.`);
      if (writer.code && !['.mjs', '.js', '.py'].includes(extname(writer.code))) problems.push(`The code of the feedback writer ${writerName} must be a .mjs, .js or .py file.`);
      if (!events.some(event => event.feedback === writerName)) problems.push(`No event uses the feedback writer ${writerName}.`);
    }
    events.forEach((event, i) => {
      const kinds = [event.correction !== undefined ? 'correction' : null, event.feedback !== undefined ? 'feedback' : null, event.model !== undefined ? 'model' : null].filter(Boolean);
      if (event.model !== undefined && (event.correction !== undefined || event.feedback !== undefined || event.input !== undefined)) problems.push(`Event ${i + 1}: a model event names only the model.`);
      else if (event.correction !== undefined && event.feedback !== undefined) problems.push(`Event ${i + 1} has both a correction and a feedback writer. Give one: fixed words, or the writer that writes them from the arm's own output.`);
      else if (!kinds.length && event.input === undefined) problems.push(`Event ${i + 1} needs a correction with its input, a feedback writer with its input, an input, or a model.`);
      else if ((event.correction !== undefined || event.feedback !== undefined) && event.input === undefined) problems.push(`Event ${i + 1}: a correction needs the input whose run it corrects.`);
      if (event.feedback !== undefined) {
        if (!writers[event.feedback]) problems.push(`Event ${i + 1} names the feedback writer ${event.feedback}, which is not one of treatment.feedback_writers${Object.keys(writers).length ? ` (${Object.keys(writers).join(', ')})` : ''}.`);
        if (event.input !== undefined && !doc.expected?.[event.input]) problems.push(`Event ${i + 1}: the feedback writer reads the hidden expected answer of ${event.input}, and it has none. Add expected: {${event.input}: FILE}.`);
      }
      if (event.input !== undefined) {
        if (teaching.length && !teaching.includes(event.input)) problems.push(`Event ${i + 1} uses ${event.input}, which is not a teaching input.`);
        else if (!teaching.length) {
          try { const value = inputValue(root, event.input); if (doc.deliverable) deliverableOf(doc.deliverable, value); }
          catch (error) { problems.push(`Event ${i + 1}: ${(error as Error).message}`); }
        }
      }
    });
    for (const c of checkpoints) if (c > events.length) problems.push(`The checkpoint ${c} is after the last of the ${events.length} events.`);
    if (new Set(checkpoints).size !== checkpoints.length) problems.push('A checkpoint is listed twice.');
    if (doc.rule.at === undefined) problems.push('With a treatment over time, the rule needs at: the checkpoint that decides.');
    else if (!checkpoints.includes(doc.rule.at)) problems.push(`The rule decides at ${doc.rule.at}, which is not one of the checkpoints (${checkpoints.join(', ')}).`);
  } else {
    if (doc.rule.at !== undefined) problems.push('The rule has at, but there is no treatment over time to have checkpoints.');
    if (teaching.length) problems.push('Teaching inputs are what the arms learn from in a treatment over time. Add the treatment, or remove teaching.');
  }
  for (const id of Object.keys(doc.about_inputs?.names ?? {})) if (!inputs.includes(id) && !teaching.includes(id)) problems.push(`about_inputs names ${id}, which is not an input.`);
  for (const entry of doc.decided_by_you ?? []) {
    const [part, field] = entry.split('.');
    // A note is decided by part: notes.PART names the notes of that part.
    if (part === 'notes' ? !field || !(raw.notes && typeof raw.notes === 'object' && raw.notes[field] !== undefined) : ['id', 'decided_by_you'].includes(part!) || raw[part!] === undefined) problems.push(`decided_by_you names ${entry}, which is not a part of this file.`);
  }
  if (problems.length) throw Error(`${basename(path)} cannot run. ${problems.join(' ')}`);
  return doc;
}

/** A model as an arm runs it: the agent (claude, codex, or hosted for a Method model), the model and the effort. */
export type ArmModel = { agent: 'claude' | 'codex' | 'hosted'; model: string | null; effort: string | null };
const modelWords = (m: ArmModel) => `${m.agent === 'claude' ? 'Claude Code' : m.agent === 'codex' ? 'Codex' : 'a hosted model'}${m.model ? ` (${m.model}${m.effort ? `, ${m.effort} effort` : ''})` : m.effort ? ` (its default model, ${m.effort} effort)` : ' (its default model)'}`;
/**
 * A model ID as people say it: claude-opus-5-5 → "Claude Opus 5.5", claude-sonnet-4-5-20250929 → "Claude Sonnet 4.5". Other
 * names stay as they are.
 */
export function modelName(id: string) {
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(id);
  if (!claude) return id;
  const [, family, major, minor] = claude;
  return `Claude ${family!.charAt(0).toUpperCase()}${family!.slice(1).toLowerCase()} ${major}${minor ? `.${minor}` : ''}`;
}
/** A model in the words of the page: "Claude Opus 5.5 at high effort", "the model that Claude Code uses by default". */
const modelPhrase = (m: ArmModel) => `${m.model ? modelName(m.model) : `the model that ${m.agent === 'claude' ? 'Claude Code' : m.agent === 'codex' ? 'Codex' : 'the hosted model'} uses by default`}${m.effort ? ` at ${m.effort} effort` : ''}`;
/** The models that a Method arm's model steps and sessions run on. defaultAgent: the agent that a step with no model uses. */
async function methodModels(document: any, defaultAgent: 'claude' | 'codex'): Promise<ArmModel[]> {
  const { methodProfiles } = await import('@withmethod/runtime/agents.js');
  const profiles: Record<string, any> = methodProfiles(document);
  const found = new Map<string, ArmModel>();
  for (const step of Object.values(document.steps ?? {}) as any[]) for (const exec of [step.do, step.check]) {
    if (!exec) continue;
    let model: ArmModel | null = null;
    if (exec.kind === 'session') model = { agent: exec.agent, model: exec.model ?? null, effort: exec.reasoning_effort ?? null };
    else if (['call', 'agent'].includes(exec.kind)) {
      const profile = profiles[exec.model ?? 'default'];
      model = !profile ? { agent: defaultAgent, model: null, effort: null }
        : { agent: ['claude', 'codex'].includes(profile.backend) ? profile.backend : 'hosted', model: profile.model ?? null, effort: profile.reasoning_effort ?? profile.effort ?? null };
    }
    if (model) found.set(JSON.stringify(model), model);
  }
  return [...found.values()];
}

/**
 * The model of each arm. Every arm runs on the same model and effort unless the comparison tests the model: a plain
 * arm takes the Method arms' model, and arms that differ are refused with a plain message.
 */
export async function armModels(doc: Comparison, root: string): Promise<{ arms: Record<string, ArmModel[]>; shared: ArmModel | null }> {
  const { localAgent } = await import('@withmethod/runtime/agents.js');
  const defaultAgent: 'claude' | 'codex' = (await localAgent()) === 'codex' ? 'codex' : 'claude';
  const arms: Record<string, ArmModel[]> = {};
  for (const [armName, arm] of Object.entries(doc.arms)) if (armIsMethod(arm)) arms[armName] = await methodModels(readDocument(resolve(root, arm)), defaultAgent);
  const methodSets = Object.entries(arms).filter(([, models]) => models.length);
  const plainArms = Object.entries(doc.arms).filter(([, arm]) => !armIsMethod(arm)) as Array<[string, Exclude<Comparison['arms'][string], string>]>;
  if (doc.tested === 'model') {
    for (const [armName, arm] of plainArms) arms[armName] = [{ agent: arm.agent, model: arm.model ?? null, effort: arm.effort ?? null }];
    return { arms, shared: null };
  }
  const problems: string[] = [];
  const words = (models: ArmModel[]) => models.map(modelWords).join(' and ');
  for (const [armName, models] of methodSets) if (models.length > 1 && plainArms.length) problems.push(`The Method arm ${armName} runs its steps on more than one model (${words(models)}), so a plain arm cannot take its model. Give its model steps one model, or name the model as the tested difference (tested: model).`);
  const [first, ...rest] = methodSets;
  for (const [armName, models] of rest) if (JSON.stringify(models) !== JSON.stringify(first![1])) problems.push(`The arms ${first![0]} and ${armName} run on different models (${words(first![1])}; ${words(models)}). Every arm uses the same model and effort unless the comparison tests the model: give them the same model, or add tested: model.`);
  const shared = first && first[1].length === 1 ? first[1][0]! : null;
  for (const [armName, arm] of plainArms) {
    const model: ArmModel = shared ? { ...shared } : { agent: arm.agent, model: null, effort: null };
    if (shared && shared.agent !== arm.agent) problems.push(`The Method arm ${first![0]} runs on ${modelWords(shared)}, and the plain arm ${armName} is ${arm.agent === 'claude' ? 'Claude Code' : 'Codex'}. Every arm uses the same model unless the comparison tests the model: make the plain arm ${shared.agent === 'hosted' ? 'run on the same agent as the Method' : `agent: ${shared.agent}`}, or add tested: model.`);
    arms[armName] = [model];
  }
  const plainAgents = new Set(plainArms.map(([, arm]) => arm.agent));
  if (!shared && plainAgents.size > 1) problems.push('The plain arms are Claude Code and Codex, which run on different models. Every arm uses the same model unless the comparison tests the model: add tested: model.');
  if (problems.length) throw Error(`The comparison cannot run. ${problems.join(' ')}`);
  return { arms, shared: shared ?? (plainArms.length ? arms[plainArms[0]![0]]![0]! : null) };
}

/**
 * The rule as a sentence, as the result shows it. The guard compares the winning arm with the other arm (with more
 * than two arms, the best other arm) on the guard measure at the point that decides.
 */
export function ruleSentence(doc: Comparison) {
  const { margin, min_runs, at, guard } = doc.rule;
  const point = at !== undefined ? ` after ${plural(at, 'treatment event')}` : '';
  const other = Object.keys(doc.arms).length > 2 ? 'the best other arm\'s' : 'the other arm\'s';
  const guardText = guard ? `, and its ${guard.measure}${at !== undefined ? ' at that point' : ''} is not more than ${guard.max_drop} below ${other}` : '';
  return `An arm is better when its mean ${doc.measure.name}${point} is at least ${margin} above every other arm's, its lead is larger than the spread between two copies of the same agent${at !== undefined ? ' at that point' : ''}${guardText}, with at least ${plural(Math.max(2, min_runs), 'learner')} behind each point. Otherwise: can't tell yet.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Names on the page

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/**
 * The name of each arm on the page, by its key: "Method agent" for the one Method arm (with more than one, each Method's
 * own name), and "plain Claude Code" or "plain Codex" (with the key when two plain arms are the same agent).
 */
export function armLabels(doc: Comparison, root: string) {
  const methods = Object.entries(doc.arms).filter(([, arm]) => armIsMethod(arm)) as Array<[string, string]>;
  const base: Record<string, string> = {};
  for (const [key, arm] of Object.entries(doc.arms)) {
    if (!armIsMethod(arm)) { base[key] = `plain ${arm.agent === 'claude' ? 'Claude Code' : 'Codex'}`; continue; }
    if (methods.length === 1) { base[key] = 'Method agent'; continue; }
    let name: unknown;
    try { name = readDocument(resolve(root, arm)).name; } catch { /* the file is checked elsewhere */ }
    base[key] = typeof name === 'string' && name.trim() ? name.trim() : `Method agent ${key}`;
  }
  const shared = (label: string) => Object.values(base).filter(other => other === label).length > 1;
  return Object.fromEntries(Object.entries(base).map(([key, label]) => [key, shared(label) ? `${label} (${key})` : label]));
}
/** The file that each arm hands in, by its name: "the file reply.md", or "the file that the task names" when the path takes a value of the input. */
export function deliverableWords(doc: Comparison) {
  if (!doc.deliverable) return null;
  return /\{\{/.test(doc.deliverable) ? `the file that the ${doc.about_inputs?.noun ?? 'input'} names` : `the file ${basename(doc.deliverable)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Who decided each value

/** The parts of the comparison page; notes, decisions and Method's rules each name one. */
export type PagePart = 'arms' | 'same_for_both' | 'inputs' | 'treatment' | 'main_measure' | 'other_measures' | 'runs_per_point' | 'rule' | 'noise' | 'run_rules' | 'trial' | 'assumptions';
/** The page part of a note's part in the file: measure is the main measure, runs the runs per point. Notes on the question have no part on the page. */
const notePart = (part: string): PagePart | null => part === 'question' ? null : part === 'measure' ? 'main_measure' : part === 'runs' ? 'runs_per_point' : part as PagePart;
/** entries: the decided_by_you entries that make the value the person's, so an answer "Keep this?" on the page names the exact edit. */
export type Decision = { part: PagePart; what: string; value: string; by: 'you' | 'writer' | 'method'; entries: string[] };
const short = (value: string, max = 300) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
/**
 * Every value of the file, with who decided it: you when decided_by_you names it (a part, or each of the fields that
 * make the value), else the writer that wrote the file. Method's own values are in methodRules. what names the value in
 * its part as the page reads it: arms: difference, instructions, other differences; inputs: inputs, teaching inputs;
 * treatment: treatment; main_measure: main measure; other_measures: the measure's name; runs_per_point: learners;
 * rule: decision rule; trial: trial size; assumptions: the assumption's text; any part: note.
 */
export function decisions(doc: Comparison): Decision[] {
  const marked = doc.decided_by_you ?? [];
  const has = (key: string) => marked.some(entry => key === entry || key.startsWith(`${entry}.`));
  // A value made of several fields is yours when each of them is. The starting instructions are yours only when
  // decided_by_you names them (exact): naming the arm says which agent it is, not what its instructions say.
  const out: Decision[] = [];
  // keys: the fields that make the value; entries: what to add to decided_by_you to make it the person's (the keys, or their part).
  const add = (part: PagePart, what: string, value: string, keys: string[], options: { exact?: boolean; entries?: string[] } = {}) => out.push({ part, what, value: short(value, 2000),
    by: keys.length > 0 && keys.every(key => options.exact ? marked.includes(key) : has(key)) ? 'you' : 'writer', entries: options.entries ?? keys });
  const plain = Object.entries(doc.arms).filter(([, arm]) => !armIsMethod(arm)) as Array<[string, Exclude<Comparison['arms'][string], string>]>;
  add('arms', 'difference', doc.difference, ['difference']);
  if (plain.length) add('arms', 'instructions', plain.map(([armName, arm]) => `${armName}: ${arm.instructions}`).join('; '), plain.map(([armName]) => `arms.${armName}.instructions`), { exact: true });
  if (doc.other_differences?.length) add('arms', 'other differences', doc.other_differences.join('; '), ['other_differences']);
  if (doc.tested) add('arms', 'tested', doc.tested, ['tested']);
  if (doc.deliverable) add('same_for_both', 'deliverable', `Each agent hands in ${deliverableWords(doc)}.`, ['deliverable']);
  add('inputs', 'inputs', doc.inputs.join(', '), ['inputs']);
  if (doc.teaching?.length) add('inputs', 'teaching inputs', doc.teaching.join(', '), ['teaching']);
  if (doc.treatment) {
    const corrections = doc.treatment.events.filter(isCorrection).length;
    for (const [writerName, writer] of Object.entries(doc.treatment.feedback_writers ?? {}))
      add('treatment', 'feedback writer', `${writerName}: ${writer.code ? `the script ${writer.code}` : `one Claude judge with the instruction: ${writer.judge}`}`, ['treatment']);
    add('treatment', 'treatment', `${plural(doc.treatment.events.length, 'event')}${corrections ? ` (${plural(corrections, 'correction')})` : ''}, ${doc.treatment.seed !== undefined ? `shuffled once with seed ${doc.treatment.seed}` : 'in the given order'}, measured after ${[...doc.treatment.checkpoints].sort((a, b) => a - b).join(', ')}`, ['treatment']);
  }
  const how = (m: Measure) => m.code ? `the script ${m.code}` : m.rubric ? `a rubric of ${plural(m.rubric.length, 'sentence')}` : m.checklist ? `each input's checklist from its expected answer${m.covered ? ', only the items that corrections cover so far' : ''}` : `a person answers: ${m.person}`;
  add('main_measure', 'main measure', `${doc.measure.name}: ${how(doc.measure)}`, ['measure', ...(doc.measure.checklist ? ['expected'] : [])]);
  (doc.other_measures ?? []).forEach((m, i) => add('other_measures', m.name, how(m), [`other_measures.${i + 1}`]));
  add('runs_per_point', 'learners', String(doc.runs), ['runs']);
  const ruleFields = ['margin', 'min_runs', ...(doc.rule.at !== undefined ? ['at'] : []), ...(doc.rule.guard ? ['guard'] : [])].map(f => `rule.${f}`);
  add('rule', 'decision rule', ruleSentence(doc), ruleFields, { entries: ['rule'] });
  (doc.assumptions ?? []).forEach((a, i) => add('assumptions', short(typeof a === 'string' ? a : a.text, 200), typeof a === 'string' ? a : a.text, [`assumptions.${i + 1}`]));
  for (const [part, list] of Object.entries(doc.notes ?? {})) {
    const page = notePart(part);
    if (page) for (const note of list ?? []) add(page, 'note', note, [`notes.${part}`]);
  }
  return out;
}

/**
 * The rules that Method applies to this comparison, in plain words, by the part of the page that shows them. The page
 * is for the person who asked: it says agent, copy and correction, names a model as people say it, and names no
 * command, file path or step.
 */
export function methodRules(doc: Comparison, settings: { model: ArmModel | null; judge: { agent: string; model: string | null }; labels: Record<string, string> }) {
  const rules: Array<{ part: PagePart; text: string }> = [];
  const add = (part: PagePart, text: string) => rules.push({ part, text });
  const plain = Object.entries(doc.arms).filter(([, arm]) => !armIsMethod(arm)) as Array<[string, Exclude<Comparison['arms'][string], string>]>;
  const corrections = (doc.treatment?.events ?? []).some(isCorrection);
  const feedback = (doc.treatment?.events ?? []).some(e => e.feedback !== undefined);
  const web = doc.tested === 'tools';
  const agentName = (agent: string) => agent === 'claude' ? 'Claude Code' : 'Codex';
  if (corrections) {
    for (const [armName, arm] of plain) add('arms', `${capital(settings.labels[armName] ?? armName)}: a ${agentName(arm.agent)} session reads the correction and the wrong output, then edits the agent's instructions file. The edited file is what the agent keeps.`);
    for (const [armName] of Object.entries(doc.arms).filter(([, arm]) => armIsMethod(arm))) add('arms', `${capital(settings.labels[armName] ?? armName)}: Method marks the wrong run with the correction. A session of the same agent changes the agent's Method and writes a check of the correction. Method keeps the change only when the check fails before it and passes after it, every earlier check still passes, and the person's own words are unchanged.`);
  }
  if (doc.tested === 'model') add('same_for_both', 'The model is the tested difference, so each agent runs on its own model.');
  else {
    add('same_for_both', `Every agent runs on ${settings.model ? modelPhrase(settings.model) : 'the model that its agent uses by default'}.`);
    if (corrections) add('same_for_both', 'The session that changes an agent after a correction runs on the same model.');
  }
  add('same_for_both', 'No agent has personal instructions, memory, settings, skills or plugins, and each works on its own copy of the files it reads.');
  add('same_for_both', web ? 'The tools are the tested difference, so the agents may use the web.' : 'No agent can use the web.');
  if (doc.deliverable) add('same_for_both', 'Only the handed-in file is measured.');
  if (doc.deliverable && plain.length) add('same_for_both', 'A plain agent\'s last message is not its output.');
  if (plain.length) add('same_for_both', 'A plain agent gets its starting instructions and the same task as the Method agent, with the same files.');
  if (corrections) {
    add('treatment', 'Corrections arrive one at a time: an agent finishes learning from one correction before it gets the next.');
    add('trial', `Before approval, the trial gives one copy of each agent its first ${TRIAL_EVENTS} corrections, to show what it received and what changed it, and how long one takes. The full run gives every copy the rest.`);
    add('treatment', `An agent has up to ${FIX_LIMIT_MS / 3_600_000} hours to learn from each correction.`);
    add('treatment', 'A correction counts as received when Method\'s fix ended: it applied a tested change, found that the run already does what the correction asks, or found no fix. For a plain agent it counts as received when the session that edits the instructions finished, edited or not. When Method\'s fix could not test a change or stopped (a usage limit too), the correction is not received, and the comparison stops there.');
    add('treatment', 'Each agent\'s page counts both: the corrections it received, and those that changed the agent (a tested change applied, or the instructions edited), and shows what each correction changed.');
  }
  if (feedback) {
    add('treatment', 'A feedback writer reads each agent\'s own output of its training run and the hidden expected answer, and writes the correction that this agent gets. So each agent\'s corrections are about its own work, and their words differ by design. Each agent\'s page lists the words it received.');
    add('treatment', 'Every agent has the same feedback writer and the same hidden answer. The writer is not told which agent did the work.');
    add('treatment', 'A feedback writer says what it checked. When it checked the whole output and found nothing wrong, the agent is told that its output was right (was right). When it checked only a part and found nothing wrong there, the agent gets no feedback (no feedback): nothing tells it the rest is right.');
  }
  add('runs_per_point', `Runs count separate copies of each agent: each copy${doc.treatment ? ' gets the full treatment and' : ''} is measured once per input at each point.`);
  if ([doc.measure, ...(doc.other_measures ?? [])].some(m => m.rubric || m.checklist)) {
    add('main_measure', `One Claude judge (${settings.judge.model ? modelName(settings.judge.model) : 'the model that Claude Code uses by default'}) marks each item met, partly or not met. Partly counts as half.`);
    add('main_measure', 'The judge reads the handed-in file, every source the agent read in full, and the checklist.');
  }
  add('main_measure', 'Every item and every run counts the same.');
  if ([doc.measure, ...(doc.other_measures ?? [])].some(m => m.checklist)) add('main_measure', 'A checklist comes from each input\'s expected answer: each item counts for that input only, and nothing is added to it.');
  if (doc.measure.covered) add('main_measure', 'At each checkpoint only the items that a correction given so far covers count.');
  if (corrections) add('other_measures', 'Usage per correction for each agent is shown and does not decide: tokens when every agent reports them, else minutes.');
  if (!doc.measure.person) add('rule', `If the main measure is a share from 0 to 1 and every agent already scores more than ${fixed(1 - doc.rule.margin)} (1 minus the margin) at the start, no agent can lead by the margin, so the comparison stops before approval.`);
  add('rule', 'An agent is not better when two copies of the same agent differ at the point that decides by as much as its lead: the lead could come from which copies learned what.');
  add('noise', `The trial runs every checking input at the start with ${NOISE_LEARNERS} copies of each agent, and shows how much two copies differ. It does not stop the comparison: the spread between copies at the point that decides is part of the decision.${doc.measure.covered ? ' No item is covered at the start, so the start is measured on all items of the same checklist.' : ''}`);
  // Where run content goes, with the workspace's name, is the page's own line.
  add('run_rules', 'A failed run stops the comparison until you run it again. Runs that did not change are reused.');
  return rules;
}

// ---------------------------------------------------------------------------------------------------------------
// Compiling: the comparison folder, the arm copies, and the generated Method

/** The folder of a comparison's generated Method, arm copies, runs and marks: .compare/NAME/ beside the file. */
export const comparisonFolder = (file: string) => join(dirname(authoringPath(file)), '.compare', basename(file).replace(/\.compare$/i, ''));
const stageScript = `import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
// One stage of a comparison: the method CLI that runs this Method does the work (method __compare STAGE).
const run = spawnSync('method', ['__compare', process.argv[2]], { input: readFileSync(0), stdio: ['pipe', 'inherit', 'inherit'] });
if (run.error) console.error(run.error.message);
process.exitCode = run.error ? 1 : run.status ?? 1;
`;

/**
 * Write `id: cmp_...` as the first line of a comparison file (the first key of a JSON file), the way a Method file keeps
 * its Method ID. The rest of the file is unchanged.
 */
export function writeComparisonId(file: string, id: string) {
  const path = authoringPath(file), text = readFileSync(path, 'utf8');
  const next = /^\s*\{/.test(text)
    ? JSON.stringify((({ id: _old, ...rest }) => ({ id, ...rest }))(JSON.parse(text)), null, /\n {2}"/.test(text) ? 2 : undefined) + (text.endsWith('\n') ? '\n' : '')
    : [`id: ${id}`, ...text.split('\n').filter(line => !/^id:/.test(line))].join('\n');
  writeFileSync(path, next, { mode: 0o600 });
}
/** The file's comparison ID; writes a new one when the file has none. */
function ensureComparisonId(file: string, doc: Comparison) {
  if (doc.id) return doc.id;
  const id = `cmp_${randomBytes(16).toString('hex')}`;
  writeComparisonId(file, id);
  return id;
}

/** The files of a folder, hashed, for an arm's content hash. The id: line of the Method is left out. */
function folderHash(dir: string, methodFile?: string) {
  const parts: Array<[string, string]> = [];
  const walk = (sub: string) => {
    for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.name === '.method-runs' || entry.name === 'node_modules' || entry.name === '.method') continue;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) parts.push([rel, rel === methodFile ? sha(methodContent(readDocument(join(dir, rel)))) : sha(readFileSync(join(dir, rel)))]);
    }
  };
  walk('');
  return sha(parts.sort((a, b) => a[0].localeCompare(b[0])));
}

/**
 * Copy a Method arm into the comparison folder: its package files (Method file, scripts, declared files, lockfiles,
 * learned rules) and its cases, under its own Method ID that stays the same across runs. Its bound file folders are
 * copied beside it once per run of the comparison, so every cell starts from the same files.
 */
async function copyArm(source: string, target: string) {
  const root = dirname(source), file = basename(source);
  const document = readDocument(source), workflow = loadWorkflow(methodContent(document));
  const idFile = join(target, 'id.json');
  const id = existsSync(idFile) ? JSON.parse(readFileSync(idFile, 'utf8')).id : newMethodId();
  const method = join(target, 'method');
  rmSync(method, { recursive: true, force: true });
  mkdirSync(method, { recursive: true, mode: 0o700 });
  for (const name of packageFileNames(root, workflow)) { mkdirSync(dirname(join(method, name)), { recursive: true }); cpSync(join(root, name), join(method, name)); }
  if (!packageFileNames(root, workflow).includes(file)) cpSync(source, join(method, file));
  if (existsSync(join(root, 'cases'))) cpSync(join(root, 'cases'), join(method, 'cases'), { recursive: true, filter: path => basename(path) !== 'snapshot' });
  writeMethodId(join(method, file), id);
  writePrivateJson(idFile, { id });
  // The folders that the arm's Method reads and writes (files connections), as this computer binds them for the original.
  const { localSetup } = await import('./local-setup.js');
  const environment = (await localSetup(source, {})).config.environment ?? {};
  const env = join(target, 'environment');
  removeFolder(env);
  const folders: Record<string, string> = {};
  for (const [envName, definition] of Object.entries(workflow.environment ?? {}) as Array<[string, any]>) {
    const bound = environment[envName];
    if (definition.type !== 'files' || typeof bound !== 'string' || !existsSync(bound)) continue;
    cpSync(bound, join(env, envName), { recursive: true, filter: path => !['.git', 'node_modules', '.venv', '.method-runs'].includes(basename(path)) });
    folders[envName] = join(env, envName);
  }
  return { dir: method, file, id, hash: folderHash(method, file), folders, run_data: document.run_data === 'device' ? 'device' : 'account' };
}

/** Marks that a person gave on earlier runs, by output and measure, so a rerun does not ask again. */
const marksFile = (folder: string) => join(folder, 'marks.json');
const readMarks = (folder: string): Record<string, number> => { try { return JSON.parse(readFileSync(marksFile(folder), 'utf8')); } catch { return {}; } };

/**
 * Steps of the generated Method, by stage. All are scripts that run method __compare STAGE. The stages that only plan
 * and report (and so cost nothing) change state.reported, which keeps them from being reused: they report to the
 * account on every run. approved: the person already said go to this version of the file, so the approval does not ask.
 */
/**
 * approval.trial: the person said yes to the trial (on the comparison page, or with method answer), or no page asks
 * (signed out); else the Trial approval step asks, with the page's link. approval.full_run: the same for the full run.
 */
function generatedMethod(doc: Comparison, previousId: string | undefined, counts: { cells: number }, approval: { trial: boolean; full_run: boolean; url: string | null }) {
  const treatment = !!doc.treatment, person = [doc.measure, ...(doc.other_measures ?? [])].some(m => m.person !== undefined);
  const stage = (name: string) => ({ kind: 'run', runtime: 'node', entrypoint: 'stage.mjs', args: [name] });
  const list = { type: 'list', items: { type: 'text' } };
  const treated = treatment ? { treated: 'treatment' } : {};
  const reports = ['state.reported'];
  const steps: Record<string, any> = {};
  const onPage = (question: string) => approval.url ? `Answer "${question}" on the comparison page, ${approval.url}, then run the comparison again. Or, when the person said it here, pass their answer: ` : '';
  steps.trial_approve = approval.trial
    ? { name: 'Trial approval', purpose: 'The person said yes to the trial of this version of the file.', in: { comparison: 'inputs.comparison' }, do: stage('trial_approved'), out: { start: { type: 'boolean' } } }
    : { name: 'Trial approval', purpose: 'The person says yes to the trial on the comparison page.', in: { comparison: 'inputs.comparison' },
      ask: `Run the trial of "${doc.question.replace(/"/g, "'")}"? ${onPage('Run the trial?') || 'Answer '}start: true to run it, or start: false to stop.`, out: { start: { type: 'boolean', description: 'true to run the trial.' } } };
  if (treatment) steps.trial_treat = { name: 'Trial treatment', purpose: `Gives the first learner of each arm the first ${TRIAL_EVENTS} treatment events, one at a time, and records what it received and what happened to each.`, in: { comparison: 'inputs.comparison', start: 'start' }, do: stage('trial_treat'), changes: ['state.treatment'], out: { trial_treatment: { type: 'text' } } };
  steps.trial_plan = { name: 'Trial plan', purpose: `Lists the trial runs (each arm at the start on the first inputs, with ${NOISE_LEARNERS} learners) that have not finished yet, and reports them to the comparison page.`, in: { comparison: 'inputs.comparison', start: 'start', ...(treatment ? { treated: 'trial_treatment' } : {}) }, do: stage('trial_plan'), changes: reports, out: { trial_cells: list, trial_done: list } };
  steps.trial = { name: 'Trial', purpose: 'Runs each trial cell.', each: { cell: 'trial_cells' }, concurrency: 4, do: stage('trial_cell'), out: { trial_run: { type: 'text' } } };
  steps.trial_gather = { name: 'Trial grades', purpose: 'Lists each trial run with the measures that grade it (a person marks only after the full run).', in: { comparison: 'inputs.comparison', trial_runs: 'trial_run', trial_done: 'trial_done', ...(treatment ? { treated: 'trial_treatment' } : {}) }, do: stage('trial_gather'), out: { trial_graded: list } };
  steps.trial_grade = { name: 'Trial grade', purpose: 'Gives each trial run its number on each measure, with the judge\'s verdicts.', each: { item: 'trial_graded' }, concurrency: 4, do: stage('trial_grade'), out: { trial_grade: { type: 'text' } } };
  steps.trial_check = { name: 'Treatment and noise check', purpose: 'Says what each arm received and what happened to each correction, and stops when an arm did not receive everything. Measures the noise at the start and stops when it is more than half the margin. Estimates the full run from the trial.', in: { comparison: 'inputs.comparison', runs: 'trial_run', done: 'trial_done', grades: 'trial_grade', ...(treatment ? { treated: 'trial_treatment' } : {}) }, do: stage('check'), changes: reports, out: { trial_summary: { type: 'text' } } };
  steps.approve = approval.full_run
    ? { name: 'Approval', purpose: 'The person already approved the full run of this version of the file.', in: { summary: 'trial_summary' }, do: stage('approved'), out: { go: { type: 'boolean' } } }
    : { name: 'Approval', purpose: 'The person reads the trial and says go.', in: { summary: 'trial_summary' }, ask: `{{summary}}\n\nStart the full run? ${onPage('Run the full run?') || 'Answer '}go: true to start it, or go: false to stop.`, out: { go: { type: 'boolean', description: 'true to start the full run.' } } };
  if (treatment) steps.treat = { name: 'Treatment', purpose: 'Gives each learner of each arm every treatment event, one at a time and in order, freezes a copy at each checkpoint, and records what it received and what happened to each.', in: { comparison: 'inputs.comparison', go: 'go' }, do: stage('treat'), changes: ['state.treatment'], out: { treatment: { type: 'text' } } };
  steps.plan = { name: 'Plan', purpose: 'Lists every cell of the full run that has not finished yet, and reports the plan to the comparison page.', in: { comparison: 'inputs.comparison', go: 'go', ...treated }, do: stage('plan'), changes: reports, out: { cells: list, done: list } };
  steps.cells = { name: 'Full run', purpose: 'Runs each cell: one learner of one arm on one input, at one checkpoint.', each: { cell: 'cells' }, concurrency: 4, do: stage('cell'), out: { full_run: { type: 'text' } } };
  const runs = { trial_runs: 'trial_run', trial_done: 'trial_done', full_runs: 'full_run', done_runs: 'done' };
  if (person) {
    steps.to_mark = { name: 'Outputs to mark', purpose: 'Lists the outputs that a person has not marked yet.', in: { comparison: 'inputs.comparison', marks: 'inputs.marks', ...runs }, do: stage('to_mark'), out: { mark_questions: list, mark_keys: list } };
    steps.mark = { name: 'Person marks', purpose: 'A person marks each output with a number.', each: { question: 'mark_questions' }, ask: '{{question}}', out: { mark: { type: 'number', description: 'The number for this output.' } } };
  }
  steps.gather = { name: 'Gather', purpose: 'Lists every run with the measures that grade it.', in: { comparison: 'inputs.comparison', marks: 'inputs.marks', ...runs, ...treated, ...(person ? { mark_keys: 'mark_keys', marks_given: 'mark' } : {}) }, do: stage('gather'), out: { graded: list } };
  steps.grade = { name: 'Grade', purpose: 'Gives each run its number on each measure, with the judge\'s verdicts.', each: { item: 'graded' }, concurrency: 4, do: stage('grade'), out: { grade: { type: 'text' } } };
  steps.decide = { name: 'Decide', purpose: 'Applies the decision rule, writes the result and reports it to the comparison page.', in: { comparison: 'inputs.comparison', grades: 'grade', trial_grades: 'trial_grade', ...runs, ...treated }, do: stage('decide'), changes: reports, out: { answer: { type: 'text', description: 'The answer, the rule as a sentence, what each arm received, and n per point.' } } };
  const most = 2_147_483_647;
  return {
    format: 'method/3.4', ...(previousId ? { id: previousId } : {}),
    name: `Comparison: ${doc.question}`.slice(0, 200), goal: doc.question,
    inputs: { comparison: { type: 'text', description: 'The checked comparison, as JSON.' }, marks: { type: 'text', description: 'Marks that a person gave earlier, as JSON.' } },
    state: { reported: { type: 'text', description: 'When the comparison page last got a report.', default: '' },
      ...(treatment ? { treatment: { type: 'text', description: 'What each arm received so far.', default: '' } } : {}) },
    limits: { timeout_ms: most, max_invocations: 4 * counts.cells + 100, step: { timeout_ms: most } },
    steps, result: 'answer',
  };
}

/** An assumption as the account keeps it: its words, what it would mean if false, how to check it, and who stated it. */
function assumptionsOf(doc: Comparison) {
  const marked = doc.decided_by_you ?? [];
  const byYou = (i: number) => marked.some(entry => entry === 'assumptions' || entry === `assumptions.${i + 1}`);
  return [
    ...(doc.treatment ? [{ text: 'Each agent received its full treatment.', if_false: 'An agent that missed part of its treatment is not measured on what the question asks.', check: 'Method counts what each copy of each agent received, and gives no answer when one is short.', by: 'method' as const, checked_by: 'treatment' as const }] : []),
    ...(doc.assumptions ?? []).map((a, i) => {
      const value = typeof a === 'string' ? { text: a } as { text: string; if_false?: string; check?: string; limit?: true } : a;
      return { text: value.text, ...(value.if_false ? { if_false: value.if_false } : {}), check: value.check ?? null, by: byYou(i) ? 'you' as const : 'writer' as const, ...(value.limit ? { limit: true } : {}) };
    }),
  ];
}

/**
 * The comparison as the account keeps it (packages/contracts/src/comparison.ts in the account's repository): the parts
 * of the definition, each input's name and uploaded content, the checklists, who decided each value, and Method's rules.
 * upload: puts a text in the account and returns its reference (null when signed out).
 */
async function accountSpec(doc: Comparison, root: string, arms: Array<{ name: string; label: string; id?: string; plain?: Plain }>, events: Array<{ input: { id: string }; text?: string; feedback?: { name: string }; source?: string }>,
  checklists: Record<string, ChecklistItem[]>, settings: { model: ArmModel | null; judge: { agent: 'claude'; model: string | null }; device: boolean }, upload: (text: string) => Promise<{ sha256: string; bytes: number } | null>) {
  const measure = async (m: Measure) => ({ name: m.name, how: m.code ? 'code' : m.rubric || m.checklist ? 'model' : 'person', ...(m.description ? { description: m.description } : {}),
    ...(m.rubric ? { rubric: m.rubric.map(line => `- ${line}`).join('\n') } : {}),
    ...(m.checklist ? { checklists: Object.fromEntries(doc.inputs.map(id => [id, (checklists[id] ?? []).map(item => short(item.text, 2000))])) } : {}) });
  const kinds = doc.treatment?.events ?? [];
  const kind = kinds.every(isCorrection) ? 'Corrections' : kinds.every(e => !isCorrection(e)) ? 'New inputs' : 'Events';
  const corrections = kinds.some(isCorrection);
  const about = doc.about_inputs;
  // Each input's name and content (its JSON values), uploaded first: the account refuses a name whose content it lacks.
  const details: Record<string, { name: string; file?: { sha256: string; bytes: number } }> = {};
  if (!settings.device) for (const id of [...doc.inputs, ...(doc.teaching ?? [])]) {
    const value = inputValue(root, id), file = await upload(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    details[id] = { name: about?.names?.[id] ?? id.replace(/^.*[/\\]/, '').replace(/\.[a-z0-9]+$/i, ''), ...(file ? { file } : {}) };
  } else for (const id of [...doc.inputs, ...(doc.teaching ?? [])]) details[id] = { name: about?.names?.[id] ?? id.replace(/^.*[/\\]/, '').replace(/\.[a-z0-9]+$/i, '') };
  const notes: Record<string, string[]> = {};
  for (const [part, list] of Object.entries(doc.notes ?? {})) { const page = notePart(part); if (page && list?.length) notes[page] = [...(notes[page] ?? []), ...list]; }
  return {
    question: doc.question,
    arms: arms.map(arm => ({ id: arm.name, name: arm.label, ...(arm.plain ? { agent: arm.plain.agent, instructions: arm.plain.instructions } : { method_id: arm.id }) })),
    difference: doc.difference, ...(doc.other_differences?.length ? { other_differences: doc.other_differences } : {}),
    inputs: { checking: doc.inputs, ...(doc.teaching?.length ? { teaching: doc.teaching } : {}), ...(about?.description ? { description: about.description } : {}),
      ...(about?.teaching_description ? { teaching_description: about.teaching_description } : {}), ...(about?.noun ? { noun: about.noun } : {}), details },
    main_measure: await measure(doc.measure),
    other_measures: [...await Promise.all((doc.other_measures ?? []).map(measure)),
      ...(corrections ? [{ name: 'Usage per correction', how: 'usage', higher_is_better: false, description: 'What each arm used to take one correction (its training run and its fix or edit): tokens when every agent reports them, else minutes.' }] : [])],
    rule: doc.rule, runs_per_point: doc.runs, learners: doc.runs,
    ...(doc.treatment ? { treatment: { kind, items: kinds.length, checkpoints: [...doc.treatment.checkpoints].sort((a, b) => a - b),
      order: doc.treatment.seed !== undefined ? 'shuffled' : 'given', ...(doc.treatment.seed !== undefined ? { seed: doc.treatment.seed } : {}),
      list: events.map(e => ({ input: e.input.id, text: short(e.text ?? (e.feedback ? feedbackWords(e.feedback.name) : `New input: ${e.input.id}`), 4000), ...(e.source ? { source: short(e.source, 2000) } : {}) })) } } : {}),
    ...(doc.expected ? { expected_answers: true } : {}),
    judge: { agent: settings.judge.agent, model: settings.judge.model ?? 'Claude Code\'s default model' },
    assumptions: assumptionsOf(doc),
    ...(Object.keys(notes).length ? { notes } : {}),
    decisions: decisions(doc),
    method_rules: methodRules(doc, { ...settings, labels: Object.fromEntries(arms.map(arm => [arm.name, arm.label])) }),
  };
}

/** A feedback event in the treatment list: the words differ for each agent, so the list names the writer. */
const feedbackWords = (writer: string) => `The feedback writer ${writer} reads the agent's own output and the hidden expected answer, and writes this correction.`;

/** A list in one order made from a seed (the same every time), or as it is without a seed. */
export function shuffled<T>(list: T[], seed: number | undefined): T[] {
  if (seed === undefined) return [...list];
  let state = seed >>> 0;
  const next = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out;
}

/** The person said go to this version of the file (on this computer, or the account's version is past its trial). */
const approvalFile = (folder: string) => join(folder, 'approval.json');
/** The person said yes to the trial of this version of the file (on the page, or with method answer on this computer). */
const trialApprovalFile = (folder: string) => join(folder, 'trial-approval.json');
const isTrialApproved = (folder: string, digest: string) => { try { return JSON.parse(readFileSync(trialApprovalFile(folder), 'utf8')).spec_digest === digest; } catch { return false; } };
function isApproved(folder: string, digest: string) {
  const account = readAccount(folder);
  if (account?.spec_digest === digest && ['running', 'done'].includes(account.stage)) return true;
  try { return JSON.parse(readFileSync(approvalFile(folder), 'utf8')).spec_digest === digest; } catch { return false; }
}

/** The tools of a plain arm and of its builder: the file tools (Codex works through its shell), and the web only when tools are tested. */
const plainTools = (agent: 'claude' | 'codex', web: boolean) => [...(agent === 'codex' ? ['shell'] : []), 'read', 'write', 'edit', 'search', ...(web ? ['web'] : [])];
/** A Method of one session step with a room: a plain arm's run, its builder's edit, or the judge. */
function sessionMethod(title: string, goal: string, agent: 'claude' | 'codex', model: ArmModel | null, tools: string[], prompt: string, inputs: string[], timeoutMs: number) {
  return {
    format: 'method/3.4', name: title, goal,
    inputs: Object.fromEntries([...inputs, 'room'].map(key => [key, { type: 'text', ...(key === 'room' ? { description: 'The folder that the session works in.' } : {}) }])),
    limits: { timeout_ms: timeoutMs + 60_000, step: { timeout_ms: timeoutMs } },
    steps: { work: { in: Object.fromEntries([...inputs, 'room'].map(key => [key, `inputs.${key}`])), out: 'session',
      do: { kind: 'session', agent, ...(model?.model ? { model: model.model } : {}), ...(model?.effort ? { reasoning_effort: model.effort } : {}), prompt, tools, room: 'room' } } },
    result: 'session',
  };
}
/** The task prompt that every plain agent gets for an input: the input, and the file to hand in. */
export function taskPrompt(value: unknown, deliverable: string | null) {
  const input = typeof value === 'string' ? value : `Input:\n${JSON.stringify(value, null, 2)}`;
  return deliverable ? `${input}\n\nHand in your work as the file ${deliverable} in your working folder.` : input;
}
const builderPrompt = `You maintain the instructions of an agent. Its instructions are in instructions.md.
The agent did the task in task.md, with the files in task-files/ (as the agent got them), and handed in the file in wrong-output/. A person corrected that work, or said that it is right; their words are in correction.md. The earlier corrections, in order, are in corrections-log.md.
Edit instructions.md so that the agent follows this correction on later tasks and still follows everything the instructions already say. The agent reads only instructions.md and each new task: it never sees this correction or this task again.
Read the task's files and the earlier corrections as you need them, and do not change them. Change only instructions.md. When the instructions already make the agent do what the correction asks, leave the file as it is.`;
/** What the plain arm's builder reads when the feedback writer found nothing wrong. */
const RIGHT_WORDS = 'Right: the person checked this work and found nothing wrong.';
/** The version of the feedback writer's judge: a new prompt writes every feedback again. */
const FEEDBACK_VERSION = 'feedback-writer/2';
const feedbackPrompt = `You write an expert's feedback on one piece of work. The task is in task.md. The work that the agent handed in is in output/. The correct answer, which the agent never sees, is in expected-answer.md. How to write the feedback is in instruction.md.
Read each file in full. Then write the feedback that instruction.md asks for, about this work only.
Answer with one JSON object and nothing else: {"correction": "THE FEEDBACK" or null, "checked": WHAT YOU CHECKED}. correction is null when nothing that you checked is wrong. checked is "all" when you checked the whole work against the correct answer, else the part that you checked, in a few words.`;
const judgePrompt = `You are the judge of one handed-in document. Mark each item of checklist.json for the document in document/.
First read, in full, every file that read-files.txt lists (the sources the agent read; they are in sources/), the document, and expected-answer.md when it is there. Read each file to its end: use more than one read for a long file.
For each item, decide whether the document meets it: met, partly, or not_met. Judge only the document; the sources and the expected answer are for checking it.
Answer with one JSON object and nothing else: {"verdicts": [{"id": ITEM_ID, "verdict": "met" | "partly" | "not_met", "quote": WORDS COPIED EXACTLY FROM THE DOCUMENT THAT DECIDE IT (or "" when no passage decides it), "reason": ONE SHORT SENTENCE}]}, with one verdict for each item.`;

/** A feedback writer as the plan keeps it: a script, or one Claude judge with the writer's instruction. hash: what it is. */
type Writer = { name: string; hash: string; code?: string; judge?: string; method?: string };
/** Run a script (.py with python3, else Node) with a JSON value on stdin, in its own folder. */
function runScript(path: string, input: unknown) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(done => {
    const child = spawn(extname(path) === '.py' ? 'python3' : process.execPath, [path], { cwd: dirname(path), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.on('error', error => done({ code: 1, stdout, stderr: error.message }));
    child.on('close', code => done({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}
/**
 * What a feedback writer said: the correction (null when it found nothing wrong in what it checked) and what it checked:
 * "all" for the whole output (also when it does not say), else the part it checked, in words. Undefined when the answer
 * is not {"correction": TEXT | null, "checked"?: "all" | TEXT}.
 */
export type Feedback = { correction: string | null; checked: string };
function feedbackOf(answer: string): Feedback | undefined {
  const from = answer.indexOf('{'), to = answer.lastIndexOf('}');
  if (from < 0 || to < from) return undefined;
  let value: any;
  try { value = JSON.parse(answer.slice(from, to + 1)); } catch { return undefined; }
  if (!value || typeof value !== 'object' || !('correction' in value)) return undefined;
  // A writer that does not say what it checked checked all of the output.
  const checked = typeof value.checked === 'string' && value.checked.trim() ? value.checked.trim() : 'all';
  if (value.correction === null || typeof value.correction === 'string' && !value.correction.trim()) return { correction: null, checked };
  return typeof value.correction === 'string' ? { correction: value.correction.trim(), checked } : undefined;
}
/** Whether a writer checked the whole output, so that "nothing wrong" means the work is right. */
const checkedAll = (feedback: Feedback) => /^all$/i.test(feedback.checked);
export const feedbackWriting = {
  /**
   * Write the correction for one training run: the writer reads the input, the arm's own output (null when it handed in
   * nothing) and the hidden expected answer, and nothing about the arm. Returns the correction (null when nothing is
   * wrong in what it checked) and what it checked ("all", or the part). A judge works in a folder whose path names no
   * arm, with one retry when its answer is not the JSON it asks for.
   */
  async write(writer: Writer & { expected: unknown; work: string }, request: { input: { id: string; value: unknown }; task: string; output: string | null; outputName: string }): Promise<Feedback> {
    if (writer.code) {
      const result = await runScript(writer.code, { input: request.input.id, values: request.input.value, output: request.output, expected: writer.expected });
      const feedback = result.code === 0 ? feedbackOf(result.stdout) : undefined;
      if (feedback === undefined) throw Error(`The feedback writer ${writer.name} (${basename(writer.code)}) gave no correction for ${request.input.id}${result.stderr.trim() ? `: ${result.stderr.trim().split('\n').at(-1)}` : '; it must print {"correction": TEXT or null, "checked": "all" or what it checked}'}.`);
      return feedback;
    }
    mkdirSync(writer.work, { recursive: true, mode: 0o700 });
    const work = mkdtempSync(join(writer.work, 'w-')), room = join(work, 'room');
    try {
      mkdirSync(join(room, 'output'), { recursive: true, mode: 0o700 });
      if (request.output !== null) writeFileSync(join(room, 'output', request.outputName), request.output);
      else writeFileSync(join(room, 'output', 'NOT-HANDED-IN.md'), 'The agent did not hand in the file that the task asks for.\n');
      writeFileSync(join(room, 'task.md'), `${request.task}\n`);
      writeFileSync(join(room, 'expected-answer.md'), outputText(writer.expected));
      writeFileSync(join(room, 'instruction.md'), `${writer.judge}\n`);
      const { runMethod } = await import('@withmethod/runtime/runner.js');
      let last = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        const result: any = await runMethod(writer.method!, { allow_local_processes: true }, { runDir: join(work, `run-${attempt + 1}`), inputs: { room }, fresh: true });
        if (result.status !== 'completed') throw Error(`The feedback writer ${writer.name} did not finish: ${result.failure?.headline ?? result.status}.`);
        last = String(result.result?.final_text ?? '');
        const feedback = feedbackOf(last);
        if (feedback !== undefined) return feedback;
      }
      throw Error(`The feedback writer ${writer.name} did not answer {"correction": TEXT or null, "checked": "all" or what it checked}: ${last.slice(0, 300)}`);
    } finally { rmSync(work, { recursive: true, force: true }); }
  },
};

/**
 * Check a .compare file and write its generated Method, the stage script and the inputs into the comparison folder.
 * The file is saved as a version of its comparison in the account, for the comparison page. A plain Claude Code or
 * Codex arm runs as the runtime's session step, in a room with the files that the Method arms get.
 */
export async function compileComparison(file: string, options: { strict?: boolean } = {}) {
  const path = authoringPath(file), root = dirname(path);
  const doc = readComparison(path);
  if (doc.treatment?.events.some(event => event.model !== undefined)) throw Error('A treatment event that changes the model cannot run yet: that is not built yet. Corrections and new inputs run today.');
  const models = await armModels(doc, root);
  const id = ensureComparisonId(path, doc);
  const folder = comparisonFolder(path);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const web = doc.tested === 'tools';
  const labels = armLabels(doc, root);
  const arms: any[] = [];
  for (const [armName, arm] of Object.entries(doc.arms)) {
    const cache_dir = join(folder, 'arms', armName, 'cache');
    if (!armIsMethod(arm)) {
      const model = models.arms[armName]![0]!;
      arms.push({ name: armName, label: labels[armName], plain: { agent: arm.agent, instructions: readFileSync(resolve(root, arm.instructions), 'utf8'), model: model.model, effort: model.effort }, models: [model], cache_dir });
      continue;
    }
    arms.push({ name: armName, label: labels[armName], ...await copyArm(resolve(root, arm), join(folder, 'arms', armName)), models: models.arms[armName] ?? [], cache_dir });
  }
  // A plain arm gets the same folders that the Method arms get: a copy of each bound folder, by its name. For an input
  // with its own folder, measured or teaching, every arm gets that input's folders instead (cellFolders).
  const shared = Object.assign({}, ...arms.filter(a => !a.plain).map(a => a.folders)) as Record<string, string>;
  const generated = (armName: string, fileName: string, method: unknown) => {
    const target = join(folder, 'arms', armName, fileName);
    let methodId: string | undefined;
    try { methodId = readDocument(target).id; } catch { /* first run */ }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, JSON.stringify(method, null, 2) + '\n', { mode: 0o600 });
    writeMethodId(target, methodId && methodIdPattern.test(methodId) ? methodId : newMethodId());
    return target;
  };
  for (const arm of arms.filter(a => a.plain)) {
    arm.folders = shared;
    const tools = plainTools(arm.plain.agent, web), model = arm.models[0];
    arm.method = generated(arm.name, 'plain.method', sessionMethod(`Plain ${arm.plain.agent === 'claude' ? 'Claude Code' : 'Codex'}`, 'Do the task in the instructions for the input, as a plain agent.', arm.plain.agent, model, tools, '{{instructions}}\n\n{{task}}', ['instructions', 'task'], 3_600_000));
    arm.builder = generated(arm.name, 'builder.method', sessionMethod('Instructions builder', 'Edit a plain agent\'s instructions after a correction.', arm.plain.agent, model, plainTools(arm.plain.agent, false), builderPrompt, [], FIX_LIMIT_MS));
    arm.id = readDocument(arm.method).id;
    arm.hash = sha({ ...arm.plain, tools, deliverable: doc.deliverable ?? null, prompt: 'task/1', folders: Object.fromEntries(Object.entries(shared).map(([envName, dir]) => [envName, folderHash(dir)])) });
  }
  const device = arms.some(a => a.run_data === 'device');
  const judge = { agent: 'claude' as const, model: models.shared?.agent === 'claude' ? models.shared.model : null };
  const judgeMethod = join(folder, 'judge.method');
  writeFileSync(judgeMethod, JSON.stringify(sessionMethod('Comparison judge', 'Mark each checklist item of a handed-in document.', 'claude', { agent: 'claude', model: judge.model, effort: models.shared?.agent === 'claude' ? models.shared.effort : null }, ['read', 'search'], judgePrompt, [], 1_800_000), null, 2) + '\n', { mode: 0o600 });
  const resolveInput = (inputId: string) => {
    const value = inputValue(root, inputId), room = inputRoom(root, inputId);
    return { id: inputId, value, room, deliverable: doc.deliverable ? deliverableOf(doc.deliverable, value) : null, hash: room ? sha({ value, room: folderHash(room) }) : sha(value) };
  };
  const measure = (m: Measure, main: boolean) => ({ name: m.name, main,
    ...(m.code ? { code: { path: resolve(root, m.code), hash: sha(readFileSync(resolve(root, m.code))) } } : {}),
    ...(m.rubric ? { rubric: m.rubric } : {}), ...(m.checklist ? { checklist: m.checklist, covered: m.covered === true } : {}), ...(m.person ? { person: m.person } : {}) });
  // The measures read the expected answers of the measured inputs; a feedback event carries its own input's.
  const expected = Object.fromEntries(Object.entries(doc.expected ?? {}).filter(([inputId]) => doc.inputs.includes(inputId)).map(([inputId, p]) => [inputId, expectedValue(root, p)]));
  // The events in the order that every arm gets them: as given, or shuffled once with the seed. index is the place in
  // that order; an item of a checklist names its events by their place in the file, so its covered_by is mapped.
  const order = shuffled((doc.treatment?.events ?? []).map((event, i) => ({ event, file_index: i + 1 })), doc.treatment?.seed);
  const place = new Map(order.map((e, i) => [e.file_index, i + 1]));
  // A feedback writer: a script, or one Claude judge with the writer's instruction (feedback.method, on the judge's model).
  const writers = doc.treatment?.feedback_writers ?? {};
  const feedbackMethod = join(folder, 'feedback.method');
  if (Object.values(writers).some(w => w.judge !== undefined)) writeFileSync(feedbackMethod, JSON.stringify(sessionMethod('Feedback writer', 'Write an expert\'s feedback on one piece of work from the hidden expected answer.', 'claude', { agent: 'claude', model: judge.model, effort: models.shared?.agent === 'claude' ? models.shared.effort : null }, ['read', 'search'], feedbackPrompt, [], 1_800_000), null, 2) + '\n', { mode: 0o600 });
  const writerOf = (writerName: string): Writer => {
    const w = writers[writerName]!;
    return w.code ? { name: writerName, code: resolve(root, w.code), hash: sha({ code: sha(readFileSync(resolve(root, w.code))) }) }
      : { name: writerName, judge: w.judge!, method: feedbackMethod, hash: sha({ judge: w.judge, model: judge.model, version: FEEDBACK_VERSION }) };
  };
  // A feedback event carries its writer and the input's hidden answer, which only the writer reads. Its hash is both.
  const events = order.map(({ event, file_index }, i) => {
    const feedback = event.feedback !== undefined ? (() => { const writer = writerOf(event.feedback!), expected = expectedValue(root, doc.expected![event.input!]!);
      return { ...writer, expected, hash: sha({ writer: writer.hash, expected }), work: join(folder, 'feedback-work') }; })() : null;
    return { index: i + 1, file_index, kind: isCorrection(event) ? 'correction' : 'input', ...(event.correction ? { text: event.correction } : {}), ...(feedback ? { feedback } : {}), input: resolveInput(event.input!) };
  });
  const feedbackHash = events.some(e => e.feedback) ? sha(events.map(e => e.feedback?.hash ?? null)) : null;
  const checklists = Object.fromEntries(Object.entries(expected).map(([inputId, value]) => [inputId, checklistOf(value).map(item => ({ ...item, covered_by: item.covered_by.map(n => place.get(n) ?? n) }))]));
  // The page shows where each correction's words come from; the run's plan does not need it.
  const sourced = events.map(e => { const source = doc.treatment?.events[e.file_index - 1]?.source; return source ? { ...e, source } : e; });
  const spec = await accountSpec(doc, root, arms, sourced, checklists, { model: models.shared, judge, device }, uploadSignedIn);
  // The approval holds for the definition, whether or not the inputs' content went up.
  const digest = sha({ ...spec, inputs: { ...spec.inputs, details: Object.fromEntries(Object.entries(spec.inputs.details).map(([key, d]) => [key, d.name])) } });
  writePrivateJson(join(folder, 'spec.json'), { spec_digest: digest });
  const account = await saveComparison(folder, id, basename(path).replace(/\.compare$/i, ''), spec, options);
  const plan = {
    file: path, folder, question: doc.question, difference: doc.difference, other_differences: doc.other_differences ?? [],
    arms, inputs: doc.inputs.map(id => resolveInput(id)),
    events, feedback_hash: feedbackHash,
    checkpoints: doc.treatment ? [...doc.treatment.checkpoints].sort((a, b) => a - b) : null,
    measures: [measure(doc.measure, true), ...(doc.other_measures ?? []).map(m => measure(m, false))],
    expected, checklists,
    rule: doc.rule, rule_sentence: ruleSentence(doc), learners: doc.runs,
    assumptions: assumptionsOf(doc), compare_root: root, web, judge, judge_method: judgeMethod, model: models.shared, names: doc.about_inputs?.names ?? {},
  };
  const methodPath = join(folder, 'comparison.method');
  let previousId: string | undefined;
  try { const old = JSON.parse(readFileSync(methodPath, 'utf8')).id; if (typeof old === 'string' && methodIdPattern.test(old)) previousId = old; } catch { /* first run */ }
  const cellCount = arms.length * doc.inputs.length * Math.max(doc.runs, NOISE_LEARNERS) * ((plan.checkpoints?.length ?? 1) + 1);
  writeFileSync(join(folder, 'stage.mjs'), stageScript, { mode: 0o600 });
  // The answers on the comparison page: the approvals let the run go on, and the other answers are for the agent.
  const page = account ? await readAnswers(account) : null;
  const approval = { trial: !page || page.approved.trial || isTrialApproved(folder, digest), full_run: isApproved(folder, digest) || !!page?.approved.full_run, url: page?.url ?? account?.url ?? null };
  writeFileSync(methodPath, JSON.stringify(generatedMethod(doc, previousId, { cells: cellCount }, approval), null, 2) + '\n', { mode: 0o600 });
  const inputs = join(folder, 'inputs.json');
  writePrivateJson(inputs, { comparison: JSON.stringify(plan), marks: JSON.stringify(readMarks(folder)) });
  return { method: methodPath, inputs, folder, plan, spec, account, page };
}

/**
 * `method publish NAME.compare`: save the file to the account as a draft of its comparison, with the same spec and
 * input uploads that method run saves, and print the page's link. It runs nothing. A later method run of the same file
 * continues from that draft (the account answers the same version for the same spec).
 */
export async function publishComparison(args: string[]) {
  if (args.length !== 2) throw Error('Use method publish NAME.compare. It takes no options: it saves the comparison as a draft for review and runs nothing.');
  const compiled = await compileComparison(args[1]!, { strict: true });
  const account = compiled.account!, file = basename(authoringPath(args[1]!)), page = compiled.page;
  const todo = pageToDo(page), change = page?.answers.some(answer => answer.change);
  const next = change ? `The comparison page has answers that change the file. Make each change in answers, then publish again: method publish ${file}`
    : account.stage === 'draft' ? `Give the user this link. The page asks them about the comparison one question at a time; when they say yes to the trial there, run it: method run ${file}`
    : account.stage === 'trial' ? `The trial of this version has run. Give the user this link to read it; the page asks them to approve the full run. Then run it: method run ${file}`
    : 'This version has already run. Change the file to make a new draft.';
  process.stdout.write(JSON.stringify({ comparison_id: account.comparison_id, version_number: account.version_number, stage: account.stage, url: account.url,
    ...(page ? { questions_open: page.open } : {}), ...(todo.length ? { answers: todo } : {}), next }, null, 2) + '\n');
}

/**
 * What the agent does about the answers on the comparison page: each answer that asks for a change of the file, and
 * each writer's choice that the person kept (it goes into decided_by_you). Approvals and plain yeses need nothing.
 */
export function pageToDo(page: PageAnswers | null) {
  return (page?.answers ?? []).filter(answer => answer.change || answer.kind === 'writer_choice').map(answer => answer.to_do);
}

/**
 * `method run NAME.compare [OPTIONS]` becomes `method run .compare/NAME/comparison.method [OPTIONS] --inputs FILE`.
 * A resumed run keeps its saved inputs.
 */
export async function comparisonRunArgs(args: string[]) {
  const rest = args.slice(2);
  if (rest.some(arg => /^--inputs(-from)?(=|$)/.test(arg))) throw Error('A comparison names its inputs in the file. Run it without --inputs.');
  const compiled = await compileComparison(args[1]!);
  // An answer on the page that changes the file holds the run until the file has the change.
  const todo = pageToDo(compiled.page), file = basename(authoringPath(args[1]!));
  if (compiled.page?.answers.some(answer => answer.change))
    throw Error(`The comparison page has answers that change the file (${compiled.page.url}):\n${todo.map(line => `- ${line}`).join('\n')}\nChange the file, then publish again: method publish ${file}. The run starts when no answer waits for a change.`);
  if (todo.length) process.stderr.write(`Answers on the comparison page (${compiled.page!.url}):\n${todo.map(line => `- ${line}`).join('\n')}\n`);
  return ['run', compiled.method, ...rest, ...(rest.includes('--resume') ? [] : ['--inputs', compiled.inputs])];
}

// ---------------------------------------------------------------------------------------------------------------
// The treatment (method __compare STAGE: the bindings as JSON on stdin, the outputs as JSON on stdout)

type Plan = ReturnType<typeof JSON.parse>;
/** A plain arm: Claude Code or Codex with its instructions (after a treatment, as its builder left them), model and effort. */
type Plain = { agent: 'claude' | 'codex'; instructions: string; model: string | null; effort: string | null };
/** An arm at one point: a Method folder and file, or a plain agent. */
type Snapshot = { dir: string; file: string; hash: string; cache_dir?: string } | { plain: Plain; hash: string };
type Cell = { key: string; folder: string; arm: string; dir?: string; file?: string; plain?: Plain; method?: string; hash: string; cache_dir: string; folders: Record<string, string>; web: boolean; feedback?: string;
  input: { id: string; value: unknown; hash: string; room: string | null; deliverable: string | null }; repeat: number; checkpoint: number | null; trial: boolean; treatment_note: string | null };
const pointLabel = (checkpoint: number | null) => checkpoint === null ? '' : ` after ${plural(checkpoint, 'event')}`;
/** An arm's name on the page (armLabels), by its key. */
const labelOf = (plan: Plan, arm: string): string => plan.arms.find((a: any) => a.name === arm)?.label ?? arm;

/**
 * What happened to one correction for one learner. Method: fixed, no_change_needed, no_fix_found (received), or
 * could_not_test, question, held, stopped (not received). Plain builder: edited, not_edited (received), or stopped.
 * was_right: the feedback writer found nothing wrong, and the arm was told its output was right (received).
 * not_run: the training run failed. not_given: an earlier event of the learner is missing. given: a new input.
 */
export type CorrectionOutcome = 'fixed' | 'no_change_needed' | 'no_fix_found' | 'could_not_test' | 'question' | 'held' | 'stopped' | 'edited' | 'not_edited' | 'was_right' | 'no_feedback' | 'not_run' | 'not_given' | 'given';
/** What a correction changed: Method's summary of its fix, and the diff of the Method's files or of the plain agent's instructions. */
export type ChangeRecord = { summary?: string; diff: string };
/** Whether an outcome changed the agent: Method's fix applied a tested change, or the builder edited the instructions. */
export const changedAgent = (outcome: CorrectionOutcome) => outcome === 'fixed' || outcome === 'edited';
export const outcomeWords: Record<CorrectionOutcome, string> = { fixed: 'fixed', no_change_needed: 'no change needed', no_fix_found: 'no fix found', could_not_test: 'could not test',
  question: 'the fix asks a question', held: 'held for another correction', stopped: 'stopped', edited: 'edited', not_edited: 'not edited', was_right: 'was right', no_feedback: 'no feedback', not_run: 'the training run failed', not_given: 'not given', given: 'given' };
/** What one event did for one learner, as the record and the account keep it. text: the words that the learner received (a feedback writer's words differ by learner). */
type EventRecord = { key: string; index: number; kind: string; input: string; learner: number; received: boolean; outcome: CorrectionOutcome; text?: string; reason?: string; detail?: string; change?: ChangeRecord;
  run_id?: string; judgment_id?: string; instructions?: string; tokens: number | null; duration_ms: number; at: string };
/** Treatment of one learner: what each event did, what is missing, and the frozen copy of the learner at each checkpoint it reached. */
type LearnerTreatment = { learner: number; events: EventRecord[]; missing: Array<{ index: number; reason: string; detail?: string; after?: number }>; snapshots: Record<string, Snapshot> };
/** Treatment of one arm: each learner's. */
type ArmTreatment = { arm: string; planned: number; learners: LearnerTreatment[] };

/**
 * Both kinds of arm run an event's input on the folders that a cell of that input gets (cellFolders): the arm's own,
 * with each folder of the input's own folder in place of the one of its name.
 *
 * How a correction reaches a Method arm. The arm runs the event's input (a training run, saved to the account), then
 * method judge RUN wrong --note TEXT, then method wait until the fix has a final outcome, for at most FIX_LIMIT_MS.
 * Received: fixed, no change needed (the run already does what the correction asks), or no fix found. Not received: could not
 * test, a question, held, or a fix that stopped or ran out of time. A rerun of the comparison waits for the same
 * judgment while its fix is still working or waits for the person's answer (method answer), and never judges the run
 * a second time then. A fix that already ended stopped or could not test is over: the rerun gives the correction again,
 * with a new training run and a new judgment. A new input: the training run alone. reason says what happened in plain
 * words, for the page; detail is what an agent needs to fix the cause (a step, a script, an error), for the CLI only.
 *
 * How a correction reaches a plain arm (build): the plain agent runs the event's input with its current instructions
 * (a training run), then a builder session gets the correction, the task and the wrong output, and edits the agent's
 * instructions file. Received when the builder finished, edited or not. Tests replace deliver and build.
 *
 * A feedback event: after the training run, the event's feedback writer reads the arm's own output (the deliverable
 * file, or a Method arm's result without one) and the hidden expected answer, and writes the words that this arm gets:
 * the --note of method judge RUN wrong, or the builder's correction. When it finds nothing wrong, a Method arm gets
 * method judge RUN right and the builder reads that the work is right; the event is received as was_right. Each
 * delivery keeps the words the arm received (text).
 */
type Delivered = { received: boolean; outcome: CorrectionOutcome; text?: string; reason?: string; detail?: string; run_id?: string; judgment_id?: string; tokens?: number | null; change?: ChangeRecord };
type Built = { received: boolean; outcome: CorrectionOutcome; text?: string; reason?: string; detail?: string; instructions?: string; tokens?: number | null; change?: ChangeRecord };
export const delivery = {
  async deliver(event: any, learner: { dir: string; file: string }, cacheDir: string, workDir: string, before?: Delivered, settings: { web: boolean; folders?: Record<string, string> } = { web: false }): Promise<Delivered> {
    // The training run and its fix run in a clean room, as the arm's cells do: they see none of the user's
    // instructions, memory or settings, only the sign-ins of the agents they use.
    const room = await armRoom(join(learner.dir, learner.file), cacheDir, true, {}, settings.web);
    const placed = placeFolders(learner.dir, settings.folders ?? {});
    try { return await deliverIn(room.env, event, learner, workDir, before); } finally { placed(); await room.remove(); }
  },
  async build(event: any, arm: any, instructions: string, workDir: string, plan: Plan, log: Array<{ index: number; input: string; text: string }> = []): Promise<Built> {
    return buildIn(event, arm, instructions, workDir, plan, log);
  },
};
/**
 * Put a copy of each folder beside the learner's Method, by its files connection's name: the learner's copy has its own
 * Method ID and no bindings, so method run and its fix use the folder beside it. Returns what removes the copies (and
 * puts back what was there), so that the learner's frozen copies hold only the Method.
 */
function placeFolders(dir: string, folders: Record<string, string>) {
  const aside: Array<[string, string]> = [];
  for (const [envName, from] of Object.entries(folders)) {
    const target = join(dir, envName);
    if (existsSync(target)) { aside.push([target, `${target}.method-aside`]); renameSync(target, `${target}.method-aside`); }
    cpSync(from, target, { recursive: true, verbatimSymlinks: true });
  }
  return () => {
    for (const envName of Object.keys(folders)) removeFolder(join(dir, envName));
    for (const [target, saved] of aside) renameSync(saved, target);
  };
}
async function deliverIn(env: NodeJS.ProcessEnv, event: any, learner: { dir: string; file: string }, workDir: string, before?: Delivered): Promise<Delivered> {
  const file = join(learner.dir, learner.file);
  if (before?.judgment_id && before.run_id) {
    let earlier = await waitForFix(before.run_id, before.judgment_id, env, file);
    // A fix that stopped (an error, a usage limit) gave its correction back: the same judgment of the same run is fixed
    // again, so one correction stays one judgment with one case.
    if (earlier.outcome === 'stopped' && earlier.pending) {
      await command(['__fix', file, '--judgment', before.judgment_id], env);
      earlier = await waitForFix(before.run_id, before.judgment_id, env, file);
    }
    if (earlier.outcome !== 'stopped' && earlier.outcome !== 'could_not_test') return { ...earlier, ...(before.text ? { text: before.text } : {}) };
    // A correction given again is a new judgment of a new run: the old judgment's case does not stay as a second one.
    rmSync(join(learner.dir, 'cases', correctionCaseId(before.judgment_id)), { recursive: true, force: true });
  }
  const runDir = join(workDir, 'run');
  removeFolder(workDir);
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  writePrivateJson(join(workDir, 'inputs.json'), event.input.value);
  // A training run reuses nothing: its output is this learner's work now, as a plain arm's training run is.
  const run = await command(['run', join(learner.dir, learner.file), '--inputs', join(workDir, 'inputs.json'), '--run-dir', runDir, '--fresh'], env);
  let summary: any = {};
  try { summary = JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8')); } catch { /* the run did not start */ }
  if (summary.status !== 'completed') return { received: false, outcome: 'not_run', reason: 'the training run did not finish',
    detail: `the training run on ${event.input.id} ended ${summary.status ?? 'before its first step'}${summary.failure?.headline ? `: ${summary.failure.headline}` : run.stderr ? `: ${run.stderr.trim().split('\n').at(-1)}` : ''}` };
  if (event.kind !== 'correction') return { received: true, outcome: 'given' };
  let runId: string | undefined;
  try { runId = JSON.parse(readFileSync(join(runDir, 'method-sync.json'), 'utf8')).dashboard_id; } catch { /* not saved */ }
  if (!runId) return { received: false, outcome: 'not_run', reason: 'the training run is not in your Method account, so Method cannot take the correction', detail: 'Sign in with method login, then run the comparison again' };
  let text: string = event.text;
  if (event.feedback) {
    // The arm's own output of this training run: the file it handed in beside its Method, or its result.
    let output: string | null = null;
    try { output = event.input.deliverable ? readFileSync(join(learner.dir, event.input.deliverable), 'utf8') : outputText(JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8'))); } catch { /* handed in nothing */ }
    let written: Feedback;
    try { written = await feedbackWriting.write(event.feedback, { input: event.input, task: taskPrompt(event.input.value, event.input.deliverable), output, outputName: event.input.deliverable ? basename(event.input.deliverable) : 'output.md' }); }
    catch (error) { return { received: false, outcome: 'stopped', run_id: runId, reason: 'the feedback writer gave no correction', detail: (error as Error).message }; }
    // Nothing wrong in one part says nothing about the rest: the arm gets no feedback, and Method keeps no approved run.
    if (written.correction === null && !checkedAll(written)) return { received: true, outcome: 'no_feedback', run_id: runId, text: `No feedback (the writer checked ${written.checked} and found nothing wrong).`, tokens: null };
    if (written.correction === null) {
      const right = await command(['judge', runId, 'right', '--json'], env);
      let id: string | undefined;
      try { id = JSON.parse(right.stdout)?.judgment?.id; } catch { /* below */ }
      if (!id) return { received: false, outcome: 'stopped', run_id: runId, reason: 'Method could not take the verdict right', detail: `method judge failed: ${right.stderr.trim() || right.stdout.trim()}` };
      return { received: true, outcome: 'was_right', run_id: runId, judgment_id: id, text: 'right', tokens: null };
    }
    text = written.correction;
  }
  const judged = await command(['judge', runId, 'wrong', '--note', text, '--json'], env);
  let judgment: any;
  try { judgment = JSON.parse(judged.stdout); } catch { return { received: false, outcome: 'stopped', run_id: runId, reason: 'Method could not take the correction', detail: `method judge failed: ${judged.stderr.trim() || judged.stdout.trim()}` }; }
  const id = judgment?.judgment?.id;
  if (!id || !judgment.fix) return { received: false, outcome: 'stopped', run_id: runId, text, reason: 'Method started no fix for this correction', ...(judgment?.stopped?.failure?.headline ? { detail: judgment.stopped.failure.headline } : {}) };
  return { ...await waitForFix(runId, id, env, file), text };
}

/** Why a fix ended without an outcome for this correction, in words, by the loop's outcome. */
const stoppedWhy: Record<string, string> = {
  already_changed: 'The step that this correction is about changed after its training run, so Method did not fix it',
  elsewhere: 'No fix on this computer took this correction',
  retry: 'Method gave this correction back to fix it again on the changed agent, and no later fix took it',
};
/** A fix's outcome in the comparison's words, and whether the correction counts as received. */
export function fixOutcome(outcome: string | undefined): { received: boolean; outcome: CorrectionOutcome } {
  if (outcome === 'fixed') return { received: true, outcome: 'fixed' };
  if (outcome === 'no_change_needed') return { received: true, outcome: 'no_change_needed' };
  if (outcome === 'no_fix_found') return { received: true, outcome: 'no_fix_found' };
  if (outcome === 'could_not_test') return { received: false, outcome: 'could_not_test' };
  if (outcome === 'question') return { received: false, outcome: 'question' };
  if (outcome === 'held') return { received: false, outcome: 'held' };
  return { received: false, outcome: 'stopped' };
}

/**
 * The clean room of a Method arm (cleanRoomEnv): a fresh HOME with only the sign-ins of the agents that its model
 * steps run on (and, for a fix, the user's own agent, which runs the fix), a short TMPDIR, and a copy of each bound
 * folder. Method's own sign-in, cache and server stay: the arm's runs and judgments belong to the user's account.
 * Without web, its Claude Code and Codex steps (and its fix's) run without web search and fetch (METHOD_WEB=off).
 */
async function armRoom(file: string, cacheDir: string, fix: boolean, folders: Record<string, string> = {}, web = false) {
  const { cleanRoomEnv } = await import('@withmethod/runtime/clean-room.js');
  const { localAgent, methodProfiles } = await import('@withmethod/runtime/agents.js');
  const method = readDocument(file);
  const models = Object.values(method.steps ?? {}).flatMap((step: any) => [step.do, step.check]).filter((exec: any) => ['call', 'agent'].includes(exec?.kind));
  const agents = new Set<string>(Object.values(methodProfiles(method)).map((profile: any) => profile.backend));
  // A session step runs its own agent, which needs that agent's sign-in in the room.
  for (const step of Object.values(method.steps ?? {}) as any[]) if (step.do?.kind === 'session') agents.add(step.do.agent);
  if (fix || models.length) { const local = await localAgent(); if (local) agents.add(local); }
  const room = await cleanRoomEnv([...agents].filter((agent): agent is 'claude' | 'codex' => agent === 'claude' || agent === 'codex'), process.env, { folders });
  Object.assign(room.env, { METHOD_CONFIG_DIR: configRoot(), METHOD_CACHE_DIR: cacheDir, ...(web ? {} : { METHOD_WEB: 'off' }), ...(process.env.METHOD_SERVER ? { METHOD_SERVER: process.env.METHOD_SERVER } : {}),
    ...(process.env.METHOD_ACCOUNT ? { METHOD_ACCOUNT: process.env.METHOD_ACCOUNT } : {}) });
  return room;
}
/**
 * Wait for the fix of a correction until it has a final outcome and the fix has ended completely (its lock is free), so
 * the next correction learns on the changed Method. For at most FIX_LIMIT_MS. pending: the fix stopped and gave the
 * correction back.
 */
async function waitForFix(runId: string, id: string, env: NodeJS.ProcessEnv, file: string): Promise<Delivered & { pending?: boolean }> {
  const deadline = Date.now() + FIX_LIMIT_MS;
  const late = { received: false, outcome: 'stopped' as const, run_id: runId, judgment_id: id, reason: `Method's fix did not finish within ${FIX_LIMIT_MS / 3_600_000} hours, the time each correction has` };
  for (;;) {
    const left = Math.ceil((deadline - Date.now()) / 1000);
    if (left <= 0) return late;
    const waited = await command(['wait', id, '--json', '--timeout', String(Math.min(600, left))], env);
    let record: any;
    try { record = JSON.parse(waited.stdout).outcomes?.[0]; } catch { return { received: false, outcome: 'stopped', run_id: runId, judgment_id: id, reason: 'Method could not read what the fix did', detail: `method wait failed: ${waited.stderr.trim()}` }; }
    if (record?.status === 'working') continue;
    if (record?.status === 'done') {
      if (fixHolds(file, env)) {
        while (fixHolds(file, env) && Date.now() < deadline) await new Promise(done => setTimeout(done, 1000));
        if (fixHolds(file, env)) return late;
        continue;
      }
      const { received, outcome } = fixOutcome(record.outcome?.outcome);
      if (outcome === 'question') return { received, outcome, run_id: runId, judgment_id: id, reason: `Method's fix asks a question: ${record.outcome?.question ?? record.lines?.[0] ?? ''}`, detail: `Answer it with method answer ${id} "THE ANSWER", then run the comparison again` };
      if (outcome === 'could_not_test') return { received, outcome, run_id: runId, judgment_id: id, reason: 'Method\'s fix could not test a change', ...(record.outcome?.detail ? { detail: record.outcome.detail } : {}) };
      if (!received) return { received, outcome, run_id: runId, judgment_id: id, reason: stoppedWhy[record.outcome?.outcome] ?? `Method's fix ended ${outcomeWords[outcome]}` };
      // What the learner changed: its summary for the person and the diff of the Method's files.
      const change = outcome === 'fixed' && typeof record.outcome?.diff === 'string' ? { ...(record.outcome.summary ? { summary: String(record.outcome.summary) } : {}), diff: record.outcome.diff as string } : undefined;
      return { received, outcome, run_id: runId, judgment_id: id, tokens: null, ...(change ? { change } : {}) };
    }
    // The fix stopped: its error in its own words (a usage limit says so), with the cause for the CLI.
    const error = typeof record?.error === 'string' && record.error.trim() ? record.error.trim() : null;
    return { received: false, outcome: 'stopped', run_id: runId, judgment_id: id, pending: true, reason: error ? `Method's fix stopped: ${error.split('\n')[0]}` : 'Method\'s fix stopped before it finished', ...(error ? { detail: `${error} (judgment ${id})` } : {}) };
  }
}
/** Whether a fix of the learner's Method still runs: its lock in the learner's cache names a running process. */
function fixHolds(file: string, env: NodeJS.ProcessEnv) {
  const id = (readDocument(file) as any).id;
  if (typeof id !== 'string' || !env.METHOD_CACHE_DIR) return false;
  try { const pid = JSON.parse(readFileSync(join(env.METHOD_CACHE_DIR, 'fixes', id, 'lock'), 'utf8')).pid; process.kill(pid, 0); return true; } catch { return false; }
}
/** Run the method CLI that runs this comparison (the first method on PATH, which the SDK puts there). */
function command(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(done => {
    const child = spawn('method', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => done({ code: 1, stdout, stderr: error.message }));
    child.on('close', code => done({ code: code ?? 1, stdout, stderr }));
  });
}

/** The tokens that the agents of a run reported (Claude Code and Codex sessions and steps), or null when none did. */
export function tokensOfRun(runDir: string): number | null {
  let total = 0, found = false;
  let lines: string[] = [];
  try { lines = readFileSync(join(runDir, 'events.jsonl'), 'utf8').split('\n'); } catch { return null; }
  for (const line of lines) {
    let e: any; try { e = line ? JSON.parse(line) : null; } catch { continue; }
    if (e?.event === 'agent.completed' && e.usage && typeof e.usage === 'object') {
      found = true;
      for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) total += Number(e.usage[key]) || 0;
    }
    if (e?.event === 'codex.completed' && Array.isArray(e.usage)) for (const u of e.usage) { found = true; total += (Number(u?.input_tokens) || 0) + (Number(u?.output_tokens) || 0); }
  }
  return found ? total : null;
}

/** Run a plain session Method (an arm's run or its builder) in its own run folder, with a copy of each folder in its room. */
async function runSession(methodFile: string, runDir: string, folders: Record<string, string> | string, values: Record<string, string>, hooks: any = {}) {
  // A ready folder is the room as it is (the session works on its own copy); folders are copied into a room by name.
  const room = typeof folders === 'string' ? folders : join(dirname(runDir), 'room');
  if (typeof folders !== 'string') {
    removeFolder(room);
    mkdirSync(room, { recursive: true, mode: 0o700 });
    for (const [envName, dir] of Object.entries(folders)) cpSync(dir, join(room, envName), { recursive: true });
  }
  const { runMethod } = await import('@withmethod/runtime/runner.js');
  const inputs = { ...values, room };
  try {
    await hooks.before?.(inputs);
    return await runMethod(methodFile, { allow_local_processes: true }, { runDir, inputs, fresh: true, ...(hooks.onStart ? { onStart: hooks.onStart, onEvent: hooks.onEvent } : {}) });
  } finally { if (typeof folders !== 'string') removeFolder(room); }
}
/** The text of a file that a session wrote in its room (a copy under its attempt folder in artifacts/session), or null. */
function sessionFile(runDir: string, session: any, path: string): string | null {
  const written = (session?.files_written ?? []).find((f: any) => typeof f?.path === 'string' && f.path.replace(/^session\/attempt-[^/]+\/room\//, '') === path);
  if (!written) return null;
  try { return readFileSync(join(runDir, 'artifacts', written.path), 'utf8'); } catch { return null; }
}

/** The builder of a plain arm, for one correction: a training run with the current instructions (on the input's folders), then the edit. */
async function buildIn(event: any, arm: any, instructions: string, workDir: string, plan: Plan, log: Array<{ index: number; input: string; text: string }> = []): Promise<Built> {
  removeFolder(workDir);
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const folders = cellFolders(arm, event.input);
  const train = join(workDir, 'training', 'run');
  const trained: any = await runSession(arm.method, train, folders, { instructions, task: taskPrompt(event.input.value, event.input.deliverable) });
  if (trained.status !== 'completed') return { received: false, outcome: 'not_run', reason: 'the training run did not finish', detail: `the training run on ${event.input.id} ended ${trained.status}${trained.failure?.headline ? `: ${trained.failure.headline}` : ''}` };
  const wrong = event.input.deliverable ? sessionFile(train, trained.result, event.input.deliverable) : null;
  // A feedback writer writes the correction from this output; nothing wrong means the builder reads that it is right.
  let text: string = event.text, right = false;
  if (event.feedback) {
    let written: Feedback;
    try { written = await feedbackWriting.write(event.feedback, { input: event.input, task: taskPrompt(event.input.value, event.input.deliverable), output: wrong, outputName: event.input.deliverable ? basename(event.input.deliverable) : 'output.md' }); }
    catch (error) { return { received: false, outcome: 'stopped', reason: 'the feedback writer gave no correction', detail: (error as Error).message }; }
    // Nothing wrong in one part: the builder gets nothing, as the Method arm does.
    if (written.correction === null && !checkedAll(written)) return { received: true, outcome: 'no_feedback', text: `No feedback (the writer checked ${written.checked} and found nothing wrong).`, instructions, tokens: tokensOfRun(train) };
    right = written.correction === null;
    text = written.correction ?? RIGHT_WORDS;
  }
  const room = join(workDir, 'builder-room');
  mkdirSync(join(room, 'wrong-output'), { recursive: true, mode: 0o700 });
  writeFileSync(join(room, 'instructions.md'), instructions);
  writeFileSync(join(room, 'correction.md'), `${text}\n`);
  writeFileSync(join(room, 'task.md'), `${taskPrompt(event.input.value, event.input.deliverable)}\n`);
  if (wrong !== null) writeFileSync(join(room, 'wrong-output', basename(event.input.deliverable)), wrong);
  else writeFileSync(join(room, 'wrong-output', 'NOT-HANDED-IN.md'), `The agent did not hand in ${event.input.deliverable ?? 'a file'}.\n`);
  // The case it learns from: the task's own files as the agent got them, and every earlier correction in order.
  for (const [envName, dir] of Object.entries(folders)) cpSync(dir, join(room, 'task-files', envName), { recursive: true });
  writeFileSync(join(room, 'corrections-log.md'), log.length ? `${log.map(l => `${l.index}. On ${l.input}: ${l.text}`).join('\n')}\n` : 'No earlier corrections.\n');
  const build = join(workDir, 'builder', 'run');
  const built: any = await runSession(arm.builder, build, room, {});
  const tokens = [tokensOfRun(train), tokensOfRun(build)];
  const used = tokens.every(t => t !== null) ? (tokens[0]! + tokens[1]!) : null;
  if (built.status !== 'completed') return { received: false, outcome: 'stopped', text, reason: `the ${arm.plain?.agent === 'codex' ? 'Codex' : 'Claude Code'} session that edits the instructions did not finish`, detail: `the builder ended ${built.status}${built.failure?.headline ? `: ${built.failure.headline}` : ''}`, tokens: used };
  const edited = sessionFile(build, built.result, 'instructions.md');
  const next = edited !== null && edited !== instructions ? edited : instructions;
  return { received: true, outcome: next !== instructions ? 'edited' : right ? 'was_right' : 'not_edited', text, instructions: next, tokens: used,
    ...(next !== instructions ? { change: { diff: textDiff(instructions, next, 'instructions.md', 'instructions.md') } } : {}) };
}

/** Copy a folder without its run records. */
const copyFolder = (from: string, to: string) => { removeFolder(to); cpSync(from, to, { recursive: true, filter: path => !['.method-runs', 'node_modules'].includes(basename(path)) }); };
const readRecords = (file: string) => {
  const records = new Map<string, any>();
  try { for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(line); records.set(r.key, r); } } catch { /* nothing yet */ }
  return records;
};
/** The folder of one learner's treatment: its own copy of the arm, its own cache and its record. */
const learnerFolder = (plan: Plan, arm: any, learner: number) => join(plan.folder, 'arms', arm.name, `treatment-${(plan.feedback_hash ? sha({ arm: arm.hash, feedback: plan.feedback_hash }) : arm.hash).slice(0, 12)}`, `learner-${learner + 1}`);

/**
 * Give each learner of each arm its events in order, up to its limit (limits[learner]), one at a time, and freeze a
 * copy at each checkpoint. Each Method learner is its own copy of the arm, with its own Method ID, folder and cache.
 * The record (treatment.jsonl in the learner's folder) keeps what each event did, so a rerun gives an event again only
 * when it was not received. After a missing event no later event is given: the order is part of the treatment.
 */
async function treat(plan: Plan, limits: number[]): Promise<ArmTreatment[]> {
  return Promise.all(plan.arms.map(async (arm: any) => ({
    arm: arm.name, planned: Math.max(...limits),
    learners: await Promise.all(limits.map((limit, learner) => treatLearner(plan, arm, learner, plan.events.slice(0, limit)))),
  })));
}
async function treatLearner(plan: Plan, arm: any, learner: number, events: any[]): Promise<LearnerTreatment> {
  const base = learnerFolder(plan, arm, learner);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const recordFile = join(base, 'treatment.jsonl');
  const records = readRecords(recordFile);
  const snapshots: LearnerTreatment['snapshots'] = {};
  // A Method learner: its own copy of the arm with its own Method ID and cache, frozen at the start too.
  const method = arm.plain ? null : { dir: join(base, 'method'), file: arm.file, cache: join(base, 'cache') };
  if (method && !existsSync(join(method.dir, method.file))) {
    copyFolder(arm.dir, method.dir);
    writeMethodId(join(method.dir, method.file), newMethodId());
    copyFolder(method.dir, join(base, 'after-0'));
  }
  let instructions: string = arm.plain ? arm.plain.instructions : '';
  const freeze = (at: number) => {
    if (arm.plain) {
      const plain = { ...arm.plain, instructions };
      snapshots[at] = { plain, hash: at === 0 && instructions === arm.plain.instructions ? arm.hash : sha({ plain, room: arm.hash }) };
      return;
    }
    const dir = join(base, `after-${at}`);
    if (!existsSync(join(dir, arm.file))) copyFolder(method!.dir, dir);
    snapshots[at] = { dir, file: arm.file, hash: folderHash(dir, arm.file), cache_dir: method!.cache };
  };
  freeze(0);
  const done: EventRecord[] = [], missing: LearnerTreatment['missing'] = [];
  let stopped = false;
  for (const event of events) {
    const key = sha({ index: event.index, kind: event.kind, text: event.text ?? null, input: event.input.hash, builder: arm.plain ? sha({ plain: arm.plain, prompt: builderPrompt }) : null, ...(event.feedback ? { feedback: event.feedback.hash } : {}) });
    if (stopped) {
      missing.push({ index: event.index, reason: 'not given', after: missing[0]!.index });
      done.push({ key, index: event.index, kind: event.kind, input: event.input.id, learner, received: false, outcome: 'not_given', tokens: null, duration_ms: 0, at: new Date().toISOString() });
      continue;
    }
    if (!records.get(key)?.received) {
      const started = Date.now();
      let result: Delivered | Built;
      try {
        if (arm.plain) result = event.kind === 'correction' ? await delivery.build(event, arm, instructions, join(base, 'events', String(event.index)), plan,
          done.filter(e => e.kind === 'correction' && e.received && e.outcome !== 'no_feedback').map(e => ({ index: e.index, input: plan.names?.[e.input] ?? e.input.replace(/^.*[/\\]/, '').replace(/\.[a-z0-9]+$/i, ''), text: e.text ?? plan.events.find((x: any) => x.index === e.index)?.text ?? '' }))) : { received: true, outcome: 'given', instructions };
        else result = await delivery.deliver(event, method!, method!.cache, join(base, 'events', String(event.index)), records.get(key), { web: plan.web, folders: cellFolders(arm, event.input) });
      } catch (error) { result = { received: false, outcome: 'stopped', reason: 'it stopped with an error', detail: (error as Error).message }; }
      const before = records.get(key);
      // The same judgment with the same outcome again (a fix that still waits for an answer) is already in the record.
      const same = before && !result.received && 'judgment_id' in result && result.judgment_id && result.judgment_id === before.judgment_id && result.outcome === before.outcome;
      if (!same) {
        const record = { key, index: event.index, kind: event.kind, input: event.input.id, learner, text_sha256: event.text ? sha(event.text) : null, ...result, tokens: result.tokens ?? null, duration_ms: Date.now() - started, at: new Date().toISOString() };
        writeFileSync(recordFile, JSON.stringify(record) + '\n', { flag: 'a', mode: 0o600 });
        records.set(key, record);
      }
    }
    const record = records.get(key);
    done.push({ key, index: record.index, kind: record.kind, input: record.input, learner, received: record.received, outcome: record.outcome ?? (record.received ? 'fixed' : 'stopped'), ...(typeof record.text === 'string' ? { text: record.text } : {}), ...(record.reason ? { reason: record.reason } : {}), ...(record.detail ? { detail: record.detail } : {}),
      ...(record.change ? { change: record.change } : {}), ...(record.run_id ? { run_id: record.run_id } : {}), ...(record.judgment_id ? { judgment_id: record.judgment_id } : {}), tokens: record.tokens ?? null, duration_ms: record.duration_ms ?? 0, at: record.at });
    if (!record.received) { missing.push({ index: event.index, reason: record.reason ?? 'not received', ...(record.detail ? { detail: record.detail } : {}) }); stopped = true; continue; }
    if (arm.plain && typeof record.instructions === 'string') instructions = record.instructions;
    if (plan.checkpoints?.includes(event.index)) freeze(event.index);
  }
  return { learner, events: done, missing, snapshots };
}

/** The treatment that a run at a checkpoint received, in words, for its page. Null without a treatment over time. */
function treatmentNote(plan: Plan, arm: any, checkpoint: number | null, learner?: LearnerTreatment) {
  if (checkpoint === null) return null;
  const given = plan.events.filter((e: any) => e.index <= checkpoint);
  if (!given.length) return 'Nothing was given to the agent before this run.';
  const how = arm.plain ? `After each correction a ${arm.plain.agent === 'codex' ? 'Codex' : 'Claude Code'} session edited the agent's instructions. The corrections, one at a time, in this order` : 'Method learned from each correction, one at a time, in this order';
  const record = (e: any) => learner?.events.find(x => x.index === e.index);
  const outcome = (e: any) => { const r = record(e); return r && e.kind === 'correction' ? ` (${outcomeWords[r.outcome]})` : ''; };
  const name = (id: string) => plan.names?.[id] ?? id.replace(/^.*[/\\]/, '').replace(/\.[a-z0-9]+$/i, '');
  // A feedback writer's words are this copy's own.
  const words = (e: any) => record(e)?.text ?? e.text ?? (e.feedback ? `(from the feedback writer ${e.feedback.name})` : '');
  return [`Copy ${(learner?.learner ?? 0) + 1}. ${how}:`, ...given.map((e: any) => `${e.index}. ${e.kind === 'correction' ? `Correction on ${name(e.input.id)}: ${words(e)}${outcome(e)}` : `New input: ${name(e.input.id)}`}`)].join('\n');
}

/** A reason as the end of a sentence: one period, never two. */
const sentence = (text: string) => `${text.trim().replace(/[.\s]+$/, '')}.`;
/** The start of a text, cut at a word boundary: "The video script to the general counsel should do this: uses…". */
export function clipWords(text: string, max = 60) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1), space = cut.lastIndexOf(' ');
  return `${(space > max / 3 ? cut.slice(0, space) : text.slice(0, max)).replace(/[\s,.;:–-]+$/, '')}…`;
}
/** Numbers as runs: [2, 3, 4, 7] → "2 to 4 and 7". */
function numberRuns(list: number[]) {
  const runs: Array<[number, number]> = [];
  for (const n of [...list].sort((a, b) => a - b)) { const last = runs.at(-1); if (last && n === last[1] + 1) last[1] = n; else runs.push([n, n]); }
  const words = runs.map(([a, b]) => a === b ? String(a) : b === a + 1 ? `${a} and ${b}` : `${a} to ${b}`);
  return words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}
/** A treatment event's kind as the page says it: correction, or new input. */
const eventWord = (kind: string | undefined) => kind === 'correction' ? 'correction' : 'new input';
/**
 * What one copy (learner) of an arm is missing of one kind, in plain words, for the page: the event that was not
 * received, with its words cut at a word boundary, and one line for the events after it that were not given. The page
 * opens the full words of "correction N" from the treatment list. details: the same with what an agent needs to fix the
 * cause, for the CLI.
 */
function missingLines(plan: Plan, learner: LearnerTreatment, kind: string, copies: boolean) {
  const kindOf = (index: number) => plan.events.find((e: any) => e.index === index)?.kind;
  const own = learner.missing.filter(m => kindOf(m.index) === kind);
  const copy = (text: string) => copies ? `Copy ${learner.learner + 1}: ${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
  const word = eventWord(kind), capital = word.charAt(0).toUpperCase() + word.slice(1);
  const lines: string[] = [], details: string[] = [];
  for (const m of own.filter(m => m.after === undefined)) {
    const event = plan.events.find((e: any) => e.index === m.index);
    const line = copy(`${capital} ${m.index}${event?.text ? ` (“${clipWords(event.text)}”)` : ''} was not received: ${sentence(m.reason)}`);
    lines.push(line);
    details.push(m.detail ? `${line.replace(/\.$/, '')}: ${sentence(m.detail)}` : line);
  }
  const notGiven = own.filter(m => m.after !== undefined);
  if (notGiven.length) {
    const first = notGiven[0]!.after!;
    const line = copy(`${notGiven.length === 1 ? capital : `${capital}s`} ${numberRuns(notGiven.map(m => m.index))} ${notGiven.length === 1 ? 'was' : 'were'} not given, because ${eventWord(kindOf(first))} ${first} did not arrive.`);
    lines.push(line); details.push(line);
  }
  return { lines, details };
}
/**
 * What an arm received, as the account keeps it: the models its runs used, one line per kind of thing (summed over its
 * learners), and each correction for each learner with what happened to it. details: the missing lines with their
 * causes, for the CLI.
 */
function receivedOf(arm: string, runs: any[], planned: number, t: ArmTreatment | undefined, plan: Plan) {
  const own = runs.filter(r => r.arm === arm);
  const lines: Array<{ what: string; received: number; planned: number; missing: string[]; changed?: number }> = [{ what: 'Inputs run', received: own.length, planned, missing: [] as string[] }];
  const details: string[] = [];
  const count = (kind: string) => {
    const learners = t?.learners ?? [];
    const plannedEvents = learners.reduce((n, l) => n + l.events.filter(e => e.kind === kind).length, 0);
    const received = learners.reduce((n, l) => n + l.events.filter(e => e.kind === kind && e.received).length, 0);
    // A copy is named only when more than one copy of the arm got events of this kind.
    const copies = learners.filter(l => l.events.some(e => e.kind === kind)).length > 1;
    const missing = learners.map(l => missingLines(plan, l, kind, copies));
    details.push(...missing.flatMap(m => m.details));
    const changed = learners.reduce((n, l) => n + l.events.filter(e => e.kind === kind && e.received && changedAgent(e.outcome)).length, 0);
    return { planned: plannedEvents, received, missing: missing.flatMap(m => m.lines), ...(kind === 'correction' ? { changed } : {}) };
  };
  const corrections = count('correction'), inputs = count('input');
  if (corrections.planned) lines.push({ what: 'Corrections received', ...corrections });
  if (inputs.planned) lines.push({ what: 'New inputs received', ...inputs });
  const list = (t?.learners ?? []).flatMap(l => l.events.filter(e => e.kind === 'correction').map(e => {
    const event = plan.events.find((x: any) => x.index === e.index);
    return { index: e.index, input: e.input, text: short(e.text ?? event?.text ?? '', 2000), outcome: e.outcome, received: e.received, changed: e.received && changedAgent(e.outcome), learner: l.learner + 1, ...(e.reason ? { reason: short(e.reason, 500) } : {}),
      ...(e.change ? { change: { ...(e.change.summary ? { summary: short(e.change.summary, 500) } : {}), diff: short(e.change.diff, CHANGE_DIFF_CHARS) } } : {}) };
  }));
  return { models: [...new Set(own.flatMap(r => r.models ?? []))].map(modelName).slice(0, 10), lines, corrections: list, details };
}
/** The outcomes that the account shows; a correction that ended otherwise is named in its line's missing. */
const accountOutcomes = new Set<CorrectionOutcome>(['fixed', 'no_change_needed', 'no_fix_found', 'could_not_test', 'edited', 'not_edited', 'was_right', 'no_feedback']);
/** The most of one change's diff that the page shows. */
const CHANGE_DIFF_CHARS = 20_000;
/** What each arm received, as the account takes it: each correction with {index, input, text, outcome, learner, change?}. */
function accountReceived(received: Record<string, ReturnType<typeof receivedOf>>) {
  return Object.fromEntries(Object.entries(received).map(([arm, r]) => [arm, { models: r.models, lines: r.lines.map(l => ({ ...l, missing: l.missing.map(m => m.slice(0, 500)) })),
    corrections: r.corrections.filter(c => accountOutcomes.has(c.outcome) && c.text).map(c => ({ index: c.index, input: c.input, text: c.text, outcome: c.outcome, learner: c.learner, ...(c.change ? { change: c.change } : {}) })) }]));
}
/** The received record as lines of text: "Model: … · Inputs run: 2 of 2 · Corrections received: 5 of 5 (3 fixed, …)", then what is missing. */
function receivedText(received: ReturnType<typeof receivedOf>) {
  const tally = (list: typeof received.corrections) => {
    const counts = new Map<string, number>();
    for (const c of list) counts.set(c.outcome, (counts.get(c.outcome) ?? 0) + 1);
    return [...counts].map(([outcome, n]) => `${n} ${outcomeWords[outcome as CorrectionOutcome]}`).join(', ');
  };
  return [...(received.models.length ? [`Model: ${received.models.join(', ')}.`] : []),
    ...received.lines.map(l => `${l.what}: ${l.received} of ${l.planned}${l.what === 'Corrections received' && received.corrections.length ? ` (${tally(received.corrections)})` : ''}.${l.changed !== undefined ? ` Changed the agent: ${l.changed}.` : ''}`),
    ...received.details.map(m => `Missing: ${m.charAt(0).toLowerCase()}${m.slice(1)}`)].join(' ');
}

/**
 * Usage per correction for each arm: each learner's usage for its received corrections (its training runs and its
 * fixes or edits), divided by their number, then the mean over the learners. Tokens when every correction of every
 * arm reports them, else minutes.
 */
export function usagePerCorrection(plan: Plan, treated: ArmTreatment[] | null) {
  const all = (treated ?? []).flatMap(t => t.learners.flatMap(l => l.events.filter(e => e.kind === 'correction' && e.received)));
  if (!all.length) return null;
  const unit: 'tokens' | 'minutes' = all.every(e => typeof e.tokens === 'number') ? 'tokens' : 'minutes';
  const values: Record<string, { value: number | null; n: number; per_learner: Array<number | null> }> = {};
  for (const t of treated ?? []) {
    const per = t.learners.map(l => {
      const own = l.events.filter(e => e.kind === 'correction' && e.received);
      if (!own.length) return null;
      const sum = own.reduce((s, e) => s + (unit === 'tokens' ? e.tokens! : e.duration_ms / 60_000), 0);
      return Number((sum / own.length).toFixed(unit === 'tokens' ? 0 : 2));
    });
    const known = per.filter((v): v is number => v !== null);
    values[t.arm] = { value: known.length ? Number((known.reduce((a, b) => a + b, 0) / known.length).toFixed(unit === 'tokens' ? 0 : 2)) : null, n: known.length, per_learner: per };
  }
  return { measure: 'Usage per correction', unit, higher_is_better: false, by: 'method' as const, values };
}

// ---------------------------------------------------------------------------------------------------------------
// The cells

/** The key of a run cell: its content (the arm as it was at that point, the input, the learner and the checkpoint, and how it runs). */
const runKey = (c: { arm: string; hash: string; input: { hash: string; deliverable?: string | null }; repeat: number; checkpoint: number | null; web: boolean; feedback?: string | null }) =>
  sha({ arm: c.arm, hash: c.hash, input: c.input.hash, repeat: c.repeat, checkpoint: c.checkpoint, ...(c.web ? { web: true } : {}), ...(c.input.deliverable ? { deliverable: c.input.deliverable } : {}), ...(c.feedback ? { feedback: c.feedback } : {}) });
/** The version of the judge: a new judge grades every run again. */
const JUDGE_VERSION = 'session-judge/1';
/** The grader: every measure, as the comparison defines it, and the judge. A changed measure is a new grader, and every run is graded again. */
const graderVersion = (plan: Plan) => sha({ judge: JUDGE_VERSION, model: plan.judge?.model ?? null, measures: plan.measures.map((m: any) => ({ name: m.name, code: m.code?.hash ?? null, rubric: m.rubric ?? null, checklist: m.checklist ?? null, covered: m.covered ?? null, person: m.person ?? null })) }).slice(0, 16);
/**
 * The keys of the grade cells of these runs, by run key. A measure may read other runs of the same arm (a regression
 * measure reads the earlier checkpoints), so a grade key holds the hash of each run of that arm and learner up to and
 * including the run's checkpoint, as it finished. When one of those runs again, every grade that could read it grades again.
 */
function gradeKeys(plan: Plan, list: Array<{ key: string; arm: string; checkpoint: number | null; repeat?: number; input: string | { id: string } }>) {
  const finished = new Map(list.map(c => { try { return [c.key, sha(readFileSync(recordFile(plan.folder, c.key)))]; } catch { return [c.key, null]; } }));
  const grader = graderVersion(plan);
  return new Map(list.map(c => {
    const reads = list.filter(o => o.arm === c.arm && (o.checkpoint ?? 0) <= (c.checkpoint ?? 0)).map(o => [o.key, finished.get(o.key)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const input = typeof c.input === 'string' ? c.input : c.input.id;
    return [c.key, sha({ target: c.key, grader, expected: sha(plan.expected[input] ?? null), reads, ...(plan.feedback_hash ? { feedback: plan.feedback_hash } : {}) })];
  }));
}

/**
 * The folders that an arm works on for an input, by files connection: the arm's own (for a plain arm, those of the
 * Method arms), with each folder of the input's own folder in place of the one of its name. Both kinds of arm get the
 * same folders for an input, and nothing of another input's folder: in a cell and in a training run on a teaching input.
 */
function cellFolders(arm: any, input: { room: string | null }): Record<string, string> {
  const own = input.room ? Object.fromEntries(readdirSync(input.room, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => [e.name, join(input.room!, e.name)])) : {};
  return { ...arm.folders, ...own };
}

/**
 * The cells of a stage. Full: every arm × checkpoint × learner × input. Trial: each arm at the start (checkpoint 0, or
 * the arm itself without a treatment) on every checking input, with NOISE_LEARNERS learners: the start values. The
 * full run reuses them.
 */
function cells(plan: Plan, treated: ArmTreatment[] | null, stage: 'trial' | 'full'): Cell[] {
  const start = plan.checkpoints ? 0 : null;
  const checkpoints: Array<number | null> = stage === 'trial' ? [start] : plan.checkpoints ?? [null];
  const inputs = plan.inputs;
  const learners = stage === 'trial' ? NOISE_LEARNERS : plan.learners;
  const out: Cell[] = [];
  for (const arm of plan.arms) for (const checkpoint of checkpoints) for (let learner = 0; learner < learners; learner++) {
    const own = treated?.find(t => t.arm === arm.name)?.learners[learner];
    const snapshot: Snapshot | undefined = checkpoint === null ? (arm.plain ? { plain: arm.plain, hash: arm.hash } : { dir: arm.dir, file: arm.file, hash: arm.hash }) : own?.snapshots[checkpoint];
    if (!snapshot) continue;
    for (const input of inputs) {
      const cell = { folder: plan.folder, arm: arm.name, ...snapshot, ...(arm.plain ? { method: arm.method } : {}), folders: cellFolders(arm, input), cache_dir: (snapshot as any).cache_dir ?? arm.cache_dir, web: plan.web, ...(plan.feedback_hash ? { feedback: plan.feedback_hash } : {}), input, repeat: learner, checkpoint,
        trial: learner < NOISE_LEARNERS && checkpoint === start, treatment_note: treatmentNote(plan, arm, checkpoint, own) };
      out.push({ key: runKey(cell), ...cell });
    }
  }
  return out;
}

/** A finished cell, kept in the comparison folder by its key, so that a later run or version reuses it. */
const recordFile = (folder: string, key: string) => join(folder, 'cells', `${key}.json`);
const readRecord = (folder: string, key: string) => { try { return JSON.parse(readFileSync(recordFile(folder, key), 'utf8')); } catch { return null; } };
const writeRecord = (folder: string, key: string, value: unknown) => { mkdirSync(join(folder, 'cells'), { recursive: true, mode: 0o700 }); writePrivateJson(recordFile(folder, key), value); };

/** The account's plan of cells: each run cell and the grade cell of each. */
function plannedCells(plan: Plan, list: Cell[]): PlannedCell[] {
  const grader = graderVersion(plan), keys = gradeKeys(plan, list);
  return list.flatMap(c => {
    const run = { key: c.key, kind: 'run' as const, arm: c.arm, input: c.input.id, checkpoint: c.checkpoint, repeat: c.repeat, trial: c.trial };
    return [run, { ...run, key: keys.get(c.key)!, kind: 'grade' as const, target: c.key, grader_version: grader }];
  });
}
/**
 * Send the plan of these cells to the account and split them: the cells to run, and the finished ones that this
 * computer keeps (a cell that an earlier run or version finished runs once). A finished cell that the account lacks is
 * linked again.
 */
async function split(plan: Plan, list: Cell[], all: Cell[]) {
  // A finished run that its cell could not save to the account when it ran is saved now, before the plan goes up: the
  // grade keys read the run records as they are, and the run's grade links only to a saved run.
  if (readAccount(plan.folder)) for (const cell of list) {
    const record = readRecord(plan.folder, cell.key);
    if (record && !record.run_id) await saveFinishedRun(cell, record);
  }
  const missing = await sendPlan(plan.folder, plannedCells(plan, all));
  const run: Cell[] = [], done: any[] = [];
  for (const cell of list) {
    const record = readRecord(plan.folder, cell.key);
    if (!record) { run.push(cell); continue; }
    done.push(record);
    if (missing?.has(cell.key)) await linkRun(plan.folder, record);
  }
  return { run, done };
}

/**
 * The models that a run used, from its record: what Claude Code said it ran on, the model that a Codex or hosted model
 * step named, or Codex's default model when the step named none (Codex does not report its name).
 */
function modelsOfRun(runDir: string) {
  const found = new Set<string>();
  let events: any[] = [];
  try { events = readFileSync(join(runDir, 'events.jsonl'), 'utf8').split('\n').flatMap(line => { try { return line ? [JSON.parse(line)] : []; } catch { return []; } }); } catch { return []; }
  for (const e of events) {
    if (e.event === 'agent.ready' && e.model) found.add(e.model);
    if (e.event === 'model.used' && e.backend !== 'claude') found.add(e.model ?? (e.backend === 'codex' ? 'Codex\'s default model' : e.backend));
  }
  // A Claude Code step that stopped before it started names the model it asked for.
  if (!events.some(e => e.event === 'agent.ready')) for (const e of events) if (e.event === 'model.used' && e.backend === 'claude') found.add(e.model ?? 'Claude Code\'s default model');
  return [...found];
}

/**
 * Save the run of a cell in the account: the version of its Method, and the run's records as it runs. A learner's frozen
 * copy at a checkpoint (frozen) saves a version of the learner's Method without becoming its home, so the learner's own
 * copy, which takes the later corrections, stays the home.
 */
async function cellSync(folder: string, file: string, frozen: boolean) {
  const account = readAccount(folder);
  if (!account) return null;
  try {
    const { clientOf } = await import('./compare-account.js');
    const { Outbox } = await import('./outbox.js');
    const { prepareVersion } = await import('./versions.js');
    const { MethodSync } = await import('./method-sync.js');
    const client = clientOf(account), outbox = new Outbox(client);
    const version = await prepareVersion(client, outbox, file, 'Saved by a comparison.', { home: !frozen });
    return (runDir: string) => new MethodSync(client, runDir, version.method_id, version.version_id, undefined, readDocument(file).run_data === 'device', outbox);
  } catch (error) {
    process.stderr.write(`This run is not saved to your Method account: ${(error as Error).message}\n`);
    return null;
  }
}

/** Save a finished run of a cell to the account from its run folder, as its cell would have when it ran, and keep its run ID in the cell's record. */
async function saveFinishedRun(cell: Cell, record: any) {
  const file = cell.plain ? cell.method! : join(cell.dir!, cell.file!);
  try {
    const sync = (await cellSync(cell.folder, file, !cell.plain && cell.checkpoint !== null))?.(record.run_dir);
    if (!sync) return;
    await sync.start(readDocument(file), (cell.plain ? { instructions: cell.plain.instructions, task: taskPrompt(cell.input.value, cell.input.deliverable) } : cell.input.value) as any, {}, false);
    await sync.finish();
    await sync.outbox.drain();
    const runId = JSON.parse(readFileSync(join(record.run_dir, 'method-sync.json'), 'utf8')).id;
    if (!runId) return;
    Object.assign(record, { run_id: runId, device: sync.device });
    writeRecord(cell.folder, cell.key, record);
  } catch (error) {
    process.stderr.write(`This run is not saved to your Method account: ${(error as Error).message}\n`);
  }
}

/**
 * Run one cell: one learner of the arm on one input, with nothing reused, in its own folder. A Method arm runs with its
 * learner's cache in a clean room (armRoom) on its own copy of its bound folders, which the cell keeps in its folder. A
 * plain arm runs as one session, which makes its own clean room, in a copy of its room. Both hand in the deliverable
 * file, which the cell reads; without a deliverable a Method arm's output is its result. Both write the same run
 * records, with a transcript of each agent attempt; the run is saved in the account and linked to its cell.
 */
async function runCell(cell: Cell) {
  process.env.METHOD_CACHE_DIR = cell.cache_dir;
  const runDir = join(cell.folder, 'runs', cell.arm, cell.key.slice(0, 16));
  removeFolder(runDir);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const { runMethod } = await import('@withmethod/runtime/runner.js');
  const started = Date.now();
  const file = cell.plain ? cell.method! : join(cell.dir!, cell.file!);
  // A Method cell at a checkpoint runs the learner's frozen copy (after-N); without a treatment it runs the arm's own copy.
  const syncFor = await cellSync(cell.folder, file, !cell.plain && cell.checkpoint !== null);
  const sync = syncFor?.(join(runDir, 'run'));
  const hooks = {
    onStart: async ({ method, inputs }: any) => { await sync?.start(method, inputs, {}); },
    onEvent: async () => { sync?.snapshot(); },
  };
  let result: any, output: unknown = null, handedIn = true;
  try {
    if (cell.plain) {
      // The session's room: a copy of each of the cell's folders, by its name. The session works on its own copy of it.
      result = await runSession(file, join(runDir, 'run'), cell.folders, { instructions: cell.plain.instructions, task: taskPrompt(cell.input.value, cell.input.deliverable) },
        { before: async (inputs: any) => { await sync?.start(readDocument(file), inputs, {}, false); }, ...hooks });
      output = cell.input.deliverable ? sessionFile(join(runDir, 'run'), result.result, cell.input.deliverable) : null;
      handedIn = output !== null;
    } else {
      const { preparedConfig } = await import('./quality.js');
      const { resolveSecrets } = await import('./secrets.js');
      const prepared = await preparedConfig(file, {});
      const secrets = resolveSecrets(Object.keys(readDocument(file).secrets ?? {}));
      await sync?.start(readDocument(file), cell.input.value as any, {}, false);
      const room = await armRoom(file, cell.cache_dir, false, cell.folders, cell.web);
      // The cell's process runs the arm in the room: its agent steps and scripts get the room's environment.
      const outside = { ...process.env };
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, room.env);
      try {
        result = await runMethod(file, { ...prepared.config, web: cell.web, environment: { ...prepared.config.environment, ...room.folders } }, {
          runDir: join(runDir, 'run'), inputs: cell.input.value as any, fresh: true, processPath: prepared.processPath, prepareBundle: prepared.prepareBundle,
          secrets, ...(prepared.hostedModels ? { hostedModels: prepared.hostedModels } : {}), ...(prepared.classification ? { classification: prepared.classification } : {}), ...hooks });
      } finally {
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, outside);
        // The cell keeps what the arm left in its folders, for the measures.
        for (const [envName, copy] of Object.entries(room.folders as Record<string, string>)) cpSync(copy, join(runDir, 'environment', envName), { recursive: true, verbatimSymlinks: true });
        await room.remove();
      }
      if (cell.input.deliverable) {
        try { output = readFileSync(join(runDir, 'environment', cell.input.deliverable), 'utf8'); } catch { output = null; handedIn = false; }
      } else output = result.result ?? null;
    }
  } finally {
    await sync?.finish();
    await sync?.outbox.drain();
  }
  if (!['completed', 'unconfirmed'].includes(result.status))
    throw Error(`The arm ${cell.arm} ${result.status === 'needs_input' ? 'asked a question' : 'failed'} on the input ${cell.input.id} (learner ${cell.repeat + 1}${pointLabel(cell.checkpoint)}): ${result.failure?.headline ?? result.status}. Its run folder: ${join(runDir, 'run')}. Fix the cause and run the comparison again; finished runs are reused.`);
  const transcript = writeTranscripts(join(runDir, 'run', 'artifacts'), runDir);
  let runId: string | null = null;
  try { runId = JSON.parse(readFileSync(join(runDir, 'run', 'method-sync.json'), 'utf8')).id; } catch { /* not saved in the account */ }
  const record = { key: cell.key, arm: cell.arm, input: cell.input.id, repeat: cell.repeat, checkpoint: cell.checkpoint, trial: cell.trial, result: output, deliverable: cell.input.deliverable, handed_in: handedIn,
    folders: cell.folders, run_dir: join(runDir, 'run'), artifacts: join(runDir, 'run', 'artifacts'), transcript: transcript?.markdown ?? null, transcript_jsonl: transcript?.jsonl ?? null,
    treatment_note: cell.treatment_note, models: modelsOfRun(join(runDir, 'run')), run_id: runId, device: sync?.device ?? false,
    duration_ms: Date.now() - started, cost_usd: typeof result.usage?.cost_usd === 'number' ? result.usage.cost_usd : null };
  writeRecord(cell.folder, cell.key, record);
  await linkRun(cell.folder, record);
  return record;
}

/**
 * Link a run cell to its saved run. Its transcript and treatment go to the account only when the run's content is kept
 * there; otherwise the local Method server shows them to the dashboard, from this computer.
 */
async function linkRun(folder: string, record: any) {
  const account = readAccount(folder);
  if (!account || !record.run_id) return;
  if (record.device) {
    registerLocalRun(account.cache_dir, record.run_id, account.server, entry => ({ ...entry, treatment_note: record.treatment_note, transcript: record.transcript_jsonl }));
    await ensureLocalServer(account.cache_dir);
    await linkCells(folder, [{ key: record.key, run_id: record.run_id }]);
    return;
  }
  const transcript = record.transcript_jsonl ? await uploadText(folder, readFileSync(record.transcript_jsonl, 'utf8')) : null;
  await linkCells(folder, [{ key: record.key, run_id: record.run_id, ...(transcript ? { transcript } : {}), ...(record.treatment_note ? { treatment_note: record.treatment_note } : {}) }]);
}

/** Every agent attempt of a run, oldest first, as one transcript: entries numbered again from 0 across the attempts. */
function runTranscript(artifacts: string) {
  const attempts = ['claude', 'codex', 'session', 'model'].flatMap(kind => {
    try { return readdirSync(join(artifacts, kind)).filter(name => name.startsWith('attempt-')).map(name => join(artifacts, kind, name)); } catch { return []; }
  }).filter(dir => existsSync(join(dir, 'transcript.jsonl'))).sort((a, b) => statSync(join(a, 'transcript.jsonl')).mtimeMs - statSync(join(b, 'transcript.jsonl')).mtimeMs);
  const entries: any[] = [], parts: Array<{ dir: string; from: number }> = [];
  for (const dir of attempts) {
    const offset = entries.length;
    parts.push({ dir, from: offset });
    for (const line of readFileSync(join(dir, 'transcript.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      const e = JSON.parse(line);
      entries.push({ ...e, i: e.i + offset, ...(e.parent !== undefined ? { parent: e.parent + offset } : {}) });
    }
  }
  return { entries, parts };
}

/**
 * The run's transcript: transcript.jsonl (every attempt, numbered from 0; the dashboard shows it and a verdict names its
 * line) and transcript.md, a readable copy in which a long tool result is cut at 2,000 characters. Null when the run had
 * no agent attempt.
 */
function writeTranscripts(artifacts: string, target: string) {
  const { entries, parts } = runTranscript(artifacts);
  if (!entries.length) return null;
  const jsonl = join(target, 'transcript.jsonl'), markdown = join(target, 'transcript.md');
  writeFileSync(jsonl, entries.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
  const who: Record<string, string> = { user: 'You', assistant: 'Agent', tool: 'Tool', system: 'Method' };
  const cut = (text: string) => text.length > 2000 ? `${text.slice(0, 2000)}\n[... ${text.length - 2000} more characters in transcript.jsonl]` : text;
  const lines: string[] = [];
  for (const [n, part] of parts.entries()) {
    lines.push(`## ${part.dir.slice(artifacts.length + 1)}`, `Full record: ${join(part.dir, 'transcript.jsonl')}`, '');
    for (const e of entries.slice(part.from, parts[n + 1]?.from ?? entries.length)) {
      const label = [e.kind, e.tool, e.path].filter(Boolean).join(' · ');
      lines.push(`**${who[e.role] ?? e.role}** (${label}${e.inferred ? ', inferred' : ''})`, '', e.role === 'tool' ? cut(e.text) : e.text, '');
    }
  }
  writeFileSync(markdown, lines.join('\n'), { mode: 0o600 });
  return { jsonl, markdown };
}

// ---------------------------------------------------------------------------------------------------------------
// The trial: what each arm received, and the noise at the start

/**
 * The noise at the start (checkpoint 0, or the arms themselves without a treatment): the difference between the mean
 * main measure of two learners of the same arm on every checking input. It is shown and does not stop anything: the
 * noise that decides is the spread between learners at the point that decides (learnerSpread). With a main measure
 * that scores only the items that corrections cover, no item is covered at the start, so the start is measured on all
 * items of the same checklist. A main measure that a person marks has no start value (spread null).
 */
export function noiseCheck(plan: Plan, grades: any[]) {
  const main = plan.measures.find((m: any) => m.main);
  const margin = plan.rule.margin;
  if (main.person !== undefined) return { spread: null, margin, measure: main.name, by_arm: {} as Record<string, number | null>, start: {} as Record<string, Array<number | null>> };
  const start = plan.checkpoints ? 0 : null;
  const inputs: string[] = plan.inputs.map((i: any) => i.id);
  const scoreOf = (g: any) => { const v = g.scores?.[main.name]; return typeof v === 'number' ? v : typeof g.noise_scores?.[main.name] === 'number' ? g.noise_scores[main.name] : null; };
  const by_arm: Record<string, number | null> = {}, starts: Record<string, Array<number | null>> = {};
  for (const arm of plan.arms) {
    const means = Array.from({ length: NOISE_LEARNERS }, (_, learner) =>
      inputs.map(input => grades.find(g => g.arm === arm.name && g.checkpoint === start && g.repeat === learner && g.input === input)).map(g => g ? scoreOf(g) : null));
    // Only the inputs that every learner has a number for.
    const both = inputs.map((_, i) => means.every(list => list[i] !== null && list[i] !== undefined));
    const meanOf = (list: Array<number | null>) => { const values = list.filter((_, i) => both[i]) as number[]; return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; };
    const learnerMeans = means.map(meanOf);
    starts[arm.name] = learnerMeans.map(m => m === null ? null : Number(m.toFixed(4)));
    by_arm[arm.name] = learnerMeans.some(m => m === null) ? null : Number((Math.max(...learnerMeans as number[]) - Math.min(...learnerMeans as number[])).toFixed(4));
  }
  const known = Object.values(by_arm).filter((v): v is number => v !== null);
  return { spread: known.length ? Math.max(...known) : null, margin, measure: main.name, by_arm, start: starts };
}

/**
 * The spread between the learners of each arm at a point: each learner's mean main measure over the inputs, and the
 * largest difference between two learners of the same arm. A lead that is not larger than this spread could come from
 * which copies happened to learn what, so the decision says "can't tell yet". Null for an arm with fewer than 2
 * learners with a number; spread is null unless every arm has one.
 */
export function learnerSpread(plan: Plan, grades: any[], at: number | null, measure: string) {
  const by_arm: Record<string, number | null> = {};
  for (const arm of plan.arms) {
    const means: number[] = [];
    for (let learner = 0; learner < plan.learners; learner++) {
      const values = grades.filter(g => g.arm === arm.name && g.checkpoint === at && g.repeat === learner).map(g => g.scores?.[measure]).filter((v): v is number => typeof v === 'number');
      if (values.length) means.push(values.reduce((a, b) => a + b, 0) / values.length);
    }
    by_arm[arm.name] = means.length >= 2 ? Number((Math.max(...means) - Math.min(...means)).toFixed(4)) : null;
  }
  // Every arm needs two copies with a number: a lead over an arm whose copies cannot be compared says nothing.
  const values = Object.values(by_arm);
  return { spread: values.length && values.every(v => v !== null) ? Math.max(...values as number[]) : null, by_arm };
}

/**
 * The too easy check: when every arm's start value on the main measure (the mean of its learners' values at the start)
 * is above 1 − margin, no arm can lead by the margin, and the trial stops before approval. For a main measure whose
 * values are shares from 0 to 1: a rubric or a checklist, or a code measure whose start values all lie from 0 to 1.
 * Null when an arm has no start value, or a value is outside 0 to 1. sentence: what the page and the error say.
 */
export function tooEasyCheck(plan: Plan, noise: ReturnType<typeof noiseCheck>) {
  const main = plan.measures.find((m: any) => m.main);
  if (main.person !== undefined) return null;
  const start: Record<string, number> = {};
  for (const arm of plan.arms) {
    const values = (noise.start[arm.name] ?? []).filter((v): v is number => typeof v === 'number');
    if (!values.length || values.some(v => v < 0 || v > 1)) return null;
    start[arm.name] = Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(4));
  }
  const margin = plan.rule.margin, passes = !Object.values(start).every(v => v > 1 - margin + 1e-9);
  const values = plan.arms.map((arm: any) => `${fixed(start[arm.name]!)} (${labelOf(plan, arm.name)})`);
  const when = plan.events.some((e: any) => e.kind === 'correction') ? ' before any correction' : plan.checkpoints ? ' at the start' : '';
  const sentence = `This test is too easy to show a difference: ${plan.arms.length === 2 ? 'both agents' : `all ${plan.arms.length} agents`} already score ${values.slice(0, -1).join(', ')} and ${values.at(-1)}${when}, and the rule needs a lead of ${margin}.`;
  return { start, margin, passes, sentence };
}

/** The summary of the trial for the approval question, or an error that names what an arm did not receive, the noise, or a test that is too easy. */
async function trialCheck(plan: Plan, runs: any[], grades: any[], treated: ArmTreatment[] | null) {
  const lines: string[] = [], short: string[] = [];
  const trialInputs = plan.inputs.length;
  const received: Record<string, ReturnType<typeof receivedOf>> = {};
  for (const arm of plan.arms) {
    const t = treated?.find(x => x.arm === arm.name);
    received[arm.name] = receivedOf(arm.name, runs, trialInputs * NOISE_LEARNERS, t, plan);
    const line = `${labelOf(plan, arm.name)}: ${receivedText(received[arm.name]!)}`;
    lines.push(line);
    if (runs.filter(r => r.arm === arm.name).length < trialInputs * NOISE_LEARNERS || (t && t.learners.some(l => l.missing.length))) short.push(line);
  }
  const noise = noiseCheck(plan, grades), easy = tooEasyCheck(plan, noise);
  const usage = usagePerCorrection(plan, treated);
  const estimate = fullRunEstimate(plan, runs, treated);
  await sendStage(plan.folder, { stage: 'trial', trial: { inputs: trialInputs, received: accountReceived(received),
    ...(noise.spread !== null ? { noise: { spread: noise.spread, margin: noise.margin, start: noise.start } } : {}),
    ...(easy ? { too_easy: { start: easy.start, margin: easy.margin, passes: easy.passes } } : {}) },
    cost_estimate: { ...estimate.account, ...(usage ? { usage: { unit: usage.unit, values: Object.fromEntries(Object.entries(usage.values).map(([arm, v]) => [arm, v.value])) } } : {}) } });
  if (short.length) throw Error(`The trial stopped: an arm did not receive everything.\n${short.join('\n')}\nFix the cause and run the comparison again; everything that was received is kept.`);
  const noiseText = noise.spread === null ? `Noise at the start: not measured (${plan.measures.find((m: any) => m.main).person !== undefined ? 'a person marks the main measure after the full run' : 'the trial runs have no number on the main measure'}).`
    : `Noise at the start: two learners of the same arm differ by up to ${fixed(noise.spread)} on ${noise.measure} (${Object.entries(noise.by_arm).map(([arm, v]) => `${labelOf(plan, arm)} ${v === null ? 'not measured' : fixed(v)}`).join(', ')}). The decision checks the spread between learners at the point that decides.`;
  if (easy && !easy.passes) throw Error(`The trial stopped. ${easy.sentence} Use harder inputs or a stricter measure, then run the comparison again.`);
  const usageText = usage ? [`Usage per correction (${usage.unit}): ${Object.entries(usage.values).map(([arm, v]) => `${labelOf(plan, arm)} ${v.value ?? 'not known'}`).join(', ')}.`] : [];
  return [`Trial of "${plan.question}"`, '', 'What each arm received:', ...lines.map(l => `  ${l}`), '', noiseText, ...usageText, '',
    'The trial runs (each folder holds the run\'s records; each transcript reads as a conversation):',
    ...runs.flatMap(r => [`  ${labelOf(plan, r.arm)}, learner ${r.repeat + 1}, input ${r.input}: ${r.run_dir}${r.handed_in === false ? ` (did not hand in ${r.deliverable})` : ''}`, ...(r.transcript ? [`    transcript: ${r.transcript}`] : [])]), '',
    estimate.text].join('\n');
}

/**
 * The full run, estimated from the trial and counted as the page counts it. runs: every graded run of the full run (each
 * arm, input, learner and checkpoint), of which reused are the trial's runs that count again. events: the treatment
 * events still to give over every arm and learner, each a training run and a fix or edit. The time: the treatment first,
 * every learner of every arm at the same time, one event at a time at its arm's mean time per event in the trial (its
 * training run and its fix or edit); then the runs still to run, 4 at a time, at the trial's mean time per run. An arm
 * whose events all ended without being received has no time per event (null): a stopped fix says nothing about how
 * long a fix takes. Then the total time is not known: the text and the page give none (minutes leaves that arm out). The price is
 * known only when every trial run reported one and there are no events (a fix or an edit reports no price).
 */
export function fullRunEstimate(plan: Plan, runs: any[], treated: ArmTreatment[] | null) {
  const total = plan.arms.length * plan.inputs.length * plan.learners * (plan.checkpoints?.length ?? 1);
  // The trial's runs at the start count for the full run when the start is one of its points and the learner is one of its learners.
  const reused = Math.min(total, runs.filter(r => r.repeat < plan.learners && (!plan.checkpoints || plan.checkpoints.includes(0))).length);
  const left = total - reused;
  const perRun = runs.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0) / Math.max(runs.length, 1);
  const arms = plan.arms.map((arm: any) => {
    const learners = treated?.find(t => t.arm === arm.name)?.learners ?? [];
    const finished = learners.flatMap(l => l.events.filter(e => e.received));
    const perEvent = finished.length ? finished.reduce((sum, e) => sum + e.duration_ms, 0) / finished.length : null;
    // Each learner of the full run gets every event that it has not received yet.
    const due = Array.from({ length: plan.learners }, (_, l) => plan.events.length - (learners[l]?.events.filter(e => e.received).length ?? 0));
    return { arm: arm.name, label: labelOf(plan, arm.name), events: due.reduce((a, b) => a + b, 0), perEvent, longest: perEvent === null ? 0 : Math.max(0, ...due) * perEvent };
  });
  const events = arms.reduce((n: number, a: any) => n + a.events, 0);
  const minutes = Math.round((Math.max(0, ...arms.map((a: any) => a.longest)) + left * perRun / 4) / 60_000);
  const costs = runs.map(r => r.cost_usd);
  const usd = !events && runs.length && costs.every(c => typeof c === 'number') ? Number(((costs.reduce((a, b) => a + b, 0) / runs.length) * left).toFixed(2)) : null;
  const eventMinutes = Object.fromEntries(arms.map((a: any) => [a.arm, a.perEvent === null ? null : Number((a.perEvent / 60_000).toFixed(1))]));
  const unknown = events ? arms.filter((a: any) => a.events && a.perEvent === null).map((a: any) => a.label) : [];
  const perEventText = events ? `; per event ${arms.filter((a: any) => a.events).map((a: any) => `${a.label} ${a.perEvent === null ? 'not known yet, because none was received in the trial' : `about ${Math.round(a.perEvent / 1000)} s`}`).join(', ')}, the learners at the same time` : '';
  const text = !left && !events ? 'The full run: nothing more to run; the trial ran every cell.'
    : [`The full run: ${plural(total, 'graded run')} in all${reused ? ` (${reused} done in the trial)` : ''}${events ? `, and ${plural(events, 'treatment event')} to give over all learners, each a training run and a fix or edit` : ''}.`,
      unknown.length ? `Time: not known yet: about ${Math.round(perRun / 1000)} s per run, 4 at a time${perEventText}.`
        : `Time: ${minutes ? `about ${plural(minutes, 'minute')}` : 'under a minute'}: about ${Math.round(perRun / 1000)} s per run, 4 at a time${perEventText}.`,
      `Cost: ${usd !== null ? `about $${usd.toFixed(2)} at API prices` : events ? 'not known: a fix or an edit reports no price' : 'not known: the trial runs reported no price (a run on your own Claude Code or Codex subscription reports none)'}.`].join(' ');
  return { text, account: { minutes, runs: total, reused, events, ...(events ? { event_minutes: eventMinutes } : {}), usd } };
}
/**
 * The trial gives the first learner of each arm the first 2 events: enough to see what each arm received and what
 * changed it, and to time one, before the person approves. The full run gives the rest.
 */
export const TRIAL_EVENTS = 2;
const trialEvents = (plan: Plan) => Math.min(TRIAL_EVENTS, plan.events.length);
/** The person said go: keep it for this version of the file, and tell the account (this locks the file there). */
async function recordApproval(plan: Plan) {
  const digest = JSON.parse(readFileSync(join(plan.folder, 'spec.json'), 'utf8')).spec_digest;
  writePrivateJson(approvalFile(plan.folder), { spec_digest: digest, at: new Date().toISOString() });
  await sendStage(plan.folder, { stage: 'running' });
}

// ---------------------------------------------------------------------------------------------------------------
// Grades

/** The key of a person's mark: the measure's question and the output it marks. */
const markKey = (measure: any, run: any) => sha({ question: measure.person, output: run.result });
const outputText = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const words = (text: string) => text.replace(/^\s*\d+[.)]\s+/gm, ' ').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Whether a quote is in a text: each passage of the quote, in order. A quote may join passages with an ellipsis. */
const quotedIn = (quote: string, text: string) => {
  const textWords = ` ${words(text)} `;
  let from = 0;
  for (const part of quote.split(/\.{3}|…/).map(words).filter(Boolean)) {
    const at = textWords.indexOf(` ${part} `, from);
    if (at < 0) return false;
    from = at + part.length + 1;
  }
  return true;
};
/**
 * The transcript line that a quote comes from: the last reply that holds its words, else the result, else any line.
 * Null for an empty quote, or one that no line holds.
 */
export function quoteLine(entries: any[], quote: string | null) {
  const wanted = quote ? quote.split(/\.{3}|…/).map(words).filter(Boolean) : [];
  if (!wanted.length) return null;
  const holds = (e: any) => { const text = ` ${words(e.text ?? '')} `; return wanted.every(part => text.includes(` ${part} `)); };
  const last = (test: (e: any) => boolean) => [...entries].reverse().find(e => test(e) && holds(e))?.i;
  return last(e => e.role === 'assistant' && e.kind === 'message') ?? last(e => e.kind === 'result') ?? last(() => true) ?? null;
}

/**
 * The sources that a run's agent read, as paths in its folders (CONNECTION/PATH): each file that the transcript shows it
 * read, found in the run's folders. Files that the agent wrote itself are left out.
 */
export function sourcesRead(entries: any[], folders: Record<string, string>) {
  const found = new Set<string>();
  for (const e of entries) {
    // A file read: Claude Code's Read (its call and its result), or a file that a Codex command read.
    if (typeof e.path !== 'string' || !(e.kind === 'file_read' || e.role === 'tool' && e.tool === 'Read')) continue;
    // In a room the path is ROOM/folders/CONNECTION/PATH (a Method arm) or ROOM/folders/room/CONNECTION/PATH (a plain
    // arm); a relative path is in the room itself.
    const at = e.path.lastIndexOf('/folders/');
    const rest = e.path.startsWith('/') ? (at < 0 ? null : e.path.slice(at + '/folders/'.length)) : e.path.replace(/^\.\//, '');
    if (rest === null) continue;
    for (const candidate of [rest, rest.replace(/^room\//, '')]) {
      const [envName, ...parts] = candidate.split('/');
      const dir = folders[envName!], rel = parts.join('/');
      if (dir && rel && existsSync(join(dir, rel)) && statSync(join(dir, rel)).isFile()) { found.add(`${envName}/${rel}`); break; }
    }
  }
  return [...found].sort();
}

/** What grading a run needs of the comparison: its folder, its judge, and the checklist of the run's input. */
type GradeContext = { folder: string; judge: { agent: string; model: string | null }; judge_method: string; checklist: ChecklistItem[] };
/** One judgment of one document: a verdict for each item. Tests replace judge. */
type Verdict = { id: string; verdict: 'met' | 'partly' | 'not_met'; quote: string; reason: string };
export const judging = {
  /**
   * The judge: one Claude Code session in a read-only room that holds the document, every folder the agent worked on
   * (sources/), the list of files the agent read (read-files.txt), the checklist and the expected answer. It reads every
   * source the agent read in full, with its own file tools, so no source is cut. One retry when its answer is not JSON.
   */
  async judge(request: { method: string; document: string; documentName: string; items: Array<{ id: string; text: string }>; expected: string | null; folders: Record<string, string>; read: string[]; work: string }): Promise<Verdict[]> {
    const room = join(request.work, 'room');
    removeFolder(request.work);
    mkdirSync(join(room, 'document'), { recursive: true, mode: 0o700 });
    writeFileSync(join(room, 'document', request.documentName), request.document);
    writeFileSync(join(room, 'checklist.json'), JSON.stringify(request.items, null, 2));
    writeFileSync(join(room, 'read-files.txt'), request.read.length ? request.read.map(p => `sources/${p}`).join('\n') + '\n' : '(The agent read no source files.)\n');
    if (request.expected !== null) writeFileSync(join(room, 'expected-answer.md'), request.expected);
    for (const [envName, dir] of Object.entries(request.folders)) cpSync(dir, join(room, 'sources', envName), { recursive: true });
    const { runMethod } = await import('@withmethod/runtime/runner.js');
    let last = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const result: any = await runMethod(request.method, { allow_local_processes: true }, { runDir: join(request.work, `run-${attempt + 1}`), inputs: { room }, fresh: true });
      if (result.status !== 'completed') throw Error(`The judge did not finish: ${result.failure?.headline ?? result.status}.`);
      last = String(result.result?.final_text ?? '');
      const parsed = parseVerdicts(last, request.items);
      if (parsed) return parsed;
    }
    throw Error(`The judge did not answer with a verdict for each item: ${last.slice(0, 300)}`);
  },
};
/** The judge's verdicts from its answer, one per item, or null when the answer is not that. */
export function parseVerdicts(answer: string, items: Array<{ id: string }>): Verdict[] | null {
  const from = answer.indexOf('{'), to = answer.lastIndexOf('}');
  if (from < 0 || to < from) return null;
  let value: any;
  try { value = JSON.parse(answer.slice(from, to + 1)); } catch { return null; }
  const list: any[] = Array.isArray(value?.verdicts) ? value.verdicts : [];
  const out: Verdict[] = [];
  for (const item of items) {
    const v = list.find(x => x?.id === item.id);
    if (!v || !['met', 'partly', 'not_met'].includes(v.verdict)) return null;
    out.push({ id: item.id, verdict: v.verdict, quote: typeof v.quote === 'string' ? v.quote : '', reason: typeof v.reason === 'string' ? v.reason : '' });
  }
  return out;
}
const verdictScore = { met: 1, partly: 0.5, not_met: 0 } as const;

/**
 * Judge a run's document on a list of items, once per document, sources and items: the judgments are kept in the
 * comparison folder, so a measure that scores a part of the same checklist reads the same verdicts. A run that handed
 * in nothing meets no item. A quote that is not in the document makes its verdict not met.
 */
async function judged(run: any, context: GradeContext, items: Array<{ id: string; text: string }>, expected: unknown, entries: any[]) {
  if (run.result === null || run.result === undefined) return { verdicts: items.map(i => ({ id: i.id, verdict: 'not_met' as const, quote: '', reason: `The arm did not hand in ${run.deliverable ?? 'its output'}.` })), read: [] as string[] };
  const document = outputText(run.result);
  const folders: Record<string, string> = run.folders ?? {};
  const read = sourcesRead(entries, folders);
  const expectedText = expected === undefined || expected === null ? null : outputText(expected);
  const key = sha({ judge: JUDGE_VERSION, model: context.judge?.model ?? null, document, items: items.map(i => i.text), expected: expectedText, read: read.map(p => { const [envName, ...rest] = p.split('/'); return [p, sha(readFileSync(join(folders[envName!]!, rest.join('/'))))]; }) });
  const cache = join(context.folder, 'judgments', `${key}.json`);
  if (existsSync(cache)) return { verdicts: JSON.parse(readFileSync(cache, 'utf8')) as Verdict[], read };
  // Each grade judges in its own work folder: two runs that hand in the same document have the same key, and may be
  // graded at the same time. The key names only the cached verdicts.
  mkdirSync(join(context.folder, 'judge-work'), { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(context.folder, 'judge-work', `${key.slice(0, 16)}-`));
  const verdicts = (await judging.judge({ method: context.judge_method, document, documentName: run.deliverable ? basename(run.deliverable) : 'output.md', items: items.map(i => ({ id: i.id, text: i.text })), expected: expectedText,
    folders, read, work }).finally(() => rmSync(work, { recursive: true, force: true }))).map(v => v.verdict !== 'not_met' && words(v.quote) && !quotedIn(v.quote, document) ? { ...v, verdict: 'not_met' as const, reason: `The quote is not in the document: "${v.quote.slice(0, 120)}"` } : v);
  mkdirSync(dirname(cache), { recursive: true, mode: 0o700 });
  writeFileSync(cache, JSON.stringify(verdicts), { mode: 0o600 });
  return { verdicts, read };
}

/**
 * Grade one run on every measure. A rubric or checklist measure gives the judge's verdicts, each at the transcript line
 * it judged; met scores 1, partly 0.5, not met 0, and the score is their mean. A covered checklist scores only the items
 * that the corrections given so far cover (null when none is covered), and keeps the score on all items for the noise
 * check. A grade with the same key that a trial already gave is reused.
 */
async function grade(item: any) {
  const { run, measures, expected, marks } = item;
  const kept = readRecord(item.folder, item.key);
  if (kept && measures.every((m: any) => Object.prototype.hasOwnProperty.call(kept.scores ?? {}, m.name))) {
    // A kept grade takes its run as it is now (a run saved to the account later has its run ID now), and links again
    // when it changed or the account lacks it.
    const record = { ...kept, usage: item.usage ?? null, run_id: run.run_id ?? null, device: run.device ?? false };
    const changed = JSON.stringify(record) !== JSON.stringify({ ...kept, usage: kept.usage ?? null, run_id: kept.run_id ?? null, device: kept.device ?? false });
    if (changed) writeRecord(item.folder, item.key, record);
    if (changed || item.unlinked) await linkGrade(item.folder, record);
    return record;
  }
  const context: GradeContext = item.context;
  const scores: Record<string, number | null> = {}, noise: Record<string, number> = {}, verdicts: any[] = [];
  const entries = run.transcript_jsonl && existsSync(run.transcript_jsonl)
    ? readFileSync(run.transcript_jsonl, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  let read: string[] | null = null;
  const mean = (list: number[]) => list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
  for (const m of measures) {
    if (m.person !== undefined) { scores[m.name] = marks[m.name]; continue; }
    if (m.code) { scores[m.name] = await codeScore(m, run, expected); continue; }
    const checklist: ChecklistItem[] = m.checklist ? context.checklist : m.rubric.map((text: string, i: number) => ({ id: `c${i + 1}`, text, covered_by: [] }));
    // A checklist is the expected answer itself; a rubric's judge also reads the expected answer.
    const result = await judged(run, context, checklist, m.checklist ? undefined : expected, entries);
    read = result.read;
    const byId = new Map(result.verdicts.map(v => [v.id, v]));
    const covered = m.covered ? checklist.filter(i => i.covered_by.some(n => run.checkpoint !== null && n <= run.checkpoint)) : checklist;
    scores[m.name] = mean(covered.map(i => verdictScore[byId.get(i.id)?.verdict ?? 'not_met']));
    if (m.covered) noise[m.name] = mean(checklist.map(i => verdictScore[byId.get(i.id)?.verdict ?? 'not_met']))!;
    for (const i of checklist) {
      if (verdicts.some(v => v.criterion === i.text)) continue;
      const v = byId.get(i.id);
      const quote = v?.quote?.trim() || null;
      verdicts.push({ criterion: i.text, verdict: v?.verdict ?? 'not_met', quote: quote ? quote.slice(0, 4000) : null, line: quoteLine(entries, quote) });
    }
  }
  const seen = read === null ? null : [
    `The judge (${context.judge?.model ?? 'Claude Code\'s default model'}) read in full: ${read.length ? read.join(', ') : 'no source files (the agent read none)'}.`,
    `The document that the judge marked${run.deliverable ? ` (${run.deliverable})` : ''}:\n${run.result === null || run.result === undefined ? '(not handed in)' : outputText(run.result)}`].join('\n\n');
  const record = { key: item.key, target: run.key, grader_version: item.grader_version, arm: run.arm, input: run.input, repeat: run.repeat, checkpoint: run.checkpoint,
    run_dir: run.run_dir, scores, usage: item.usage ?? null, ...(Object.keys(noise).length ? { noise_scores: noise } : {}), verdicts, seen, run_id: run.run_id, device: run.device };
  writeRecord(item.folder, item.key, record);
  await linkGrade(item.folder, record);
  return record;
}
/** Link a grade cell with its numbers; its verdicts and what the grader saw go where the run keeps its content. */
async function linkGrade(folder: string, record: any) {
  const account = readAccount(folder);
  if (!account || !record.run_id) return;
  // Usage per correction goes with each grade, as a number of the run's point.
  const measures = Object.fromEntries([...Object.entries(record.scores), ...(typeof record.usage === 'number' ? [['Usage per correction', record.usage]] : [])].filter(([, value]) => typeof value === 'number' && Number.isFinite(value)));
  if (record.device) {
    const seenFile = record.seen === null ? null : join(folder, 'cells', `${record.key}.seen.txt`);
    if (seenFile) writeFileSync(seenFile, record.seen, { mode: 0o600 });
    registerLocalRun(account.cache_dir, record.run_id, account.server, entry => ({ ...entry, grades: { ...entry.grades, [record.key]: { verdicts: record.verdicts, seen: seenFile } } }));
    await ensureLocalServer(account.cache_dir);
    await linkCells(folder, [{ key: record.key, measures }]);
    return;
  }
  const seen = record.seen === null ? null : await uploadText(folder, record.seen);
  await linkCells(folder, [{ key: record.key, measures, ...(record.verdicts.length ? { verdicts: record.verdicts } : {}), ...(seen ? { seen } : {}) }]);
}
async function codeScore(m: any, run: any, expected: unknown) {
  const result = await runScript(m.code.path, { input: run.input, output: run.result, expected: expected ?? null, run_dir: run.run_dir, artifacts: run.artifacts });
  let score: unknown;
  try { const value = JSON.parse(result.stdout); score = typeof value === 'number' ? value : value?.score; } catch { /* below */ }
  if (result.code !== 0 || typeof score !== 'number' || !Number.isFinite(score))
    throw Error(`The measure ${m.name} (${basename(m.code.path)}) gave no score for ${run.arm} on ${run.input}${result.stderr.trim() ? `: ${result.stderr.trim().split('\n').at(-1)}` : `; it must print {"score": NUMBER}`}.`);
  return score;
}

/**
 * The usage measure of a run, as its point on the page shows it: what its learner used per correction for the
 * corrections it received up to the run's checkpoint (null at the start, or without corrections).
 */
function usageOfRun(plan: Plan, treated: ArmTreatment[] | null) {
  const unit = usagePerCorrection(plan, treated)?.unit;
  return (run: any): number | null => {
    if (!unit || run.checkpoint === null) return null;
    const own = treated?.find(t => t.arm === run.arm)?.learners[run.repeat]?.events.filter(e => e.kind === 'correction' && e.received && e.index <= run.checkpoint) ?? [];
    if (!own.length) return null;
    return Number((own.reduce((sum, e) => sum + (unit === 'tokens' ? e.tokens ?? 0 : e.duration_ms / 60_000), 0) / own.length).toFixed(unit === 'tokens' ? 0 : 2));
  };
}
/** The runs to grade, each with the measures that grade it. trial: the trial's runs, without the measures that a person marks. */
function gradeItems(plan: Plan, runs: any[], planned: Cell[], marks: Record<string, number>, trial: boolean, treated: ArmTreatment[] | null, missing: Set<string> | null) {
  const measures = trial ? plan.measures.filter((m: any) => m.person === undefined) : plan.measures;
  const usage = usageOfRun(plan, treated);
  const keys = gradeKeys(plan, [...planned, ...runs.filter(run => !planned.some(c => c.key === run.key))]);
  return runs.map(run => JSON.stringify({ key: keys.get(run.key), unlinked: missing?.has(keys.get(run.key)!) ?? false, grader_version: graderVersion(plan), folder: plan.folder,
    context: { folder: plan.folder, judge: plan.judge, judge_method: plan.judge_method, checklist: plan.checklists[run.input] ?? [] } satisfies GradeContext,
    run, measures, expected: plan.expected[run.input], usage: usage(run),
    marks: Object.fromEntries(measures.filter((m: any) => m.person !== undefined).map((m: any) => [m.name, marks[markKey(m, run)]])) }));
}

// ---------------------------------------------------------------------------------------------------------------
// The decision

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const fixed = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(2);

/** Apply the decision rule to the grades: the answer, the reason, the decision as the account keeps it, and the result text. */
export function decide(plan: Plan, grades: any[], treated: ArmTreatment[] | null, runs: any[] = [], noise: ReturnType<typeof noiseCheck> | null = null) {
  const main = plan.measures.find((m: any) => m.main);
  const points: Array<number | null> = plan.checkpoints ?? [null];
  const at: number | null = plan.rule.at ?? null;
  // n: the fewest learners behind the point on any input; the mean leaves out runs that have no number on the measure
  // (an input with no covered item yet).
  const point = (arm: string, checkpoint: number | null, measure: string) => {
    const own = grades.filter(g => g.arm === arm && g.checkpoint === checkpoint && g.repeat < plan.learners);
    const n = Math.min(...plan.inputs.map((input: any) => own.filter(g => g.input === input.id).length));
    const values = own.map(g => g.scores[measure]).filter((v): v is number => typeof v === 'number');
    return { n, mean: values.length ? mean(values) : null };
  };
  const reasons: string[] = [];
  const shortArms = (treated ?? []).filter(t => t.learners.some(l => l.missing.length));
  const planned = plan.inputs.length * plan.learners * points.length;
  const ownGrades = grades.filter(g => g.repeat < plan.learners);
  const received = Object.fromEntries(plan.arms.map((arm: any) => [arm.name, receivedOf(arm.name, ownGrades, planned, treated?.find(x => x.arm === arm.name), plan)]));
  for (const arm of plan.arms) received[arm.name]!.models = [...new Set(runs.filter(r => r.arm === arm.name).flatMap(r => r.models ?? []))].slice(0, 10);
  for (const t of shortArms) reasons.push(`${labelOf(plan, t.arm)} did not receive its full treatment (${receivedText(received[t.arm]!)})`);
  const allN = plan.arms.flatMap((arm: any) => points.map(c => point(arm.name, c, main.name).n));
  const fewest = Math.min(...allN);
  if (!shortArms.length && fewest < plan.rule.min_runs) reasons.push(`${fewest === 0 ? 'a point has no runs' : `each point has ${plural(fewest, 'learner')}`}, and the rule needs ${plan.rule.min_runs}`);
  let answer = "Can't tell yet", reason = '', better: string | undefined;
  if (reasons.length) reason = reasons[0]!;
  else if (plan.arms.some((arm: any) => point(arm.name, at, main.name).mean === null)) reason = `an arm has no number on ${main.name}${pointLabel(at)} (no item is covered there yet)`;
  else {
    const ranked = plan.arms.map((arm: any) => ({ arm: arm.name, mean: point(arm.name, at, main.name).mean! })).sort((a: any, b: any) => b.mean - a.mean);
    const [best, next] = [ranked[0], ranked[1]];
    const lead = best.mean - next.mean;
    const copies = learnerSpread(plan, grades.filter(g => g.repeat < plan.learners), at, main.name);
    if (lead < plan.rule.margin) reason = `${labelOf(plan, best.arm)} is ahead of ${labelOf(plan, next.arm)} by ${fixed(lead)} on ${main.name}, and the rule needs ${plan.rule.margin}`;
    else if (copies.spread === null) reason = `${labelOf(plan, best.arm)} is ahead of ${labelOf(plan, next.arm)} by ${fixed(lead)} on ${main.name}${pointLabel(at)}, but no agent has two copies with a number there, so Method cannot tell whether the lead is larger than the difference between copies`;
    else if (copies.spread >= lead) reason = `${labelOf(plan, best.arm)} is ahead of ${labelOf(plan, next.arm)} by ${fixed(lead)} on ${main.name}${pointLabel(at)}, but two copies of the same agent differ by ${fixed(copies.spread)} there, so the lead could come from which copies learned what`;
    else {
      const guard = plan.rule.guard;
      // The guard: at the point that decides, the winner's guard measure against the best of the other arms'.
      const rival = guard ? plan.arms.filter((a: any) => a.name !== best.arm).map((a: any) => ({ arm: a.name, mean: point(a.name, at, guard.measure).mean! })).sort((a: any, b: any) => b.mean - a.mean)[0] : null;
      const below = guard ? rival.mean - point(best.arm, at, guard.measure).mean! : 0;
      if (guard && below > guard.max_drop) reason = `${labelOf(plan, best.arm)} is ahead on ${main.name}, but its ${guard.measure} is ${fixed(below)} below ${labelOf(plan, rival.arm)}'s${pointLabel(at)}, and the rule allows ${guard.max_drop}`;
      else { answer = `${labelOf(plan, best.arm)} is better`; better = best.arm; reason = `${labelOf(plan, best.arm)} is ahead of ${labelOf(plan, next.arm)} by ${fixed(lead)} on ${main.name}${pointLabel(at)}, and the rule needs ${plan.rule.margin}`; }
    }
  }
  const lines = [`${answer}: ${reason}.`, '', `Question: ${plan.question}`, `Difference: ${plan.difference}`, ...plan.other_differences.map((d: string) => `Other difference: ${d}`),
    `Rule: ${plan.rule_sentence}`, '', 'What each arm received:'];
  for (const arm of plan.arms) {
    const ran = ownGrades.filter(g => g.arm === arm.name).length;
    const t = treated?.find(x => x.arm === arm.name);
    const full = ran === planned && !t?.learners.some(l => l.missing.length);
    lines.push(`  ${full ? '' : 'SHORT '}${arm.label ?? arm.name}: ${receivedText(received[arm.name]!)}`);
  }
  for (const m of plan.measures) {
    lines.push('', `${m.main ? 'Main measure' : 'Also shown'}: ${m.name} (mean per run; n = learners behind the point)`);
    for (const arm of plan.arms) lines.push(`  ${arm.label ?? arm.name}: ${points.map(c => { const p = point(arm.name, c, m.name); return `${c === null ? '' : `after ${c}: `}${p.mean === null ? 'no number' : fixed(p.mean)} (n=${p.n})`; }).join('; ')}`);
  }
  const usage = usagePerCorrection(plan, treated);
  if (usage) lines.push('', `Also shown: usage per correction (${usage.unit}, decided by Method)`, ...Object.entries(usage.values).map(([arm, v]) => `  ${labelOf(plan, arm)}: ${v.value === null ? 'not known' : fixed(v.value)} (n=${v.n})`));
  if (noise) lines.push('', noise.spread === null ? 'Noise at the start: not measured.' : `Noise at the start: two copies of the same agent differ by up to ${fixed(noise.spread)} on ${noise.measure}.`);
  const atPoint = learnerSpread(plan, ownGrades, at, main.name);
  lines.push(atPoint.spread === null ? `Spread between copies${pointLabel(at)}: not measured (fewer than 2 copies with a number).` : `Spread between copies${pointLabel(at)}: up to ${fixed(atPoint.spread)} on ${main.name} (${plan.arms.map((arm: any) => `${labelOf(plan, arm.name)} ${atPoint.by_arm[arm.name] === null ? 'not measured' : fixed(atPoint.by_arm[arm.name]!)}`).join(', ')}). A lead must be larger.`);
  lines.push('', 'Assumptions:');
  if (treated) lines.push(`  Each arm received its full treatment: checked by Method: ${shortArms.length ? 'no' : 'yes'}.`);
  lines.push(`  Each point has at least ${plural(plan.rule.min_runs, 'learner')}: checked by Method: ${fewest >= plan.rule.min_runs ? 'yes' : 'no'}.`);
  for (const a of plan.assumptions.filter((x: any) => x.by !== 'method')) lines.push(`  ${a.text}: not checked.${a.check ? ` To check it: ${a.check}` : ''}`);
  const decision = { answer: better ? 'better' : 'cant_tell', ...(better ? { arm: better } : {}), reason: `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`.slice(0, 500),
    values: Object.fromEntries(plan.arms.map((arm: any) => { const p = point(arm.name, at, main.name); return [arm.name, { value: p.mean, n: p.n }]; })) };
  return { answer, reason, text: lines.join('\n'), decision, received, usage };
}

/** `method __compare STAGE`: one stage of a comparison, run by the generated Method's stage script. */
export async function compareStage(stage: string, bindings: any): Promise<Record<string, unknown>> {
  const plan = bindings.comparison ? JSON.parse(bindings.comparison) : undefined;
  // Every stage, its arms and their learners use the account that saved the comparison.
  const saved = plan?.folder ? readAccount(plan.folder) : null;
  if (saved?.account) process.env.METHOD_ACCOUNT = saved.account;
  const treated: ArmTreatment[] | null = bindings.treated ? JSON.parse(bindings.treated) : null;
  const runsOf = (list: string[] = []) => list.map(r => JSON.parse(r));
  const reported = { state: { reported: new Date().toISOString() } };
  if (stage === 'trial_approved') return { start: true };
  // The trial runs only after a yes (the Trial approval step's start), which holds for this version of the file.
  if ((stage === 'trial_treat' || stage === 'trial_plan') && bindings.start !== undefined) {
    if (bindings.start !== true) throw Error('The trial was not approved.');
    const digest = JSON.parse(readFileSync(join(plan.folder, 'spec.json'), 'utf8')).spec_digest;
    if (!isTrialApproved(plan.folder, digest)) writePrivateJson(trialApprovalFile(plan.folder), { spec_digest: digest, at: new Date().toISOString() });
  }
  if (stage === 'trial_treat') {
    // The first learner gets the first events; the other noise learners start as the arm is.
    const value = JSON.stringify(await treat(plan, Array.from({ length: NOISE_LEARNERS }, (_, learner) => learner === 0 ? trialEvents(plan) : 0)));
    return { trial_treatment: value, state: { treatment: value } };
  }
  if (stage === 'treat') {
    if (bindings.go !== true) throw Error('The full run was not approved.');
    await recordApproval(plan);
    const value = JSON.stringify(await treat(plan, Array.from({ length: plan.learners }, () => plan.events.length)));
    return { treatment: value, state: { treatment: value } };
  }
  if (stage === 'trial_plan') {
    const list = cells(plan, treated, 'trial'), { run, done } = await split(plan, list, list);
    return { trial_cells: run.map(c => JSON.stringify(c)), trial_done: done.map(r => JSON.stringify(r)), ...reported };
  }
  if (stage === 'trial_cell') return { trial_run: JSON.stringify(await runCell(JSON.parse(bindings.cell))) };
  if (stage === 'cell') return { full_run: JSON.stringify(await runCell(JSON.parse(bindings.cell))) };
  if (stage === 'trial_gather') {
    const runs = [...runsOf(bindings.trial_runs), ...runsOf(bindings.trial_done)];
    // The grade keys hold the runs as they finished: the account gets the trial's plan with them before the grades link.
    const planned = cells(plan, treated, 'trial');
    const missing = await sendPlan(plan.folder, plannedCells(plan, planned));
    return { trial_graded: gradeItems(plan, runs, planned, {}, true, treated, missing) };
  }
  if (stage === 'check') return { trial_summary: await trialCheck(plan, [...runsOf(bindings.runs), ...runsOf(bindings.done)], runsOf(bindings.grades), treated), ...reported };
  if (stage === 'approved') return { go: true };
  if (stage === 'plan') {
    if (bindings.go !== true) throw Error('The full run was not approved.');
    await recordApproval(plan);
    const all = cells(plan, treated, 'full'), { run, done } = await split(plan, all, all);
    return { cells: run.map(c => JSON.stringify(c)), done: done.map(r => JSON.stringify(r)), ...reported };
  }
  // Every finished run, once: the trial's, the full run's, and those that earlier runs finished.
  const all = () => [...new Map([...runsOf(bindings.trial_runs), ...runsOf(bindings.trial_done), ...runsOf(bindings.full_runs), ...runsOf(bindings.done_runs)].map(r => [r.key, r])).values()];
  if (stage === 'to_mark') {
    const marks = JSON.parse(bindings.marks || '{}'), questions: string[] = [], keys: string[] = [];
    let n = 0;
    for (const m of plan.measures.filter((m: any) => m.person !== undefined)) for (const run of all().filter(r => r.repeat < plan.learners)) {
      const key = markKey(m, run);
      if (marks[key] !== undefined || keys.includes(key)) continue;
      keys.push(key);
      // The arm is not named, so the mark is blind.
      questions.push(`Output ${++n} (input ${run.input}):\n\n${outputText(run.result)}\n\n${m.person}\nAnswer mark: a number.`);
    }
    return { mark_questions: questions, mark_keys: keys };
  }
  if (stage === 'gather') {
    const marks = { ...JSON.parse(bindings.marks || '{}') };
    (bindings.mark_keys ?? []).forEach((key: string, i: number) => { marks[key] = bindings.marks_given[i]; });
    if (bindings.mark_keys?.length) writePrivateJson(marksFile(plan.folder), { ...readMarks(plan.folder), ...marks });
    // The grade keys hold the runs as they finished: the account gets the plan with them before the grades link.
    const planned = cells(plan, treated, 'full');
    const missing = await sendPlan(plan.folder, plannedCells(plan, planned));
    return { graded: gradeItems(plan, all().filter(r => r.repeat < plan.learners), planned, marks, false, treated, missing) };
  }
  if (stage === 'grade') return { grade: JSON.stringify(await grade(JSON.parse(bindings.item))) };
  if (stage === 'trial_grade') return { trial_grade: JSON.stringify(await grade(JSON.parse(bindings.item))) };
  if (stage === 'decide') {
    const grades = runsOf(bindings.grades), runs = all();
    const noise = noiseCheck(plan, [...runsOf(bindings.trial_grades), ...grades]);
    const result = decide(plan, grades, treated, runs, noise);
    // The account gets every finished cell that it lacks, then the decision.
    const missing = await sendPlan(plan.folder, plannedCells(plan, cells(plan, treated, 'full')));
    if (missing) {
      for (const run of runs) if (missing.has(run.key)) await linkRun(plan.folder, run);
      for (const g of grades) if (missing.has(g.key)) await linkGrade(plan.folder, g);
    }
    const minutes = Math.round(runs.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0) / 60_000);
    const usd = runs.length && runs.every(r => typeof r.cost_usd === 'number') ? runs.reduce((sum, r) => sum + r.cost_usd, 0) : null;
    await sendStage(plan.folder, { stage: 'done', decision: result.decision, received: accountReceived(result.received), cost_estimate: { minutes, runs: runs.length, usd } });
    return { answer: result.text, ...reported };
  }
  throw Error(`Unknown comparison stage ${stage}.`);
}
export async function compareStageCommand(stage: string) {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  try { process.stdout.write(JSON.stringify(await compareStage(stage, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))) + '\n'); }
  catch (error) { process.stderr.write(`${(error as Error).message}\n`); process.exitCode = 1; }
}
