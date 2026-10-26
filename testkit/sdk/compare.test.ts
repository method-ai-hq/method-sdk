import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareStage, comparisonRunArgs, compileComparison, decide, delivery, readComparison } from '../../packages/sdk/src/compare.js';
import { runCurrentFile } from '../../packages/sdk/src/current-runtime.js';
import { baselineAnswer } from '../../packages/sdk/src/quality.js';

const roots: string[] = [];
const original = delivery.deliver;
afterEach(() => { process.exitCode = 0; delivery.deliver = original; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A folder with two script arms (a returns n, b returns 2n), three input files and a code measure (value / 10). */
function fixture(extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'method-compare-'));
  roots.push(root);
  for (const [arm, factor] of [['a', 1], ['b', 2]] as const) {
    mkdirSync(join(root, arm));
    writeFileSync(join(root, arm, 'agent.method'), JSON.stringify({ format: 'method/3.4', name: `Agent ${arm}`, goal: 'Answer with a number.',
      inputs: { n: { type: 'number' } }, steps: { answer: { in: { n: 'inputs.n' }, do: { kind: 'run', runtime: 'node', entrypoint: 'answer.mjs' }, out: { value: { type: 'number' } } } }, result: 'value' }));
    answer(root, arm, factor);
  }
  mkdirSync(join(root, 'inputs'));
  for (const [id, n] of [['one', 1], ['two', 2], ['three', 3]] as const) writeFileSync(join(root, 'inputs', `${id}.json`), JSON.stringify({ n }));
  measure(root, 10);
  const file = join(root, 'numbers.compare');
  writeFileSync(file, JSON.stringify({
    question: 'Which agent gives the larger number?', arms: { a: 'a/agent.method', b: 'b/agent.method' }, difference: 'The factor in the answer script.',
    inputs: ['inputs/one.json', 'inputs/two.json'], measure: { name: 'size', code: 'size.mjs' }, rule: { margin: 0.1, min_runs: 1 }, runs: 1, trial: 1, ...extra,
  }));
  return { root, file };
}
const answer = (root: string, arm: string, factor: number) => writeFileSync(join(root, arm, 'answer.mjs'),
  `import{appendFileSync,readFileSync}from'node:fs';appendFileSync(${JSON.stringify(join(root, `calls-${arm}`))},'x');const{n}=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({value:n*${factor}}))`);
const measure = (root: string, divisor: number) => writeFileSync(join(root, 'size.mjs'),
  `import{readFileSync}from'node:fs';const{output}=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({score:output/${divisor}}))`);
const calls = (root: string, arm: string) => existsSync(join(root, `calls-${arm}`)) ? readFileSync(join(root, `calls-${arm}`), 'utf8').length : 0;

/** method run FILE.compare: the trial stops at the approval; the person's go resumes the run to its result. */
async function runComparison(root: string, file: string, name: string) {
  const args = await comparisonRunArgs(['run', file]);
  const runDir = join(root, 'runs', name), human = join(root, `${name}-go.json`);
  const trial: any = await runCurrentFile(args[1]!, { inputs: args[args.indexOf('--inputs') + 1]!, 'run-dir': runDir } as any);
  expect(trial.status).toBe('needs_input');
  writeFileSync(human, JSON.stringify({ steps: { approve: { outputs: { go: true } } } }));
  return await runCurrentFile(args[1]!, { 'run-dir': runDir, resume: true, human } as any) as any;
}

