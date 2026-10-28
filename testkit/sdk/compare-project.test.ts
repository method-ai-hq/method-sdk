import { afterEach, beforeEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareStage, compileComparison, decide, readComparison } from '../../packages/sdk/src/compare.js';
import { didSummary, methodCommands, whatItDid } from '../../packages/sdk/src/compare-project.js';
import { comparisonRunArgs } from '../../packages/sdk/src/compare.js';
import { runCurrentFile } from '../../packages/sdk/src/current-runtime.js';
import { saveAnswer } from '../../packages/sdk/src/local-answer.js';

const roots: string[] = [];
const path = process.env.PATH;
beforeEach(() => { process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token'; });
afterEach(() => {
  process.env.PATH = path; delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const lines = (file: string) => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];

/**
 * Two Claude Code project arms (plain, and with the Method plugin) on numbered tasks. The message asks for answer.txt;
 * the first chat of a project gets a guide first. The writer says the answer is wrong unless it is n + 1.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'method-project-'));
  roots.push(root);
  for (const [dir, id, n] of [['inputs', 'one', 1], ['inputs', 'two', 2], ['teaching', 't1', 5], ['teaching', 't2', 6]] as const) {
    mkdirSync(join(root, dir, id, 'docs'), { recursive: true });
    writeFileSync(join(root, dir, `${id}.json`), JSON.stringify({ n }));
    writeFileSync(join(root, dir, id, 'docs', 'brief.md'), `brief ${id}`);
  }
  mkdirSync(join(root, 'expected'));
  for (const [id, n] of [['one', 1], ['two', 2], ['t1', 5], ['t2', 6]] as const) writeFileSync(join(root, 'expected', `${id}.json`), JSON.stringify({ answer: n + 1 }));
  writeFileSync(join(root, 'message.md'), 'Here is task {{n}}. Save your answer as answer.txt.');
  writeFileSync(join(root, 'first.md'), 'Our guide: answer with the number.');
  writeFileSync(join(root, 'writer.mjs'), `import{readFileSync}from'node:fs';const{output,expected}=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({correction:Number(output)===expected.answer?null:'It needs to be '+expected.answer+' because we add one.',checked:'all'}))`);
  writeFileSync(join(root, 'size.mjs'), `import{readFileSync}from'node:fs';const{output,expected}=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({score:Number(output)===expected.answer?1:0}))`);
  writeFileSync(join(root, 'probe.mjs'), `import{readFileSync}from'node:fs';const{probe}=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({score:probe&&probe.includes('add one')?1:0}))`);
  const file = join(root, 'desk.compare');
  writeFileSync(file, JSON.stringify({
    question: 'Does Claude Code keep corrections better with the Method plugin?',
    arms: { plain: { project: 'claude', model: 'claude-opus-5-5' }, method: { project: 'claude', plugins: ['method'], model: 'claude-opus-5-5' } },
    difference: 'The Method plugin.', inputs: ['inputs/one.json', 'inputs/two.json'], teaching: ['teaching/t1.json', 'teaching/t2.json'],
    deliverable: 'answer.txt', message: 'message.md', first_message: 'first.md',
    expected: { 'inputs/one.json': 'expected/one.json', 'inputs/two.json': 'expected/two.json', 'teaching/t1.json': 'expected/t1.json', 'teaching/t2.json': 'expected/t2.json' },
    measure: { name: 'right', code: 'size.mjs' }, other_measures: [{ name: 'says its rule', code: 'probe.mjs' }],
    rule: { margin: 0.1, min_runs: 1, at: 2 }, runs: 1,
    treatment: { feedback_writers: { her: { code: 'writer.mjs' } }, checkpoints: [0, 2], probe: 'Which rules do you follow?',
      events: [{ feedback: 'her', input: 'teaching/t1.json' }, { feedback: 'her', input: 'teaching/t2.json' }] },
  }));
  return { root, file };
}

/**
 * A stand-in for Claude Code on PATH, as a project chat runs it. A task message: it reads NOTES.md and answers n plus
 * the number of "add one" lines in it, in the file the message names. A second message (a resumed chat): it saves the
 * words in NOTES.md, and when method is on its PATH it also builds a Method and runs method judge (as a Bash call it
 * does not run). The probe: it answers with NOTES.md. Each call is logged with its arguments, prompt and environment.
 */
function claudeStub(root: string) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const argv = process.argv.slice(2);
let prompt = '';
const out = event => console.log(JSON.stringify(event));
process.stdin.on('data', d => prompt += d).on('end', () => {
  const cwd = process.cwd();
  const hasMethod = (process.env.PATH || '').split(':').some(dir => fs.existsSync(path.join(dir, 'method')));
  fs.appendFileSync(${JSON.stringify(join(root, 'claude-calls.jsonl'))}, JSON.stringify({ args: argv, prompt, cwd, files: fs.readdirSync(cwd, { recursive: true }).sort(), home: process.env.HOME,
    hasMethod, config: process.env.METHOD_CONFIG_DIR || null, memory: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY || null }) + '\\n');
  out({ type: 'system', subtype: 'init', model: argv[argv.indexOf('--model') + 1] });
  const notes = path.join(cwd, 'NOTES.md'), known = fs.existsSync(notes) ? fs.readFileSync(notes, 'utf8') : '';
  let result = 'Done.';
  const task = /task (\\d+)\\. Save your answer as (\\S+)\\./.exec(prompt);
  if (task) fs.writeFileSync(path.join(cwd, task[2]), String(Number(task[1]) + known.split('\\n').filter(l => l.includes('add one')).length));
  else if (prompt.startsWith('Which rules')) result = known || 'None yet.';
  else if (argv.includes('--resume')) {
    if (!prompt.startsWith("That's right")) fs.appendFileSync(notes, prompt + '\\n');
    if (hasMethod) {
      fs.writeFileSync(path.join(cwd, 'review.method'), 'name: Review\\n');
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'method judge run_1 wrong --note "' + prompt.slice(0, 20) + '"' } }] } });
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'ok' }] } });
    }
  }
  out({ type: 'result', subtype: 'success', is_error: false, result, usage: { input_tokens: 100, output_tokens: 20 } });
});
`, { mode: 0o700 });
  mkdirSync(join(process.env.HOME!, '.claude'), { recursive: true });
  writeFileSync(join(process.env.HOME!, '.claude', '.credentials.json'), '{}');
  process.env.PATH = `${bin}:${path}`;
  return () => lines(join(root, 'claude-calls.jsonl'));
}

it('a project arm is compared only with project arms, needs a message and a file to hand in, and names one model for every arm', () => {
  const { root, file } = fixture();
  const good = JSON.parse(readFileSync(file, 'utf8'));
  const check = (value: unknown) => { writeFileSync(file, JSON.stringify(value)); return () => readComparison(file); };
  expect(check(good)()).toBeTruthy();
  writeFileSync(join(root, 'plain.md'), 'Answer.');
  expect(check({ ...good, arms: { ...good.arms, plain: { agent: 'claude', instructions: 'plain.md' } } })).toThrow(/The arm method is a Claude Code project, and plain is not\. A project arm is compared with other project arms\./);
  const { message: _m, deliverable: _d, ...bare } = good;
  expect(check(bare)).toThrow(/Add message: a file with its words.*Add deliverable: the path in the project/);
  expect(check({ ...good, arms: { ...good.arms, plain: { project: 'claude', model: 'claude-haiku' } } })).toThrow(/name different models or efforts/);
  writeFileSync(join(root, 'message.md'), 'Task {{name}}.');
  expect(check(good)).toThrow(/For the input inputs\/one\.json: The message message\.md names \{\{name\}\}/);
});

it('each event is a new chat in the project folder: the task, then the correction or "That\'s right, thanks." in the same chat; only the folder carries over', async () => {
  const { root, file } = fixture();
  const calls = claudeStub(root);
  const compiled = await compileComparison(file);
  expect(compiled.spec.arms.map((a: any) => [a.id, a.name, a.agent])).toEqual([['plain', 'Claude Code project', 'claude'], ['method', 'Claude Code project with the Method plugin', 'claude']]);
  expect(compiled.spec.method_rules.map((r: any) => r.text).join(' ')).toContain('a correction is the second message of the same chat');
  const comparison = JSON.parse(readFileSync(compiled.inputs, 'utf8')).comparison as string;
  const treated = JSON.parse((await compareStage('treat', { comparison, go: true })).treatment as string);
  const chats = calls();
  // Two events per arm: each a task message and a second message in the same chat (resumed by its session ID).
  for (const arm of ['plain', 'method']) {
    const own = chats.filter(c => c.cwd.includes(`/arms/${arm}/`));
    expect(own).toHaveLength(2 * 2 + 1); // and the probe at checkpoint 2
    const [first, second, third, fourth] = own;
    expect(first.prompt).toBe('Our guide: answer with the number.\n\nHere is task 5. Save your answer as answer.txt.');
    expect(third.prompt).toBe('Here is task 6. Save your answer as answer.txt.');
    expect(second.args[second.args.indexOf('--resume') + 1]).toBe(first.args[first.args.indexOf('--session-id') + 1]);
    // 5 was wrong (5 + 1 is right); after the note, 6 + 1 is right.
    expect(second.prompt).toBe('It needs to be 6 because we add one.');
    expect(fourth.prompt).toBe('That\'s right, thanks.');
    // The input's folder is in the project; a clean room with Claude Code's memory off, the same model and no web.
    expect(first.files).toContain('docs/brief.md');
    expect(first.home).not.toBe(process.env.HOME);
    expect(first.memory).toBe('1');
    expect(first.args[first.args.indexOf('--model') + 1]).toBe('claude-opus-5-5');
    expect(first.args[first.args.indexOf('--disallowedTools') + 1]).toBe('WebSearch,WebFetch');
    expect(first.args[first.args.indexOf('--allowedTools') + 1]).toContain('Bash');
    // The Method plugin: loaded with --plugin-dir, and the method CLI on PATH with its sign-in folder. The plain project has neither.
    expect(first.hasMethod).toBe(arm === 'method');
    expect(first.args.includes('--plugin-dir')).toBe(arm === 'method');
    expect(first.config === null).toBe(arm === 'plain');
  }
  const events = (arm: string) => treated.find((t: any) => t.arm === arm).learners[0].events;
  expect(events('plain').map((e: any) => [e.outcome, e.text, e.change.summary])).toEqual([
    ['edited', 'It needs to be 6 because we add one.', 'Wrote NOTES.md.'], ['was_right', 'That\'s right, thanks.', 'Changed nothing in the project.']]);
  expect(events('method').map((e: any) => [e.outcome, e.change.summary])).toEqual([
    ['edited', 'Wrote NOTES.md. Built a Method (review.method). Ran method judge (wrong).'], ['was_right', 'Ran method judge (wrong).']]);
  expect(events('plain')[0].change.diff).toContain('+It needs to be 6 because we add one.');
  // The probe at checkpoint 2 was asked in a copy: the learner's project has no trace of it.
  const learner = treated.find((t: any) => t.arm === 'plain').learners[0];
  expect(learner.snapshots['2'].probe).toBe('It needs to be 6 because we add one.\n');
  expect(learner.snapshots['0'].probe).toBeNull();
  // What each arm did with its corrections, counted for the page.
  const result = decide(JSON.parse(comparison), [], treated);
  expect(result.received.method.lines.map((l: any) => [l.what, l.received, l.planned])).toEqual([['Inputs run', 0, 4], ['Corrections received', 2, 2],
    ['Corrections after which it saved something in the project', 1, 2], ['Corrections after which it built or changed a Method', 1, 2], ['Corrections it gave to method judge', 2, 2]]);
  expect(result.received.plain.lines.map((l: any) => l.what)).not.toContain('Corrections it gave to method judge');
  // A rerun gives nothing again.
  const before = calls().length;
  await compareStage('treat', { comparison, go: true });
  expect(calls().length).toBe(before);
}, 600_000);

it('a checkpoint is measured in fresh copies of the project: one new chat per checking input, the first chat gets the guide, and code measures get the probe', async () => {
  const { root, file } = fixture();
  const calls = claudeStub(root);
  const compiled = await compileComparison(file);
  const comparison = JSON.parse(readFileSync(compiled.inputs, 'utf8')).comparison as string;
  const treated = (await compareStage('treat', { comparison, go: true })).treatment as string;
  const plan = JSON.parse(comparison);
  const learnerProject = join(plan.folder, 'arms', 'plain', readdirSync(join(plan.folder, 'arms', 'plain')).find(d => d.startsWith('treatment-'))!, 'learner-1', 'project');
  const notes = readFileSync(join(learnerProject, 'NOTES.md'), 'utf8');
  const cells = ((await compareStage('plan', { comparison, go: true, treated })).cells as string[]).map(c => JSON.parse(c)).filter((c: any) => c.arm === 'plain');
  expect(cells.map((c: any) => [c.checkpoint, c.input.id])).toEqual([[0, 'inputs/one.json'], [0, 'inputs/two.json'], [2, 'inputs/one.json'], [2, 'inputs/two.json']]);
  const start = calls().length;
  const runs = [];
  for (const cell of cells) runs.push(JSON.parse((await compareStage('cell', { cell: JSON.stringify(cell) })).full_run as string));
  const chats = calls().slice(start);
  // At the start the chat is the project's first, so it gets the guide; after 2 events it does not.
  expect(chats.map(c => c.prompt)).toEqual(['Our guide: answer with the number.\n\nHere is task 1. Save your answer as answer.txt.', 'Our guide: answer with the number.\n\nHere is task 2. Save your answer as answer.txt.',
    'Here is task 1. Save your answer as answer.txt.', 'Here is task 2. Save your answer as answer.txt.']);
  expect(chats.every(c => !c.args.includes('--resume'))).toBe(true);
  // Each chat ran in its own copy; the learner's project did not change.
  expect(new Set(chats.map(c => c.cwd)).size).toBe(4);
  expect(readFileSync(join(learnerProject, 'NOTES.md'), 'utf8')).toBe(notes);
  expect(existsSync(join(learnerProject, 'answer.txt'))).toBe(true);
  // At the start it answered n (wrong); after the correction n + 1 (right).
  expect(runs.map(r => [r.checkpoint, r.result, r.handed_in])).toEqual([[0, '1', true], [0, '2', true], [2, '2', true], [2, '3', true]]);
  expect(runs.map(r => r.probe)).toEqual([null, null, notes, notes]);
  expect(runs[0].transcript).toBeTruthy();
  expect(runs[2].did).toMatchObject({ added: [], changed: [] });
  expect(runs[0].models).toEqual(['claude-opus-5-5']);
}, 600_000);

it('runs a comparison of two projects from the trial to the answer', async () => {
  const { root, file } = fixture();
  claudeStub(root);
  const args = await comparisonRunArgs(['run', file]);
  const runDir = join(root, 'runs', 'first');
  const trial: any = await runCurrentFile(args[1]!, { inputs: args[args.indexOf('--inputs') + 1]!, 'run-dir': runDir } as any);
  expect(trial.status).toBe('needs_input');
  saveAnswer(runDir, 'approve:0', { go: true });
  const result: any = await runCurrentFile(args[1]!, { 'run-dir': runDir, resume: true } as any);
  expect(result.status).toBe('completed');
  // Both learn the same note, so neither is ahead; one copy cannot decide.
  expect(result.result).toMatch(/^Can't tell yet/);
  expect(result.result).toContain('Claude Code project with the Method plugin: Model: claude-opus-5-5. Inputs run: 4 of 4. Corrections received: 2 of 2 (1 edited, 1 was right). Changed the agent: 1. Corrections after which it saved something in the project: 1 of 2. Corrections after which it built or changed a Method: 1 of 2.');
  expect(result.result).toContain('Corrections it gave to method judge: 2 of 2.');
  expect(result.result).toMatch(/says its rule \(mean per run; n = learners behind the point\)\n {2}Claude Code project: after 0: 0 \(n=1\); after 2: 1 \(n=1\)/);
}, 900_000);

it('says what a chat did with the project in plain words', () => {
  const did = whatItDid({ 'a.md': '1', 'answer.txt': 'x' }, { 'a.md': '2', 'CLAUDE.md': '3', 'nda.method': '4', 'answer.txt': 'y', '.method-runs/r/x.json': '5' },
    [{ kind: 'command', text: 'cd x && method run nda.method --inputs i.json' }, { kind: 'command', text: '~/.local/bin/method judge run_1 wrong --note "No."' }, { kind: 'command', text: 'grep method notes.md' }], 'answer.txt');
  expect(did).toMatchObject({ added: ['CLAUDE.md', 'nda.method'], changed: ['a.md'], methods_built: ['nda.method'], commands: ['method run', 'method judge'], judged: ['wrong'] });
  expect(didSummary(did)).toBe('Saved notes to CLAUDE.md. Changed a.md. Built a Method (nda.method). Ran method judge (wrong). Ran method run.');
  expect(methodCommands([{ kind: 'command', text: 'echo methodical' }]).commands).toEqual([]);
});
