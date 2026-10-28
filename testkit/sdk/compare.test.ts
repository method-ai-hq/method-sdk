import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { armLabels, armModels, checklistOf, clipWords, modelName, fullRunEstimate, methodRules, compareStage, comparisonRunArgs, compileComparison, decide, decisions, delivery, feedbackWriting, fixOutcome, judging, noiseCheck, tooEasyCheck, parseVerdicts, readComparison, shuffled, sourcesRead, usagePerCorrection } from '../../packages/sdk/src/compare.js';
import { runCurrentFile } from '../../packages/sdk/src/current-runtime.js';
import { baselineAnswer } from '../../packages/sdk/src/quality.js';
import { saveAnswer } from '../../packages/sdk/src/local-answer.js';
import { LOCAL_SERVER_PORT, registerLocalRun, serveLocal } from '../../packages/sdk/src/local-server.js';
import { methodMain } from '../../packages/sdk/src/method.js';
import { MethodClient } from '../../packages/sdk/src/method-client.js';

const roots: string[] = [];
const original = { deliver: delivery.deliver, build: delivery.build, judge: judging.judge };
const path = process.env.PATH;
beforeEach(() => { process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token'; });
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0; Object.assign(delivery, { deliver: original.deliver, build: original.build }); judging.judge = original.judge;
  process.env.PATH = path; delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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
  `import{readFileSync}from'node:fs';const{output}=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({score:Number(output)/${divisor}}))`);
const calls = (root: string, arm: string) => existsSync(join(root, `calls-${arm}`)) ? readFileSync(join(root, `calls-${arm}`), 'utf8').length : 0;
const lines = (file: string) => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];

/**
 * A stand-in for Claude Code on PATH. As a plain agent it reads each file in docs/ and hands in the file that the task
 * names, with 3n plus the number of instruction lines that start with "- " (so a builder's edits show), and says
 * "done" as its last message. As a builder it adds "- CORRECTION" to instructions.md (nothing for a correction with
 * [keep]). As the judge it reads every file that read-files.txt lists and marks an item met, partly or not met by the
 * word (met), (partly) or neither in it. Each call is logged with its arguments, prompt and folder.
 */
function claudeStub(root: string) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const argv = process.argv.slice(2);
if (argv[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let prompt = '';
const out = event => console.log(JSON.stringify(event));
process.stdin.on('data', d => prompt += d).on('end', () => {
  const cwd = process.cwd();
  const log = kind => fs.appendFileSync(${JSON.stringify(join(root, 'claude-calls.jsonl'))}, JSON.stringify({ kind, args: argv, prompt, files: fs.readdirSync(cwd, { recursive: true }).sort(), home: process.env.HOME }) + '\\n');
  out({ type: 'system', subtype: 'init', model: argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : 'stub-default' });
  let n = 0;
  const read = file => { const id = 't' + (++n), text = fs.readFileSync(file, 'utf8');
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: file } }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } }); return text; };
  let result = 'done';
  if (argv.includes('--json-schema')) {
    // A Method's own Claude Code step.
    log('step');
    out({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { ok: 'ok' }, usage: { input_tokens: 10, output_tokens: 2 } });
    return;
  }
  if (prompt.startsWith('You are the judge')) {
    log('judge');
    const items = JSON.parse(fs.readFileSync(path.join(cwd, 'checklist.json'), 'utf8'));
    const listed = fs.readFileSync(path.join(cwd, 'read-files.txt'), 'utf8').split('\\n').filter(l => l.startsWith('sources/'));
    const sizes = Object.fromEntries(listed.map(p => [p, read(path.join(cwd, p)).length]));
    const document = fs.readdirSync(path.join(cwd, 'document')).map(f => fs.readFileSync(path.join(cwd, 'document', f), 'utf8')).join('');
    fs.appendFileSync(${JSON.stringify(join(root, 'judge-seen.jsonl'))}, JSON.stringify({ sizes, document, expected: fs.existsSync(path.join(cwd, 'expected-answer.md')) }) + '\\n');
    result = 'Here are the verdicts. ' + JSON.stringify({ verdicts: items.map(i => ({ id: i.id, verdict: i.text.includes('(met)') ? 'met' : i.text.includes('(partly)') ? 'partly' : 'not_met', quote: '', reason: 'By the word.' })) });
  } else if (prompt.startsWith('You write an expert')) {
    log('writer');
    const output = fs.readdirSync(path.join(cwd, 'output')).map(f => fs.readFileSync(path.join(cwd, 'output', f), 'utf8')).join('');
    const expected = JSON.parse(fs.readFileSync(path.join(cwd, 'expected-answer.md'), 'utf8')).answer;
    result = JSON.stringify({ correction: Number(output) === expected ? null : fs.readFileSync(path.join(cwd, 'instruction.md'), 'utf8').trim() + ' ' + output });
  } else if (prompt.startsWith('You maintain the instructions')) {
    log('builder');
    const correction = fs.readFileSync(path.join(cwd, 'correction.md'), 'utf8').trim();
    const wrong = Object.fromEntries(fs.readdirSync(path.join(cwd, 'wrong-output')).map(f => [f, fs.readFileSync(path.join(cwd, 'wrong-output', f), 'utf8')]));
    fs.appendFileSync(${JSON.stringify(join(root, 'builder-seen.jsonl'))}, JSON.stringify({ correction, wrong, instructions: fs.readFileSync(path.join(cwd, 'instructions.md'), 'utf8'), task: fs.readFileSync(path.join(cwd, 'task.md'), 'utf8') }) + '\\n');
    if (!correction.includes('[keep]')) fs.appendFileSync(path.join(cwd, 'instructions.md'), '\\n- ' + correction);
  } else {
    log('task');
    if (fs.existsSync(path.join(cwd, 'docs'))) for (const f of fs.readdirSync(path.join(cwd, 'docs')).sort()) read(path.join(cwd, 'docs', f));
    const target = /Hand in your work as the file (\\S+) in your working folder\\./.exec(prompt)?.[1];
    const value = JSON.parse(prompt.slice(prompt.indexOf('Input:') + 6, prompt.indexOf('Hand in')).trim()).n;
    const told = prompt.split('\\n').filter(l => l.startsWith('- ')).length;
    if (target) { fs.mkdirSync(path.dirname(path.join(cwd, target)), { recursive: true }); fs.writeFileSync(path.join(cwd, target), String(value * 3 + told)); }
  }
  out({ type: 'result', subtype: 'success', is_error: false, result, usage: { input_tokens: 100, output_tokens: 20 } });
});
`, { mode: 0o700 });
  // The sign-in that the clean room links when no token is in the environment (a stage runs as its own process).
  mkdirSync(join(process.env.HOME!, '.claude'), { recursive: true });
  writeFileSync(join(process.env.HOME!, '.claude', '.credentials.json'), '{}');
  process.env.PATH = `${bin}:${path}`;
  return { calls: () => lines(join(root, 'claude-calls.jsonl')), judged: () => lines(join(root, 'judge-seen.jsonl')), built: () => lines(join(root, 'builder-seen.jsonl')) };
}

/** A stand-in for Codex on PATH that logs each call; a comparison's judge must never call it. */
function codexStub(root: string) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('fs');
if (process.argv[2] === 'login') { console.log('Logged in'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(join(root, 'codex-calls'))}, 'x');
let prompt = '';
process.stdin.on('data', d => prompt += d).on('end', () => {
  const argv = process.argv.slice(2);
  fs.writeFileSync(${JSON.stringify(join(root, 'codex-seen.json'))}, JSON.stringify({ args: argv, files: fs.readdirSync(process.cwd(), { recursive: true }).sort() }));
  const target = /Hand in your work as the file (\\S+) in your working folder\\./.exec(prompt)?.[1];
  if (target) { fs.mkdirSync(require('path').dirname(target), { recursive: true }); fs.writeFileSync(target, '9'); }
  fs.writeFileSync(argv[argv.indexOf('--output-last-message') + 1], 'done');
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'done' } }));
});
`, { mode: 0o700 });
  mkdirSync(join(process.env.HOME!, '.codex'), { recursive: true });
  if (!existsSync(join(process.env.HOME!, '.codex', 'auth.json'))) writeFileSync(join(process.env.HOME!, '.codex', 'auth.json'), '{}');
  process.env.PATH = `${bin}:${process.env.PATH}`;
}

/**
 * A Method arm a that hands in work/answer.txt (n), records the web setting it ran with, and a plain arm that the file
 * names (Claude Code by default) with the instructions "Answer with three times n.". Each input has its own docs folder.
 */
