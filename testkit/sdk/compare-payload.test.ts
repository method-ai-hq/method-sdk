import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// What a comparison sends to the account: the spec of each version and each stage, captured in place of the account.
const sent = vi.hoisted(() => ({ specs: [] as any[], stages: [] as any[], cells: [] as any[], plans: [] as any[][], linked: new Set<string>() }));
// Saving a run to the account: refused (as a frozen copy's save was before SDK 0.22.3) while saving.fail is true.
const saving = vi.hoisted(() => ({ fail: false }));
vi.mock('../../packages/sdk/src/versions.js', async original => ({ ...(await original() as any),
  prepareVersion: async (_client: unknown, _outbox: unknown, file: string) => {
    if (saving.fail) throw Object.assign(Error(`This Method is saved from ${file}. Make the change in that file and run it there; this copy was not run or saved.`), { code: 'other_home' });
    return { method_id: `wf_${'c'.repeat(32)}`, version_id: `v_${'d'.repeat(32)}`, url: '', unchanged: true, workflow: {} };
  } }));
vi.mock('../../packages/sdk/src/method-client.js', () => ({ MethodClient: class { constructor(readonly server: string) {} } }));
vi.mock('../../packages/sdk/src/outbox.js', () => ({ Outbox: class { async drain() {} } }));
vi.mock('../../packages/sdk/src/method-sync.js', async original => {
  const { writeFileSync: write } = await import('node:fs'), { join: joined } = await import('node:path'), { randomUUID } = await import('node:crypto');
  return { ...(await original() as any), MethodSync: class {
    device = false; outbox = { drain: async () => {} };
    constructor(_client: unknown, readonly dir: string) {}
    async start() {} snapshot() {}
    async finish() { write(joined(this.dir, 'method-sync.json'), JSON.stringify({ id: randomUUID() })); return 'saved'; }
  } };
});
vi.mock('../../packages/sdk/src/compare-account.js', async original => {
  const real: any = await original();
  const hash = (text: string) => ({ sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) });
  return { ...real,
    saveComparison: async (_folder: string, _id: string, _name: string, spec: unknown) => { sent.specs.push(spec); return null; },
    sendStage: async (_folder: string, update: unknown) => { sent.stages.push(update); },
    // The account answers the keys that it has not linked yet.
    sendPlan: async (folder: string, cells: any[]) => {
      sent.plans.push(cells);
      const { existsSync } = await import('node:fs'), { join: joined } = await import('node:path');
      return existsSync(joined(folder, 'account.json')) ? new Set(cells.filter(c => !sent.linked.has(c.key)).map(c => c.key)) : null;
    },
    linkCells: async (_folder: string, cells: any[]) => { sent.cells.push(...cells); for (const cell of cells) sent.linked.add(cell.key); },
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
    measure: { name: 'size', code: 'size.mjs', description: 'The number over ten.' }, rule: { margin: 0.1, min_runs: 1, at: 2 }, runs: 1,
    treatment: { events: [{ correction: 'It needs to be bigger because small is wrong.', input: 'inputs/teach.json' }, { correction: 'It needs a unit because readers ask.', input: 'inputs/teach.json' }], checkpoints: [0, 2] },
    assumptions: [{ text: 'The measure is fair.', if_false: 'The sizes say nothing.', check: 'Read 5 runs.' }], decided_by_you: ['question', 'rule'], notes: { treatment: ['Both corrections are about size.'] } }));
  delivery.deliver = async (event: any) => ({ received: true, outcome: event.index === 1 ? 'fixed' : 'no_change_needed' });
  const { inputs } = await compileComparison(file);
  const spec = sent.specs.at(-1);
  expect(Object.keys(spec).sort()).toEqual(['arms', 'assumptions', 'decisions', 'difference', 'inputs', 'judge', 'learners', 'main_measure', 'method_rules', 'notes', 'other_measures', 'question', 'rule', 'runs_per_point', 'treatment']);
  expect(spec.inputs).toMatchObject({ checking: ['inputs/one.json', 'inputs/two.json'], teaching: ['inputs/teach.json'], noun: 'number', description: 'Two small numbers.',
    details: { 'inputs/one.json': { name: 'One', file: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/), bytes: 12 } }, 'inputs/teach.json': { name: 'teach' } } });
  expect(spec.treatment).toEqual({ kind: 'Corrections', items: 2, checkpoints: [0, 2], order: 'given', list: [{ input: 'inputs/teach.json', text: 'It needs to be bigger because small is wrong.' }, { input: 'inputs/teach.json', text: 'It needs a unit because readers ask.' }] });
  expect(spec.other_measures).toEqual([{ name: 'Usage per correction', how: 'usage', higher_is_better: false, description: expect.any(String) }]);
  expect(spec.judge).toEqual({ agent: 'claude', model: 'Claude Code\'s default model' });
  expect(spec.learners).toBe(1);
  expect(spec.decisions).toEqual(expect.arrayContaining([{ part: 'rule', what: 'decision rule', value: expect.any(String), by: 'you' }, { part: 'treatment', what: 'note', value: 'Both corrections are about size.', by: 'writer' }]));
  expect(spec.assumptions[0]).toEqual({ text: 'Each agent received its full treatment.', if_false: expect.any(String), check: expect.any(String), by: 'method', checked_by: 'treatment' });
  expect(new Set(spec.method_rules.map((r: any) => r.part))).toEqual(new Set(['arms', 'same_for_both', 'treatment', 'runs_per_point', 'main_measure', 'other_measures', 'rule', 'noise', 'run_rules', 'trial']));

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
  expect(trial.trial.noise).toEqual({ spread: 0, margin: 0.1, start: { a: [0.15, 0.15], b: [0.15, 0.15] } });
  // The one learner got both corrections in the trial, so none is left to give.
  expect(trial.cost_estimate).toEqual({ minutes: 0, runs: 8, reused: 4, events: 0, usd: null, usage: { unit: 'minutes', values: { a: expect.any(Number), b: expect.any(Number) } } });
  expect(spec.arms.map((arm: any) => arm.name)).toEqual(['Agent (a)', 'Agent (b)']);
  expect(trial.trial.received.a.corrections).toEqual([
    { index: 1, input: 'inputs/teach.json', text: 'It needs to be bigger because small is wrong.', outcome: 'fixed', learner: 1 },
    { index: 2, input: 'inputs/teach.json', text: 'It needs a unit because readers ask.', outcome: 'no_change_needed', learner: 1 }]);
  // Received and changed are counted apart: no change needed is received and did not change the agent.
  expect(trial.trial.received.a.lines).toEqual([{ what: 'Inputs run', received: 4, planned: 4, missing: [] }, { what: 'Corrections received', received: 2, planned: 2, missing: [], changed: 1 }]);
}, 600_000);

