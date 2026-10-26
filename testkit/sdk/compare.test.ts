import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareStage, comparisonRunArgs, compileComparison, decide, delivery, readComparison } from '../../packages/sdk/src/compare.js';
import { runCurrentFile } from '../../packages/sdk/src/current-runtime.js';
import { baselineAnswer } from '../../packages/sdk/src/quality.js';
import { saveAnswer } from '../../packages/sdk/src/local-answer.js';
import { LOCAL_SERVER_PORT, registerLocalRun, serveLocal } from '../../packages/sdk/src/local-server.js';
import { methodMain } from '../../packages/sdk/src/method.js';

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

/**
 * method run FILE.compare: the trial stops at the approval, unless the person already approved this version of the
 * file; the person's go (kept in the run folder, as method answer keeps it) resumes the run to its result.
 */
async function runComparison(root: string, file: string, name: string) {
  const args = await comparisonRunArgs(['run', file]);
  const runDir = join(root, 'runs', name);
  const trial: any = await runCurrentFile(args[1]!, { inputs: args[args.indexOf('--inputs') + 1]!, 'run-dir': runDir } as any);
  if (trial.status !== 'needs_input') return trial;
  saveAnswer(runDir, 'approve:0', { go: true });
  return await runCurrentFile(args[1]!, { 'run-dir': runDir, resume: true } as any) as any;
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

/** A stand-in for Codex on PATH: it answers with the number of lines in its prompt that start with "- " (corrections). */
function codexStub(root: string) {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
let prompt = '';
process.stdin.on('data', d => prompt += d).on('end', () => {
  fs.appendFileSync(${JSON.stringify(join(root, 'calls-plain'))}, 'x');
  fs.writeFileSync(${JSON.stringify(join(root, 'plain-seen.json'))}, JSON.stringify({ prompt, home: process.env.HOME, user_secret: process.env.USER_SECRET ?? null,
    files: fs.readdirSync(process.cwd(), { recursive: true }).sort(), args: argv }));
  const n = JSON.parse(prompt.slice(prompt.indexOf('{'))).n;
  fs.writeFileSync(argv[argv.indexOf('--output-last-message') + 1], String(n * 3));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: String(n * 3) } }));
});
`, { mode: 0o700 });
  // The sign-in that the clean room links: Codex's auth.json in the user's home.
  mkdirSync(join(process.env.HOME!, '.codex'), { recursive: true });
  writeFileSync(join(process.env.HOME!, '.codex', 'auth.json'), '{}');
  return bin;
}

it('runs a plain Codex arm as one session in a clean room, with only its instructions and the input, and shows its transcript in the trial', async () => {
  const { root, file } = fixture();
  const bin = codexStub(root);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  process.env.USER_SECRET = 'not for the arm';
  try {
    writeFileSync(join(root, 'plain.md'), 'Answer with three times n.');
    // The Method arm records the home folder that its script saw.
    writeFileSync(join(root, 'a', 'answer.mjs'), `import{appendFileSync,writeFileSync,readFileSync}from'node:fs';appendFileSync(${JSON.stringify(join(root, 'calls-a'))},'x');writeFileSync(${JSON.stringify(join(root, 'a-home'))},process.env.HOME);const{n}=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({value:n}))`);
    // The Method arm reads a folder of files; the plain arm's room holds the same files.
    const armFile = join(root, 'a', 'agent.method');
    writeFileSync(armFile, JSON.stringify({ ...JSON.parse(readFileSync(armFile, 'utf8')), environment: { docs: { type: 'files', description: 'The briefs to read.' } } }));
    mkdirSync(join(root, 'a', 'docs'));
    writeFileSync(join(root, 'a', 'docs', 'brief.md'), 'Answer briefly.');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...doc, arms: { a: doc.arms.a, plain: { agent: 'codex', instructions: 'plain.md' } } }));
    const args = await comparisonRunArgs(['run', file]);
    const trial: any = await runCurrentFile(args[1]!, { inputs: args[args.indexOf('--inputs') + 1]!, 'run-dir': join(root, 'runs', 'first') } as any);
    expect(trial.status).toBe('needs_input');
    const question = readFileSync(join(root, 'runs', 'first', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).find(e => e.event === 'human.required').prompt;
    // What each arm received names the model that its runs used.
    expect(question).toContain('plain: Model: Codex\'s default model. Inputs run: 1 of 1.');
    const transcript = /plain, input inputs\/one\.json: .*\n {4}transcript: (\S+)/.exec(question)?.[1];
    expect(transcript && readFileSync(transcript, 'utf8')).toMatch(/\*\*You\*\* \(prompt\)\n\nAnswer with three times n\.\n\nInput:\n\{\n {2}"n": 1\n\}/);
    const seen = JSON.parse(readFileSync(join(root, 'plain-seen.json'), 'utf8'));
    expect(seen.prompt).toBe('Answer with three times n.\n\nInput:\n{\n  "n": 1\n}');
    expect(seen.home).not.toBe(process.env.HOME);
    expect(seen.user_secret).toBeNull();
    expect(seen.files).toEqual(['docs', 'docs/brief.md']);
    // The same tools as Method's own Codex steps, the web too.
    expect(seen.args.join(' ')).toContain('web_search="live"');
    // The Method arm runs in a clean room too, with a fresh home that is removed after its run.
    const armHome = readFileSync(join(root, 'a-home'), 'utf8');
    expect(armHome).not.toBe(process.env.HOME);
    expect(armHome).toMatch(/\/mr-[^/]+\/home$/);
    expect(existsSync(armHome)).toBe(false);
    saveAnswer(join(root, 'runs', 'first'), 'approve:0', { go: true });
    const done: any = await runCurrentFile(args[1]!, { 'run-dir': join(root, 'runs', 'first'), resume: true } as any);
    expect(done.result).toMatch(/^plain is better: plain is ahead of a by 0\.30 on size/);
    expect(calls(root, 'plain')).toBe(2);
  } finally { process.env.PATH = path; delete process.env.USER_SECRET; }
}, 600_000);

it('tells a plain arm each correction in its instructions, in order, and measures it at each checkpoint', async () => {
  const { root, file } = fixture({ teaching: ['inputs/three.json'], rule: { margin: 0.1, min_runs: 1, at: 2 },
    treatment: { events: [{ correction: 'Be brief.', input: 'inputs/three.json' }, { input: 'inputs/three.json' }, { correction: 'Use numbers.', input: 'inputs/three.json' }], checkpoints: [0, 2, 3] } });
  writeFileSync(join(root, 'plain.md'), 'Answer with three times n.');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...doc, arms: { ...doc.arms, plain: { agent: 'claude', instructions: 'plain.md' } } }));
  delivery.deliver = async () => ({ received: true, outcome: 'fixed' });
  const { inputs } = await compileComparison(file);
  const comparison = JSON.parse(readFileSync(inputs, 'utf8')).comparison;
  const treated = JSON.parse((await compareStage('treat', { comparison, go: true })).treatment as string);
  const plain = treated.find((t: any) => t.arm === 'plain');
  expect([plain.corrections, plain.inputs, plain.missing]).toEqual([{ planned: 2, received: 2 }, { planned: 1, received: 1 }, []]);
  expect(plain.snapshots['0'].plain.instructions).toBe('Answer with three times n.');
  expect(plain.snapshots['2'].plain.instructions).toBe('Answer with three times n.\n\nCorrections to follow:\n- Be brief.\n');
  expect(plain.snapshots['3'].plain.instructions).toBe('Answer with three times n.\n\nCorrections to follow:\n- Be brief.\n- Use numbers.\n');
  // Every point that has not run yet: 3 checkpoints × 2 inputs (no trial ran here).
  const cells = (await compareStage('plan', { comparison, go: true, treated: JSON.stringify(treated) })).cells as string[];
  const plainCells = cells.map(c => JSON.parse(c)).filter((c: any) => c.arm === 'plain');
  expect(plainCells.map((c: any) => [c.checkpoint, c.plain.instructions.includes('Use numbers.')])).toEqual([[0, false], [0, false], [2, false], [2, false], [3, true], [3, true]]);
  // Each run at a checkpoint says what it received.
  expect(plainCells[4].treatment_note).toBe('Told in its instructions, in this order:\n1. Correction on inputs/three.json: Be brief.\n2. New input: inputs/three.json\n3. Correction on inputs/three.json: Use numbers.');
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
  // The person approved this version of the file: the next run does not ask again.
  const asked = (name: string) => readFileSync(join(root, 'runs', name, 'events.jsonl'), 'utf8').includes('"human.required"');
  expect([asked('first'), asked('second')]).toEqual([true, false]);

  // A changed measure grades again without running any arm.
  measure(root, 1000);
  const third = await runComparison(root, file, 'third');
  expect(third.result).toMatch(/^Can't tell yet: b is ahead of a by 0\.00 on size, and the rule needs 0\.1\./);
  expect([calls(root, 'a'), calls(root, 'b')]).toEqual([2, 4]);
}, 600_000);

it('takes the person\'s go from method answer RUN_ID, as an agent passes it on, and continues the run', async () => {
  const { root, file } = fixture();
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const execArgv = [...process.execArgv];
  process.execArgv = ['--import', 'tsx'];
  try {
    await methodMain(['run', file, '--run-dir', join(root, 'runs', 'first')]);
    const printed = out.mock.calls.map(call => String(call[0])).join('');
    const stopped = JSON.parse(printed.slice(printed.indexOf('{')));
    expect(stopped).toMatchObject({ status: 'needs_input', question: { step: 'approve:0' } });
    expect(stopped.failure.next.text).toContain(`method answer ${stopped.run_id} --answer '{"go":"…"}'`);
    out.mockClear();
    await methodMain(['answer', stopped.run_id]);
    expect(JSON.parse(String(out.mock.calls[0]![0]))).toMatchObject({ run_id: stopped.run_id, step: 'approve:0', form: { properties: { go: { type: 'boolean' } } } });
    await expect(methodMain(['answer', stopped.run_id, '--answer', '{"go":"yes"}'])).rejects.toThrow(/go must be a boolean/);
    await methodMain(['answer', stopped.run_id, '--answer', '{"go":true}']);
    const summary = JSON.parse(readFileSync(join(root, 'runs', 'first', 'summary.json'), 'utf8'));
    expect(summary.status).toBe('completed');
    expect(summary.result).toMatch(/^b is better/);
  } finally { out.mockRestore(); process.execArgv = execArgv; }
}, 600_000);

it('serves a run that keeps its content on this computer to the dashboard of its account, and to no other page', async () => {
  const cache = mkdtempSync(join(tmpdir(), 'method-local-')), port = LOCAL_SERVER_PORT;
  roots.push(cache);
  const runId = '6f1c2a4e-1111-4222-8333-944455556666';
  writeFileSync(join(cache, 'transcript.jsonl'), `${JSON.stringify({ i: 0, role: 'user', kind: 'prompt', text: 'Review the NDA.', tool: null, path: null, raw_ref: 'prompt.md' })}\n`);
  writeFileSync(join(cache, 'seen.txt'), 'The first prompt:\nReview the NDA.');
  registerLocalRun(cache, runId, 'https://app.example.test', entry => ({ ...entry, treatment_note: 'Told in its instructions.', transcript: join(cache, 'transcript.jsonl') }));
  registerLocalRun(cache, runId, 'https://app.example.test', entry => ({ ...entry, grades: { g1: { verdicts: [{ criterion: 'Names the term', verdict: 'met', quote: 'NDA', line: 0 }], seen: join(cache, 'seen.txt') } } }));
  const saved = process.env.METHOD_CACHE_DIR;
  process.env.METHOD_CACHE_DIR = cache;
  const server = await serveLocal();
  try {
    const url = `http://127.0.0.1:${port}/runs/${runId}/comparison`;
    const preflight = await fetch(url, { method: 'OPTIONS', headers: { origin: 'https://app.example.test', 'access-control-request-method': 'GET', 'access-control-request-private-network': 'true' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
    expect(preflight.headers.get('access-control-allow-private-network')).toBe('true');
    const response = await fetch(url, { headers: { origin: 'https://app.example.test' } });
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
    expect(await response.json()).toEqual({ treatment_note: 'Told in its instructions.',
      transcript: [{ i: 0, role: 'user', kind: 'prompt', text: 'Review the NDA.', tool: null, path: null, raw_ref: 'prompt.md' }],
      grades: { g1: { verdicts: [{ criterion: 'Names the term', verdict: 'met', quote: 'NDA', line: 0 }], seen: 'The first prompt:\nReview the NDA.' } } });
    // Another page, a run this computer did not register, or a name that only resolves here: refused.
    expect((await fetch(url, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await fetch(url.replace(runId, '6f1c2a4e-1111-4222-8333-000000000000'), { headers: { origin: 'https://app.example.test' } })).status).toBe(404);
    expect((await fetch(url.replace('127.0.0.1', 'localhost'), { headers: { origin: 'https://app.example.test' } })).status).toBe(403);
  } finally {
    server.close();
    if (saved === undefined) delete process.env.METHOD_CACHE_DIR; else process.env.METHOD_CACHE_DIR = saved;
  }
});

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
  expect(result.text).toMatch(/^Can't tell yet: b did not receive its full treatment \(Inputs run: 4 of 4\. Corrections received: 4 of 5\. Missing event 5/);
  expect(result.text).toContain('SHORT b: Inputs run: 4 of 4. Corrections received: 4 of 5.');
  expect(result.decision).toMatchObject({ answer: 'cant_tell', values: { a: { value: 0.1, n: 1 }, b: { value: 0.9, n: 1 } } });
  expect(result.received.b.lines[1]).toMatchObject({ what: 'Corrections received', received: 4, planned: 5, missing: [expect.stringMatching(/^Event 5 \("Correction 5\."\)/)] });
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