it('refuses a comparison with a missing part, more than one main measure, a rule that cannot say can\'t tell yet, or arms of one Method', () => {
  const { root, file } = fixture();
  const write = (value: unknown) => { writeFileSync(file, JSON.stringify(value)); return () => readComparison(file); };
  const good = JSON.parse(readFileSync(file, 'utf8'));
  const { question: _q, runs: _r, ...missing } = good;
  expect(write(missing)).toThrow(/It has no question\. .*It has no runs\./);
  expect(write({ ...good, measure: [good.measure, { name: 'other', code: 'size.mjs' }] })).toThrow(/more than one main measure/);
  expect(write({ ...good, measure: { name: 'size', code: 'size.mjs', person: 'Good?' } })).toThrow(/exactly one of code, rubric or person/);
  expect(write({ ...good, rule: { margin: 0, min_runs: 1 } })).toThrow(/margin above 0/);
  expect(write({ ...good, rule: 'B is better when it is clearly ahead' })).toThrow(/rule/);
  expect(write({ ...good, rule: { margin: 0.1, min_runs: 1, when: 'ahead' } })).toThrow(/Unknown part when in rule/);
  expect(write({ ...good, rule: { margin: 0.1, min_runs: 1, at: 3 } })).toThrow(/no treatment over time/);
  expect(write({ ...good, format: 'compare/1' })).toThrow(/Unknown part format/);
  writeFileSync(join(root, 'a', 'agent.method'), JSON.stringify({ ...JSON.parse(readFileSync(join(root, 'a', 'agent.method'), 'utf8')), format: 'method/3.4', id: 'wf_' + 'a'.repeat(32) }));
  writeFileSync(join(root, 'b', 'agent.method'), JSON.stringify({ ...JSON.parse(readFileSync(join(root, 'b', 'agent.method'), 'utf8')), format: 'method/3.4', id: 'wf_' + 'a'.repeat(32) }));
  expect(write(good)).toThrow(/The arms a and b are the same Method \(wf_a+\)\. Each arm needs its own Method ID: run method new-id b\/agent\.method\./);
  const treatment = { ...good, treatment: { events: [{ correction: 'Say more.', input: 'inputs/three.json' }], checkpoints: [0, 1] } };
  expect(write(treatment)).toThrow(/the rule needs at/);
});

it('says that a plain Claude Code or Codex arm is not built yet', async () => {
  const { root, file } = fixture();
  writeFileSync(join(root, 'plain.md'), 'Answer with a number.');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...doc, arms: { ...doc.arms, plain: { agent: 'claude', instructions: 'plain.md' } } }));
  expect(() => readComparison(file)).not.toThrow();
  await expect(compileComparison(file)).rejects.toThrow(/The arm plain is plain Claude Code or Codex\. A comparison cannot run a plain agent yet: that needs the session step in Method's runtime, which is not built yet\./);
});