it('saves a finished trial run that its cell could not save, and links every trial grade to the plan that the account has', async () => {
  const root = mkdtempSync(join(tmpdir(), 'method-compare-saving-'));
  roots.push(root);
  for (const [arm, factor] of [['a', 1], ['b', 2]] as const) {
    mkdirSync(join(root, arm));
    writeFileSync(join(root, arm, 'agent.method'), JSON.stringify({ format: 'method/3.4', name: `Agent ${arm}`, goal: 'Answer.', inputs: { n: { type: 'number' } },
      steps: { answer: { in: { n: 'inputs.n' }, do: { kind: 'run', runtime: 'node', entrypoint: 'answer.mjs' }, out: { value: { type: 'number' } } } }, result: 'value' }));
    writeFileSync(join(root, arm, 'answer.mjs'), `import{readFileSync}from'node:fs';const{n}=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({value:n*${factor}}))`);
  }
  writeFileSync(join(root, 'size.mjs'), `import{readFileSync}from'node:fs';const{output}=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({score:output/10}))`);
  mkdirSync(join(root, 'inputs'));
  for (const [id, n] of [['one', 1], ['two', 2]] as const) writeFileSync(join(root, 'inputs', `${id}.json`), JSON.stringify({ n }));
  const file = join(root, 'numbers.compare');
  writeFileSync(file, JSON.stringify({ question: 'Which agent gives the larger number?', arms: { a: 'a/agent.method', b: 'b/agent.method' }, difference: 'The factor.',
    inputs: ['inputs/one.json', 'inputs/two.json'], measure: { name: 'size', code: 'size.mjs' }, rule: { margin: 0.1, min_runs: 1 }, runs: 1 }));
  const { inputs, folder } = await compileComparison(file);
  writeFileSync(join(folder, 'account.json'), JSON.stringify({ server: 'https://app.example.test', config_dir: root, cache_dir: root, comparison_id: `cmp_${'e'.repeat(32)}`, version_number: 1, stage: 'draft', url: '', spec_digest: '' }));
  const comparison = JSON.parse(readFileSync(inputs, 'utf8')).comparison;
  const trial = async () => {
    const planned = await compareStage('trial_plan', { comparison });
    const runs: string[] = [];
    for (const cell of planned.trial_cells as string[]) runs.push((await compareStage('trial_cell', { cell })).trial_run as string);
    const items = (await compareStage('trial_gather', { comparison, trial_runs: runs, trial_done: planned.trial_done })).trial_graded as string[];
    for (const item of items) await compareStage('trial_grade', { item });
  };
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    // The first trial: no run could be saved, so nothing links.
    saving.fail = true;
    await trial();
    expect(sent.cells).toEqual([]);
    expect(stderr.mock.calls.map(c => String(c[0])).join('')).toContain('This run is not saved to your Method account');
    // The rerun saves each finished run from its folder, without running it again, and links it and its grade.
    saving.fail = false;
    await trial();
    const plan = sent.plans.at(-1)!;
    const runs = plan.filter(c => c.kind === 'run'), grades = plan.filter(c => c.kind === 'grade');
    expect(runs).toHaveLength(8);
    for (const cell of runs) expect(sent.cells.find(c => c.key === cell.key)).toMatchObject({ run_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    for (const cell of grades) expect(sent.cells.find(c => c.key === cell.key)).toMatchObject({ measures: { size: expect.any(Number) } });
    // A kept grade that the account lacks links again.
    sent.linked.clear(); sent.cells.length = 0;
    await trial();
    for (const cell of grades) expect(sent.cells.find(c => c.key === cell.key)).toMatchObject({ measures: { size: expect.any(Number) } });
  } finally { stderr.mockRestore(); }
}, 600_000);