function plainFixture(extra: Record<string, unknown> = {}, agent: 'claude' | 'codex' = 'claude') {
  const { root, file } = fixture();
  const armFile = join(root, 'a', 'agent.method');
  writeFileSync(armFile, JSON.stringify({ format: 'method/3.4', name: 'Agent a', goal: 'Answer with a number in a file.',
    inputs: { n: { type: 'number' } }, environment: { work: { type: 'files', description: 'Where the answer goes.' }, docs: { type: 'files', description: 'The briefs.' } },
    steps: { answer: { in: { n: 'inputs.n', work: 'environment.work' }, changes: ['environment.work'], do: { kind: 'run', runtime: 'node', entrypoint: 'answer.mjs' }, out: { value: { type: 'number' } } } }, result: 'value' }));
  writeFileSync(join(root, 'a', 'answer.mjs'), `import{appendFileSync,writeFileSync,readFileSync}from'node:fs';import{join}from'node:path';appendFileSync(${JSON.stringify(join(root, 'calls-a'))},'x');writeFileSync(${JSON.stringify(join(root, 'a-web'))},String(process.env.METHOD_WEB));const{n,work}=JSON.parse(readFileSync(0,'utf8'));writeFileSync(join(work,'answer.txt'),String(n));console.log(JSON.stringify({value:n}))`);
  for (const dir of ['work', 'docs']) mkdirSync(join(root, 'a', dir));
  writeFileSync(join(root, 'a', 'work', '.keep'), '');
  writeFileSync(join(root, 'a', 'docs', 'shared.md'), 'shared');
  for (const id of ['one', 'two']) { mkdirSync(join(root, 'inputs', id, 'docs'), { recursive: true }); writeFileSync(join(root, 'inputs', id, 'docs', `brief-${id}.md`), `brief ${id}`); }
  writeFileSync(join(root, 'plain.md'), 'Answer with three times n.');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...doc, arms: { a: doc.arms.a, plain: { agent, instructions: 'plain.md' } }, deliverable: 'work/answer.txt', ...extra }));
  return { root, file };
}

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
const question = (root: string, name: string) => readFileSync(join(root, 'runs', name, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).find(e => e.event === 'human.required')?.prompt as string;
const stagePlan = async (file: string) => JSON.parse(readFileSync((await compileComparison(file)).inputs, 'utf8')).comparison as string;

it('refuses a comparison with a missing part, more than one main measure, a rule that cannot say can\'t tell yet, or arms of one Method', () => {
  const { root, file } = fixture();
  const write = (value: unknown) => { writeFileSync(file, JSON.stringify(value)); return () => readComparison(file); };
  const good = JSON.parse(readFileSync(file, 'utf8'));
  const { question: _q, runs: _r, ...missing } = good;
  expect(write(missing)).toThrow(/It has no question\. .*It has no runs\./);
  expect(write({ ...good, measure: [good.measure, { name: 'other', code: 'size.mjs' }] })).toThrow(/more than one main measure/);
  expect(write({ ...good, measure: { name: 'size', code: 'size.mjs', person: 'Good?' } })).toThrow(/exactly one of code, rubric, checklist or person/);
  expect(write({ ...good, rule: { margin: 0, min_runs: 1 } })).toThrow(/margin above 0/);
  expect(write({ ...good, rule: 'B is better when it is clearly ahead' })).toThrow(/rule/);
  expect(write({ ...good, rule: { margin: 0.1, min_runs: 1, when: 'ahead' } })).toThrow(/Unknown part when in rule/);
  expect(write({ ...good, rule: { margin: 0.1, min_runs: 1, at: 3 } })).toThrow(/no treatment over time/);
  expect(write({ ...good, format: 'compare/1' })).toThrow(/Unknown part format/);
  expect(write({ ...good, decided_by_you: ['question', 'guard'] })).toThrow(/decided_by_you names guard, which is not a part of this file\./);
  expect(write({ ...good, measure: { name: 'size', code: 'size.mjs', covered: true } })).toThrow(/has covered, which only a checklist: expected measure can have/);
  expect(write({ ...good, measure: { name: 'items', checklist: 'expected' } })).toThrow(/the input inputs\/one\.json has none\. Add expected/);
  expect(write({ ...good, notes: { question: ['Asked by the support lead.'], measure: ['Every item counts the same.'] }, about_inputs: { noun: 'number', names: { 'inputs/one.json': 'One' } } })()).toBeTruthy();
  writeFileSync(join(root, 'a', 'agent.method'), JSON.stringify({ ...JSON.parse(readFileSync(join(root, 'a', 'agent.method'), 'utf8')), format: 'method/3.4', id: 'wf_' + 'a'.repeat(32) }));
  writeFileSync(join(root, 'b', 'agent.method'), JSON.stringify({ ...JSON.parse(readFileSync(join(root, 'b', 'agent.method'), 'utf8')), format: 'method/3.4', id: 'wf_' + 'a'.repeat(32) }));
  expect(write(good)).toThrow(/The arms a and b are the same Method \(wf_a+\)\. Each arm needs its own Method ID: run method new-id b\/agent\.method\./);
  const treatment = { ...good, treatment: { events: [{ correction: 'Say more.', input: 'inputs/three.json' }], checkpoints: [0, 1] } };
  expect(write(treatment)).toThrow(/the rule needs at/);
});

it('a plain arm hands in a file: the comparison needs a deliverable in a files connection of every Method arm', () => {
  const { file } = plainFixture({ deliverable: undefined });
  expect(() => readComparison(file)).toThrow(/The plain arm plain hands in a file, not its last message\. Add deliverable/);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...doc, deliverable: 'out/answer.txt' }));
  expect(() => readComparison(file)).toThrow(/The deliverable out\/answer\.txt is in out\/, which is not a files connection of the Method arm a \(work, docs\)/);
  writeFileSync(file, JSON.stringify({ ...doc, deliverable: 'work/{{name}}.txt' }));
  expect(() => readComparison(file)).toThrow(/names \{\{name\}\}, which the input does not give/);
  writeFileSync(file, JSON.stringify({ ...doc, deliverable: 'work/answer-{{n}}.txt' }));
  expect(readComparison(file).deliverable).toBe('work/answer-{{n}}.txt');
});

it('every arm runs on the same model: a plain arm takes the Method arm\'s model, and arms that differ are refused unless the model is tested', async () => {
  const { root, file } = plainFixture();
  const method = (models: unknown, steps: Record<string, unknown>) => ({ format: 'method/3.4', name: 'Agent a', goal: 'Write.', ...(models ? { models } : {}),
    environment: { work: { type: 'files', description: 'Where the answer goes.' }, docs: { type: 'files', description: 'The briefs.' } }, steps, result: Object.keys(steps).at(-1) === 'two' ? 'two' : 'one' });
  const step = (model?: string, out = 'text') => ({ do: { kind: 'agent', ...(model ? { model } : {}), prompt: 'Write.', tools: [] }, out: { [out]: { type: 'text' } } });
  const armFile = join(root, 'a', 'agent.method');
  writeFileSync(armFile, JSON.stringify({ ...method({ writer: { agent: 'claude', model: 'claude-opus-5-5', reasoning_effort: 'high' } }, { one: step('writer') }), result: 'text' }));
  const doc = readComparison(file);
  const same = await armModels(doc, root);
  expect(same.arms.plain).toEqual([{ agent: 'claude', model: 'claude-opus-5-5', effort: 'high' }]);
  // The compiled plain arm runs its session on that model and effort, and so does its builder.
  const { plan } = await compileComparison(file);
  const plain = plan.arms.find((a: any) => a.name === 'plain');
  for (const generated of [plain.method, plain.builder]) expect(JSON.parse(readFileSync(generated, 'utf8')).steps.work.do).toMatchObject({ agent: 'claude', model: 'claude-opus-5-5', reasoning_effort: 'high' });
  expect(plan.judge).toEqual({ agent: 'claude', model: 'claude-opus-5-5' });
  // Two models in the Method arm: a plain arm cannot take one.
  writeFileSync(armFile, JSON.stringify({ ...method({ writer: { agent: 'claude', model: 'claude-opus-5-5' }, checker: { agent: 'claude', model: 'claude-haiku' } }, { one: step('writer'), two: step('checker', 'checked') }), result: 'text' }));
  await expect(armModels(readComparison(file), root)).rejects.toThrow(/The Method arm a runs its steps on more than one model .*tested: model/);
  // A Codex Method arm against a plain Claude Code arm differs in its model.
  writeFileSync(armFile, JSON.stringify({ ...method({ writer: { agent: 'codex', model: 'gpt-5.5' } }, { one: step('writer') }), result: 'text' }));
  await expect(armModels(readComparison(file), root)).rejects.toThrow(/The Method arm a runs on Codex \(gpt-5\.5\), and the plain arm plain is Claude Code\./);
  // A plain arm names its own model only when the model is the tested difference.
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...raw, arms: { ...raw.arms, plain: { agent: 'claude', instructions: 'plain.md', model: 'claude-haiku' } } }));
  expect(() => readComparison(file)).toThrow(/names its model or effort.*tested: model/);
  writeFileSync(file, JSON.stringify({ ...raw, tested: 'model', arms: { ...raw.arms, plain: { agent: 'claude', instructions: 'plain.md', model: 'claude-haiku' } } }));
  expect((await armModels(readComparison(file), root)).arms.plain).toEqual([{ agent: 'claude', model: 'claude-haiku', effort: null }]);
  // Two Method arms on different models.
  const { root: two, file: twoFile } = fixture();
  for (const [arm, model] of [['a', 'claude-opus-5-5'], ['b', 'claude-haiku']]) writeFileSync(join(two, arm!, 'agent.method'), JSON.stringify({ format: 'method/3.4', name: `Agent ${arm}`, goal: 'Write.', models: { writer: { agent: 'claude', model } }, steps: { one: step('writer') }, result: 'text' }));
  await expect(armModels(readComparison(twoFile), two)).rejects.toThrow(/The arms a and b run on different models/);
}, 600_000);

it('runs a plain arm as one session in a clean room with the same task prompt and no web, and reads the file it hands in, not its last message', async () => {
  const { root, file } = plainFixture();
  const claude = claudeStub(root);
  // The Method arm has a Claude Code step too, on the agent's default model.
  const armFile = join(root, 'a', 'agent.method'), method = JSON.parse(readFileSync(armFile, 'utf8'));
  method.steps = { check: { do: { kind: 'agent', prompt: 'Say ok.', tools: [] }, out: { ok: { type: 'text' } } }, ...method.steps };
  writeFileSync(armFile, JSON.stringify(method));
  const result = await runComparison(root, file, 'first');
  expect(result.status).toBe('completed');
  const tasks = claude.calls().filter(c => c.kind === 'task');
  // The trial runs each arm at the start with 2 learners on the trial input; the full run reuses learner 1.
  expect(tasks).toHaveLength(3);
  expect(tasks[0].prompt).toBe('Answer with three times n.\n\nInput:\n{\n  "n": 1\n}\n\nHand in your work as the file work/answer.txt in your working folder.');
  // Its room holds the input's own docs and the Method arm's work folder; its tools are the file tools, without the web.
  expect(tasks[0].files).toEqual(['docs', 'docs/brief-one.md', 'work', 'work/.keep']);
  // A clean room: a fresh home, not the user's.
  expect(tasks[0].home).not.toBe(process.env.HOME);
  expect(tasks[0].home).toMatch(/\/mr-[^/]+\/home$/);
  expect(tasks[0].args[tasks[0].args.indexOf('--tools') + 1]).toBe('Read,Write,Edit,Glob,Grep');
  // The Method arm's Claude Code step ran without web search and fetch.
  const step = claude.calls().find(c => c.kind === 'step');
  expect(step.args[step.args.indexOf('--disallowedTools') + 1]).toBe('WebSearch,WebFetch');
  expect(step.args[step.args.indexOf('--allowedTools') + 1]).not.toContain('WebSearch');
  // The plain arm handed in 3n (its last message was "done"): plain is ahead of a by 0.30 per input.
  expect(result.result).toMatch(/^plain Claude Code is better: plain Claude Code is ahead of Method agent by 0\.30 on size/);
  expect(question(root, 'first')).toMatch(/plain Claude Code: Model: stub-default\. Inputs run: 2 of 2\./);
  expect(question(root, 'first')).toContain('Noise at the start: two learners of the same arm differ by up to 0 on size');
}, 600_000);

it('a Codex plain arm hands in its file too, and has no web search', async () => {
  const { root, file } = plainFixture({}, 'codex');
  codexStub(root);
  const result = await runComparison(root, file, 'first');
  expect(result.result).toMatch(/^plain Codex is better: plain Codex is ahead of Method agent by 0\.\d+ on size/);
  const seen = JSON.parse(readFileSync(join(root, 'codex-seen.json'), 'utf8'));
  expect(seen.args.join(' ')).toContain('web_search="disabled"');
  // The plain arm ran input two last: its room holds input two's folder, and nothing of input one's.
  expect(seen.files).toEqual(['docs', 'docs/brief-two.md', 'work', 'work/.keep']);
}, 600_000);

