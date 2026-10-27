import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// What a comparison sends to the account: the spec of each version and each stage, captured in place of the account.
const sent: { specs: any[]; stages: any[]; cells: any[] } = { specs: [], stages: [], cells: [] };
vi.mock('../../packages/sdk/src/compare-account.js', async original => {
  const real: any = await original();
  const hash = (text: string) => ({ sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) });
  return { ...real,
    saveComparison: async (_folder: string, _id: string, _name: string, spec: unknown) => { sent.specs.push(spec); return null; },
    sendStage: async (_folder: string, update: unknown) => { sent.stages.push(update); },
    sendPlan: async () => null, linkCells: async (_folder: string, cells: unknown[]) => { sent.cells.push(...cells); },
    uploadSignedIn: async (text: string) => hash(text), uploadText: async (_folder: string, text: string) => hash(text) };
});
const { compareStage, compileComparison, delivery } = await import('../../packages/sdk/src/compare.js');

const roots: string[] = [];
const deliver = delivery.deliver;
afterEach(() => { delivery.deliver = deliver; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('sends the account the spec with who decided each value, Method\'s rules and the judge, and each trial with what each learner received and the noise', async () => {
  const root = mkdtempSync(join(tmpdir(), 'method-compare-payload-'));
  roots.push(root);
  mkdirSync(join(root, 'a'));
  writeFileSync(join(root, 'a', 'agent.method'), JSON.stringify({ format: 'method/3.4', name: 'Agent', goal: 'Answer.', inputs: { n: { type: 'number' } },
    steps: { answer: { in: { n: 'inputs.n' }, do: { kind: 'run', runtime: 'node', entrypoint: 'answer.mjs' }, out: { value: { type: 'number' } } } }, result: 'value' }));
  writeFileSync(join(root, 'a', 'answer.mjs'), `import{readFileSync}from'node:fs';const{n}=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({value:n}))`);
  mkdirSync(join(root, 'b'));
  writeFileSync(join(root, 'b', 'agent.method'), readFileSync(join(root, 'a', 'agent.method')));
  writeFileSync(join(root, 'b', 'answer.mjs'), readFileSync(join(root, 'a', 'answer.mjs')));
  writeFileSync(join(root, 'size.mjs'), `import{readFileSync}from'node:fs';const{output}=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({score:output/10}))`);
  mkdirSync(join(root, 'inputs'));
  for (const [id, n] of [['one', 1], ['two', 2], ['teach', 3]] as const) writeFileSync(join(root, 'inputs', `${id}.json`), JSON.stringify({ n }));
  const file = join(root, 'numbers.compare');
  writeFileSync(file, JSON.stringify({ question: 'Which agent takes 2 corrections better?', arms: { a: 'a/agent.method', b: 'b/agent.method' }, difference: 'Nothing but the copy.',
    inputs: ['inputs/one.json', 'inputs/two.json'], teaching: ['inputs/teach.json'], about_inputs: { noun: 'number', description: 'Two small numbers.', names: { 'inputs/one.json': 'One' } },
    measure: { name: 'size', code: 'size.mjs', description: 'The number over ten.' }, rule: { margin: 0.1, min_runs: 1, at: 2 }, runs: 1, trial: 1,
    treatment: { events: [{ correction: 'It needs to be bigger because small is wrong.', input: 'inputs/teach.json' }, { correction: 'It needs a unit because readers ask.', input: 'inputs/teach.json' }], checkpoints: [0, 2] },
    assumptions: [{ text: 'The measure is fair.', if_false: 'The sizes say nothing.', check: 'Read 5 runs.' }], decided_by_you: ['question', 'rule'], notes: { treatment: ['Both corrections are about size.'] } }));
  delivery.deliver = async (event: any) => ({ received: true, outcome: event.index === 1 ? 'fixed' : 'no_change_needed' });
  const { inputs } = await compileComparison(file);
  const spec = sent.specs.at(-1);
  expect(Object.keys(spec).sort()).toEqual(['arms', 'assumptions', 'decisions', 'difference', 'inputs', 'judge', 'learners', 'main_measure', 'method_rules', 'notes', 'other_measures', 'question', 'rule', 'runs_per_point', 'treatment', 'trial']);
  expect(spec.inputs).toMatchObject({ checking: ['inputs/one.json', 'inputs/two.json'], teaching: ['inputs/teach.json'], noun: 'number', description: 'Two small numbers.',
    details: { 'inputs/one.json': { name: 'One', file: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/), bytes: 12 } }, 'inputs/teach.json': { name: 'teach' } } });
  expect(spec.treatment).toEqual({ kind: 'Corrections', items: 2, checkpoints: [0, 2], order: 'given', list: [{ input: 'inputs/teach.json', text: 'It needs to be bigger because small is wrong.' }, { input: 'inputs/teach.json', text: 'It needs a unit because readers ask.' }] });
  expect(spec.other_measures).toEqual([{ name: 'Usage per correction', how: 'usage', higher_is_better: false, description: expect.any(String) }]);
  expect(spec.judge).toEqual({ agent: 'claude', model: 'Claude Code\'s default model' });
  expect(spec.learners).toBe(1);
  expect(spec.decisions).toEqual(expect.arrayContaining([{ part: 'rule', what: 'decision rule', value: expect.any(String), by: 'you' }, { part: 'treatment', what: 'note', value: 'Both corrections are about size.', by: 'writer' }]));
  expect(spec.assumptions[0]).toEqual({ text: 'Each arm received its full treatment.', if_false: expect.any(String), check: expect.any(String), by: 'method', checked_by: 'treatment' });
  expect(new Set(spec.method_rules.map((r: any) => r.part))).toEqual(new Set(['arms', 'same_for_both', 'treatment', 'runs_per_point', 'main_measure', 'other_measures', 'noise', 'run_rules']));

  // The trial: the first learner gets the corrections before the first checkpoint after 0; 2 learners run at the start.
  const comparison = JSON.parse(readFileSync(inputs, 'utf8')).comparison;
  const treated = (await compareStage('trial_treat', { comparison })).trial_treatment as string;
  const planned = await compareStage('trial_plan', { comparison, treated });
  const runs: string[] = [];
  for (const cell of planned.trial_cells as string[]) runs.push((await compareStage('trial_cell', { cell })).trial_run as string);
  const items = (await compareStage('trial_gather', { comparison, treated, trial_runs: runs })).trial_graded as string[];
  const grades: string[] = [];
  for (const item of items) grades.push((await compareStage('trial_grade', { item })).trial_grade as string);
  await compareStage('check', { comparison, runs, grades, treated });
  const trial = sent.stages.find(s => s.stage === 'trial');
  expect(Object.keys(trial).sort()).toEqual(['cost_estimate', 'stage', 'trial']);
  // The noise names each arm's start value per learner, and the estimate counts the runs as the page does (2 arms × 2 inputs × 1 learner × 2 checkpoints).
  expect(trial.trial.noise).toEqual({ spread: 0, margin: 0.1, passes: true, start: { a: [0.1, 0.1], b: [0.1, 0.1] } });
  // The one learner got both corrections in the trial, so none is left to give.
  expect(trial.cost_estimate).toEqual({ minutes: 0, runs: 8, reused: 2, events: 0, usd: null, usage: { unit: 'minutes', values: { a: expect.any(Number), b: expect.any(Number) } } });
  expect(spec.arms.map((arm: any) => arm.name)).toEqual(['Agent (a)', 'Agent (b)']);
  expect(trial.trial.received.a.corrections).toEqual([
    { index: 1, input: 'inputs/teach.json', text: 'It needs to be bigger because small is wrong.', outcome: 'fixed', learner: 1 },
    { index: 2, input: 'inputs/teach.json', text: 'It needs a unit because readers ask.', outcome: 'no_change_needed', learner: 1 }]);
  expect(trial.trial.received.a.lines).toEqual([{ what: 'Inputs run', received: 2, planned: 2, missing: [] }, { what: 'Corrections received', received: 2, planned: 2, missing: [] }]);
}, 600_000);
