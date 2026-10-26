/**
 * Comparisons: a NAME.compare file asks one question about two or more agents. `method run NAME.compare` checks the
 * file, compiles it into a generated Method (as requestMethod does for a model request) and runs that Method. Its
 * steps are the stages: trial, treatment check, approval (an ask step), full run, grades, decision. Each cell (arm ×
 * input × run × checkpoint) is one iteration of an each step, so the runtime's step cache reuses every finished cell
 * on a rerun, and a changed measure regrades without running any agent again.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod/v4';
import { loadWorkflow, parseDocumentValue } from '../../workflow-language/src/validate.js';
import { authoringPath, readDocument } from './authoring.js';
import { methodContent, methodIdPattern, newMethodId, writeMethodId } from './versions.js';
import { packageFileNames } from './method-files.js';
import { writePrivateJson } from './files.js';

// ---------------------------------------------------------------------------------------------------------------
// The file

const text = z.string().trim().min(1);
const name = z.string().regex(/^[a-z][a-z0-9_]*$/, 'Use lowercase letters, digits and underscores, starting with a letter.');
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
  question: text.describe('One sentence in your words.'),
  arms: z.record(name, armSchema).describe('Each agent under test, by a short name.'),
  difference: text.describe('The one thing that is different between the arms.'),
  other_differences: z.array(text).optional().describe('Any other difference between the arms.'),
  inputs: z.array(text).min(1).describe('The inputs that each arm runs: case IDs (folders in cases/ beside this file) or JSON files of input values. The same for each arm.'),
  measure: measureSchema.describe('The main measure: one number per run that decides.'),
  rule: z.strictObject({
    margin: z.number().describe('How far ahead an arm must be on the main measure (the mean per run). Above 0.'),
    min_runs: z.number().int().min(1).describe('The fewest runs per input behind each point.'),
    at: z.number().int().min(0).optional().describe('The checkpoint that decides, when there is a treatment over time.'),
    guard: z.strictObject({ measure: text, max_drop: z.number().min(0) }).optional().describe('Another measure that must not drop by more than max_drop.'),
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
  const ids = new Map<string, string>();
  for (const [armName, arm] of arms) {
    if (!armIsMethod(arm)) { if (!existsSync(resolve(root, arm.instructions))) problems.push(`The instructions of the arm ${armName} (${arm.instructions}) are not there.`); continue; }
    const armFile = resolve(root, arm);
    if (!/\.method$/i.test(arm)) { problems.push(`The arm ${armName} must be a .method file, or {agent: claude|codex, instructions: FILE}.`); continue; }
    if (!existsSync(armFile)) { problems.push(`The Method file of the arm ${armName} (${arm}) is not there.`); continue; }
    let document: any;
    try { document = readDocument(armFile); loadWorkflow(methodContent(document)); } catch (error) { problems.push(`The Method of the arm ${armName} does not load: ${(error as Error).message}`); continue; }
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

/** The rule as a sentence, as the result shows it. */
export function ruleSentence(doc: Comparison) {
  const { margin, min_runs, at, guard } = doc.rule;
  const point = at !== undefined ? ` after ${plural(at, 'treatment event')}` : '';
  const guardText = guard ? (doc.treatment
    ? `, and its ${guard.measure} at that point is not more than ${guard.max_drop} below its ${guard.measure} at the first checkpoint`
    : `, and its ${guard.measure} is not more than ${guard.max_drop} below any other arm's`) : '';
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

/** The files of a folder, hashed, for an arm's content hash. The id: line of the Method is left out. */
function folderHash(dir: string, methodFile: string) {
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
  const workflow = loadWorkflow(methodContent(readDocument(source)));
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
  return { dir: method, file, id, hash: folderHash(method, file), environment: folders };
}

/** Marks that a person gave on earlier runs, by output and measure, so a rerun does not ask again. */
const marksFile = (folder: string) => join(folder, 'marks.json');
const readMarks = (folder: string): Record<string, number> => { try { return JSON.parse(readFileSync(marksFile(folder), 'utf8')); } catch { return {}; } };

/** Steps of the generated Method, by stage. All are scripts that run method __compare STAGE. */
function generatedMethod(doc: Comparison, previousId: string | undefined, counts: { cells: number }) {
  const treatment = !!doc.treatment, person = [doc.measure, ...(doc.other_measures ?? [])].some(m => m.person !== undefined);
  const stage = (name: string) => ({ kind: 'run', runtime: 'node', entrypoint: 'stage.mjs', args: [name] });
  const list = { type: 'list', items: { type: 'text' } };
  const treated = treatment ? { treated: 'treatment' } : {};
  const steps: Record<string, any> = {};
  if (treatment) steps.trial_treat = { name: 'Trial treatment', purpose: 'Gives each arm the treatment events before the first checkpoint and records what it received.', in: { comparison: 'inputs.comparison' }, do: stage('trial_treat'), changes: ['state.treatment'], out: { trial_treatment: { type: 'text' } } };
  steps.trial_plan = { name: 'Trial plan', purpose: 'Lists the trial runs: each arm on the first inputs, once.', in: { comparison: 'inputs.comparison', ...(treatment ? { treated: 'trial_treatment' } : {}) }, do: stage('trial_plan'), out: { trial_cells: list } };
  steps.trial = { name: 'Trial', purpose: 'Runs each trial cell.', each: { cell: 'trial_cells' }, concurrency: 4, do: stage('trial_cell'), out: { trial_run: { type: 'text' } } };
  steps.trial_check = { name: 'Treatment check', purpose: 'Says what each arm received, and stops when an arm did not receive everything. Estimates the full run from the trial.', in: { comparison: 'inputs.comparison', runs: 'trial_run', ...(treatment ? { treated: 'trial_treatment' } : {}) }, do: stage('check'), out: { trial_summary: { type: 'text' } } };
  steps.approve = { name: 'Approval', purpose: 'The person reads the trial and says go.', in: { summary: 'trial_summary' }, ask: '{{summary}}\n\nStart the full run? Answer go: true to start it, or go: false to stop.', out: { go: { type: 'boolean', description: 'true to start the full run.' } } };
  if (treatment) steps.treat = { name: 'Treatment', purpose: 'Gives each arm every treatment event in order, freezes a copy at each checkpoint, and records what it received.', in: { comparison: 'inputs.comparison', go: 'go' }, do: stage('treat'), changes: ['state.treatment'], out: { treatment: { type: 'text' } } };
  steps.plan = { name: 'Plan', purpose: 'Lists every cell of the full run that the trial did not already run.', in: { comparison: 'inputs.comparison', go: 'go', ...treated }, do: stage('plan'), out: { cells: list } };
  steps.cells = { name: 'Full run', purpose: 'Runs each cell: one arm on one input, once, at one checkpoint.', each: { cell: 'cells' }, concurrency: 4, do: stage('cell'), out: { full_run: { type: 'text' } } };
  const runs = { trial_runs: 'trial_run', full_runs: 'full_run' };
  if (person) {
    steps.to_mark = { name: 'Outputs to mark', purpose: 'Lists the outputs that a person has not marked yet.', in: { comparison: 'inputs.comparison', marks: 'inputs.marks', ...runs }, do: stage('to_mark'), out: { mark_questions: list, mark_keys: list } };
    steps.mark = { name: 'Person marks', purpose: 'A person marks each output with a number.', each: { question: 'mark_questions' }, ask: '{{question}}', out: { mark: { type: 'number', description: 'The number for this output.' } } };
  }
  steps.gather = { name: 'Gather', purpose: 'Lists every run with the measures that grade it.', in: { comparison: 'inputs.comparison', marks: 'inputs.marks', ...runs, ...(person ? { mark_keys: 'mark_keys', marks_given: 'mark' } : {}) }, do: stage('gather'), out: { graded: list } };
  steps.grade = { name: 'Grade', purpose: 'Gives each run its number on each measure.', each: { item: 'graded' }, concurrency: 4, do: stage('grade'), out: { grade: { type: 'text' } } };
  steps.decide = { name: 'Decide', purpose: 'Applies the decision rule and writes the result.', in: { comparison: 'inputs.comparison', grades: 'grade', ...treated }, do: stage('decide'), out: { answer: { type: 'text', description: 'The answer, the rule as a sentence, what each arm received, and n per point.' } } };
  const most = 2_147_483_647;
  return {
    format: 'method/3.4', ...(previousId ? { id: previousId } : {}),
    name: `Comparison: ${doc.question}`.slice(0, 200), goal: doc.question,
    inputs: { comparison: { type: 'text', description: 'The checked comparison, as JSON.' }, marks: { type: 'text', description: 'Marks that a person gave earlier, as JSON.' } },
    ...(treatment ? { state: { treatment: { type: 'text', description: 'What each arm received so far.', default: '' } } } : {}),
    limits: { timeout_ms: most, max_invocations: 3 * counts.cells + 100, step: { timeout_ms: most } },
    steps, result: 'answer',
  };
}

/**
 * Check a .compare file and write its generated Method, the stage script and the inputs into the comparison folder.
 * Plain Claude Code or Codex arms and model events need the runtime's session step, which Method does not have yet.
 */
export async function compileComparison(file: string) {
  const path = authoringPath(file), root = dirname(path);
  const doc = readComparison(path);
  const plain = Object.entries(doc.arms).filter(([, arm]) => !armIsMethod(arm)).map(([armName]) => armName);
  if (plain.length) throw Error(`The arm${plain.length === 1 ? '' : 's'} ${plain.join(', ')} ${plain.length === 1 ? 'is' : 'are'} plain Claude Code or Codex. A comparison cannot run a plain agent yet: that needs the session step in Method's runtime, which is not built yet. Only Method arms run today.`);
  if (doc.treatment?.events.some(event => event.model !== undefined)) throw Error('A treatment event that changes the model cannot run yet: that is not built yet. Corrections and new inputs run today.');
  const folder = comparisonFolder(path);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const arms = [];
  for (const [armName, arm] of Object.entries(doc.arms)) {
    const copied = await copyArm(resolve(root, arm as string), join(folder, 'arms', armName));
    arms.push({ name: armName, ...copied, cache_dir: join(folder, 'arms', armName, 'cache') });
  }
  const resolveInput = (id: string) => { const value = inputValue(root, id); return { id, value, hash: sha(value) }; };
  const measure = (m: Comparison['measure'], main: boolean) => ({ name: m.name, main,
    ...(m.code ? { code: { path: resolve(root, m.code), hash: sha(readFileSync(resolve(root, m.code))) } } : {}),
    ...(m.rubric ? { rubric: m.rubric } : {}), ...(m.person ? { person: m.person } : {}) });
  const expectedValue = (p: string) => { const raw = readFileSync(resolve(root, p), 'utf8'); try { return JSON.parse(raw); } catch { return raw; } };
  const plan = {
    file: path, folder, question: doc.question, difference: doc.difference, other_differences: doc.other_differences ?? [],
    arms, inputs: doc.inputs.map(resolveInput),
    events: (doc.treatment?.events ?? []).map((event, i) => ({ index: i + 1, kind: event.correction !== undefined ? 'correction' : 'input', ...(event.correction ? { text: event.correction } : {}), input: resolveInput(event.input!) })),
    checkpoints: doc.treatment ? [...doc.treatment.checkpoints].sort((a, b) => a - b) : null,
    measures: [measure(doc.measure, true), ...(doc.other_measures ?? []).map(m => measure(m, false))],
    expected: Object.fromEntries(Object.entries(doc.expected ?? {}).map(([id, p]) => [id, expectedValue(p)])),
    rule: doc.rule, rule_sentence: ruleSentence(doc), runs: doc.runs, trial: Math.min(doc.trial ?? 2, doc.inputs.length),
    assumptions: doc.assumptions ?? [], compare_root: root,
  };
  const methodPath = join(folder, 'comparison.method');
  let previousId: string | undefined;
  try { const old = JSON.parse(readFileSync(methodPath, 'utf8')).id; if (typeof old === 'string' && methodIdPattern.test(old)) previousId = old; } catch { /* first run */ }
  const cells = arms.length * doc.inputs.length * doc.runs * (plan.checkpoints?.length ?? 1);
  writeFileSync(join(folder, 'stage.mjs'), stageScript, { mode: 0o600 });
  writeFileSync(methodPath, JSON.stringify(generatedMethod(doc, previousId, { cells }), null, 2) + '\n', { mode: 0o600 });
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
type Cell = { folder: string; arm: string; dir: string; file: string; hash: string; cache_dir: string; environment: Record<string, string>; input: { id: string; value: unknown; hash: string }; repeat: number; checkpoint: number | null };
const pointLabel = (checkpoint: number | null) => checkpoint === null ? '' : ` after ${plural(checkpoint, 'event')}`;

/** Treatment of one arm: what it received so far, and the frozen copy of the arm at each checkpoint it reached. */
type ArmTreatment = { arm: string; planned: number; corrections: { planned: number; received: number }; inputs: { planned: number; received: number };
  missing: Array<{ index: number; reason: string }>; snapshots: Record<string, { dir: string; file: string; hash: string }> };

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
    const env = { ...process.env, METHOD_CACHE_DIR: cacheDir };
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
  },
};
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