it('a plain arm with corrections is a builder: after each correction a session gets the correction and the wrong output of a training run, and edits the instructions', async () => {
  const { root, file } = plainFixture({ teaching: ['inputs/three.json'], rule: { margin: 0.1, min_runs: 1, at: 2 },
    treatment: { events: [{ correction: 'Add one, because the count starts at one.', input: 'inputs/three.json' }, { input: 'inputs/three.json' }, { correction: 'Keep it. [keep]', input: 'inputs/three.json' }], checkpoints: [0, 2, 3] } });
  const claude = claudeStub(root);
  delivery.deliver = async () => ({ received: true, outcome: 'fixed' });
  // Method's rules name each arm as the page does.
  expect((await compileComparison(file)).spec.method_rules.filter((r: any) => r.part === 'arms').map((r: any) => r.text.split(':')[0])).toEqual([
    'Plain Claude Code', 'Method agent']);
  const comparison = await stagePlan(file);
  const treated = JSON.parse((await compareStage('treat', { comparison, go: true })).treatment as string);
  const plain = treated.find((t: any) => t.arm === 'plain').learners[0];
  // The first correction: a training run, then the builder saw the correction, the task and the wrong output (9 = 3 × 3).
  const built = claude.built();
  expect(built[0]).toMatchObject({ correction: 'Add one, because the count starts at one.', wrong: { 'answer.txt': '9' }, instructions: 'Answer with three times n.' });
  expect(built[0].task).toContain('Hand in your work as the file work/answer.txt');
  expect(claude.calls().filter(c => c.kind === 'task')).toHaveLength(2);
  // The edited file is the arm's state; the second correction left it as it was. Nothing is appended by Method.
  expect(plain.snapshots['0'].plain.instructions).toBe('Answer with three times n.');
  expect(plain.snapshots['2'].plain.instructions).toBe('Answer with three times n.\n- Add one, because the count starts at one.');
  expect(plain.snapshots['3'].plain.instructions).toBe(plain.snapshots['2'].plain.instructions);
  expect(plain.events.map((e: any) => [e.index, e.outcome, e.received])).toEqual([[1, 'edited', true], [2, 'given', true], [3, 'not_edited', true]]);
  expect(JSON.stringify(treated)).not.toContain('Corrections to follow');
  // The builder used the file tools and no web; usage per correction counts its tokens (training run and edit).
  expect(claude.calls().filter(c => c.kind === 'builder')[0].args.join(' ')).toContain('--tools Read,Write,Edit,Glob,Grep');
  expect(plain.events[0].tokens).toBe(240);
  // Each run at a checkpoint runs the instructions as the builder left them, and says what it received.
  const cells = ((await compareStage('plan', { comparison, go: true, treated: JSON.stringify(treated) })).cells as string[]).map(c => JSON.parse(c)).filter((c: any) => c.arm === 'plain');
  expect(cells.find((c: any) => c.checkpoint === 3).plain.instructions).toContain('- Add one');
  expect(cells.find((c: any) => c.checkpoint === 3).treatment_note).toBe('Copy 1. After each correction a Claude Code session edited the agent\'s instructions. The corrections, one at a time, in this order:\n1. Correction on three: Add one, because the count starts at one. (edited)\n2. New input: three\n3. Correction on three: Keep it. [keep] (not edited)');
}, 600_000);

it('a feedback writer writes each arm\'s correction from its own training-run output and the hidden answer; nothing wrong is received as was right', async () => {
  // Expected answer of the teaching input: 9. The writer says what is wrong with the number, or nothing when it is right.
  const { root, file } = plainFixture();
  writeFileSync(join(root, 'expected-three.json'), JSON.stringify({ answer: 9 }));
  writeFileSync(join(root, 'writer.mjs'), `import{appendFileSync,readFileSync}from'node:fs';const raw=readFileSync(0,'utf8');appendFileSync(${JSON.stringify(join(root, 'writer-seen.jsonl'))},raw+'\\n');const{output,expected}=JSON.parse(raw);console.log(JSON.stringify({correction:Number(output)===expected.answer?null:'The number '+output+' is wrong.'}))`);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...doc, teaching: ['inputs/three.json'], rule: { margin: 0.1, min_runs: 1, at: 3 }, expected: { 'inputs/three.json': 'expected-three.json' },
    treatment: { feedback_writers: { expert: { code: 'writer.mjs' } }, checkpoints: [0, 3],
      events: [{ feedback: 'expert', input: 'inputs/three.json' }, { feedback: 'expert', input: 'inputs/three.json' }, { correction: 'Fixed words.', input: 'inputs/three.json' }] } }));
  const claude = claudeStub(root);
  // A stand-in for the method CLI: the Method arm hands in 3n + 1 until it is first judged wrong, then 3n.
  writeFileSync(join(root, 'bin', 'method'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const argv = process.argv.slice(2), log = ${JSON.stringify(join(root, 'method-calls.jsonl'))};
const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
fs.appendFileSync(log, JSON.stringify(argv) + '\\n');
if (argv[0] === 'run') {
  const runDir = argv[argv.indexOf('--run-dir') + 1], n = JSON.parse(fs.readFileSync(argv[argv.indexOf('--inputs') + 1], 'utf8')).n;
  fs.writeFileSync(path.join(path.dirname(argv[1]), 'work', 'answer.txt'), String(3 * n + (before.includes('"wrong"') ? 0 : 1)));
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify({ status: 'completed' }));
  fs.writeFileSync(path.join(runDir, 'method-sync.json'), JSON.stringify({ dashboard_id: 'run_' + before.split('\\n').length }));
} else if (argv[0] === 'judge') console.log(JSON.stringify({ judgment: { id: 'jdg_' + before.split('\\n').length }, fix: { status: 'working' } }));
else if (argv[0] === 'wait') console.log(JSON.stringify({ outcomes: [{ status: 'done', outcome: { outcome: 'fixed' } }] }));
`, { mode: 0o700 });
  const compiled = await compileComparison(file);
  expect(compiled.spec.treatment!.list![0]!.text).toBe('The feedback writer expert reads the agent\'s own output and the hidden expected answer, and writes this correction.');
  expect(compiled.spec.decisions.find((d: any) => d.what === 'feedback writer')).toMatchObject({ part: 'treatment', value: 'expert: the script writer.mjs', by: 'writer' });
  expect(compiled.spec.method_rules.map((r: any) => r.text)).toEqual(expect.arrayContaining(['When the feedback writer finds nothing wrong, the agent is told that its output was right, and the event counts as received (was right).']));
  const comparison = await stagePlan(file);
  const treated = JSON.parse((await compareStage('treat', { comparison, go: true })).treatment as string);
  const events = (arm: string) => treated.find((t: any) => t.arm === arm).learners[0].events.map((e: any) => [e.outcome, e.text]);
  // The Method arm handed in 10, then 9: it was judged wrong with the writer's words about its own output, then right.
  expect(events('a')).toEqual([['fixed', 'The number 10 is wrong.'], ['was_right', 'right'], ['fixed', 'Fixed words.']]);
  const judged = lines(join(root, 'method-calls.jsonl')).filter((c: string[]) => c[0] === 'judge').map((c: string[]) => c.slice(2));
  expect(judged).toEqual([['wrong', '--note', 'The number 10 is wrong.', '--json'], ['right', '--json'], ['wrong', '--note', 'Fixed words.', '--json']]);
  // The plain arm handed in 9 (right: the builder reads that it is right), then 10 (one line more in its instructions).
  expect(events('plain')).toEqual([['was_right', 'Right: the person checked this work and found nothing wrong.'], ['edited', 'The number 10 is wrong.'], ['edited', 'Fixed words.']]);
  expect(claude.built().map(b => [b.correction, b.wrong])).toEqual([['Right: the person checked this work and found nothing wrong.', { 'answer.txt': '9' }],
    ['The number 10 is wrong.', { 'answer.txt': '10' }], ['Fixed words.', { 'answer.txt': '11' }]]);
  // The writer read the input, the arm's output and the hidden answer, and nothing about the arm; the arms never got the answer.
  const seen = lines(join(root, 'writer-seen.jsonl'));
  expect(seen).toHaveLength(4);
  for (const s of seen) expect(Object.keys(s).sort()).toEqual(['expected', 'input', 'output', 'values']);
  expect(seen.map(s => [s.input, s.values, s.expected])).toEqual(Array(4).fill(['inputs/three.json', { n: 3 }, { answer: 9 }]));
  expect(claude.calls().filter(c => c.kind === 'task').map(c => c.prompt).join('')).not.toContain('answer":9');
  // Each copy's page and run notes show the words that it received.
  const result = decide(JSON.parse(comparison), [], treated);
  expect(result.received.a.corrections.map((c: any) => [c.index, c.text, c.outcome])).toEqual([[1, 'The number 10 is wrong.', 'fixed'], [2, 'right', 'was_right'], [3, 'Fixed words.', 'fixed']]);
  expect(result.received.plain.corrections.map((c: any) => c.text)).toEqual(['Right: the person checked this work and found nothing wrong.', 'The number 10 is wrong.', 'Fixed words.']);
  expect(result.text).toContain('Corrections received: 3 of 3 (2 fixed, 1 was right)');
  const cells = ((await compareStage('plan', { comparison, go: true, treated: JSON.stringify(treated) })).cells as string[]).map(c => JSON.parse(c));
  expect(cells.find((c: any) => c.arm === 'a' && c.checkpoint === 3).treatment_note).toContain('1. Correction on three: The number 10 is wrong. (fixed)\n2. Correction on three: right (was right)');
  // A rerun gives nothing again; a changed writer is a new treatment, with new run keys.
  await compareStage('treat', { comparison, go: true });
  expect(lines(join(root, 'writer-seen.jsonl'))).toHaveLength(4);
  appendFileSync(join(root, 'writer.mjs'), '\n// changed\n');
  const changed = await stagePlan(file);
  expect(JSON.parse(changed).feedback_hash).not.toBe(JSON.parse(comparison).feedback_hash);
  const keys = async (plan: string) => ((await compareStage('trial_plan', { comparison: plan, treated: JSON.stringify(treated) })).trial_cells as string[]).map(c => JSON.parse(c).key).sort();
  expect(await keys(changed)).not.toEqual(await keys(comparison));
  // A feedback event needs its writer and the input's hidden answer.
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), expected: {}, treatment: { feedback_writers: { expert: { code: 'writer.mjs' } }, checkpoints: [0, 1], events: [{ feedback: 'other', input: 'inputs/three.json' }] } }));
  expect(() => readComparison(file)).toThrow(/Event 1 names the feedback writer other, which is not one of treatment\.feedback_writers \(expert\)\. Event 1: the feedback writer reads the hidden expected answer of inputs\/three\.json, and it has none\./);
}, 600_000);

it('a judge feedback writer is one Claude session that reads the task, the output, the hidden answer and the instruction, in a folder that names no arm', async () => {
  const { root, file } = plainFixture();
  writeFileSync(join(root, 'expected-three.json'), JSON.stringify({ answer: 9 }));
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...doc, teaching: ['inputs/three.json'], rule: { margin: 0.1, min_runs: 1, at: 1 }, expected: { 'inputs/three.json': 'expected-three.json' },
    treatment: { feedback_writers: { expert: { judge: 'Say which number is wrong:' } }, checkpoints: [0, 1], events: [{ feedback: 'expert', input: 'inputs/three.json' }] } }));
  const claude = claudeStub(root);
  const event = JSON.parse(await stagePlan(file)).events[0];
  const write = (output: string | null) => feedbackWriting.write(event.feedback, { input: event.input, task: 'Do it.', output, outputName: 'answer.txt' });
  expect(await write('10')).toBe('Say which number is wrong: 10');
  expect(await write('9')).toBeNull();
  const call = claude.calls().find(c => c.kind === 'writer')!;
  expect(call.files).toEqual(['expected-answer.md', 'instruction.md', 'output', 'output/answer.txt', 'task.md']);
  expect(JSON.stringify(call)).not.toMatch(/arms|plain|learner/);
}, 600_000);

it('decided_by_you names the notes of a part as notes.PART', () => {
  const { file } = fixture({ notes: { inputs: ['Each input runs alone.'] }, decided_by_you: ['notes.inputs'] });
  expect(decisions(readComparison(file)).find(d => d.what === 'note')).toMatchObject({ part: 'inputs', by: 'you' });
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...raw, decided_by_you: ['notes.rule'] }));
  expect(() => readComparison(file)).toThrow(/decided_by_you names notes\.rule, which is not a part of this file/);
});

it('a teaching input with its own folder gives its training runs that folder in place of the arms\' folders of that name, for a Method arm and a builder alike', async () => {
  const { root, file } = plainFixture({ teaching: ['inputs/three.json'], rule: { margin: 0.1, min_runs: 1, at: 2 },
    treatment: { events: [{ input: 'inputs/three.json' }, { correction: 'Add one.', input: 'inputs/three.json' }], checkpoints: [0, 2] } });
  mkdirSync(join(root, 'inputs', 'three', 'docs'), { recursive: true });
  writeFileSync(join(root, 'inputs', 'three', 'docs', 'brief-three.md'), 'brief three');
  const claude = claudeStub(root);
  // A stand-in for the method CLI: a training run logs what is beside the learner's Method, and completes unsaved.
  writeFileSync(join(root, 'bin', 'method'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const argv = process.argv.slice(2), file = argv[1], runDir = argv[argv.indexOf('--run-dir') + 1];
fs.appendFileSync(${JSON.stringify(join(root, 'method-calls.jsonl'))}, JSON.stringify({ files: fs.readdirSync(path.dirname(file), { recursive: true }).sort() }) + '\\n');
fs.mkdirSync(runDir, { recursive: true }); fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify({ status: 'completed' }));
`, { mode: 0o700 });
  const comparison = await stagePlan(file);
  const treated = JSON.parse((await compareStage('treat', { comparison, go: true })).treatment as string);
  // The Method arm's training run: input three's docs in place of the arm's docs, and the arm's own work folder.
  const beside = lines(join(root, 'method-calls.jsonl'))[0].files;
  expect(beside).toEqual(expect.arrayContaining(['docs/brief-three.md', 'work/.keep']));
  expect(beside.filter((f: string) => f.startsWith('docs/'))).toEqual(['docs/brief-three.md']);
  // After the event the copies are gone: the learner's frozen copies hold only the Method.
  const learner = treated.find((t: any) => t.arm === 'a').learners[0];
  expect(learner.events[0]).toMatchObject({ outcome: 'given', received: true });
  expect(existsSync(join(learner.snapshots['0'].dir, 'docs'))).toBe(false);
  expect(existsSync(join(learner.snapshots['0'].dir, '..', 'method', 'docs'))).toBe(false);
  // The builder's training run works on the same folders.
  expect(claude.calls().filter(c => c.kind === 'task')[0].files).toEqual(['docs', 'docs/brief-three.md', 'work', 'work/.keep']);
  // A teaching input's folder holds folders named after files connections, as a measured input's does.
  writeFileSync(join(root, 'inputs', 'three', 'loose.md'), 'x');
  expect(() => readComparison(file)).toThrow(/The folder of the input inputs\/three\.json holds the file loose\.md/);
}, 600_000);

