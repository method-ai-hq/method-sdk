/**
 * Comparisons: a NAME.compare file asks one question about two or more agents. `method run NAME.compare` checks the
 * file, compiles it into a generated Method (as requestMethod does for a model request) and runs that Method. Its
 * steps are the stages: trial, treatment check, approval (an ask step), full run, grades, decision. Each cell (arm ×
 * input × run × checkpoint) is one iteration of an each step, so the runtime's step cache reuses every finished cell
 * on a rerun, and a changed measure regrades without running any agent again. Each stage reports to the comparison's
 * page in the Method account (compare-account.ts); a cell is keyed by its content, so a cell that two versions of the
 * file share runs once.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
import { linkCells, readAccount, saveComparison, sendPlan, sendStage, uploadText, type PlannedCell } from './compare-account.js';
import { ensureLocalServer, registerLocalRun } from './local-server.js';

// ---------------------------------------------------------------------------------------------------------------
// The file

const text = z.string().trim().min(1);
const name = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use lowercase letters, digits and underscores, starting with a letter, at most 40 characters.');
/** The comparison's ID in the Method account: written into the file on its first run, like a Method's ID. */
export const comparisonIdPattern = /^cmp_[a-f0-9]{32}$/;
const measureSchema = z.strictObject({
  name: text.describe('A short name for the number, for example "would send".'),
  code: text.optional().describe('A script (.mjs, .js or .py) that reads {input, output, expected, run_dir, artifacts} as JSON on stdin and prints {"score": NUMBER}.'),
  rubric: z.array(text).min(1).optional().describe('Sentences that must be true of the output. A model grader judges each one; the score is the share that is true.'),
  person: text.optional().describe('A question that a person answers with a number for each output, for example 1 for "would send" and 0 for "would not send".'),
}).describe('One number per run. Higher is better. Give exactly one of code, rubric or person.');
const armSchema = z.union([
  text.describe('A Method file (.method).'),
  z.strictObject({ agent: z.enum(['claude', 'codex']).describe('Plain Claude Code or Codex.'), instructions: text.describe('A file with the instructions the agent gets.') }),
]);
const eventSchema = z.strictObject({
  correction: text.optional().describe('The words of a correction. The arm runs the input, and Method gives it this correction about that run.'),
  input: text.optional().describe('The input (case ID or file) that the arm runs for this event.'),
  model: text.optional().describe('A new model for the arm from this point on.'),
});
export const comparisonSchema = z.strictObject({
  id: z.string().regex(comparisonIdPattern).optional().describe('The comparison\'s ID in your Method account. Method writes it on the first run; keep it.'),
  question: text.describe('One sentence in your words.'),
  arms: z.record(name, armSchema).describe('Each agent under test, by a short name.'),
  difference: text.describe('The one thing that is different between the arms.'),
  other_differences: z.array(text).optional().describe('Any other difference between the arms.'),
  inputs: z.array(text).min(1).describe('The inputs that each arm runs: case IDs (folders in cases/ beside this file) or JSON files of input values. The same for each arm. An input\'s own files (inputs/ID/ beside inputs/ID.json, or the case\'s snapshot/env/), one folder per files connection, replace the arms\' folders of those names for that input.'),
  measure: measureSchema.describe('The main measure: one number per run that decides.'),
  rule: z.strictObject({
    margin: z.number().describe('How far ahead an arm must be on the main measure (the mean per run). Above 0.'),
    min_runs: z.number().int().min(1).describe('The fewest runs per input behind each point.'),
    at: z.number().int().min(0).optional().describe('The checkpoint that decides, when there is a treatment over time.'),
    guard: z.strictObject({ measure: text, max_drop: z.number().min(0) }).optional().describe('Another measure on which the winning arm must not be more than max_drop below the other arm (with more than two arms, the best other arm), at the checkpoint that decides.'),
  }).describe('The decision rule. Anything that does not pass is "can\'t tell yet".'),
  runs: z.number().int().min(1).describe('How many times each arm runs each input at each point.'),
  trial: z.number().int().min(1).optional().describe('How many inputs each arm runs in the trial before the full run. 2 when not given.'),
  treatment: z.strictObject({
    events: z.array(eventSchema).min(1).describe('What each arm gets, in order.'),
    checkpoints: z.array(z.number().int().min(0)).min(1).describe('The number of events after which the arms are measured.'),
  }).optional().describe('A list of events that each arm gets in order, with checkpoints.'),
  teaching: z.array(text).min(1).optional().describe('Inputs that the arms learn from (treatment events), kept apart from the measured inputs.'),
  other_measures: z.array(measureSchema).optional().describe('Numbers that are shown but do not decide.'),
  expected: z.record(text, text).optional().describe('For an input, a file with its correct output. The arms never see it; the measures do.'),
  assumptions: z.array(text).optional().describe('Statements that must be true for the answer to mean something. Method shows its own checks as checked by Method; these are not checked.'),
}).describe('A comparison: one question about two or more agents.');
export type Comparison = z.infer<typeof comparisonSchema>;
/** The JSON schema of a .compare file, for method schema compare. */
export const comparisonJsonSchema = () => z.toJSONSchema(comparisonSchema);

const requiredParts: Record<string, string> = {
  question: 'one sentence in your words',
  arms: 'each agent under test: a Method file, or {agent: claude|codex, instructions: FILE}',
  difference: 'the one thing that is different between the arms',
  inputs: 'the inputs that each arm runs (case IDs or JSON files)',
  measure: 'the main measure: {name, and one of code, rubric or person}',
  rule: 'the decision rule: {margin, min_runs, at?, guard?: {measure, max_drop}}',
  runs: 'how many times each arm runs each input',
};

const sha = (value: unknown) => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isFileInput = (id: string) => /\.json$/i.test(id);

/** An input: a JSON file of input values, or a case ID (cases/ID/recording.json beside the comparison file). */
function inputValue(root: string, id: string): unknown {
  const path = isFileInput(id) ? resolve(root, id) : join(root, 'cases', id, 'recording.json');
  if (!existsSync(path)) throw Error(isFileInput(id) ? `The input file ${id} is not there.` : `The input ${id} is not a file and has no case folder cases/${id}/ beside the comparison.`);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  return isFileInput(id) ? value : value.inputs ?? {};
}
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

/**
 * Read and check a .compare file. Every problem is named in one error: a missing required part, more than one main
 * measure, a rule that cannot say "can't tell yet", arms that share a Method ID, and inputs or files that are not there.
 */