/** The lines that say what an arm received of its treatment. */
function receivedLines(t: ArmTreatment, plan: Plan) {
  const parts = [];
  if (t.corrections.planned) parts.push(`Corrections received: ${t.corrections.received} of ${t.corrections.planned}.`);
  if (t.inputs.planned) parts.push(`New inputs received: ${t.inputs.received} of ${t.inputs.planned}.`);
  for (const m of t.missing) {
    const event = plan.events.find((e: any) => e.index === m.index);
    parts.push(`Missing event ${m.index}${event?.text ? ` ("${event.text.length > 60 ? event.text.slice(0, 60) + '…' : event.text}")` : ` (input ${event?.input.id})`}: ${m.reason}.`);
  }
  return parts.join(' ');
}

/** The cells of a stage: every arm × input × run × checkpoint (trial: the first inputs, once, at the first checkpoint). */
function cells(plan: Plan, treated: ArmTreatment[] | null, trial: boolean): Cell[] {
  const checkpoints: Array<number | null> = plan.checkpoints ? (trial ? [plan.checkpoints[0]] : plan.checkpoints) : [null];
  const inputs = trial ? plan.inputs.slice(0, plan.trial) : plan.inputs;
  const out: Cell[] = [];
  for (const arm of plan.arms) for (const checkpoint of checkpoints) {
    const snapshot = checkpoint === null ? { dir: arm.dir, file: arm.file, hash: arm.hash } : treated?.find(t => t.arm === arm.name)?.snapshots[checkpoint];
    if (!snapshot) continue;
    for (const input of inputs) for (let repeat = 0; repeat < (trial ? 1 : plan.runs); repeat++)
      out.push({ folder: plan.folder, arm: arm.name, ...snapshot, cache_dir: arm.cache_dir, environment: arm.environment, input, repeat, checkpoint });
  }
  return out;
}
const cellId = (c: { arm: string; input: { id: string } | string; repeat: number; checkpoint: number | null }) => JSON.stringify([c.arm, typeof c.input === 'string' ? c.input : c.input.id, c.repeat, c.checkpoint]);