it('runs counts separate learners: each Method learner has its own Method ID, folder and cache, and gets every correction one at a time', async () => {
  const { file } = fixture({ teaching: ['inputs/three.json'], runs: 2, rule: { margin: 0.1, min_runs: 2, at: 2 },
    treatment: { events: [{ correction: 'One.', input: 'inputs/three.json' }, { correction: 'Two.', input: 'inputs/three.json' }], checkpoints: [0, 2] } });
  const log: Array<{ learner: string; index: number; at: 'start' | 'end'; cache: string }> = [];
  delivery.deliver = async (event: any, learner, cache) => {
    log.push({ learner: learner.dir, index: event.index, at: 'start', cache });
    await new Promise(done => setTimeout(done, 20));
    log.push({ learner: learner.dir, index: event.index, at: 'end', cache });
    return { received: true, outcome: event.index === 1 ? 'fixed' : 'no_change_needed' };
  };
  const comparison = await stagePlan(file);
  const treated = JSON.parse((await compareStage('treat', { comparison, go: true })).treatment as string);
  const learners = [...new Set(log.map(l => l.learner))];
  // 2 arms × 2 learners, each its own copy with its own Method ID and cache.
  expect(learners).toHaveLength(4);
  const ids = learners.map(dir => /id: (wf_[a-f0-9]{32})/.exec(readFileSync(join(dir, 'agent.method'), 'utf8'))?.[1] ?? JSON.parse(readFileSync(join(dir, 'agent.method'), 'utf8')).id);
  expect(new Set(ids).size).toBe(4);
  expect(new Set(log.map(l => l.cache)).size).toBe(4);
  // Within a learner, each correction ends before the next starts.
  for (const learner of learners) expect(log.filter(l => l.learner === learner).map(l => `${l.index}${l.at}`)).toEqual(['1start', '1end', '2start', '2end']);
  // Each checkpoint measures each learner once per input: 2 arms × 2 checkpoints × 2 learners × 2 inputs.
  const cells = ((await compareStage('plan', { comparison, go: true, treated: JSON.stringify(treated) })).cells as string[]).map(c => JSON.parse(c));
  expect(cells).toHaveLength(16);
  expect(new Set(cells.filter(c => c.arm === 'a' && c.checkpoint === 2).map(c => c.dir)).size).toBe(2);
  expect(cells.filter(c => c.arm === 'a' && c.checkpoint === 2).map(c => c.repeat).sort()).toEqual([0, 0, 1, 1]);
}, 600_000);