it('runs each Method arm as its own Method, decides by the rule, and reruns only the cells of a changed part', async () => {
  const { root, file } = fixture();
  const first = await runComparison(root, file, 'first');
  expect(first.status).toBe('completed');
  expect(first.result).toMatch(/^b is better: b is ahead of a by 0\.15 on size, and the rule needs 0\.1\./);
  expect(first.result).toContain('Rule: An arm is better when its mean size is at least 0.1 above every other arm\'s, with at least 1 run per input behind each point. Otherwise: can\'t tell yet.');
  expect(first.result).toContain('  a: Inputs run: 2 of 2.');
  expect(first.result).toContain('  b: 0.30 (n=1)');
  expect([calls(root, 'a'), calls(root, 'b')]).toEqual([2, 2]);

  // Each arm runs as a copy with its own Method ID, folder and cache.
  const { plan } = await compileComparison(file);
  const [a, b] = plan.arms;
  expect(a!.id).toMatch(/^wf_[a-f0-9]{32}$/);
  expect(a!.id).not.toBe(b!.id);
  expect(a!.dir).not.toBe(b!.dir);
  expect(readFileSync(join(a!.dir, 'agent.method'), 'utf8')).toContain(a!.id);
  expect(existsSync(join(a!.cache_dir, 'cli')) && existsSync(join(b!.cache_dir, 'cli'))).toBe(true);
  expect((await compileComparison(file)).plan.arms[0]!.id).toBe(a!.id);

  // A changed arm runs again; the other arm's runs are reused.
  answer(root, 'b', 3);
  const second = await runComparison(root, file, 'second');
  expect(second.result).toMatch(/^b is better: b is ahead of a by 0\.30/);
  expect([calls(root, 'a'), calls(root, 'b')]).toEqual([2, 4]);

  // A changed measure grades again without running any arm.
  measure(root, 1000);
  const third = await runComparison(root, file, 'third');
  expect(third.result).toMatch(/^Can't tell yet: b is ahead of a by 0\.00 on size, and the rule needs 0\.1\./);
  expect([calls(root, 'a'), calls(root, 'b')]).toEqual([2, 4]);
}, 600_000);

it('stops the trial and gives no verdict when an arm did not receive a correction', async () => {
  const { root, file } = fixture({ teaching: ['inputs/three.json'], rule: { margin: 0.1, min_runs: 1, at: 5 },
    treatment: { events: [1, 2, 3, 4, 5].map(i => ({ correction: `Correction ${i}.`, input: 'inputs/three.json' })), checkpoints: [0, 5] } });
  // A stand-in for method judge: every correction reaches arm a; the fifth one does not reach arm b.
  delivery.deliver = async (event: any, learner) => learner.dir.includes(join('arms', 'b')) && event.index === 5
    ? { received: false, reason: 'the training run on inputs/three.json ended failed: the script stopped' } : { received: true, outcome: 'fixed' };
  const { inputs } = await compileComparison(file);
  const comparison = JSON.parse(readFileSync(inputs, 'utf8')).comparison;
  const treated = (await compareStage('trial_treat', { comparison })).trial_treatment as string;
  const arms = JSON.parse(treated);
  expect(arms.map((t: any) => [t.arm, t.corrections])).toEqual([['a', { planned: 5, received: 5 }], ['b', { planned: 5, received: 4 }]]);
  expect(Object.keys(arms[0].snapshots)).toEqual(['0', '5']);
  expect(Object.keys(arms[1].snapshots)).toEqual(['0']);
  const runs = ['a', 'b'].map(arm => JSON.stringify({ arm, input: 'inputs/one.json', repeat: 0, checkpoint: 0, result: 1, run_dir: root, duration_ms: 10, cost_usd: null }));
  await expect(compareStage('check', { comparison, runs, treated })).rejects.toThrow(
    /The trial stopped: an arm did not receive everything\.\nb: Inputs run: 1 of 1\. Corrections received: 4 of 5\. Missing event 5 \("Correction 5\."\): the training run on inputs\/three\.json ended failed: the script stopped\./);
  // A rerun gives only the missing correction again.
  let given = 0;
  delivery.deliver = async () => { given++; return { received: true, outcome: 'no_fix_found' }; };
  const again = JSON.parse((await compareStage('trial_treat', { comparison })).trial_treatment as string);
  expect(given).toBe(1);
  expect(again[1].corrections).toEqual({ planned: 5, received: 5 });
  // The result of a full run with a short arm says what is missing and gives no verdict.
  const grades = ['a', 'b'].flatMap(arm => [0, 5].flatMap(checkpoint => ['inputs/one.json', 'inputs/two.json'].map(input => ({ arm, input, repeat: 0, checkpoint, scores: { size: arm === 'b' ? 0.9 : 0.1 } }))));
  const result = decide(JSON.parse(comparison), grades, arms);
  expect(result.answer).toBe("Can't tell yet");
  expect(result.text).toMatch(/^Can't tell yet: b did not receive its full treatment \(Corrections received: 4 of 5\./);
  expect(result.text).toContain('SHORT b: Inputs run: 4 of 4. Corrections received: 4 of 5.');
  expect(result.text).toContain('Each arm received its full treatment: checked by Method: no.');
});

it('decides by the fixed rule: margin, minimum runs and guard', async () => {
  const { file } = fixture({ other_measures: [{ name: 'words', code: 'size.mjs' }], rule: { margin: 0.1, min_runs: 2, guard: { measure: 'words', max_drop: 0.05 } }, runs: 2, assumptions: ['Graders agree with the expert.'] });
  const { plan } = await compileComparison(file);
  const grades = (runs: number, b: { size: number; words: number }) => ['a', 'b'].flatMap(arm => ['inputs/one.json', 'inputs/two.json'].flatMap(input =>
    Array.from({ length: runs }, (_, repeat) => ({ arm, input, repeat, checkpoint: null, scores: arm === 'a' ? { size: 0.2, words: 0.5 } : b }))));
  expect(decide(plan, grades(1, { size: 0.9, words: 0.5 }), null).text).toMatch(/^Can't tell yet: each point has 1 run, and the rule needs 2\./);
  expect(decide(plan, grades(2, { size: 0.9, words: 0.4 }), null).text).toMatch(/^Can't tell yet: b is ahead on size, but its words dropped by 0\.10, and the rule allows 0\.05\./);
  const better = decide(plan, grades(2, { size: 0.9, words: 0.5 }), null);
  expect(better.answer).toBe('b is better');
  expect(better.text).toContain('Graders agree with the expert.: not checked.');
});

it('method test --baseline answers which version is better', () => {
  const counts = (fixed: number, regression: number, unverifiable = 0) => ({ counts: { fixed, regression, unverifiable } });
  expect(baselineAnswer(counts(2, 0))).toEqual({ answer: 'The new version is better', reason: 'It fixes 2 cases and breaks none.' });
  expect(baselineAnswer(counts(0, 1))).toEqual({ answer: 'The old version is better', reason: 'The new version breaks 1 case and fixes none.' });
  expect(baselineAnswer(counts(1, 1)).answer).toBe("Can't tell yet");
  expect(baselineAnswer(counts(0, 0)).answer).toBe("Can't tell yet");
  expect(baselineAnswer(counts(1, 0, 1)).answer).toBe("Can't tell yet");
});