export function readComparison(file: string): Comparison {
  const path = authoringPath(file), root = dirname(path);
  let raw: any;
  try { raw = parseDocumentValue(readFileSync(path, 'utf8')); } catch (error) { throw Error(`${basename(path)} is not readable YAML or JSON: ${(error as Error).message}`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error(`${basename(path)} must hold the parts of a comparison. Read method run --help.`);
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
  for (const m of measures) if ([m.code, m.rubric, m.person].filter(v => v !== undefined).length !== 1) problems.push(`The measure ${m.name} needs exactly one of code, rubric or person.`);
  const names = measures.map(m => m.name);
  for (const n of new Set(names)) if (names.filter(x => x === n).length > 1) problems.push(`Two measures are named ${n}. Give each its own name.`);
  for (const m of measures) if (m.code && !existsSync(resolve(root, m.code))) problems.push(`The code of the measure ${m.name} (${m.code}) is not there.`);
  for (const m of measures) if (m.code && !['.mjs', '.js', '.py'].includes(extname(m.code))) problems.push(`The code of the measure ${m.name} must be a .mjs, .js or .py file.`);
  const arms = Object.entries(doc.arms);
  if (arms.length < 2) problems.push('A comparison needs two or more arms.');
  const ids = new Map<string, string>(), connections = new Set<string>();
  for (const [armName, arm] of arms) {
    if (!armIsMethod(arm)) { if (!existsSync(resolve(root, arm.instructions))) problems.push(`The instructions of the arm ${armName} (${arm.instructions}) are not there.`); continue; }
    const armFile = resolve(root, arm);
    if (!/\.method$/i.test(arm)) { problems.push(`The arm ${armName} must be a .method file, or {agent: claude|codex, instructions: FILE}.`); continue; }
    if (!existsSync(armFile)) { problems.push(`The Method file of the arm ${armName} (${arm}) is not there.`); continue; }
    let document: any;
    try { document = readDocument(armFile); loadWorkflow(methodContent(document)); } catch (error) { problems.push(`The Method of the arm ${armName} does not load: ${(error as Error).message}`); continue; }
    for (const [envName, definition] of Object.entries(document.environment ?? {}) as Array<[string, any]>) if (definition?.type === 'files') connections.add(envName);
    const key = typeof document.id === 'string' && methodIdPattern.test(document.id) ? document.id : armFile;
    const other = ids.get(key);
    if (other) problems.push(`The arms ${other} and ${armName} are the same Method${key.startsWith('wf_') ? ` (${key})` : ''}. Each arm needs its own Method ID: run method new-id ${arm}.`);
    else ids.set(key, armName);
  }
  if (!(doc.rule.margin > 0)) problems.push('The rule needs a margin above 0. With margin 0 any difference decides, so the rule could never say "can\'t tell yet".');
  if (doc.rule.guard && !names.includes(doc.rule.guard.measure)) problems.push(`The guard names the measure ${doc.rule.guard.measure}, which is not one of the measures (${names.join(', ')}).`);
  const inputs = doc.inputs, teaching = doc.teaching ?? [];
  for (const list of [inputs, teaching]) for (const id of new Set(list)) if (list.filter(x => x === id).length > 1) problems.push(`The input ${id} is listed twice.`);
  for (const id of [...inputs, ...teaching]) { try { inputValue(root, id); } catch (error) { problems.push((error as Error).message); } }
  for (const id of teaching) if (inputs.includes(id)) problems.push(`The input ${id} is both a teaching input and a measured input. Keep them apart.`);
  for (const [id, expected] of Object.entries(doc.expected ?? {})) {
    if (!inputs.includes(id)) problems.push(`The expected answer for ${id} names no measured input.`);
    if (!existsSync(resolve(root, expected))) problems.push(`The expected answer for ${id} (${expected}) is not there.`);
  }
  // An input's own folder: each folder in it is named after a files connection, and no expected answer is in it.
  for (const id of inputs) {
    const room = inputRoom(root, id);
    if (!room) continue;
    for (const entry of readdirSync(room, { withFileTypes: true })) {
      if (!entry.isDirectory()) problems.push(`The folder of the input ${id} holds the file ${entry.name}. Put each file in a folder named after the files connection that holds it.`);
      else if (connections.size && !connections.has(entry.name)) problems.push(`The folder of the input ${id} holds ${entry.name}/, which is not a files connection of the Method arms (${[...connections].join(', ')}).`);
    }
    for (const expected of Object.values(doc.expected ?? {})) if (`${resolve(root, expected)}/`.startsWith(`${room}/`)) problems.push(`The expected answer ${expected} is in the folder of the input ${id}, which the arms get. Keep expected answers outside it.`);
  }
  for (const id of teaching) if (inputRoom(root, id)) problems.push(`The teaching input ${id} has a folder of its own files. Only measured inputs have one: a Method arm's training runs use its own folders.`);
  if (doc.treatment) {
    const { events, checkpoints } = doc.treatment;
    events.forEach((event, i) => {
      const kinds = [event.correction !== undefined ? 'correction' : null, event.model !== undefined ? 'model' : null].filter(Boolean);
      if (event.model !== undefined && (event.correction !== undefined || event.input !== undefined)) problems.push(`Event ${i + 1}: a model event names only the model.`);
      else if (!kinds.length && event.input === undefined) problems.push(`Event ${i + 1} needs a correction with its input, an input, or a model.`);
      else if (event.correction !== undefined && event.input === undefined) problems.push(`Event ${i + 1}: a correction needs the input whose run it corrects.`);
      if (event.input !== undefined) {
        if (teaching.length && !teaching.includes(event.input)) problems.push(`Event ${i + 1} uses ${event.input}, which is not a teaching input.`);
        else if (!teaching.length) { try { inputValue(root, event.input); } catch (error) { problems.push(`Event ${i + 1}: ${(error as Error).message}`); } }
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
  if (problems.length) throw Error(`${basename(path)} cannot run. ${problems.join(' ')}`);
  return doc;
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
  return `An arm is better when its mean ${doc.measure.name}${point} is at least ${margin} above every other arm's${guardText}, with at least ${plural(min_runs, 'run')} per input behind each point. Otherwise: can't tell yet.`;
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
  rmSync(env, { recursive: true, force: true });
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
function generatedMethod(doc: Comparison, previousId: string | undefined, counts: { cells: number }, approved: boolean) {
  const treatment = !!doc.treatment, person = [doc.measure, ...(doc.other_measures ?? [])].some(m => m.person !== undefined);
  const stage = (name: string) => ({ kind: 'run', runtime: 'node', entrypoint: 'stage.mjs', args: [name] });
  const list = { type: 'list', items: { type: 'text' } };
  const treated = treatment ? { treated: 'treatment' } : {};
  const reports = ['state.reported'];
  const steps: Record<string, any> = {};
  if (treatment) steps.trial_treat = { name: 'Trial treatment', purpose: 'Gives each arm the treatment events before the first checkpoint and records what it received.', in: { comparison: 'inputs.comparison' }, do: stage('trial_treat'), changes: ['state.treatment'], out: { trial_treatment: { type: 'text' } } };
  steps.trial_plan = { name: 'Trial plan', purpose: 'Lists the trial runs (each arm on the first inputs, once) that have not finished yet, and reports them to the comparison page.', in: { comparison: 'inputs.comparison', ...(treatment ? { treated: 'trial_treatment' } : {}) }, do: stage('trial_plan'), changes: reports, out: { trial_cells: list, trial_done: list } };
  steps.trial = { name: 'Trial', purpose: 'Runs each trial cell.', each: { cell: 'trial_cells' }, concurrency: 4, do: stage('trial_cell'), out: { trial_run: { type: 'text' } } };
  steps.trial_check = { name: 'Treatment check', purpose: 'Says what each arm received, and stops when an arm did not receive everything. Estimates the full run from the trial.', in: { comparison: 'inputs.comparison', runs: 'trial_run', done: 'trial_done', ...(treatment ? { treated: 'trial_treatment' } : {}) }, do: stage('check'), changes: reports, out: { trial_summary: { type: 'text' } } };
  steps.approve = approved
    ? { name: 'Approval', purpose: 'The person already approved the full run of this version of the file.', in: { summary: 'trial_summary' }, do: stage('approved'), out: { go: { type: 'boolean' } } }
    : { name: 'Approval', purpose: 'The person reads the trial and says go.', in: { summary: 'trial_summary' }, ask: '{{summary}}\n\nStart the full run? Answer go: true to start it, or go: false to stop.', out: { go: { type: 'boolean', description: 'true to start the full run.' } } };
  if (treatment) steps.treat = { name: 'Treatment', purpose: 'Gives each arm every treatment event in order, freezes a copy at each checkpoint, and records what it received.', in: { comparison: 'inputs.comparison', go: 'go' }, do: stage('treat'), changes: ['state.treatment'], out: { treatment: { type: 'text' } } };
  steps.plan = { name: 'Plan', purpose: 'Lists every cell of the full run that has not finished yet, and reports the plan to the comparison page.', in: { comparison: 'inputs.comparison', go: 'go', ...treated }, do: stage('plan'), changes: reports, out: { cells: list, done: list } };
  steps.cells = { name: 'Full run', purpose: 'Runs each cell: one arm on one input, once, at one checkpoint.', each: { cell: 'cells' }, concurrency: 4, do: stage('cell'), out: { full_run: { type: 'text' } } };
  const runs = { trial_runs: 'trial_run', trial_done: 'trial_done', full_runs: 'full_run', done_runs: 'done' };
  if (person) {
    steps.to_mark = { name: 'Outputs to mark', purpose: 'Lists the outputs that a person has not marked yet.', in: { comparison: 'inputs.comparison', marks: 'inputs.marks', ...runs }, do: stage('to_mark'), out: { mark_questions: list, mark_keys: list } };
    steps.mark = { name: 'Person marks', purpose: 'A person marks each output with a number.', each: { question: 'mark_questions' }, ask: '{{question}}', out: { mark: { type: 'number', description: 'The number for this output.' } } };
  }
  steps.gather = { name: 'Gather', purpose: 'Lists every run with the measures that grade it.', in: { comparison: 'inputs.comparison', marks: 'inputs.marks', ...runs, ...treated, ...(person ? { mark_keys: 'mark_keys', marks_given: 'mark' } : {}) }, do: stage('gather'), out: { graded: list } };
  steps.grade = { name: 'Grade', purpose: 'Gives each run its number on each measure, with the grader\'s verdicts.', each: { item: 'graded' }, concurrency: 4, do: stage('grade'), out: { grade: { type: 'text' } } };
  steps.decide = { name: 'Decide', purpose: 'Applies the decision rule, writes the result and reports it to the comparison page.', in: { comparison: 'inputs.comparison', grades: 'grade', ...runs, ...treated }, do: stage('decide'), changes: reports, out: { answer: { type: 'text', description: 'The answer, the rule as a sentence, what each arm received, and n per point.' } } };
  const most = 2_147_483_647;
  return {
    format: 'method/3.4', ...(previousId ? { id: previousId } : {}),
    name: `Comparison: ${doc.question}`.slice(0, 200), goal: doc.question,
    inputs: { comparison: { type: 'text', description: 'The checked comparison, as JSON.' }, marks: { type: 'text', description: 'Marks that a person gave earlier, as JSON.' } },
    state: { reported: { type: 'text', description: 'When the comparison page last got a report.', default: '' },
      ...(treatment ? { treatment: { type: 'text', description: 'What each arm received so far.', default: '' } } : {}) },
    limits: { timeout_ms: most, max_invocations: 3 * counts.cells + 100, step: { timeout_ms: most } },
    steps, result: 'answer',
  };
}

/** The comparison as the account keeps it (the parts of the accepted definition), for the dashboard. */
function accountSpec(doc: Comparison, arms: Array<{ name: string; id?: string; plain?: Plain }>) {
  const measure = (m: Comparison['measure']) => ({ name: m.name, how: m.code ? 'code' : m.rubric ? 'model' : 'person', ...(m.rubric ? { rubric: m.rubric.map(line => `- ${line}`).join('\n') } : {}) });
  const events = doc.treatment?.events ?? [];
  const kind = events.every(e => e.correction !== undefined) ? 'Corrections' : events.every(e => e.correction === undefined) ? 'New inputs' : 'Events';
  return {
    question: doc.question,
    arms: arms.map(arm => ({ id: arm.name, name: arm.name, ...(arm.plain ? { agent: arm.plain.agent } : { method_id: arm.id }) })),
    difference: doc.difference, ...(doc.other_differences?.length ? { other_differences: doc.other_differences } : {}),
    inputs: { checking: doc.inputs, ...(doc.teaching?.length ? { teaching: doc.teaching } : {}) },
    main_measure: measure(doc.measure), ...(doc.other_measures?.length ? { other_measures: doc.other_measures.map(measure) } : {}),
    rule: doc.rule, runs_per_point: doc.runs, ...(doc.trial ? { trial: doc.trial } : {}),
    ...(doc.treatment ? { treatment: { kind, items: events.length, checkpoints: [...doc.treatment.checkpoints].sort((a, b) => a - b) } } : {}),
    ...(doc.expected ? { expected_answers: true } : {}),
    assumptions: [...(doc.treatment ? [{ text: 'Each arm received its full treatment.', check: 'treatment' }] : []), ...(doc.assumptions ?? []).map(text => ({ text, check: null }))],
  };
}

/** The person said go to this version of the file (on this computer, or the account's version is past its trial). */
const approvalFile = (folder: string) => join(folder, 'approval.json');
function isApproved(folder: string, digest: string) {
  const account = readAccount(folder);
  if (account?.spec_digest === digest && ['running', 'done'].includes(account.stage)) return true;
  try { return JSON.parse(readFileSync(approvalFile(folder), 'utf8')).spec_digest === digest; } catch { return false; }
}

/**
 * Check a .compare file and write its generated Method, the stage script and the inputs into the comparison folder.
 * The file is saved as a version of its comparison in the account, for the comparison page. A plain Claude Code or
 * Codex arm runs as the runtime's session step, in a room with the files that the Method arms get.
 */
export async function compileComparison(file: string) {
  const path = authoringPath(file), root = dirname(path);
  const doc = readComparison(path);
  if (doc.treatment?.events.some(event => event.model !== undefined)) throw Error('A treatment event that changes the model cannot run yet: that is not built yet. Corrections and new inputs run today.');
  const id = ensureComparisonId(path, doc);
  const folder = comparisonFolder(path);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const arms: any[] = [];
  for (const [armName, arm] of Object.entries(doc.arms)) {
    const cache_dir = join(folder, 'arms', armName, 'cache');
    if (!armIsMethod(arm)) { arms.push({ name: armName, plain: { agent: arm.agent, instructions: readFileSync(resolve(root, arm.instructions), 'utf8') }, cache_dir }); continue; }
    arms.push({ name: armName, ...await copyArm(resolve(root, arm), join(folder, 'arms', armName)), cache_dir });
  }
  // A plain arm gets the same folders that the Method arms get: a copy of each bound folder, by its name. For an input
  // with its own folder, every arm gets that input's folders instead (cellFolders).
  const shared = Object.assign({}, ...arms.filter(a => !a.plain).map(a => a.folders)) as Record<string, string>;
  for (const arm of arms.filter(a => a.plain)) {
    arm.folders = shared;
    const method = join(folder, 'arms', arm.name, 'plain.method');
    let methodId: string | undefined;
    try { methodId = readDocument(method).id; } catch { /* first run */ }
    mkdirSync(dirname(method), { recursive: true, mode: 0o700 });
    writeFileSync(method, JSON.stringify(plainMethod(arm.plain.agent), null, 2) + '\n', { mode: 0o600 });
    writeMethodId(method, methodId && methodIdPattern.test(methodId) ? methodId : newMethodId());
    arm.method = method;
    arm.id = readDocument(method).id;
    arm.hash = sha({ ...arm.plain, folders: Object.fromEntries(Object.entries(shared).map(([envName, dir]) => [envName, folderHash(dir)])) });
  }
  const spec = accountSpec(doc, arms);
  const digest = sha(spec);
  writePrivateJson(join(folder, 'spec.json'), { spec_digest: digest });
  await saveComparison(folder, id, basename(path).replace(/\.compare$/i, ''), spec);
  const resolveInput = (inputId: string, measured = false) => {
    const value = inputValue(root, inputId), room = measured ? inputRoom(root, inputId) : null;
    return { id: inputId, value, room, hash: room ? sha({ value, room: folderHash(room) }) : sha(value) };
  };
  const measure = (m: Comparison['measure'], main: boolean) => ({ name: m.name, main,
    ...(m.code ? { code: { path: resolve(root, m.code), hash: sha(readFileSync(resolve(root, m.code))) } } : {}),
    ...(m.rubric ? { rubric: m.rubric } : {}), ...(m.person ? { person: m.person } : {}) });
  const expectedValue = (p: string) => { const raw = readFileSync(resolve(root, p), 'utf8'); try { return JSON.parse(raw); } catch { return raw; } };
  const plan = {
    file: path, folder, question: doc.question, difference: doc.difference, other_differences: doc.other_differences ?? [],
    arms, inputs: doc.inputs.map(id => resolveInput(id, true)),
    events: (doc.treatment?.events ?? []).map((event, i) => ({ index: i + 1, kind: event.correction !== undefined ? 'correction' : 'input', ...(event.correction ? { text: event.correction } : {}), input: resolveInput(event.input!) })),
    checkpoints: doc.treatment ? [...doc.treatment.checkpoints].sort((a, b) => a - b) : null,
    measures: [measure(doc.measure, true), ...(doc.other_measures ?? []).map(m => measure(m, false))],
    expected: Object.fromEntries(Object.entries(doc.expected ?? {}).map(([inputId, p]) => [inputId, expectedValue(p)])),
    rule: doc.rule, rule_sentence: ruleSentence(doc), runs: doc.runs, trial: Math.min(doc.trial ?? 2, doc.inputs.length),
    assumptions: doc.assumptions ?? [], compare_root: root,
  };
  const methodPath = join(folder, 'comparison.method');
  let previousId: string | undefined;
  try { const old = JSON.parse(readFileSync(methodPath, 'utf8')).id; if (typeof old === 'string' && methodIdPattern.test(old)) previousId = old; } catch { /* first run */ }
  const cellCount = arms.length * doc.inputs.length * doc.runs * (plan.checkpoints?.length ?? 1);
  writeFileSync(join(folder, 'stage.mjs'), stageScript, { mode: 0o600 });
  writeFileSync(methodPath, JSON.stringify(generatedMethod(doc, previousId, { cells: cellCount }, isApproved(folder, digest)), null, 2) + '\n', { mode: 0o600 });
  const inputs = join(folder, 'inputs.json');
  writePrivateJson(inputs, { comparison: JSON.stringify(plan), marks: JSON.stringify(readMarks(folder)) });
  return { method: methodPath, inputs, folder, plan };
}

/**
 * `method run NAME.compare [OPTIONS]` becomes `method run .compare/NAME/comparison.method [OPTIONS] --inputs FILE`.
 * A resumed run keeps its saved inputs.
 */
export async function comparisonRunArgs(args: string[]) {
  const rest = args.slice(2);
  if (rest.some(arg => /^--inputs(-from)?(=|$)/.test(arg))) throw Error('A comparison names its inputs in the file. Run it without --inputs.');
  const compiled = await compileComparison(args[1]!);
  return ['run', compiled.method, ...rest, ...(rest.includes('--resume') ? [] : ['--inputs', compiled.inputs])];
}

// ---------------------------------------------------------------------------------------------------------------
// The stages (method __compare STAGE: the bindings as JSON on stdin, the outputs as JSON on stdout)

type Plan = ReturnType<typeof JSON.parse>;
/** A plain arm: Claude Code or Codex with its instructions (and the corrections it was told, after a treatment). */
type Plain = { agent: 'claude' | 'codex'; instructions: string };
/** An arm at one point: a Method folder and file, or a plain agent. */
type Snapshot = { dir: string; file: string; hash: string } | { plain: Plain; hash: string };
type Cell = { key: string; folder: string; arm: string; dir?: string; file?: string; plain?: Plain; method?: string; hash: string; cache_dir: string; folders: Record<string, string>;
  input: { id: string; value: unknown; hash: string; room: string | null }; repeat: number; checkpoint: number | null; trial: boolean; treatment_note: string | null };
const pointLabel = (checkpoint: number | null) => checkpoint === null ? '' : ` after ${plural(checkpoint, 'event')}`;

/** Treatment of one arm: what it received so far, and the frozen copy of the arm at each checkpoint it reached. */
type ArmTreatment = { arm: string; planned: number; corrections: { planned: number; received: number }; inputs: { planned: number; received: number };
  missing: Array<{ index: number; reason: string }>; snapshots: Record<string, Snapshot> };

/**
 * How an event reaches a Method arm. A correction: the arm runs the event's input (a training run, saved to the
 * account), then method judge RUN wrong --note TEXT, then method wait until the fix has a final outcome. Any final
 * outcome counts as received, also "no fix found": Method got the correction. A question from the fix is not final:
 * after the person's answer (method answer), the next run of the comparison waits for the same judgment again, and
 * never judges the run a second time. A new input: the training run alone. Tests replace deliver.
 */
type Delivered = { received: boolean; reason?: string; run_id?: string; judgment_id?: string; outcome?: string };
export const delivery = {
  async deliver(event: any, learner: { dir: string; file: string }, cacheDir: string, workDir: string, before?: Delivered): Promise<Delivered> {
    // The training run and its fix run in a clean room, as the arm's cells do: they see none of the user's
    // instructions, memory or settings, only the sign-ins of the agents they use.
    const room = await armRoom(join(learner.dir, learner.file), cacheDir, true);
    try { return await deliverIn(room.env, event, learner, workDir, before); } finally { await room.remove(); }
  },
};
async function deliverIn(env: NodeJS.ProcessEnv, event: any, learner: { dir: string; file: string }, workDir: string, before?: Delivered): Promise<Delivered> {
  if (before?.judgment_id && before.run_id) return waitForFix(before.run_id, before.judgment_id, env);
  const runDir = join(workDir, 'run');
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  writePrivateJson(join(workDir, 'inputs.json'), event.input.value);
  const run = await command(['run', join(learner.dir, learner.file), '--inputs', join(workDir, 'inputs.json'), '--run-dir', runDir], env);
  let summary: any = {};
  try { summary = JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8')); } catch { /* the run did not start */ }
  if (summary.status !== 'completed') return { received: false, reason: `the training run on ${event.input.id} ended ${summary.status ?? 'before its first step'}${summary.failure?.headline ? `: ${summary.failure.headline}` : run.stderr ? `: ${run.stderr.trim().split('\n').at(-1)}` : ''}` };
  if (event.kind !== 'correction') return { received: true };
  let runId: string | undefined;
  try { runId = JSON.parse(readFileSync(join(runDir, 'method-sync.json'), 'utf8')).dashboard_id; } catch { /* not saved */ }
  if (!runId) return { received: false, reason: 'the training run is not in your Method account, so method judge cannot take the correction. Sign in with method login, then run the comparison again' };
  const judged = await command(['judge', runId, 'wrong', '--note', event.text, '--json'], env);
  let judgment: any;
  try { judgment = JSON.parse(judged.stdout); } catch { return { received: false, run_id: runId, reason: `method judge failed: ${judged.stderr.trim() || judged.stdout.trim()}` }; }
  const id = judgment?.judgment?.id;
  if (!id || !judgment.fix) return { received: false, run_id: runId, reason: judgment?.stopped?.failure?.headline ?? 'method judge started no fix for this correction' };
  return waitForFix(runId, id, env);
}

/**
 * The clean room of a Method arm (cleanRoomEnv): a fresh HOME with only the sign-ins of the agents that its model
 * steps run on (and, for a fix, the user's own agent, which runs the fix), a short TMPDIR, and a copy of each bound
 * folder. Method's own sign-in, cache and server stay: the arm's runs and judgments belong to the user's account.
 */
async function armRoom(file: string, cacheDir: string, fix: boolean, folders: Record<string, string> = {}) {
  const { cleanRoomEnv } = await import('@withmethod/runtime/clean-room.js');
  const { localAgent, methodProfiles } = await import('@withmethod/runtime/agents.js');
  const method = readDocument(file);
  const models = Object.values(method.steps ?? {}).flatMap((step: any) => [step.do, step.check]).filter((exec: any) => ['call', 'agent'].includes(exec?.kind));
  const agents = new Set<string>(Object.values(methodProfiles(method)).map((profile: any) => profile.backend));
  if (fix || models.length) { const local = await localAgent(); if (local) agents.add(local); }
  const room = await cleanRoomEnv([...agents].filter((agent): agent is 'claude' | 'codex' => agent === 'claude' || agent === 'codex'), process.env, { folders });
  Object.assign(room.env, { METHOD_CONFIG_DIR: configRoot(), METHOD_CACHE_DIR: cacheDir, ...(process.env.METHOD_SERVER ? { METHOD_SERVER: process.env.METHOD_SERVER } : {}) });
  return room;
}
/** Wait for the fix of a correction until it has a final outcome. */
async function waitForFix(runId: string, id: string, env: NodeJS.ProcessEnv): Promise<Delivered> {
  for (;;) {
    const waited = await command(['wait', id, '--json', '--timeout', '600'], env);
    let record: any;
    try { record = JSON.parse(waited.stdout).outcomes?.[0]; } catch { return { received: false, run_id: runId, judgment_id: id, reason: `method wait failed: ${waited.stderr.trim()}` }; }
    if (record?.status === 'working') continue;
    if (record?.status === 'done' && record.outcome?.outcome === 'question') return { received: false, run_id: runId, judgment_id: id, reason: `the fix asks a question: ${record.lines?.[0] ?? ''} Answer it with method answer ${id} "THE ANSWER", then run the comparison again` };
    if (record?.status === 'done') return { received: true, run_id: runId, judgment_id: id, outcome: record.outcome?.outcome ?? 'done' };
    return { received: false, run_id: runId, judgment_id: id, reason: `the fix stopped${record?.error ? `: ${record.error}` : ''}` };
  }
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

/** Copy a folder without its run records. */
const copyFolder = (from: string, to: string) => { rmSync(to, { recursive: true, force: true }); cpSync(from, to, { recursive: true, filter: path => !['.method-runs', 'node_modules'].includes(basename(path)) }); };

/**
 * Give each arm its events in order, up to `limit`, and freeze a copy of the arm at each checkpoint. The record
 * (treatment.jsonl beside the arm's learner) keeps what each event did, so a rerun gives an event again only when it was
 * not received. After a missing event no later event is given: the order is part of the treatment.
 */
async function treat(plan: Plan, limit: number): Promise<ArmTreatment[]> {
  const events = plan.events.slice(0, limit) as any[];
  return Promise.all(plan.arms.map(async (arm: any) => {
    if (arm.plain) return toldTreatment(plan, arm, events);
    const base = join(plan.folder, 'arms', arm.name, `treatment-${arm.hash.slice(0, 12)}`);
    const learner = { dir: join(base, 'learner'), file: arm.file };
    if (!existsSync(join(learner.dir, learner.file))) { copyFolder(arm.dir, learner.dir); writeMethodId(join(learner.dir, learner.file), newMethodId()); }
    const recordFile = join(base, 'treatment.jsonl');
    const records = new Map<string, any>();
    try { for (const line of readFileSync(recordFile, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(line); records.set(r.key, r); } } catch { /* nothing yet */ }
    const snapshots: ArmTreatment['snapshots'] = { 0: { dir: arm.dir, file: arm.file, hash: arm.hash } };
    const freeze = (at: number) => {
      const dir = join(base, `after-${at}`);
      if (!existsSync(join(dir, arm.file))) copyFolder(learner.dir, dir);
      snapshots[at] = { dir, file: arm.file, hash: folderHash(dir, arm.file) };
    };
    const missing: ArmTreatment['missing'] = [];
    let stopped = false;
    for (const event of events) {
      const key = sha({ index: event.index, kind: event.kind, text: event.text ?? null, input: event.input.hash });
      if (stopped) { missing.push({ index: event.index, reason: `not given, because event ${missing[0]!.index} is missing` }); continue; }
      if (!records.get(key)?.received) {
        const started = Date.now();
        let result: Delivered;
        try { result = await delivery.deliver(event, learner, arm.cache_dir, join(base, 'events', String(event.index)), records.get(key)); }
        catch (error) { result = { received: false, reason: (error as Error).message }; }
        const record = { key, index: event.index, kind: event.kind, input: event.input.id, text_sha256: event.text ? sha(event.text) : null, ...result, duration_ms: Date.now() - started, at: new Date().toISOString() };
        mkdirSync(base, { recursive: true });
        writeFileSync(recordFile, JSON.stringify(record) + '\n', { flag: 'a', mode: 0o600 });
        records.set(key, record);
      }
      const record = records.get(key);
      if (!record.received) { missing.push({ index: event.index, reason: record.reason ?? 'not received' }); stopped = true; continue; }
      if (plan.checkpoints.includes(event.index)) freeze(event.index);
    }
    const count = (kind: string) => ({ planned: events.filter(e => e.kind === kind).length, received: events.filter(e => e.kind === kind && !missing.some(m => m.index === e.index)).length });
    return { arm: arm.name, planned: events.length, corrections: count('correction'), inputs: count('input'), missing, snapshots };
  }));
}

/**
 * The treatment of a plain arm: it is told each correction in its instructions, in order, and starts each run fresh.
 * A correction is received when its words are in the instructions. A new input gives a plain agent nothing to keep,
 * so it is received as given.
 */
export function toldInstructions(base: string, corrections: string[]) {
  return corrections.length ? `${base.trimEnd()}\n\nCorrections to follow:\n${corrections.map(text => `- ${text}`).join('\n')}\n` : base;
}
function toldTreatment(plan: Plan, arm: any, events: any[]): ArmTreatment {
  const snapshots: ArmTreatment['snapshots'] = { 0: { plain: arm.plain, hash: arm.hash } };
  const told: string[] = [], missing: ArmTreatment['missing'] = [];
  for (const event of events) {
    if (event.kind === 'correction') {
      told.push(event.text);
      if (!toldInstructions(arm.plain.instructions, told).includes(event.text)) missing.push({ index: event.index, reason: 'its words are not in the instructions' });
    }
    if (plan.checkpoints.includes(event.index)) {
      const plain = { ...arm.plain, instructions: toldInstructions(arm.plain.instructions, told) };
      snapshots[event.index] = { plain, hash: sha({ plain, room: arm.hash }) };
    }
  }
  const count = (kind: string) => ({ planned: events.filter(e => e.kind === kind).length, received: events.filter(e => e.kind === kind && !missing.some(m => m.index === e.index)).length });
  return { arm: arm.name, planned: events.length, corrections: count('correction'), inputs: count('input'), missing, snapshots };
}

/** The treatment that a run at a checkpoint received, in words, for its page. Null without a treatment over time. */
function treatmentNote(plan: Plan, arm: any, checkpoint: number | null) {
  if (checkpoint === null) return null;
  const given = plan.events.filter((e: any) => e.index <= checkpoint);
  if (!given.length) return 'No treatment events before this run.';
  const how = arm.plain ? 'Told in its instructions, in this order' : 'Given to the Method through method judge, in this order';
  return [`${how}:`, ...given.map((e: any) => `${e.index}. ${e.kind === 'correction' ? `Correction on ${e.input.id}: ${e.text}` : `New input: ${e.input.id}`}`)].join('\n');
}

/** What an arm received, as the account keeps it: the models its runs used, and one line per kind of thing. */
function receivedOf(arm: string, runs: any[], planned: number, t: ArmTreatment | undefined, plan: Plan) {
  const own = runs.filter(r => r.arm === arm);
  const lines = [{ what: 'Inputs run', received: own.length, planned, missing: [] as string[] }];
  const missingText = (m: { index: number; reason: string }) => {
    const event = plan.events.find((e: any) => e.index === m.index);
    return `Event ${m.index}${event?.text ? ` ("${event.text.length > 60 ? event.text.slice(0, 60) + '…' : event.text}")` : ` (input ${event?.input.id})`}: ${m.reason}.`.slice(0, 500);
  };
  if (t?.corrections.planned) lines.push({ what: 'Corrections received', ...t.corrections, missing: t.missing.filter(m => plan.events.find((e: any) => e.index === m.index)?.kind === 'correction').map(missingText) });
  if (t?.inputs.planned) lines.push({ what: 'New inputs received', ...t.inputs, missing: t.missing.filter(m => plan.events.find((e: any) => e.index === m.index)?.kind === 'input').map(missingText) });
  return { models: [...new Set(own.flatMap(r => r.models ?? []))].slice(0, 10), lines };
}
/** The received record as lines of text: "Model: … · Inputs run: 2 of 2 · Corrections received: 5 of 5", then what is missing. */
function receivedText(received: ReturnType<typeof receivedOf>) {
  return [...(received.models.length ? [`Model: ${received.models.join(', ')}.`] : []), ...received.lines.map(l => `${l.what}: ${l.received} of ${l.planned}.`), ...received.lines.flatMap(l => l.missing.map(m => `Missing ${m.charAt(0).toLowerCase()}${m.slice(1)}`))].join(' ');
}

/** The key of a run cell: its content (the arm as it was at that point, the input, the run number and the checkpoint). */
const runKey = (c: { arm: string; hash: string; input: { hash: string }; repeat: number; checkpoint: number | null }) => sha({ arm: c.arm, hash: c.hash, input: c.input.hash, repeat: c.repeat, checkpoint: c.checkpoint });
/** The grader: every measure, as the comparison defines it. A changed measure is a new grader, and every run is graded again. */
const graderVersion = (plan: Plan) => sha(plan.measures.map((m: any) => ({ name: m.name, code: m.code?.hash ?? null, rubric: m.rubric ?? null, person: m.person ?? null }))).slice(0, 16);
/**
 * The keys of the grade cells of these runs, by run key. A measure may read other runs of the same arm (a regression
 * measure reads the earlier checkpoints), so a grade key holds the hash of each run of that arm up to and including the
 * run's checkpoint, as it finished. When one of those runs again, every grade that could read it grades again.
 */
function gradeKeys(plan: Plan, list: Array<{ key: string; arm: string; checkpoint: number | null; input: string | { id: string } }>) {
  const finished = new Map(list.map(c => { try { return [c.key, sha(readFileSync(recordFile(plan.folder, c.key)))]; } catch { return [c.key, null]; } }));
  const grader = graderVersion(plan);
  return new Map(list.map(c => {
    const reads = list.filter(o => o.arm === c.arm && (o.checkpoint ?? 0) <= (c.checkpoint ?? 0)).map(o => [o.key, finished.get(o.key)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const input = typeof c.input === 'string' ? c.input : c.input.id;
    return [c.key, sha({ target: c.key, grader, expected: sha(plan.expected[input] ?? null), reads })];
  }));
}

/**
 * The folders that an arm works on for an input, by files connection: the arm's own (for a plain arm, those of the
 * Method arms), with each folder of the input's own folder in place of the one of its name. Both kinds of arm get the
 * same folders for an input, and nothing of another input's folder.
 */
function cellFolders(arm: any, input: { room: string | null }): Record<string, string> {
  const own = input.room ? Object.fromEntries(readdirSync(input.room, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => [e.name, join(input.room!, e.name)])) : {};
  return { ...arm.folders, ...own };
}

/** The cells of a stage: every arm × input × run × checkpoint (trial: the first inputs, once, at the first checkpoint). */
function cells(plan: Plan, treated: ArmTreatment[] | null, trial: boolean): Cell[] {
  const checkpoints: Array<number | null> = plan.checkpoints ? (trial ? [plan.checkpoints[0]] : plan.checkpoints) : [null];
  const inputs = trial ? plan.inputs.slice(0, plan.trial) : plan.inputs;
  const out: Cell[] = [];
  for (const arm of plan.arms) for (const checkpoint of checkpoints) {
    const snapshot: Snapshot | undefined = checkpoint === null ? (arm.plain ? { plain: arm.plain, hash: arm.hash } : { dir: arm.dir, file: arm.file, hash: arm.hash }) : treated?.find(t => t.arm === arm.name)?.snapshots[checkpoint];
    if (!snapshot) continue;
    for (const input of inputs) for (let repeat = 0; repeat < (trial ? 1 : plan.runs); repeat++) {
      const cell = { folder: plan.folder, arm: arm.name, ...snapshot, ...(arm.plain ? { method: arm.method } : {}), folders: cellFolders(arm, input), cache_dir: arm.cache_dir, input, repeat, checkpoint,
        trial: plan.inputs.slice(0, plan.trial).some((i: any) => i.id === input.id) && repeat === 0 && checkpoint === checkpoints[0], treatment_note: treatmentNote(plan, arm, checkpoint) };
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

/** The tools of a plain arm: the ones that Method's own Claude Code and Codex steps have, so tools are no difference. */
const plainTools = { claude: ['read', 'write', 'edit', 'search', 'web'], codex: ['shell', 'read', 'write', 'edit', 'search', 'web'] } as const;
/** The Method that runs a plain arm: one session step with the arm's instructions and the input, in its room. */
function plainMethod(agent: 'claude' | 'codex') {
  return {
    format: 'method/3.4', name: `Plain ${agent === 'claude' ? 'Claude Code' : 'Codex'}`, goal: 'Do the task in the instructions for the input, as a plain agent.',
    inputs: { instructions: { type: 'text' }, input: { type: 'text' }, room: { type: 'text', description: 'The folder with the files that the agent works on.' } },
    limits: { step: { timeout_ms: 3_600_000 } },
    steps: { work: { in: { instructions: 'inputs.instructions', input: 'inputs.input', room: 'inputs.room' }, out: 'session',
      do: { kind: 'session', agent, prompt: '{{instructions}}\n\n{{input}}', tools: [...plainTools[agent]], room: 'room' } } },
    result: 'session',
  };
}
const inputText = (value: unknown) => typeof value === 'string' ? value : `Input:\n${JSON.stringify(value, null, 2)}`;

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

/** Save the run of a cell in the account: the version of its Method, and the run's records as it runs. */
async function cellSync(folder: string, file: string) {
  const account = readAccount(folder);
  if (!account) return null;
  try {
    process.env.METHOD_CONFIG_DIR ??= account.config_dir;
    const { MethodClient } = await import('./method-client.js');
    const { Outbox } = await import('./outbox.js');
    const { prepareVersion } = await import('./versions.js');
    const { MethodSync } = await import('./method-sync.js');
    const client = new MethodClient(account.server), outbox = new Outbox(client);
    const version = await prepareVersion(client, outbox, file, 'Saved by a comparison.');
    return (runDir: string) => new MethodSync(client, runDir, version.method_id, version.version_id, undefined, readDocument(file).run_data === 'device', outbox);
  } catch (error) {
    process.stderr.write(`This run is not saved to your Method account: ${(error as Error).message}\n`);
    return null;
  }
}

/**
 * Run one cell: the arm on one input, with nothing reused, in its own folder. A Method arm runs with its own cache in a
 * clean room (armRoom) on its own copy of its bound folders, which the cell keeps in its folder. A plain arm runs as one
 * session, which makes its own clean room, in a copy of its room. Both write the same run records, with a transcript of
 * each agent attempt; the run is saved in the account and linked to its cell.
 */
async function runCell(cell: Cell) {
  process.env.METHOD_CACHE_DIR = cell.cache_dir;
  const runDir = join(cell.folder, 'runs', cell.arm, cell.key.slice(0, 16));
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const { runMethod } = await import('@withmethod/runtime/runner.js');
  const started = Date.now();
  const file = cell.plain ? cell.method! : join(cell.dir!, cell.file!);
  const syncFor = await cellSync(cell.folder, file);
  const sync = syncFor?.(join(runDir, 'run'));
  const hooks = {
    onStart: async ({ method, inputs }: any) => { await sync?.start(method, inputs, {}); },
    onEvent: async () => { sync?.snapshot(); },
  };
  let result: any;
  try {
    if (cell.plain) {
      // The session's room: a copy of each of the cell's folders, by its name. The session works on its own copy of it.
      const room = join(runDir, 'room');
      mkdirSync(room, { recursive: true, mode: 0o700 });
      for (const [envName, dir] of Object.entries(cell.folders)) cpSync(dir, join(room, envName), { recursive: true });
      const inputs = { instructions: cell.plain.instructions, input: inputText(cell.input.value), room };
      await sync?.start(readDocument(file), inputs, {}, false);
      try { result = await runMethod(file, { allow_local_processes: true }, { runDir: join(runDir, 'run'), inputs, fresh: true, ...hooks }); }
      finally { rmSync(room, { recursive: true, force: true }); }
      if (result.result) result.result = result.result.final_text;
    } else {
      const { preparedConfig } = await import('./quality.js');
      const { resolveSecrets } = await import('./secrets.js');
      const prepared = await preparedConfig(file, {});
      const secrets = resolveSecrets(Object.keys(readDocument(file).secrets ?? {}));
      await sync?.start(readDocument(file), cell.input.value as any, {}, false);
      const room = await armRoom(file, cell.cache_dir, false, cell.folders);
      // The cell's process runs the arm in the room: its agent steps and scripts get the room's environment.
      const outside = { ...process.env };
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, room.env);
      try {
        result = await runMethod(file, { ...prepared.config, environment: { ...prepared.config.environment, ...room.folders } }, {
          runDir: join(runDir, 'run'), inputs: cell.input.value as any, fresh: true, processPath: prepared.processPath, prepareBundle: prepared.prepareBundle,
          secrets, ...(prepared.hostedModels ? { hostedModels: prepared.hostedModels } : {}), ...(prepared.classification ? { classification: prepared.classification } : {}), ...hooks });
      } finally {
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, outside);
        // The cell keeps what the arm left in its folders, for the measures.
        for (const [envName, copy] of Object.entries(room.folders as Record<string, string>)) cpSync(copy, join(runDir, 'environment', envName), { recursive: true, verbatimSymlinks: true });
        await room.remove();
      }
    }
  } finally {
    await sync?.finish();
    await sync?.outbox.drain();
  }
  if (!['completed', 'unconfirmed'].includes(result.status))
    throw Error(`The arm ${cell.arm} ${result.status === 'needs_input' ? 'asked a question' : 'failed'} on the input ${cell.input.id} (run ${cell.repeat + 1}${pointLabel(cell.checkpoint)}): ${result.failure?.headline ?? result.status}. Its run folder: ${join(runDir, 'run')}. Fix the cause and run the comparison again; finished runs are reused.`);
  const transcript = writeTranscripts(join(runDir, 'run', 'artifacts'), runDir);
  let runId: string | null = null;
  try { runId = JSON.parse(readFileSync(join(runDir, 'run', 'method-sync.json'), 'utf8')).id; } catch { /* not saved in the account */ }
  const record = { key: cell.key, arm: cell.arm, input: cell.input.id, repeat: cell.repeat, checkpoint: cell.checkpoint, trial: cell.trial, result: result.result ?? null,
    run_dir: join(runDir, 'run'), artifacts: join(runDir, 'run', 'artifacts'), transcript: transcript?.markdown ?? null, transcript_jsonl: transcript?.jsonl ?? null,
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

/** The summary of the trial for the approval question, or an error that names what an arm did not receive. */
async function trialCheck(plan: Plan, runs: any[], treated: ArmTreatment[] | null) {
  const lines: string[] = [], short: string[] = [];
  const trialInputs = plan.inputs.slice(0, plan.trial).length;
  const received: Record<string, ReturnType<typeof receivedOf>> = {};
  for (const arm of plan.arms) {
    const t = treated?.find(x => x.arm === arm.name);
    received[arm.name] = receivedOf(arm.name, runs, trialInputs, t, plan);
    const line = `${arm.name}: ${receivedText(received[arm.name]!)}`;
    lines.push(line);
    if (runs.filter(r => r.arm === arm.name).length < trialInputs || (t && t.missing.length)) short.push(line);
  }
  const fullCells = plan.arms.length * plan.inputs.length * plan.runs * (plan.checkpoints?.length ?? 1) - runs.length;
  const mean = runs.reduce((sum, r) => sum + r.duration_ms, 0) / Math.max(runs.length, 1);
  const deliveries = treated ? plan.events.length - trialEvents(plan) : 0;
  const deliveryMs = treated ? meanDelivery(plan) : 0;
  const minutes = Math.round((fullCells * mean / 4 + deliveries * deliveryMs) / 60_000);
  const costs = runs.map(r => r.cost_usd);
  const usd = runs.length && costs.every(c => typeof c === 'number') ? (costs.reduce((a, b) => a + b, 0) / runs.length) * fullCells : null;
  await sendStage(plan.folder, { stage: 'trial', trial: { inputs: trialInputs, received }, cost_estimate: { minutes, runs: fullCells, usd } });
  if (short.length) throw Error(`The trial stopped: an arm did not receive everything.\n${short.join('\n')}\nFix the cause and run the comparison again; everything that was received is kept.`);
  const cost = usd !== null ? `about $${usd.toFixed(2)} at API prices` : 'not known: the trial runs reported no price (a run on your own Claude Code or Codex subscription reports none)';
  return [`Trial of "${plan.question}"`, '', 'What each arm received:', ...lines.map(l => `  ${l}`), '', 'The trial runs (each folder holds the run\'s records; each transcript reads as a conversation):',
    ...runs.flatMap(r => [`  ${r.arm}, input ${r.input}: ${r.run_dir}`, ...(r.transcript ? [`    transcript: ${r.transcript}`] : [])]), '',
    !fullCells && !deliveries ? 'The full run: nothing more to run; the trial ran every cell.'
      : `The full run: ${plural(fullCells, 'more run')}${deliveries ? ` and ${plural(deliveries, 'more treatment event')} per arm` : ''}. Time: ${minutes ? `about ${plural(minutes, 'minute')}` : 'under a minute'} (about ${Math.round(mean / 1000)} s per run, 4 at a time${deliveries ? `, and about ${Math.round(deliveryMs / 1000)} s per treatment event, the arms at the same time` : ''}). Cost: ${cost}.`].join('\n');
}
/** The trial gives the events before the first checkpoint after 0 (none when every checkpoint is 0). */
const trialEvents = (plan: Plan) => plan.checkpoints.find((c: number) => c > 0) ?? 0;
/** The mean time that the trial's treatment events took, from the arms' records. */
function meanDelivery(plan: Plan) {
  const times: number[] = [];
  for (const arm of plan.arms) {
    try { for (const line of readFileSync(join(plan.folder, 'arms', arm.name, `treatment-${arm.hash.slice(0, 12)}`, 'treatment.jsonl'), 'utf8').split('\n').filter(Boolean)) times.push(JSON.parse(line).duration_ms ?? 0); } catch { /* none */ }
  }
  return times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
}

/** The person said go: keep it for this version of the file, and tell the account (this locks the file there). */
async function recordApproval(plan: Plan) {
  const digest = JSON.parse(readFileSync(join(plan.folder, 'spec.json'), 'utf8')).spec_digest;
  writePrivateJson(approvalFile(plan.folder), { spec_digest: digest, at: new Date().toISOString() });
  await sendStage(plan.folder, { stage: 'running' });
}

/** The key of a person's mark: the measure's question and the output it marks. */
const markKey = (measure: any, run: any) => sha({ question: measure.person, output: run.result });
const outputText = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);

/**
 * What a grader sees of a run, in order: the first prompt, then each file that the agent read and each tool result.
 * Each part is cut at 20,000 characters, and the whole at 150,000.
 */
export function seenContext(entries: any[]) {
  const cut = (text: string) => text.length > 20_000 ? `${text.slice(0, 20_000)}\n[... ${text.length - 20_000} more characters]` : text;
  const prompt = entries.find(e => e.kind === 'prompt');
  const parts = prompt ? [`The first prompt:\n${cut(prompt.text)}`] : [];
  for (const e of entries) {
    if (e.role !== 'tool') continue;
    parts.push(`${e.path ? `The file ${e.path}, as the agent read it` : `The result of ${e.tool ?? 'a tool'}`}${e.kind === 'error' ? ' (an error)' : ''}:\n${cut(e.text)}`);
  }
  const text = parts.join('\n\n');
  return text.length > 150_000 ? `${text.slice(0, 150_000)}\n[... the rest is left out]` : text;
}
const words = (text: string) => text.replace(/^\s*\d+[.)]\s+/gm, ' ').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
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

/** Grade one run on every measure. A rubric gives the grader's verdicts, each at the transcript line it judged. */
async function grade(item: any) {
  const { run, measures, expected, marks } = item;
  const scores: Record<string, number> = {}, verdicts: any[] = [];
  let seen: string | null = null;
  const entries = run.transcript_jsonl && existsSync(run.transcript_jsonl)
    ? readFileSync(run.transcript_jsonl, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  for (const m of measures) {
    if (m.person !== undefined) { scores[m.name] = marks[m.name]; continue; }
    if (m.code) { scores[m.name] = await codeScore(m, run, expected); continue; }
    const graded = await rubricGrade(m, run, expected, item.method, entries);
    scores[m.name] = graded.score;
    verdicts.push(...graded.verdicts);
    seen = graded.seen;
  }
  const record = { key: item.key, target: run.key, grader_version: item.grader_version, arm: run.arm, input: run.input, repeat: run.repeat, checkpoint: run.checkpoint,
    run_dir: run.run_dir, scores, verdicts, seen, run_id: run.run_id, device: run.device };
  writeRecord(item.folder, item.key, record);
  await linkGrade(item.folder, record);
  return record;
}
/** Link a grade cell with its numbers; its verdicts and what the grader saw go where the run keeps its content. */
async function linkGrade(folder: string, record: any) {
  const account = readAccount(folder);
  if (!account || !record.run_id) return;
  const measures = Object.fromEntries(Object.entries(record.scores).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)));
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
  const isPython = extname(m.code.path) === '.py';
  const input = JSON.stringify({ input: run.input, output: run.result, expected: expected ?? null, run_dir: run.run_dir, artifacts: run.artifacts });
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>(done => {
    const child = spawn(isPython ? 'python3' : process.execPath, [m.code.path], { cwd: dirname(m.code.path), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.on('error', error => done({ code: 1, stdout, stderr: error.message }));
    child.on('close', code => done({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
  let score: unknown;
  try { const value = JSON.parse(result.stdout); score = typeof value === 'number' ? value : value?.score; } catch { /* below */ }
  if (result.code !== 0 || typeof score !== 'number' || !Number.isFinite(score))
    throw Error(`The measure ${m.name} (${basename(m.code.path)}) gave no score for ${run.arm} on ${run.input}${result.stderr.trim() ? `: ${result.stderr.trim().split('\n').at(-1)}` : `; it must print {"score": NUMBER}`}.`);
  return score;
}
/**
 * A rubric grade: the judges read what the agent saw (seenContext) and the expected answer, and judge the run's output
 * against each sentence. The score is the share of sentences met. Each verdict: met (every vote passes), not met (none
 * does), or partly (the votes or the judges differ), with the quote that decides it and its transcript line.
 */
async function rubricGrade(m: any, run: any, expected: unknown, methodFile: string, entries: any[]) {
  const context = [entries.length ? seenContext(entries) : '', expected !== undefined ? `The expected answer:\n${outputText(expected)}` : ''].filter(Boolean).join('\n\n');
  const value = outputText(run.result);
  const { preparedConfig, judgeProfiles } = await import('./quality.js');
  const { judgeRubric } = await import('@withmethod/runtime/rubric.js');
  const prepared = await preparedConfig(methodFile, {}, { judge: true });
  const judges = await judgeProfiles(prepared.config);
  const detail: any = await judgeRubric({ value, criteria: m.rubric.map((text: string, i: number) => ({ id: `c${i + 1}`, text })), context, config: prepared.config,
    options: { runOptions: { processPath: prepared.processPath, ...(prepared.hostedModels ? { hostedModels: prepared.hostedModels } : {}) }, ...(judges.length > 1 ? { judges } : {}) } });
  const verdicts = detail.criteria.map((c: any) => {
    const votes: any[] = c.votes ?? [];
    const verdict = c.unsure ? 'partly' : c.pass ? 'met' : votes.some(v => v.pass) ? 'partly' : 'not_met';
    const quote = (votes.find(v => v.pass === (verdict === 'met') && v.quote?.trim()) ?? votes.find(v => v.quote?.trim()))?.quote?.trim() || null;
    const line = quoteLine(entries, quote);
    return { criterion: c.text, verdict, quote: quote ? quote.slice(0, 4000) : null, line };
  });
  return { score: detail.criteria.filter((c: any) => c.pass).length / detail.criteria.length, verdicts,
    seen: `${context ? `${context}\n\n` : ''}The output that the grader judged:\n${value}` };
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const fixed = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(2);

/** Apply the decision rule to the grades: the answer, the reason, the decision as the account keeps it, and the result text. */
export function decide(plan: Plan, grades: any[], treated: ArmTreatment[] | null, runs: any[] = []) {
  const main = plan.measures.find((m: any) => m.main);
  const points: Array<number | null> = plan.checkpoints ?? [null];
  const at: number | null = plan.rule.at ?? null;
  const point = (arm: string, checkpoint: number | null, measure: string) => {
    const own = grades.filter(g => g.arm === arm && g.checkpoint === checkpoint);
    const n = Math.min(...plan.inputs.map((input: any) => own.filter(g => g.input === input.id).length));
    return { n, mean: own.length ? mean(own.map(g => g.scores[measure])) : null };
  };
  const reasons: string[] = [];
  const short = (treated ?? []).filter(t => t.missing.length);
  const planned = plan.inputs.length * plan.runs * points.length;
  const received = Object.fromEntries(plan.arms.map((arm: any) => [arm.name, receivedOf(arm.name, grades, planned, treated?.find(x => x.arm === arm.name), plan)]));
  for (const arm of plan.arms) received[arm.name]!.models = [...new Set(runs.filter(r => r.arm === arm.name).flatMap(r => r.models ?? []))].slice(0, 10);
  for (const t of short) reasons.push(`${t.arm} did not receive its full treatment (${receivedText(received[t.arm]!)})`);
  const allN = plan.arms.flatMap((arm: any) => points.map(c => point(arm.name, c, main.name).n));
  const fewest = Math.min(...allN);
  if (!short.length && fewest < plan.rule.min_runs) reasons.push(`${fewest === 0 ? 'a point has no runs' : `each point has ${plural(fewest, 'run')}`}, and the rule needs ${plan.rule.min_runs}`);
  let answer = "Can't tell yet", reason = '', better: string | undefined;
  if (reasons.length) reason = reasons[0]!;
  else {
    const ranked = plan.arms.map((arm: any) => ({ arm: arm.name, mean: point(arm.name, at, main.name).mean! })).sort((a: any, b: any) => b.mean - a.mean);
    const [best, next] = [ranked[0], ranked[1]];
    const lead = best.mean - next.mean;
    if (lead < plan.rule.margin) reason = `${best.arm} is ahead of ${next.arm} by ${fixed(lead)} on ${main.name}, and the rule needs ${plan.rule.margin}`;
    else {
      const guard = plan.rule.guard;
      // The guard: at the point that decides, the winner's guard measure against the best of the other arms'.
      const rival = guard ? plan.arms.filter((a: any) => a.name !== best.arm).map((a: any) => ({ arm: a.name, mean: point(a.name, at, guard.measure).mean! })).sort((a: any, b: any) => b.mean - a.mean)[0] : null;
      const below = guard ? rival.mean - point(best.arm, at, guard.measure).mean! : 0;
      if (guard && below > guard.max_drop) reason = `${best.arm} is ahead on ${main.name}, but its ${guard.measure} is ${fixed(below)} below ${rival.arm}'s${pointLabel(at)}, and the rule allows ${guard.max_drop}`;
      else { answer = `${best.arm} is better`; better = best.arm; reason = `${best.arm} is ahead of ${next.arm} by ${fixed(lead)} on ${main.name}${pointLabel(at)}, and the rule needs ${plan.rule.margin}`; }
    }
  }
  const lines = [`${answer}: ${reason}.`, '', `Question: ${plan.question}`, `Difference: ${plan.difference}`, ...plan.other_differences.map((d: string) => `Other difference: ${d}`),
    `Rule: ${plan.rule_sentence}`, '', 'What each arm received:'];
  for (const arm of plan.arms) {
    const ran = grades.filter(g => g.arm === arm.name).length;
    const t = treated?.find(x => x.arm === arm.name);
    const full = ran === planned && !t?.missing.length;
    lines.push(`  ${full ? '' : 'SHORT '}${arm.name}: ${receivedText(received[arm.name]!)}`);
  }
  for (const m of plan.measures) {
    lines.push('', `${m.main ? 'Main measure' : 'Also shown'}: ${m.name} (mean per run; n = runs per input behind the point)`);
    for (const arm of plan.arms) lines.push(`  ${arm.name}: ${points.map(c => { const p = point(arm.name, c, m.name); return `${c === null ? '' : `after ${c}: `}${p.mean === null ? 'no runs' : fixed(p.mean)} (n=${p.n})`; }).join('; ')}`);
  }
  lines.push('', 'Assumptions:');
  if (treated) lines.push(`  Each arm received its full treatment: checked by Method: ${short.length ? 'no' : 'yes'}.`);
  lines.push(`  Each point has at least ${plural(plan.rule.min_runs, 'run')} per input: checked by Method: ${fewest >= plan.rule.min_runs ? 'yes' : 'no'}.`);
  for (const a of plan.assumptions) lines.push(`  ${a}: not checked.`);
  const decision = { answer: better ? 'better' : 'cant_tell', ...(better ? { arm: better } : {}), reason: `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`.slice(0, 500),
    values: Object.fromEntries(plan.arms.map((arm: any) => { const p = point(arm.name, at, main.name); return [arm.name, { value: p.mean, n: p.n }]; })) };
  return { answer, reason, text: lines.join('\n'), decision, received };
}

/** `method __compare STAGE`: one stage of a comparison, run by the generated Method's stage script. */
export async function compareStage(stage: string, bindings: any): Promise<Record<string, unknown>> {
  const plan = bindings.comparison ? JSON.parse(bindings.comparison) : undefined;
  const treated: ArmTreatment[] | null = bindings.treated ? JSON.parse(bindings.treated) : null;
  const runsOf = (list: string[] = []) => list.map(r => JSON.parse(r));
  const reported = { state: { reported: new Date().toISOString() } };
  if (stage === 'trial_treat' || stage === 'treat') {
    if (stage === 'treat') { if (bindings.go !== true) throw Error('The full run was not approved.'); await recordApproval(plan); }
    const value = JSON.stringify(await treat(plan, stage === 'treat' ? plan.events.length : trialEvents(plan)));
    return { [stage === 'treat' ? 'treatment' : 'trial_treatment']: value, state: { treatment: value } };
  }
  if (stage === 'trial_plan') {
    const list = cells(plan, treated, true), { run, done } = await split(plan, list, list);
    return { trial_cells: run.map(c => JSON.stringify(c)), trial_done: done.map(r => JSON.stringify(r)), ...reported };
  }
  if (stage === 'trial_cell') return { trial_run: JSON.stringify(await runCell(JSON.parse(bindings.cell))) };
  if (stage === 'cell') return { full_run: JSON.stringify(await runCell(JSON.parse(bindings.cell))) };
  if (stage === 'check') return { trial_summary: await trialCheck(plan, [...runsOf(bindings.runs), ...runsOf(bindings.done)], treated), ...reported };
  if (stage === 'approved') return { go: true };
  if (stage === 'plan') {
    if (bindings.go !== true) throw Error('The full run was not approved.');
    await recordApproval(plan);
    const all = cells(plan, treated, false), { run, done } = await split(plan, all, all);
    return { cells: run.map(c => JSON.stringify(c)), done: done.map(r => JSON.stringify(r)), ...reported };
  }
  // Every finished run, once: the trial's, the full run's, and those that earlier runs finished.
  const all = () => [...new Map([...runsOf(bindings.trial_runs), ...runsOf(bindings.trial_done), ...runsOf(bindings.full_runs), ...runsOf(bindings.done_runs)].map(r => [r.key, r])).values()];
  if (stage === 'to_mark') {
    const marks = JSON.parse(bindings.marks || '{}'), questions: string[] = [], keys: string[] = [];
    let n = 0;
    for (const m of plan.measures.filter((m: any) => m.person !== undefined)) for (const run of all()) {
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
    const measures = plan.measures;
    const method = join(plan.folder, 'comparison.method');
    // The grade keys hold the runs as they finished: the account gets the plan with them before the grades link.
    const planned = cells(plan, treated, false), runs = all();
    await sendPlan(plan.folder, plannedCells(plan, planned));
    const keys = gradeKeys(plan, [...planned, ...runs.filter(run => !planned.some(c => c.key === run.key))]);
    return { graded: runs.map(run => JSON.stringify({ key: keys.get(run.key), grader_version: graderVersion(plan), folder: plan.folder,
      run, measures, method, expected: plan.expected[run.input],
      marks: Object.fromEntries(measures.filter((m: any) => m.person !== undefined).map((m: any) => [m.name, marks[markKey(m, run)]])) })) };
  }
  if (stage === 'grade') return { grade: JSON.stringify(await grade(JSON.parse(bindings.item))) };
  if (stage === 'decide') {
    const grades = runsOf(bindings.grades), runs = all();
    const result = decide(plan, grades, treated, runs);
    // The account gets every finished cell that it lacks, then the decision.
    const missing = await sendPlan(plan.folder, plannedCells(plan, cells(plan, treated, false)));
    if (missing) {
      for (const run of runs) if (missing.has(run.key)) await linkRun(plan.folder, run);
      for (const g of grades) if (missing.has(g.key)) await linkGrade(plan.folder, g);
    }
    const minutes = Math.round(runs.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0) / 60_000);
    const usd = runs.length && runs.every(r => typeof r.cost_usd === 'number') ? runs.reduce((sum, r) => sum + r.cost_usd, 0) : null;
    await sendStage(plan.folder, { stage: 'done', decision: result.decision, received: result.received, cost_estimate: { minutes, runs: runs.length, usd } });
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