it('says what happened to each correction for each learner; could not test and a stopped fix are not received, and the trial stops', async () => {
  expect([fixOutcome('fixed'), fixOutcome('not_reproduced'), fixOutcome('no_fix_found'), fixOutcome('could_not_test'), fixOutcome('question'), fixOutcome(undefined)]).toEqual([
    { received: true, outcome: 'fixed' }, { received: true, outcome: 'no_change_needed' }, { received: true, outcome: 'no_fix_found' },
    { received: false, outcome: 'could_not_test' }, { received: false, outcome: 'question' }, { received: false, outcome: 'stopped' }]);
  const { root, file } = fixture({ teaching: ['inputs/three.json'], rule: { margin: 0.1, min_runs: 1, at: 5 },
    treatment: { events: [1, 2, 3, 4, 5].map(i => ({ correction: `Correction ${i}.`, input: 'inputs/three.json' })), checkpoints: [0, 5] } });
  // Every correction reaches arm a; the fifth one could not be tested for arm b.
  delivery.deliver = async (event: any, learner) => learner.dir.includes(join('arms', 'b')) && event.index === 5
    ? { received: false, outcome: 'could_not_test', reason: 'Method\'s fix could not test a change', detail: 'the case needs a file.' } : { received: true, outcome: event.index === 2 ? 'no_fix_found' : 'fixed' };
  const comparison = await stagePlan(file);
  const treated = (await compareStage('trial_treat', { comparison })).trial_treatment as string;
  const arms = JSON.parse(treated);
  // The trial treats the first learner; the second noise learner starts as the arm is.
  expect(arms.map((t: any) => t.learners.map((l: any) => l.events.length))).toEqual([[5, 0], [5, 0]]);
  expect(Object.keys(arms[0].learners[0].snapshots)).toEqual(['0', '5']);
  expect(Object.keys(arms[1].learners[0].snapshots)).toEqual(['0']);
  const runs = ['a', 'b'].flatMap(arm => [0, 1].map(repeat => JSON.stringify({ arm, input: 'inputs/one.json', repeat, checkpoint: 0, result: 1, run_dir: root, duration_ms: 10, cost_usd: null })));
  await expect(compareStage('check', { comparison, runs, treated, grades: [] })).rejects.toThrow(
    /The trial stopped: an arm did not receive everything\.\nAgent b: Inputs run: 2 of 2\. Corrections received: 4 of 5 \(3 fixed, 1 no fix found, 1 could not test\)\. Missing: correction 5 \(“Correction 5\.”\) was not received: Method's fix could not test a change: the case needs a file\.\nFix the cause/);
  // A rerun gives only the missing correction again.
  let given = 0;
  delivery.deliver = async () => { given++; return { received: true, outcome: 'no_change_needed' }; };
  const again = JSON.parse((await compareStage('trial_treat', { comparison })).trial_treatment as string);
  expect(given).toBe(1);
  expect(again[1].learners[0].events.map((e: any) => e.outcome)).toEqual(['fixed', 'no_fix_found', 'fixed', 'fixed', 'no_change_needed']);
  // The result of a full run with a short arm says what is missing and gives no verdict.
  const grades = ['a', 'b'].flatMap(arm => [0, 5].flatMap(checkpoint => ['inputs/one.json', 'inputs/two.json'].map(input => ({ arm, input, repeat: 0, checkpoint, scores: { size: arm === 'b' ? 0.9 : 0.1 } }))));
  const result = decide(JSON.parse(comparison), grades, arms);
  expect(result.answer).toBe("Can't tell yet");
  expect(result.text).toMatch(/^Can't tell yet: Agent b did not receive its full treatment/);
  expect(result.text).toContain('SHORT Agent b: Inputs run: 4 of 4. Corrections received: 4 of 5');
  // Each correction of each learner, with its outcome, counted from 1.
  expect(result.received.b.corrections[4]).toEqual({ index: 5, input: 'inputs/three.json', text: 'Correction 5.', outcome: 'could_not_test', received: false, learner: 1, reason: 'Method\'s fix could not test a change' });
  // The page's line says what happened in plain words, without the cause's details.
  expect(result.received.b.lines[1]!.missing).toEqual(['Correction 5 (“Correction 5.”) was not received: Method\'s fix could not test a change.']);
  expect(result.text).toContain('Each arm received its full treatment: checked by Method: no.');
});

/**
 * A stand-in for the method CLI that a Method learner's correction uses: run completes a saved training run, judge
 * starts judgment jdg_N, and wait answers from outcomes.json: the outcome of that judgment, else the default.
 */
function methodStub(root: string) {
  writeFileSync(join(root, 'bin', 'method'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const argv = process.argv.slice(2), log = ${JSON.stringify(join(root, 'method-calls.jsonl'))};
fs.appendFileSync(log, JSON.stringify(argv.slice(0, 2)) + '\\n');
if (argv[0] === 'run') {
  const runDir = argv[argv.indexOf('--run-dir') + 1];
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify({ status: 'completed' }));
  fs.writeFileSync(path.join(runDir, 'method-sync.json'), JSON.stringify({ dashboard_id: 'run_' + Date.now() }));
} else if (argv[0] === 'judge') {
  const n = fs.readFileSync(log, 'utf8').split('\\n').filter(l => l.startsWith('["judge"')).length;
  console.log(JSON.stringify({ judgment: { id: 'jdg_' + n }, fix: { status: 'working' } }));
} else if (argv[0] === 'wait') {
  const outcomes = JSON.parse(fs.readFileSync(${JSON.stringify(join(root, 'outcomes.json'))}, 'utf8'));
  console.log(JSON.stringify({ outcomes: [outcomes[argv[1]] ?? outcomes.default] }));
}
`, { mode: 0o700 });
  const calls = () => lines(join(root, 'method-calls.jsonl')).map((c: string[]) => c[0]);
  return { outcomes: (value: Record<string, unknown>) => writeFileSync(join(root, 'outcomes.json'), JSON.stringify(value)), calls };
}

it('a rerun gives a correction again when its fix stopped, but waits for the same judgment while the fix waits for an answer, and records each outcome once', async () => {
  const { root, file } = fixture({ teaching: ['inputs/three.json'], rule: { margin: 0.1, min_runs: 1, at: 1 },
    treatment: { events: [{ correction: 'It needs to be bigger because small is wrong.', input: 'inputs/three.json' }], checkpoints: [0, 1] } });
  claudeStub(root);
  const method = methodStub(root);
  const comparison = await stagePlan(file);
  const treat = async () => JSON.parse((await compareStage('trial_treat', { comparison })).trial_treatment as string);
  const record = (arm: string) => lines(join(JSON.parse(comparison).folder, 'arms', arm, readdirSync(join(JSON.parse(comparison).folder, 'arms', arm)).find(d => d.startsWith('treatment-'))!, 'learner-1', 'treatment.jsonl'));
  // The fix stops in Method's own code: not received, said in plain words; the cause is kept for the CLI.
  method.outcomes({ default: { status: 'stopped', error: 'In step "Find the step by trying" (task 1 of 1), the script steps/locate.mjs exited with code 1.' } });
  const first = await treat();
  expect(first[0].learners[0].events[0]).toMatchObject({ received: false, outcome: 'stopped', reason: 'Method\'s fix stopped before it finished', detail: expect.stringContaining('steps/locate.mjs') });
  expect(method.calls().filter(c => c === 'judge')).toHaveLength(2);
  // A rerun: the old fix is over, so each arm gets the correction again, with a new training run and a new judgment.
  method.outcomes({ jdg_1: { status: 'stopped', error: 'x' }, jdg_2: { status: 'stopped', error: 'x' }, default: { status: 'done', outcome: { outcome: 'fixed' } } });
  const second = await treat();
  expect(second.map((t: any) => t.learners[0].events[0].outcome)).toEqual(['fixed', 'fixed']);
  expect(method.calls().filter(c => c === 'judge')).toHaveLength(4);
  expect(method.calls().filter(c => c === 'run')).toHaveLength(4);
  expect(record('a').map((r: any) => r.outcome)).toEqual(['stopped', 'fixed']);

  // A fix that asks a question waits for the person's answer: a rerun waits for the same judgment and judges nothing again.
  const other = fixture({ teaching: ['inputs/three.json'], rule: { margin: 0.1, min_runs: 1, at: 1 },
    treatment: { events: [{ correction: 'It needs a unit because readers ask.', input: 'inputs/three.json' }], checkpoints: [0, 1] } });
  claudeStub(other.root);
  const asking = methodStub(other.root);
  const plan = await stagePlan(other.file), folder = JSON.parse(plan).folder;
  const records = () => readdirSync(join(folder, 'arms')).map(arm => lines(join(folder, 'arms', arm, readdirSync(join(folder, 'arms', arm)).find(d => d.startsWith('treatment-'))!, 'learner-1', 'treatment.jsonl')).map((r: any) => r.outcome));
  asking.outcomes({ default: { status: 'done', outcome: { outcome: 'question', question: 'Which unit?' } } });
  await compareStage('trial_treat', { comparison: plan });
  await compareStage('trial_treat', { comparison: plan });
  expect(asking.calls().filter(c => c === 'judge')).toHaveLength(2);
  expect(asking.calls().filter(c => c === 'wait')).toHaveLength(4);
  expect(records()).toEqual([['question'], ['question']]);
  // After the answer the fix ends fixed: the same judgment, received.
  asking.outcomes({ default: { status: 'done', outcome: { outcome: 'fixed' } } });
  const answered = JSON.parse((await compareStage('trial_treat', { comparison: plan })).trial_treatment as string);
  expect(answered.map((t: any) => t.learners[0].events[0].outcome)).toEqual(['fixed', 'fixed']);
  expect(asking.calls().filter(c => c === 'judge')).toHaveLength(2);
  expect(records()).toEqual([['question', 'fixed'], ['question', 'fixed']]);
}, 600_000);

it('says what an agent missed once, in plain words: the correction that was not received, cut at a word, and one line for the corrections after it', async () => {
  const long = 'The video script to the general counsel should do this: uses the facts of the incident correctly and states no other facts.';
  const { file } = fixture({ teaching: ['inputs/three.json'], rule: { margin: 0.1, min_runs: 1, at: 4 },
    treatment: { events: [long, 'Two.', 'Three.', 'Four.'].map(correction => ({ correction, input: 'inputs/three.json' })), checkpoints: [0, 4] } });
  delivery.deliver = async (_event: any, learner) => learner.dir.includes(join('arms', 'b'))
    ? { received: false, outcome: 'stopped', reason: 'Method\'s fix stopped before it finished', detail: 'In step "Find the step by trying", the script steps/locate.mjs exited with code 1.' } : { received: true, outcome: 'fixed' };
  const comparison = await stagePlan(file);
  const treated = JSON.parse((await compareStage('trial_treat', { comparison })).trial_treatment as string);
  const result = decide(JSON.parse(comparison), [], treated);
  // The trial teaches one copy, so no copy is named.
  expect(result.received.b.lines[1]!.missing).toEqual([
    'Correction 1 (“The video script to the general counsel should do this: uses…”) was not received: Method\'s fix stopped before it finished.',
    'Corrections 2 to 4 were not given, because correction 1 did not arrive.']);
  // The CLI keeps the cause, for the agent that fixes it.
  expect(result.text).toContain('Missing: correction 1 (“The video script to the general counsel should do this: uses…”) was not received: Method\'s fix stopped before it finished: In step "Find the step by trying", the script steps/locate.mjs exited with code 1.');
  expect(clipWords('one two three four', 9)).toBe('one two…');
}, 600_000);

it('measures the noise at the start with two learners per arm, and stops before approval when it is more than half the margin', async () => {
  const { file } = fixture({ rule: { margin: 0.1, min_runs: 1 }, trial: 2 });
  const comparison = await stagePlan(file);
  const plan = JSON.parse(comparison);
  // The trial plans each arm on the trial inputs with 2 learners.
  const trial = ((await compareStage('trial_plan', { comparison })).trial_cells as string[]).map(c => JSON.parse(c));
  expect(trial.map(c => `${c.arm} ${c.repeat} ${c.input.id}`).sort()).toEqual(['a 0 inputs/one.json', 'a 0 inputs/two.json', 'a 1 inputs/one.json', 'a 1 inputs/two.json',
    'b 0 inputs/one.json', 'b 0 inputs/two.json', 'b 1 inputs/one.json', 'b 1 inputs/two.json']);
  const grades = (b1: number) => ['a', 'b'].flatMap(arm => [0, 1].flatMap(repeat => ['inputs/one.json', 'inputs/two.json'].map(input => ({ arm, input, repeat, checkpoint: null, scores: { size: arm === 'b' && repeat === 1 ? b1 : 0.5 } }))));
  expect(noiseCheck(plan, grades(0.54))).toMatchObject({ spread: 0.04, margin: 0.1, passes: true });
  expect(noiseCheck(plan, grades(0.6))).toMatchObject({ spread: 0.1, passes: false, by_arm: { a: 0, b: 0.1 } });
  const runs = ['a', 'b'].flatMap(arm => [0, 1].flatMap(repeat => ['inputs/one.json', 'inputs/two.json'].map(input => JSON.stringify({ arm, input, repeat, checkpoint: null, result: 1, run_dir: '/', duration_ms: 10, cost_usd: null }))));
  await expect(compareStage('check', { comparison, runs, grades: grades(0.6).map(g => JSON.stringify(g)) })).rejects.toThrow(
    /The trial stopped: the noise is more than half the margin\. Noise at the start: two learners of the same arm differ by up to 0\.10 on size \(Agent a 0, Agent b 0\.10\); the margin is 0\.1, and half of it is 0\.05\./);
  expect(await compareStage('check', { comparison, runs, grades: grades(0.52).map(g => JSON.stringify(g)) })).toMatchObject({ trial_summary: expect.stringContaining('differ by up to 0.02 on size') });
}, 600_000);

it('stops before approval when the test is too easy: every arm already scores above 1 minus the margin at the start', async () => {
  const { file } = fixture({ rule: { margin: 0.1, min_runs: 1 }, trial: 2 });
  const plan = JSON.parse(await stagePlan(file)), inputs = ['inputs/one.json', 'inputs/two.json'];
  const grades = (a: number, b: number, extra: Record<string, unknown> = {}) => ['a', 'b'].flatMap(arm => [0, 1].flatMap(repeat => inputs.map(input =>
    ({ arm, input, repeat, checkpoint: null, scores: { size: arm === 'a' ? a : b }, ...extra }))));
  // A code measure has no known top, so it is not checked.
  expect(tooEasyCheck(plan, noiseCheck(plan, grades(0.95, 0.97)))).toBeNull();
  plan.measures[0] = { name: 'size', main: true, rubric: ['Is big.'] };
  expect(tooEasyCheck(plan, noiseCheck(plan, grades(0.95, 0.97)))).toEqual({ start: { a: 0.95, b: 0.97 }, margin: 0.1, passes: false,
    sentence: 'This test is too easy to show a difference: both agents already score 0.95 (Agent a) and 0.97 (Agent b), and the rule needs a lead of 0.1.' });
  // An arm at 1 minus the margin can still be beaten by the margin.
  expect(tooEasyCheck(plan, noiseCheck(plan, grades(0.9, 0.97)))!.passes).toBe(true);
  const runs = ['a', 'b'].flatMap(arm => [0, 1].flatMap(repeat => inputs.map(input => JSON.stringify({ arm, input, repeat, checkpoint: null, result: 1, run_dir: '/', duration_ms: 10, cost_usd: null }))));
  await expect(compareStage('check', { comparison: JSON.stringify(plan), runs, grades: grades(0.95, 0.97).map(g => JSON.stringify(g)) })).rejects.toThrow(
    'The trial stopped. This test is too easy to show a difference: both agents already score 0.95 (Agent a) and 0.97 (Agent b), and the rule needs a lead of 0.1. Use harder inputs or a stricter measure, then run the comparison again.');
  expect(await compareStage('check', { comparison: JSON.stringify(plan), runs, grades: grades(0.5, 0.52).map(g => JSON.stringify(g)) })).toMatchObject({ trial_summary: expect.any(String) });
  // A covered checklist has no covered item at the start: the check uses the start value of the noise check (all items).
  Object.assign(plan, { checkpoints: [0, 1], events: [{ index: 1, kind: 'correction', text: 'It needs to be X because Y.' }] });
  plan.measures[0] = { name: 'size', main: true, checklist: 'expected', covered: true };
  const covered = grades(0, 0).map(g => ({ ...g, checkpoint: 0, scores: { size: null }, noise_scores: { size: g.arm === 'a' ? 0.96 : 0.98 } }));
  expect(tooEasyCheck(plan, noiseCheck(plan, covered))).toMatchObject({ start: { a: 0.96, b: 0.98 }, passes: false,
    sentence: expect.stringContaining('already score 0.96 (Agent a) and 0.98 (Agent b) before any correction, and the rule needs a lead of 0.1.') });
}, 600_000);

it('method publish NAME.compare saves the comparison as a draft with its inputs and prints its page, runs nothing, and a later run continues from that draft', async () => {
  const { root, file } = fixture();
  const id = () => JSON.parse(readFileSync(file, 'utf8')).id as string;
  vi.spyOn(MethodClient.prototype, 'token').mockReturnValue(null);
  await expect(methodMain(['publish', file])).rejects.toThrow('Sign in to publish this comparison: method login');
  vi.spyOn(MethodClient.prototype, 'token').mockReturnValue('method_x');
  const sent: Array<{ path: string; verb: string; body: any }> = [], uploaded: string[] = [];
  vi.spyOn(MethodClient.prototype, 'request').mockImplementation(async (path: string, verb?: string, body?: any) => {
    sent.push({ path, verb: verb!, body });
    return { comparison_id: id(), version_number: 1, stage: 'draft', url: `https://example.test/comparisons/${id()}?version=1` } as any;
  });
  vi.spyOn(MethodClient.prototype, 'transfer').mockImplementation(async (path: string) => { uploaded.push(path); return {} as any; });
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await methodMain(['publish', file]);
  const printed = JSON.parse(stdout.mock.calls.map(c => String(c[0])).join(''));
  stdout.mockRestore();
  expect(printed).toEqual({ comparison_id: id(), version_number: 1, stage: 'draft', url: `https://example.test/comparisons/${id()}?version=1`,
    next: 'Give the user this link to review every part of the comparison. When they are ready, run it: method run numbers.compare' });
  expect(sent.map(s => `${s.verb} ${s.path}`)).toEqual([`PUT /api/cli/comparisons/${id()}`]);
  // The same spec that method run saves, with each input's content uploaded.
  expect(sent[0]!.body.spec.inputs.details['inputs/one.json'].file.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(uploaded).toContain(`/api/cli/result-files/${sent[0]!.body.spec.inputs.details['inputs/one.json'].file.sha256}`);
  expect([calls(root, 'a'), calls(root, 'b')]).toEqual([0, 0]);
  // method run of the same file saves the same spec, so the account answers the same draft.
  await comparisonRunArgs(['run', file]);
  expect(sent[1]!.body).toEqual(sent[0]!.body);
  await expect(methodMain(['publish', file, '--reason', 'x'])).rejects.toThrow('It takes no options');
});

it('grades two runs that hand in the same document at the same time, each in its own work folder', async () => {
  const { root, file } = fixture({ measure: { name: 'items right', rubric: ['Names the cause (met).', 'Gives a date (partly).'] } });
  const claude = claudeStub(root);
  const plan = JSON.parse(await stagePlan(file));
  const grade = (n: number) => compareStage('grade', { item: JSON.stringify({ key: String(n).repeat(64), grader_version: 'v', folder: plan.folder,
    context: { folder: plan.folder, judge: plan.judge, judge_method: plan.judge_method, checklist: [] }, measures: plan.measures, marks: {},
    run: { key: String(n).repeat(64), arm: n === 1 ? 'a' : 'b', input: 'inputs/one.json', repeat: 0, checkpoint: null, result: 'The same reply.', folders: {}, run_dir: root } }) });
  const graded = (await Promise.all([grade(1), grade(2)])).map(g => JSON.parse(g.grade as string));
  expect(graded.map(g => g.scores['items right'])).toEqual([0.75, 0.75]);
  // Both judged; the verdicts are kept once, by the document's content, and no work folder is left.
  expect(claude.calls().filter(c => c.kind === 'judge').length).toBeGreaterThanOrEqual(1);
  expect(readdirSync(join(plan.folder, 'judgments'))).toHaveLength(1);
  expect(readdirSync(join(plan.folder, 'judge-work'))).toEqual([]);
}, 600_000);

it('one Claude judge reads every source the agent read in full, marks met, partly or not met, and partly counts as half', async () => {
  const { root, file } = fixture({ measure: { name: 'items right', rubric: ['Names the cause (met).', 'Gives a date (partly).', 'Says sorry (none).'] } });
  const claude = claudeStub(root);
  codexStub(root);
  const comparison = await stagePlan(file);
  const plan = JSON.parse(comparison);
  // A run that read a source of 60,000 characters in its room.
  const docs = join(root, 'docs-folder');
  mkdirSync(docs);
  writeFileSync(join(docs, 'big.md'), 'x'.repeat(60_000));
  writeFileSync(join(docs, 'unread.md'), 'not read');
  const transcript = join(root, 'transcript.jsonl');
  writeFileSync(transcript, [{ i: 0, role: 'user', kind: 'prompt', text: 'Do it.', tool: null, path: null, raw_ref: 'prompt.md' },
    { i: 1, role: 'assistant', kind: 'file_read', text: '{}', tool: 'Read', path: '/tmp/mr-1/folders/room/docs/big.md', raw_ref: 'events.jsonl:2' },
    { i: 2, role: 'tool', kind: 'tool_result', text: 'x'.repeat(2000), tool: 'Read', path: '/tmp/mr-1/folders/room/docs/big.md', raw_ref: 'events.jsonl:3' },
    { i: 3, role: 'assistant', kind: 'message', text: 'The cause is the cable.', tool: null, path: null, raw_ref: 'events.jsonl:4' }].map(e => JSON.stringify(e)).join('\n'));
  const run = { key: 'r'.repeat(64), arm: 'a', input: 'inputs/one.json', repeat: 0, checkpoint: null, result: 'The cause is the cable.', deliverable: 'work/reply.md', folders: { docs }, transcript_jsonl: transcript, run_dir: root };
  const graded = JSON.parse((await compareStage('grade', { item: JSON.stringify({ key: 'g'.repeat(64), grader_version: 'v', folder: plan.folder,
    context: { folder: plan.folder, judge: plan.judge, judge_method: plan.judge_method, checklist: [] }, run, measures: plan.measures, marks: {} }) })).grade as string);
  expect(graded.scores['items right']).toBe(0.5);
  expect(graded.verdicts.map((v: any) => v.verdict)).toEqual(['met', 'partly', 'not_met']);
  // The judge read the whole source that the agent read (not a cut), and only that one is listed.
  expect(claude.judged()[0].sizes).toEqual({ 'sources/docs/big.md': 60_000 });
  expect(sourcesRead(lines(transcript), { docs })).toEqual(['docs/big.md']);
  expect(graded.seen).toContain('read in full: docs/big.md');
  // One judge: Claude Code only, with read-only tools.
  expect(existsSync(join(root, 'codex-calls'))).toBe(false);
  const judgeCall = claude.calls().find(c => c.kind === 'judge');
  expect(judgeCall.args[judgeCall.args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep');
  expect(parseVerdicts('{"verdicts":[{"id":"c1","verdict":"maybe"}]}', [{ id: 'c1' }])).toBeNull();
}, 600_000);

it('a checklist comes from each input\'s expected answer, and a covered measure scores only the items that corrections given so far cover', async () => {
  expect(checklistOf('Intro\n- First item\n2. Second item\n')).toEqual([{ id: 'i1', text: 'First item', covered_by: [] }, { id: 'i2', text: 'Second item', covered_by: [] }]);
  const { root, file } = fixture({ teaching: ['inputs/three.json'], rule: { margin: 0.1, min_runs: 1, at: 2 },
    measure: { name: 'corrected items right', checklist: 'expected', covered: true }, other_measures: [{ name: 'all items right', checklist: 'expected' }],
    expected: { 'inputs/one.json': 'expected/one.json', 'inputs/two.json': 'expected/two.md' },
    treatment: { events: [{ correction: 'Name the cause.', input: 'inputs/three.json' }, { correction: 'Give a date.', input: 'inputs/three.json' }], checkpoints: [0, 1, 2] } });
  mkdirSync(join(root, 'expected'));
  writeFileSync(join(root, 'expected', 'one.json'), JSON.stringify([{ text: 'Names the cause (met).', covered_by: [1] }, { text: 'Gives a date (partly).', covered_by: [2] }, { text: 'Says sorry.' }]));
  writeFileSync(join(root, 'expected', 'two.md'), '- Item two (met)\n');
  claudeStub(root);
  const comparison = await stagePlan(file);
  const plan = JSON.parse(comparison);
  expect(plan.checklists['inputs/one.json'].map((i: any) => i.covered_by)).toEqual([[1], [2], []]);
  const grade = async (checkpoint: number, key: string) => JSON.parse((await compareStage('grade', { item: JSON.stringify({ key: key.repeat(64), grader_version: 'v', folder: plan.folder,
    context: { folder: plan.folder, judge: plan.judge, judge_method: plan.judge_method, checklist: plan.checklists['inputs/one.json'] },
    run: { key: 'r'.repeat(64), arm: 'a', input: 'inputs/one.json', repeat: 0, checkpoint, result: 'Some reply.', folders: {}, run_dir: root }, measures: plan.measures, marks: {} }) })).grade as string);
  const start = await grade(0, 'a'), one = await grade(1, 'b'), two = await grade(2, 'c');
  // At the start nothing is covered: no number, and the noise check reads all items (1 + 0.5 + 0) / 3.
  expect(start.scores['corrected items right']).toBeNull();
  expect(start.noise_scores['corrected items right']).toBe(0.5);
  expect(one.scores['corrected items right']).toBe(1);
  expect(two.scores['corrected items right']).toBe(0.75);
  expect(two.scores['all items right']).toBe(0.5);
  // A malformed item reference is refused: an item covered by an event that is not a correction.
  writeFileSync(join(root, 'expected', 'one.json'), JSON.stringify([{ text: 'Names the cause.', covered_by: [3] }]));
  expect(() => readComparison(file)).toThrow(/covered by event 3, which is not a correction of the treatment/);
}, 600_000);

it('estimates the full run as the page counts it: every graded run, the treatment events left, and each arm\'s own time per event', () => {
  const event = (index: number, received: boolean, minutes: number, outcome = received ? 'fixed' : 'stopped') => ({ key: String(index), index, kind: 'correction', input: 'i', learner: 0, received, outcome, tokens: null, duration_ms: minutes * 60_000, at: '' });
  const plan = { arms: [{ name: 'method', label: 'Method agent' }, { name: 'plain', label: 'plain Claude Code' }], inputs: [{ id: 'one' }, { id: 'two' }, { id: 'three' }, { id: 'four' }],
    learners: 2, checkpoints: [0, 15, 30], events: Array.from({ length: 30 }, (_, i) => ({ index: i + 1 })) };
  // The trial: learner 1 of each arm got the first 15 corrections; a Method fix takes 10 minutes, a plain edit 2.
  const treated: any = [{ arm: 'method', learners: [{ events: Array.from({ length: 15 }, (_, i) => event(i + 1, true, 10)) }, { events: [] }] },
    { arm: 'plain', learners: [{ events: Array.from({ length: 15 }, (_, i) => event(i + 1, true, 2)) }, { events: [] }] }];
  const runs = ['method', 'plain'].flatMap(arm => [0, 1].flatMap(repeat => ['one', 'two'].map(input => ({ arm, input, repeat, checkpoint: 0, duration_ms: 4 * 60_000, cost_usd: null }))));
  const estimate = fullRunEstimate(plan, runs, treated);
  // 2 arms × 4 inputs × 2 learners × 3 checkpoints, as "48 in all" on the page; the 8 trial runs count again.
  expect(estimate.account).toEqual({ minutes: 300 + 40, runs: 48, reused: 8, events: 90, event_minutes: { method: 10, plain: 2 }, usd: null });
  expect(estimate.text).toBe('The full run: 48 graded runs in all (8 done in the trial), and 90 treatment events to give over all learners, each a training run and a fix or edit. '
    + 'Time: about 340 minutes: about 240 s per run, 4 at a time; per event Method agent about 600 s, plain Claude Code about 120 s, the learners at the same time. Cost: not known: a fix or an edit reports no price.');
  // A Method fix that stopped in the trial says nothing about how long a fix takes: the Method agent's time per correction
  // is not known yet, and no total is given as if it were known.
  treated[0].learners[0].events = [event(1, false, 0), ...Array.from({ length: 14 }, (_, i) => event(i + 2, false, 0, 'not_given'))];
  const stopped = fullRunEstimate(plan, runs, treated);
  expect(stopped.account).toMatchObject({ events: 105, event_minutes: { method: null, plain: 2 } });
  expect(stopped.text).toContain('Time: not known yet: about 240 s per run, 4 at a time; per event Method agent not known yet, because none was received in the trial, plain Claude Code about 120 s');
  expect(stopped.text).not.toMatch(/about \d+ minutes/);
});

it('shows usage per correction for each arm, in tokens when every agent reports them, else minutes', () => {
  const learner = (events: Array<{ tokens: number | null; duration_ms: number }>) => ({ learner: 0, missing: [], snapshots: {}, events: events.map((e, i) => ({ index: i + 1, kind: 'correction', received: true, outcome: 'fixed', ...e })) });
  const tokens = usagePerCorrection({}, [{ arm: 'plain', planned: 2, learners: [learner([{ tokens: 100, duration_ms: 60_000 }, { tokens: 300, duration_ms: 60_000 }])] }] as any);
  expect(tokens).toMatchObject({ unit: 'tokens', higher_is_better: false, by: 'method', values: { plain: { value: 200, n: 1 } } });
  const minutes = usagePerCorrection({}, [{ arm: 'plain', planned: 1, learners: [learner([{ tokens: 100, duration_ms: 60_000 }])] },
    { arm: 'method', planned: 1, learners: [learner([{ tokens: null, duration_ms: 180_000 }]), learner([{ tokens: null, duration_ms: 60_000 }])] }] as any);
  expect(minutes).toMatchObject({ unit: 'minutes', values: { plain: { value: 1, n: 1 }, method: { value: 2, n: 2, per_learner: [3, 1] } } });
});

it('marks who decided each value: you for what decided_by_you names, Method for its rules, the writer for the rest; notes and descriptions change no cell', async () => {
  const { file } = plainFixture({ decided_by_you: ['question', 'difference', 'rule'], about_inputs: { noun: 'number', names: { 'inputs/one.json': 'The first number' } },
    measure: { name: 'size', code: 'size.mjs', description: 'The handed-in number over ten.' },
    assumptions: ['The measure is fair.', { text: 'The judge agrees with the expert.', if_false: 'The scores show the judge\'s taste.', check: 'The expert marks 10 verdicts.' }, { text: 'The corrections and the checklist come from one source.', limit: true }],
    notes: { inputs: ['Each input runs alone.'], measure: ['Bigger is better.'] } });
  const doc = readComparison(file);
  const by = (what: string) => decisions(doc).find(d => d.what === what)?.by;
  expect([by('difference'), by('decision rule'), by('main measure'), by('learners'), by('trial size'), by('instructions')]).toEqual(['you', 'you', 'writer', 'writer', 'writer', 'writer']);
  expect(decisions(doc).filter(d => d.what === 'note').map(d => [d.part, d.value])).toEqual([['inputs', 'Each input runs alone.'], ['main_measure', 'Bigger is better.']]);
  const { spec, plan } = await compileComparison(file);
  expect(spec.method_rules.map((r: any) => r.part)).toEqual(expect.arrayContaining(['same_for_both', 'main_measure', 'noise', 'run_rules', 'runs_per_point']));
  // Method's rules in the person's words: agents and copies, a model as people say it, no path, command or internal name.
  const rules = spec.method_rules.map((r: any) => r.text).join(' ');
  expect(rules).toContain('No agent can use the web. Only the handed-in file is measured. A plain agent\'s last message is not its output.');
  // Each rule is plain sentences, with no semicolon.
  expect(rules).not.toContain(';');
  expect(rules).not.toMatch(/clean room|builder|learner|runner|method judge|\barm\b|answer\.txt|work\//);
  expect(spec.decisions.find((d: any) => d.what === 'deliverable')).toEqual({ part: 'same_for_both', what: 'deliverable', value: 'Each agent hands in the file answer.txt.', by: 'writer' });
  expect(spec.assumptions).toEqual([{ text: 'The measure is fair.', check: null, by: 'writer' },
    { text: 'The judge agrees with the expert.', if_false: 'The scores show the judge\'s taste.', check: 'The expert marks 10 verdicts.', by: 'writer' },
    { text: 'The corrections and the checklist come from one source.', check: null, by: 'writer', limit: true }]);
  expect(spec.main_measure).toEqual({ name: 'size', how: 'code', description: 'The handed-in number over ten.' });
  expect(spec.inputs).toMatchObject({ noun: 'number', details: { 'inputs/one.json': { name: 'The first number' }, 'inputs/two.json': { name: 'two' } } });
  expect(spec.arms.find((a: any) => a.id === 'plain')).toEqual({ id: 'plain', name: 'plain Claude Code', agent: 'claude', instructions: 'Answer with three times n.' });
  expect(spec.arms.find((a: any) => a.id === 'a')).toMatchObject({ id: 'a', name: 'Method agent' });
  expect(spec.notes).toEqual({ inputs: ['Each input runs alone.'], main_measure: ['Bigger is better.'] });
  // Where run content goes is the page's own line, with the workspace's name: no rule says it again.
  expect(spec.method_rules.filter((r: any) => /Run content/.test(r.text))).toEqual([]);
  // Naming the arm says which agent it is; its starting instructions are the user's only when decided_by_you names them.
  const marked = (entries: string[]) => decisions({ ...doc, decided_by_you: entries }).find(d => d.what === 'instructions')?.by;
  expect([marked(['arms']), marked(['arms.plain']), marked(['arms.plain.instructions'])]).toEqual(['writer', 'writer', 'you']);
  // A deliverable that takes a value of the input is said in words, without its placeholder.
  expect(methodRules({ ...doc, deliverable: 'work/{{name}}' }, { model: null, judge: { agent: 'claude', model: null }, labels: {} }).map(r => r.text))
    .toEqual(expect.arrayContaining(['Only the handed-in file is measured.', 'A plain agent\'s last message is not its output.']));
  expect(decisions({ ...doc, deliverable: 'work/{{name}}' }).find(d => d.what === 'deliverable')?.value).toBe('Each agent hands in the file that the number names.');
  expect([modelName('claude-opus-5-5'), modelName('claude-sonnet-4-5-20250929'), modelName('gpt-5-codex')]).toEqual(['Claude Opus 5.5', 'Claude Sonnet 4.5', 'gpt-5-codex']);
  expect(methodRules({ ...doc, measure: { name: 'items right', rubric: ['Names the cause.'] } }, { model: { agent: 'claude', model: 'claude-opus-5-5', effort: 'high' }, judge: { agent: 'claude', model: 'claude-opus-5-5' }, labels: {} }).map(r => r.text))
    .toEqual(expect.arrayContaining(['Every agent runs on Claude Opus 5.5 at high effort.', 'One Claude judge (Claude Opus 5.5) marks each item met, partly or not met. Partly counts as half.',
      'If every agent already scores more than 0.90 (1 minus the margin) at the start, no agent can lead by the margin, so the comparison stops before approval.']));
  const corrected = methodRules({ ...doc, treatment: { events: [{ correction: 'It needs to be X because Y.', input: 'inputs/one.json' }], checkpoints: [0, 1] } }, { model: { agent: 'claude', model: 'claude-opus-5-5', effort: null }, judge: { agent: 'claude', model: null }, labels: {} }).map(r => r.text);
  expect(corrected).toEqual(expect.arrayContaining(['Every agent runs on Claude Opus 5.5.', 'The session that changes an agent after a correction runs on the same model.']));
  expect(corrected.join(' ')).not.toContain(';');
  // Notes, descriptions, assumptions and decided_by_you change no run cell or grade.
  const keys = async () => ((await compareStage('trial_plan', { comparison: JSON.parse(readFileSync((await compileComparison(file)).inputs, 'utf8')).comparison })).trial_cells as string[]).map(c => JSON.parse(c).key);
  const before = await keys();
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...raw, decided_by_you: ['question'], notes: { rule: ['Changed.'] }, assumptions: ['Another.'], measure: { ...raw.measure, description: 'Changed.' } }));
  expect(await keys()).toEqual(before);
  expect(plan.measures[0]).not.toHaveProperty('description');
}, 600_000);

it('names the arms as people say them: the Method agent and plain Claude Code, or each Method by its name', () => {
  const { root, file } = plainFixture();
  expect(armLabels(readComparison(file), root)).toEqual({ a: 'Method agent', plain: 'plain Claude Code' });
  const two = fixture();
  expect(armLabels(readComparison(two.file), two.root)).toEqual({ a: 'Agent a', b: 'Agent b' });
  const doc = readComparison(file);
  expect(armLabels({ ...doc, arms: { one: { agent: 'codex', instructions: 'plain.md' }, two: { agent: 'codex', instructions: 'plain.md' } } } as any, root))
    .toEqual({ one: 'plain Codex (one)', two: 'plain Codex (two)' });
});

it('gives the corrections in one shuffled order from the seed, the same for every arm, and maps the items they cover', async () => {
  expect(shuffled([1, 2, 3, 4, 5], 2610)).toEqual(shuffled([1, 2, 3, 4, 5], 2610));
  expect(shuffled([1, 2, 3, 4, 5], undefined)).toEqual([1, 2, 3, 4, 5]);
  const events = [1, 2, 3, 4, 5].map(i => ({ correction: `Correction ${i}.`, input: 'inputs/three.json' }));
  const { root, file } = fixture({ teaching: ['inputs/three.json'], rule: { margin: 0.1, min_runs: 1, at: 5 }, measure: { name: 'items', checklist: 'expected', covered: true },
    expected: { 'inputs/one.json': 'one.json', 'inputs/two.json': 'one.json' }, treatment: { events, checkpoints: [0, 5], seed: 2610 } });
  writeFileSync(join(root, 'one.json'), JSON.stringify([{ text: 'Item for the first correction.', covered_by: [1] }]));
  const { plan, spec } = await compileComparison(file);
  const order = shuffled([1, 2, 3, 4, 5], 2610);
  expect(plan.events.map((e: any) => e.text)).toEqual(order.map(i => `Correction ${i}.`));
  expect(plan.checklists['inputs/one.json'][0].covered_by).toEqual([order.indexOf(1) + 1]);
  expect(spec.treatment).toMatchObject({ order: 'shuffled', seed: 2610, list: order.map(i => ({ input: 'inputs/three.json', text: `Correction ${i}.` })) });
}, 600_000);

it('runs each Method arm as its own Method, decides by the rule, and reruns only the cells of a changed part', async () => {
  const { root, file } = fixture();
  const first = await runComparison(root, file, 'first');
  expect(first.status).toBe('completed');
  expect(first.result).toMatch(/^Agent b is better: Agent b is ahead of Agent a by 0\.15 on size, and the rule needs 0\.1\./);
  expect(first.result).toContain('Rule: An arm is better when its mean size is at least 0.1 above every other arm\'s, with at least 1 learner behind each point. Otherwise: can\'t tell yet.');
  expect(first.result).toContain('  Agent a: Inputs run: 2 of 2.');
  expect(first.result).toContain('  Agent b: 0.30 (n=1)');
  // The trial ran input one with 2 learners; the full run reused learner 1 and ran input two.
  expect([calls(root, 'a'), calls(root, 'b')]).toEqual([3, 3]);

  // Each arm runs as a copy with its own Method ID, folder and cache.
  const { plan } = await compileComparison(file);
  const [a, b] = plan.arms;
  expect(a!.id).toMatch(/^wf_[a-f0-9]{32}$/);
  expect(a!.id).not.toBe(b!.id);
  expect(a!.dir).not.toBe(b!.dir);
  expect(readFileSync(join(a!.dir, 'agent.method'), 'utf8')).toContain(a!.id);
  expect((await compileComparison(file)).plan.arms[0]!.id).toBe(a!.id);

  // A changed arm runs again; the other arm's runs are reused.
  answer(root, 'b', 3);
  const second = await runComparison(root, file, 'second');
  expect(second.result).toMatch(/^Agent b is better: Agent b is ahead of Agent a by 0\.30/);
  expect([calls(root, 'a'), calls(root, 'b')]).toEqual([3, 6]);
  // The person approved this version of the file: the next run does not ask again.
  const asked = (name: string) => readFileSync(join(root, 'runs', name, 'events.jsonl'), 'utf8').includes('"human.required"');
  expect([asked('first'), asked('second')]).toEqual([true, false]);

  // A changed measure grades again without running any arm.
  measure(root, 1000);
  const third = await runComparison(root, file, 'third');
  expect(third.result).toMatch(/^Can't tell yet: Agent b is ahead of Agent a by 0\.00 on size, and the rule needs 0\.1\./);
  expect([calls(root, 'a'), calls(root, 'b')]).toEqual([3, 6]);
}, 600_000);

it('decides by the fixed rule: margin, minimum learners and guard', async () => {
  const { file } = fixture({ other_measures: [{ name: 'words', code: 'size.mjs' }], rule: { margin: 0.1, min_runs: 2, guard: { measure: 'words', max_drop: 0.05 } }, runs: 2, assumptions: ['Graders agree with the expert.'] });
  const { plan } = await compileComparison(file);
  const grades = (runs: number, b: { size: number; words: number }) => ['a', 'b'].flatMap(arm => ['inputs/one.json', 'inputs/two.json'].flatMap(input =>
    Array.from({ length: runs }, (_, repeat) => ({ arm, input, repeat, checkpoint: null, scores: arm === 'a' ? { size: 0.2, words: 0.5 } : b }))));
  expect(decide(plan, grades(1, { size: 0.9, words: 0.5 }), null).text).toMatch(/^Can't tell yet: each point has 1 learner, and the rule needs 2\./);
  expect(decide(plan, grades(2, { size: 0.9, words: 0.4 }), null).text).toMatch(/^Can't tell yet: Agent b is ahead on size, but its words is 0\.10 below Agent a's, and the rule allows 0\.05\./);
  expect(plan.rule_sentence).toBe('An arm is better when its mean size is at least 0.1 above every other arm\'s, and its words is not more than 0.05 below the other arm\'s, with at least 2 learners behind each point. Otherwise: can\'t tell yet.');
  const better = decide(plan, grades(2, { size: 0.9, words: 0.5 }), null);
  expect(better.answer).toBe('Agent b is better');
  expect(better.text).toContain('Graders agree with the expert.: not checked.');
});

it('guards the winner against the other arm at the deciding checkpoint, not against its own first score', async () => {
  const { root, file } = fixture({ other_measures: [{ name: 'words', code: 'size.mjs' }], teaching: ['inputs/three.json'],
    rule: { margin: 0.1, min_runs: 1, at: 1, guard: { measure: 'words', max_drop: 0.05 } }, treatment: { events: [{ correction: 'Be brief.', input: 'inputs/three.json' }], checkpoints: [0, 1] } });
  const { plan } = await compileComparison(file);
  expect(plan.rule_sentence).toContain('and its words at that point is not more than 0.05 below the other arm\'s,');
  const grades = (scores: Record<string, Record<number, { size: number; words: number }>>) => Object.keys(scores).flatMap(arm => [0, 1].flatMap(checkpoint =>
    ['inputs/one.json', 'inputs/two.json'].map(input => ({ arm, input, repeat: 0, checkpoint, scores: scores[arm]![checkpoint]! }))));
  const low = decide(plan, grades({ a: { 0: { size: 0.2, words: 0.8 }, 1: { size: 0.2, words: 0.8 } }, b: { 0: { size: 0.2, words: 0.5 }, 1: { size: 0.9, words: 0.5 } } }), null);
  expect(low.answer).toBe("Can't tell yet");
  expect(low.text).toMatch(/^Can't tell yet: Agent b is ahead on size, but its words is 0\.30 below Agent a's after 1 event, and the rule allows 0\.05\./);
  const level = decide(plan, grades({ a: { 0: { size: 0.2, words: 0.9 }, 1: { size: 0.2, words: 0.5 } }, b: { 0: { size: 0.2, words: 0.9 }, 1: { size: 0.9, words: 0.5 } } }), null);
  expect(level.answer).toBe('Agent b is better');
  mkdirSync(join(root, 'c'));
  writeFileSync(join(root, 'c', 'agent.method'), readFileSync(join(root, 'a', 'agent.method')));
  writeFileSync(join(root, 'c', 'answer.mjs'), readFileSync(join(root, 'a', 'answer.mjs')));
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...doc, arms: { ...doc.arms, c: 'c/agent.method' } }));
  const three = (await compileComparison(file)).plan;
  expect(three.rule_sentence).toContain('below the best other arm\'s,');
  const best = decide(three, grades({ a: { 0: { size: 0.2, words: 0.5 }, 1: { size: 0.2, words: 0.5 } }, b: { 0: { size: 0.2, words: 0.5 }, 1: { size: 0.9, words: 0.5 } },
    c: { 0: { size: 0.1, words: 0.9 }, 1: { size: 0.1, words: 0.9 } } }), null);
  expect(best.text).toMatch(/^Can't tell yet: Agent b is ahead on size, but its words is 0\.40 below Agent a \(c\)'s after 1 event/);
});