/** Run one cell: the arm's Method on one input, with nothing reused, in its own folder and with its own cache. */
async function runCell(cell: Cell) {
  process.env.METHOD_CACHE_DIR = cell.cache_dir;
  const runDir = join(cell.folder, 'runs', cell.arm, sha(cell).slice(0, 16));
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const file = join(cell.dir, cell.file);
  const { preparedConfig } = await import('./quality.js');
  const { runMethod } = await import('@withmethod/runtime/runner.js');
  const { resolveSecrets } = await import('./secrets.js');
  const prepared = await preparedConfig(file, {});
  // Each cell works on its own copy of the folders that the arm reads and writes.
  const environment: Record<string, string> = { ...prepared.config.environment };
  for (const [envName, source] of Object.entries(cell.environment)) { const copy = join(runDir, 'environment', envName); cpSync(source, copy, { recursive: true }); environment[envName] = copy; }
  const started = Date.now();
  const result: any = await runMethod(file, { ...prepared.config, ...(Object.keys(environment).length ? { environment } : {}) }, {
    runDir: join(runDir, 'run'), inputs: cell.input.value as any, fresh: true, processPath: prepared.processPath, prepareBundle: prepared.prepareBundle,
    secrets: resolveSecrets(Object.keys(readDocument(file).secrets ?? {})), ...(prepared.hostedModels ? { hostedModels: prepared.hostedModels } : {}), ...(prepared.classification ? { classification: prepared.classification } : {}) });
  if (!['completed', 'unconfirmed'].includes(result.status))
    throw Error(`The arm ${cell.arm} ${result.status === 'needs_input' ? 'asked a question' : 'failed'} on the input ${cell.input.id} (run ${cell.repeat + 1}${pointLabel(cell.checkpoint)}): ${result.failure?.headline ?? result.status}. Its run folder: ${join(runDir, 'run')}. Fix the cause and run the comparison again; finished runs are reused.`);
  return { arm: cell.arm, input: cell.input.id, repeat: cell.repeat, checkpoint: cell.checkpoint, result: result.result ?? null, run_dir: join(runDir, 'run'),
    artifacts: join(runDir, 'run', 'artifacts'), duration_ms: Date.now() - started, cost_usd: typeof result.usage?.cost_usd === 'number' ? result.usage.cost_usd : null };
}