it('grades again every grade that could read a run that ran again', async () => {
  const { file } = fixture({ teaching: ['inputs/three.json'], rule: { margin: 0.1, min_runs: 1, at: 1 },
    treatment: { events: [{ correction: 'Be brief.', input: 'inputs/three.json' }], checkpoints: [0, 1] } });
  delivery.deliver = async () => ({ received: true, outcome: 'fixed' });
  const { inputs, folder } = await compileComparison(file);
  const comparison = JSON.parse(readFileSync(inputs, 'utf8')).comparison;
  const treated = (await compareStage('treat', { comparison, go: true })).treatment as string;
  const planned = ((await compareStage('plan', { comparison, go: true, treated })).cells as string[]).map(c => JSON.parse(c));
  const finish = (cell: any, result: number) => {
    const record = { key: cell.key, arm: cell.arm, input: cell.input.id, repeat: cell.repeat, checkpoint: cell.checkpoint, trial: false, result, run_dir: folder, duration_ms: 1, cost_usd: null };
    mkdirSync(join(folder, 'cells'), { recursive: true });
    writeFileSync(join(folder, 'cells', `${cell.key}.json`), JSON.stringify(record));
    return JSON.stringify(record);
  };
  const runs = planned.map(cell => finish(cell, 1));
  const keys = async () => new Map(((await compareStage('gather', { comparison, treated, marks: '{}', full_runs: runs })).graded as string[])
    .map(g => JSON.parse(g)).map(g => [`${g.run.arm} ${g.run.checkpoint} ${g.run.input}`, g.key]));
  const before = await keys();
  expect(before.size).toBe(8);
  finish(planned.find(c => c.arm === 'a' && c.checkpoint === 0 && c.input.id === 'inputs/one.json'), 2);
  const after = await keys();
  const changed = [...before.keys()].filter(k => before.get(k) !== after.get(k)).sort();
  expect(changed).toEqual(['a 0 inputs/one.json', 'a 0 inputs/two.json', 'a 1 inputs/one.json', 'a 1 inputs/two.json']);
  finish(planned.find(c => c.arm === 'a' && c.checkpoint === 1 && c.input.id === 'inputs/two.json'), 3);
  const later = await keys();
  expect([...after.keys()].filter(k => after.get(k) !== later.get(k)).sort()).toEqual(['a 1 inputs/one.json', 'a 1 inputs/two.json']);
});

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
    expect(summary.result).toMatch(/^Agent b is better/);
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

it('method test --baseline answers which version is better', () => {
  const counts = (fixed: number, regression: number, unverifiable = 0) => ({ counts: { fixed, regression, unverifiable } });
  expect(baselineAnswer(counts(2, 0))).toEqual({ answer: 'The new version is better', reason: 'It fixes 2 cases and breaks none.' });
  expect(baselineAnswer(counts(0, 1))).toEqual({ answer: 'The old version is better', reason: 'The new version breaks 1 case and fixes none.' });
  expect(baselineAnswer(counts(1, 1)).answer).toBe("Can't tell yet");
  expect(baselineAnswer(counts(0, 0)).answer).toBe("Can't tell yet");
  expect(baselineAnswer(counts(1, 0, 1)).answer).toBe("Can't tell yet");
});

it('method authoring comparisons teaches the seven rules with a support-reply example, and its example comparison is valid', async () => {
  const { authoringGuide } = await import('../../packages/sdk/src/method-help.js');
  const { exampleDirectory } = await import('../../packages/sdk/src/authoring-example.js');
  const guide = authoringGuide('comparisons');
  expect(guide.match(/^\d\. /gm)).toHaveLength(7);
  expect(guide).toContain('Publish the draft with `method publish NAME.compare` and give the user the link before any run, so they can review every part.');
  expect(guide).toContain('Write the question so that it names the treatment and the test.');
  expect(guide).toContain('"It needs to be X because Y"');
  expect(guide).toContain('method authoring example support-replies');
  expect(guide).not.toMatch(/legal|lawyer|DLA|Piper|Raccine/i);
  const doc = readComparison(join(exampleDirectory('support-replies').directory, 'replies.compare'));
  expect(doc.treatment!.events.filter(e => e.correction)).toHaveLength(20);
  expect(authoringGuide('all')).toContain('# Comparisons');
});