/** The summary of the trial for the approval question, or an error that names what an arm did not receive. */
function trialCheck(plan: Plan, runs: any[], treated: ArmTreatment[] | null) {
  const lines: string[] = [], short: string[] = [];
  const trialInputs = plan.inputs.slice(0, plan.trial).length;
  for (const arm of plan.arms) {
    const ran = runs.filter(r => r.arm === arm.name).length;
    const t = treated?.find(x => x.arm === arm.name);
    const line = `${arm.name}: Inputs run: ${ran} of ${trialInputs}.${t ? ' ' + receivedLines(t, plan) : ''}`;
    lines.push(line);
    if (ran < trialInputs || (t && t.missing.length)) short.push(line);
  }
  if (short.length) throw Error(`The trial stopped: an arm did not receive everything.\n${short.join('\n')}\nFix the cause and run the comparison again; everything that was received is kept.`);
  const fullCells = plan.arms.length * plan.inputs.length * plan.runs * (plan.checkpoints?.length ?? 1) - runs.length;
  const mean = runs.reduce((sum, r) => sum + r.duration_ms, 0) / Math.max(runs.length, 1);
  const deliveries = treated ? plan.events.length - trialEvents(plan) : 0;
  const deliveryMs = treated ? meanDelivery(plan) : 0;
  const minutes = Math.round((fullCells * mean / 4 + deliveries * deliveryMs) / 60_000);
  const costs = runs.map(r => r.cost_usd);
  const cost = runs.length && costs.every(c => typeof c === 'number')
    ? `about $${((costs.reduce((a, b) => a + b, 0) / runs.length) * fullCells).toFixed(2)} at API prices`
    : 'not known: the trial runs reported no price (a run on your own Claude Code or Codex subscription reports none)';
  return [`Trial of "${plan.question}"`, '', 'What each arm received:', ...lines.map(l => `  ${l}`), '', 'The trial runs (each folder holds the run\'s records):',
    ...runs.map(r => `  ${r.arm}, input ${r.input}: ${r.run_dir}`), '',
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

/** The key of a person's mark: the measure's question and the output it marks. */
const markKey = (measure: any, run: any) => sha({ question: measure.person, output: run.result });
const outputText = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);

/** Grade one run on every measure. */
async function grade(item: any) {
  const { run, measures, expected, marks } = item;
  const scores: Record<string, number> = {};
  for (const m of measures) {
    if (m.person !== undefined) { scores[m.name] = marks[m.name]; continue; }
    if (m.code) scores[m.name] = await codeScore(m, run, expected);
    else scores[m.name] = await rubricScore(m, run, expected, item.method);
  }
  return { arm: run.arm, input: run.input, repeat: run.repeat, checkpoint: run.checkpoint, run_dir: run.run_dir, scores };
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
async function rubricScore(m: any, run: any, expected: unknown, methodFile: string) {
  const { preparedConfig, judgeProfiles } = await import('./quality.js');
  const { judgeRubric } = await import('@withmethod/runtime/rubric.js');
  const prepared = await preparedConfig(methodFile, {}, { judge: true });
  const judges = await judgeProfiles(prepared.config);
  const detail: any = await judgeRubric({ value: outputText(run.result), criteria: m.rubric.map((text: string, i: number) => ({ id: `c${i + 1}`, text })),
    ...(expected !== undefined ? { context: { expected: outputText(expected) } } : {}), config: prepared.config,
    options: { runOptions: { processPath: prepared.processPath, ...(prepared.hostedModels ? { hostedModels: prepared.hostedModels } : {}) }, ...(judges.length > 1 ? { judges } : {}) } });
  return detail.criteria.filter((c: any) => c.pass).length / detail.criteria.length;
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const fixed = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(2);

/** Apply the decision rule to the grades: the answer, the reason, and the result text. */
export function decide(plan: Plan, grades: any[], treated: ArmTreatment[] | null) {
  const main = plan.measures.find((m: any) => m.main);
  const points: Array<number | null> = plan.checkpoints ?? [null];
  const at: number | null = plan.rule.at ?? null;
  const point = (arm: string, checkpoint: number | null, measure: string) => {
    const runs = grades.filter(g => g.arm === arm && g.checkpoint === checkpoint);
    const n = Math.min(...plan.inputs.map((input: any) => runs.filter(g => g.input === input.id).length));
    return { n, mean: runs.length ? mean(runs.map(g => g.scores[measure])) : null };
  };
  const reasons: string[] = [];
  const short = (treated ?? []).filter(t => t.missing.length);
  for (const t of short) reasons.push(`${t.arm} did not receive its full treatment (${receivedLines(t, plan)})`);
  const allN = plan.arms.flatMap((arm: any) => points.map(c => point(arm.name, c, main.name).n));
  const fewest = Math.min(...allN);
  if (!short.length && fewest < plan.rule.min_runs) reasons.push(`${fewest === 0 ? 'a point has no runs' : `each point has ${plural(fewest, 'run')}`}, and the rule needs ${plan.rule.min_runs}`);
  let answer = "Can't tell yet", reason = '';
  if (reasons.length) reason = reasons[0]!;
  else {
    const ranked = plan.arms.map((arm: any) => ({ arm: arm.name, mean: point(arm.name, at, main.name).mean! })).sort((a: any, b: any) => b.mean - a.mean);
    const [best, next] = [ranked[0], ranked[1]];
    const lead = best.mean - next.mean;
    if (lead < plan.rule.margin) reason = `${best.arm} is ahead of ${next.arm} by ${fixed(lead)} on ${main.name}, and the rule needs ${plan.rule.margin}`;
    else {
      const guard = plan.rule.guard;
      let drop = 0;
      if (guard) drop = plan.checkpoints
        ? point(best.arm, plan.checkpoints[0], guard.measure).mean! - point(best.arm, at, guard.measure).mean!
        : Math.max(...plan.arms.filter((a: any) => a.name !== best.arm).map((a: any) => point(a.name, at, guard.measure).mean! - point(best.arm, at, guard.measure).mean!));
      if (guard && drop > guard.max_drop) reason = `${best.arm} is ahead on ${main.name}, but its ${guard.measure} dropped by ${fixed(drop)}, and the rule allows ${guard.max_drop}`;
      else { answer = `${best.arm} is better`; reason = `${best.arm} is ahead of ${next.arm} by ${fixed(lead)} on ${main.name}${pointLabel(at)}, and the rule needs ${plan.rule.margin}`; }
    }
  }
  const lines = [`${answer}: ${reason}.`, '', `Question: ${plan.question}`, `Difference: ${plan.difference}`, ...plan.other_differences.map((d: string) => `Other difference: ${d}`),
    `Rule: ${plan.rule_sentence}`, '', 'What each arm received:'];
  const planned = plan.inputs.length * plan.runs * points.length;
  for (const arm of plan.arms) {
    const ran = grades.filter(g => g.arm === arm.name).length;
    const t = treated?.find(x => x.arm === arm.name);
    const full = ran === planned && !t?.missing.length;
    lines.push(`  ${full ? '' : 'SHORT '}${arm.name}: Inputs run: ${ran} of ${planned}.${t ? ' ' + receivedLines(t, plan) : ''}`);
  }
  for (const m of plan.measures) {
    lines.push('', `${m.main ? 'Main measure' : 'Also shown'}: ${m.name} (mean per run; n = runs per input behind the point)`);
    for (const arm of plan.arms) lines.push(`  ${arm.name}: ${points.map(c => { const p = point(arm.name, c, m.name); return `${c === null ? '' : `after ${c}: `}${p.mean === null ? 'no runs' : fixed(p.mean)} (n=${p.n})`; }).join('; ')}`);
  }
  lines.push('', 'Assumptions:');
  if (treated) lines.push(`  Each arm received its full treatment: checked by Method: ${short.length ? 'no' : 'yes'}.`);
  lines.push(`  Each point has at least ${plural(plan.rule.min_runs, 'run')} per input: checked by Method: ${fewest >= plan.rule.min_runs ? 'yes' : 'no'}.`);
  for (const a of plan.assumptions) lines.push(`  ${a}: not checked.`);
  return { answer, reason, text: lines.join('\n') };
}

/** `method __compare STAGE`: one stage of a comparison, run by the generated Method's stage script. */
export async function compareStage(stage: string, bindings: any): Promise<Record<string, unknown>> {
  const plan = bindings.comparison ? JSON.parse(bindings.comparison) : undefined;
  const treated: ArmTreatment[] | null = bindings.treated ? JSON.parse(bindings.treated) : null;
  const runsOf = (list: string[] = []) => list.map(r => JSON.parse(r));
  if (stage === 'trial_treat' || stage === 'treat') {
    if (stage === 'treat' && bindings.go !== true) throw Error('The full run was not approved.');
    const value = JSON.stringify(await treat(plan, stage === 'treat' ? plan.events.length : trialEvents(plan)));
    return { [stage === 'treat' ? 'treatment' : 'trial_treatment']: value, state: { treatment: value } };
  }
  if (stage === 'trial_plan') return { trial_cells: cells(plan, treated, true).map(c => JSON.stringify(c)) };
  if (stage === 'trial_cell') return { trial_run: JSON.stringify(await runCell(JSON.parse(bindings.cell))) };
  if (stage === 'cell') return { full_run: JSON.stringify(await runCell(JSON.parse(bindings.cell))) };
  if (stage === 'check') return { trial_summary: trialCheck(plan, runsOf(bindings.runs), treated) };
  if (stage === 'plan') {
    if (bindings.go !== true) throw Error('The full run was not approved.');
    const trial = new Set(cells(plan, treated, true).map(cellId));
    return { cells: cells(plan, treated, false).filter(c => !trial.has(cellId(c))).map(c => JSON.stringify(c)) };
  }
  const all = () => [...runsOf(bindings.trial_runs), ...runsOf(bindings.full_runs)];
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
    return { graded: all().map(run => JSON.stringify({ run, measures, method, expected: plan.expected[run.input],
      marks: Object.fromEntries(measures.filter((m: any) => m.person !== undefined).map((m: any) => [m.name, marks[markKey(m, run)]])) })) };
  }
  if (stage === 'grade') return { grade: JSON.stringify(await grade(JSON.parse(bindings.item))) };
  if (stage === 'decide') return { answer: decide(plan, runsOf(bindings.grades), treated).text };
  throw Error(`Unknown comparison stage ${stage}.`);
}
export async function compareStageCommand(stage: string) {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  try { process.stdout.write(JSON.stringify(await compareStage(stage, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))) + '\n'); }
  catch (error) { process.stderr.write(`${(error as Error).message}\n`); process.exitCode = 1; }
}
