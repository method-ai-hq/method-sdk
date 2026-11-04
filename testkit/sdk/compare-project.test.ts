import { afterEach, beforeEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareStage, compileComparison, decide, readComparison } from '../../packages/sdk/src/compare.js';
import { comparisonPlugin, didSummary, methodCommands, waitForFixes, whatItDid } from '../../packages/sdk/src/compare-project.js';
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
  // The comparison's folder is in a repository, with instructions, as a person's study folder can be.
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'AGENTS.md'), 'Use Method for everything.');
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
 * A stand-in for Claude Code on PATH, as a project chat runs it. As Claude Code does, it keys its memory by the
 * repository that holds the folder (else the folder), names that memory folder in its start event, and reads the
 * AGENTS.md of the folders above. A task message: it reads NOTES.md and its Claude Code memory (HOME/.claude/projects/SLUG/memory/MEMORY.md) and answers n plus the number of "add one" lines in them, in the
 * file the message names. A second message (a resumed chat): without method on its PATH it saves the words in its
 * memory; with method it saves them in NOTES.md, builds a Method and runs method judge (as a Bash call it does not run).
 * The probe: it answers with what it saved. Each call is logged with its arguments, prompt and environment.
 */
function claudeStub(root: string) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const argv = process.argv.slice(2);
let prompt = '';
const out = event => console.log(JSON.stringify(event));
const above = dir => dir === path.dirname(dir) ? [dir] : [dir, ...above(path.dirname(dir))];
process.stdin.on('data', d => prompt += d).on('end', () => {
  const cwd = process.cwd();
  const hasMethod = (process.env.PATH || '').split(':').some(dir => fs.existsSync(path.join(dir, 'method')));
  fs.appendFileSync(${JSON.stringify(join(root, 'claude-calls.jsonl'))}, JSON.stringify({ args: argv, prompt, cwd, files: fs.readdirSync(cwd, { recursive: true }).sort(), home: process.env.HOME,
    hasMethod, config: process.env.METHOD_CONFIG_DIR || null, memory: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY || null,
    traffic: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || null,
    methodId: (() => { try { return JSON.parse(fs.readFileSync(path.join(cwd, 'review.method'), 'utf8')).id; } catch { return null; } })(), cache: process.env.METHOD_CACHE_DIR || null,
    listed: [path.dirname(path.dirname(cwd)), path.dirname(process.env.HOME)].filter(dir => { try { fs.readdirSync(dir); return true; } catch { return false; } }), instructions: above(cwd).filter(d => fs.existsSync(path.join(d, 'AGENTS.md'))) }) + '\\n');
  const repo = above(cwd).find(d => fs.existsSync(path.join(d, '.git'))) || cwd;
  const memoryDir = path.join(process.env.HOME, '.claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
  out({ type: 'system', subtype: 'init', model: argv[argv.indexOf('--model') + 1], memory_paths: { auto: memoryDir + '/' } });
  const memory = path.join(memoryDir, 'MEMORY.md');
  const notes = hasMethod ? path.join(cwd, 'NOTES.md') : memory, known = fs.existsSync(notes) ? fs.readFileSync(notes, 'utf8') : '';
  let result = 'Done.';
  const task = /task (\\d+)\\. Save your answer as (\\S+)\\./.exec(prompt);
  if (task) fs.writeFileSync(path.join(cwd, task[2]), String(Number(task[1]) + known.split('\\n').filter(l => l.includes('add one')).length));
  else if (prompt.startsWith('Which rules')) { result = known || 'None yet.'; fs.mkdirSync(path.dirname(memory), { recursive: true }); fs.appendFileSync(memory, 'I was asked about my rules.\\n'); }
  else if (fs.existsSync(${JSON.stringify(join(root, 'no-fix-found'))}) && argv.includes('--resume') && hasMethod && fs.existsSync(path.join(process.env.METHOD_CACHE_DIR, 'fixes'))) {
    // After the first fix, a correction that Method finds no fix for: the chat runs method judge and changes nothing.
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'method judge run_2 wrong --note "' + prompt.slice(0, 20) + '"' } }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'No fix found yet.' }] } });
  }
  else if (argv.includes('--resume')) {
    if (!prompt.startsWith("That's right")) { fs.mkdirSync(path.dirname(notes), { recursive: true }); fs.appendFileSync(notes, prompt + '\\n'); }
    if (hasMethod) {
      if (!fs.existsSync(path.join(cwd, 'review.method'))) fs.writeFileSync(path.join(cwd, 'review.method'), JSON.stringify({ format: 'method/3.4', id: 'wf_' + 'b'.repeat(32), name: 'Review', steps: {} }) + '\\n');
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'method judge run_1 wrong --note "' + prompt.slice(0, 20) + '"' } }] } });
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'ok' }] } });
      // With fixes on, the fix works as Method's does: it changes the Method's home file (the file that claimed the
      // Method first, or that a redesign claimed), saves a check beside it, and records Fixed in the Method cache.
      if (fs.existsSync(${JSON.stringify(join(root, 'fixes-on'))}) && !prompt.startsWith("That's right")) {
        const cache = process.env.METHOD_CACHE_DIR, homeFile = path.join(cache, 'homes', 'review.json');
        if (!fs.existsSync(homeFile)) { fs.mkdirSync(path.dirname(homeFile), { recursive: true }); fs.writeFileSync(homeFile, JSON.stringify({ path: path.join(cwd, 'review.method') })); }
        const home = JSON.parse(fs.readFileSync(homeFile, 'utf8')).path, outcomes = path.join(cache, 'fixes', 'wf_' + 'b'.repeat(32), 'outcomes');
        fs.mkdirSync(outcomes, { recursive: true });
        const n = fs.readdirSync(outcomes).length + 1, judgment = 'jdg_' + String(n).repeat(32);
        fs.mkdirSync(path.join(path.dirname(home), 'cases', 'correction-' + n), { recursive: true });
        fs.writeFileSync(path.join(path.dirname(home), 'cases', 'correction-' + n, 'case.json'), JSON.stringify({ note: prompt }));
        fs.writeFileSync(path.join(outcomes, judgment + '.json'), JSON.stringify({ judgment, file: home, status: 'done', outcome: { id: judgment, outcome: 'fixed', tokens: 7 } }));
        result = 'Fixed.';
      }
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

it('each event is a new chat in the project folder: the task, then the correction or "That\'s right, thanks." in the same chat; only the folder and Claude Code\'s memory carry over', async () => {
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
    const own = chats.filter(c => c.hasMethod === (arm === 'method'));
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
    expect(first.memory).toBeNull();
    // The chat works outside the comparison's folder and its repository: no instructions from the folders above, no
    // hidden answers beside it, and the account's cloud plugins are not synced in.
    expect([root, realpathSync(root)].some(r => first.cwd.startsWith(r))).toBe(false);
    expect(first.instructions).toEqual([]);
    expect(first.traffic).toBe('1');
    // No other chat can be found from it: the folder of all projects and its room cannot be listed, and its Method
    // cache is beside its folder, not in the comparison's folder.
    expect(first.listed).toEqual([]);
    expect(first.cache === null).toBe(arm === 'plain');
    if (first.cache) expect([root, realpathSync(root)].some(r => first.cache.startsWith(r))).toBe(false);
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
    ['edited', 'It needs to be 6 because we add one.', 'Saved to Claude memory (MEMORY.md).'], ['was_right', 'That\'s right, thanks.', 'Changed nothing in the project.']]);
  expect(events('method').map((e: any) => [e.outcome, e.change.summary])).toEqual([
    ['edited', 'Wrote NOTES.md. Built a Method (review.method). Ran method judge (wrong).'], ['was_right', 'Ran method judge (wrong).']]);
  expect(events('plain')[0].change.diff).toContain('+++ Claude memory/MEMORY.md');
  expect(events('plain')[0].change.diff).toContain('+It needs to be 6 because we add one.');
  // The probe at checkpoint 2 was asked in a copy: the learner's project has no trace of it.
  const learner = treated.find((t: any) => t.arm === 'plain').learners[0];
  expect(learner.snapshots['2'].probe).toBe('It needs to be 6 because we add one.\n');
  expect(learner.snapshots['0'].probe).toBeNull();
  // What each arm did with its corrections, counted for the page.
  const result = decide(JSON.parse(comparison), [], treated);
  expect(result.received.method.lines.map((l: any) => [l.what, l.received, l.planned])).toEqual([['Inputs run', 0, 4], ['Corrections received', 2, 2],
    ['Corrections after which it saved something in the project or memory', 1, 2], ['Corrections after which it built or changed a Method', 1, 2], ['Corrections it gave to method judge', 2, 2]]);
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
  const learner = join(plan.folder, 'arms', 'plain', readdirSync(join(plan.folder, 'arms', 'plain')).find(d => d.startsWith('treatment-'))!, 'learner-1');
  const learnerProject = join(learner, 'project'), memoryFile = join(learner, 'memory', 'MEMORY.md');
  // The plain project kept the correction in Claude Code's memory, which carried over to its next chat; the probe, asked in a copy, left no trace.
  const notes = readFileSync(memoryFile, 'utf8');
  expect(notes).toBe('It needs to be 6 because we add one.\n');
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
  expect(readFileSync(memoryFile, 'utf8')).toBe(notes);
  expect(existsSync(join(learnerProject, 'answer.txt'))).toBe(true);
  // At the start it answered n (wrong); after the correction n + 1 (right).
  expect(runs.map(r => [r.checkpoint, r.result, r.handed_in])).toEqual([[0, '1', true], [0, '2', true], [2, '2', true], [2, '3', true]]);
  expect(runs.map(r => r.probe)).toEqual([null, null, notes, notes]);
  expect(runs[0].transcript).toBeTruthy();
  expect(runs[2].did).toMatchObject({ added: [], changed: [] });
  expect(runs[0].models).toEqual(['claude-opus-5-5']);
  // A Method-arm copy at a checkpoint runs its Method under a new ID of its own, so it cannot catch up to versions that
  // the learner saved later under the learner's ID, and nothing it saves reaches the learner's Method.
  const methodCell = ((await compareStage('plan', { comparison, go: true, treated })).cells as string[]).map(c => JSON.parse(c)).find((c: any) => c.arm === 'method' && c.checkpoint === 2);
  const before = calls().length;
  await compareStage('cell', { cell: JSON.stringify(methodCell) });
  const seen = calls().slice(before).map(c => c.methodId);
  expect(seen[0]).toMatch(/^wf_[0-9a-f]{32}$/);
  expect(seen[0]).not.toBe('wf_' + 'b'.repeat(32));
  expect(readFileSync(join(methodCell.copy.dir, 'review.method'), 'utf8')).toContain('wf_' + 'b'.repeat(32));
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
  expect(result.result).toContain('Claude Code project with the Method plugin: Model: claude-opus-5-5. Inputs run: 4 of 4. Corrections received: 2 of 2 (1 edited, 1 was right). Changed the agent: 1. Corrections after which it saved something in the project or memory: 1 of 2. Corrections after which it built or changed a Method: 1 of 2.');
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

it('removes a chat\'s folder while a process that just ended still writes files into it', async () => {
  const { spawn } = await import('node:child_process');
  const { removeTree } = await import('../../packages/sdk/src/files.js');
  const root = mkdtempSync(join(tmpdir(), 'busy-tree-')); roots.push(root);
  const cache = join(root, 'home', 'Library', 'Caches', 'claude');
  mkdirSync(cache, { recursive: true });
  for (let i = 0; i < 200; i++) writeFileSync(join(cache, `old-${i}`), 'x');
  // As a Claude Code cache flush does: for a short time, new files keep appearing in the folder.
  const code = `const{writeFileSync}=require("node:fs");const end=Date.now()+1000;let i=0;console.log("go");while(Date.now()<end){try{writeFileSync(${JSON.stringify(cache)}+"/new-"+(i++),"x")}catch{}}`;
  const writer = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(done => writer.stdout!.once('data', done));
  const ended = new Promise(done => writer.on('close', done));
  try { removeTree(root); } finally { await ended; }
  expect(existsSync(root)).toBe(false);
}, 20_000);

it('a comparison keeps its copy of the Method plugin when an update changes only the plugin\'s version number, so the arm is the same arm; changed skills make a new copy only before the trial starts', () => {
  const folder = mkdtempSync(join(tmpdir(), 'method-plugin-copy-'));
  try {
    const copy = comparisonPlugin(folder), manifest = join(copy, '.claude-plugin', 'plugin.json');
    const installed = JSON.parse(readFileSync(manifest, 'utf8'));
    // The copy that an earlier version of the method CLI made: the same plugin with its own version number.
    writeFileSync(manifest, JSON.stringify({ ...installed, version: '0.0.1' }, null, 2));
    expect(comparisonPlugin(folder)).toBe(copy);
    expect(JSON.parse(readFileSync(manifest, 'utf8')).version).toBe('0.0.1');
    // A skill that differs is a different plugin: the copy becomes the installed plugin.
    const skill = join(copy, 'skills', readdirSync(join(copy, 'skills'))[0]!, 'SKILL.md');
    writeFileSync(skill, 'An older skill.');
    comparisonPlugin(folder);
    expect(readFileSync(skill, 'utf8')).not.toBe('An older skill.');
    expect(JSON.parse(readFileSync(manifest, 'utf8')).version).toBe(installed.version);
    // After the trial starts, the copy stays as it is, so the arm's treatment and runs are not done again.
    writeFileSync(join(folder, 'trial-approval.json'), '{}');
    writeFileSync(skill, 'The skill that the trial ran with.');
    comparisonPlugin(folder);
    expect(readFileSync(skill, 'utf8')).toBe('The skill that the trial ran with.');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

/**
 * A stand-in for Codex on PATH, as a Codex project chat runs it. `codex plugin ...` is logged. `codex exec` starts a
 * chat (a new thread) and `codex exec resume THREAD` goes on with it; it saves the chat in HOME/.codex/sessions with
 * the model of HOME/.codex/config.toml, as Codex does. A task message: it reads NOTES.md (with method on PATH) or its
 * Codex home's AGENTS.md and answers n plus the number of "add one" lines. A correction: without method it saves the
 * words in its home's AGENTS.md; with method in NOTES.md, builds a Method and runs method judge in its shell's call.
 */
function codexStub(root: string) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const argv = process.argv.slice(2);
const log = entry => fs.appendFileSync(${JSON.stringify(join(root, 'codex-calls.jsonl'))}, JSON.stringify(entry) + '\\n');
const home = path.join(process.env.HOME, '.codex');
if (argv[0] !== 'exec') { log({ args: argv, home: process.env.HOME }); process.exit(0); }
let prompt = '';
const out = event => console.log(JSON.stringify(event));
process.stdin.on('data', d => prompt += d).on('end', () => {
  const cwd = process.cwd();
  const resume = argv[1] === 'resume', thread = resume ? argv[2] : crypto.randomUUID();
  const hasMethod = (process.env.PATH || '').split(':').some(dir => fs.existsSync(path.join(dir, 'method')));
  const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  log({ args: argv, prompt, cwd, files: fs.readdirSync(cwd, { recursive: true }).sort(), home: process.env.HOME, hasMethod, config, cache: process.env.METHOD_CACHE_DIR || null });
  out({ type: 'thread.started', thread_id: thread });
  const agents = path.join(home, 'AGENTS.md');
  const notes = hasMethod ? path.join(cwd, 'NOTES.md') : agents, known = fs.existsSync(notes) ? fs.readFileSync(notes, 'utf8') : '';
  let result = 'Done.';
  const task = /task (\\d+)\\. Save your answer as (\\S+)\\./.exec(prompt);
  // With the Method plugin, the task is a method run: its record in the Method cache holds its Codex step's tokens.
  if (task && hasMethod) {
    const run = path.join(process.env.METHOD_CACHE_DIR, 'runs', crypto.randomUUID());
    fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(path.join(run, 'events.jsonl'), JSON.stringify({ event: 'codex.completed', step: 'draft', usage: [{ input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50 }] }) + '\\n');
  }
  if (task) fs.writeFileSync(path.join(cwd, task[2]), String(Number(task[1]) + known.split('\\n').filter(l => l.includes('add one')).length));
  else if (prompt.startsWith('Which rules')) result = known || 'None yet.';
  else if (resume) {
    if (!prompt.startsWith("That's right")) fs.appendFileSync(notes, prompt + '\\n');
    if (hasMethod) {
      if (!fs.existsSync(path.join(cwd, 'review.method'))) fs.writeFileSync(path.join(cwd, 'review.method'), JSON.stringify({ format: 'method/3.4', id: 'wf_' + 'c'.repeat(32), name: 'Review' }) + '\\n');
      const command = "/bin/zsh -lc 'method judge run_1 wrong --note \\"" + prompt.slice(0, 20) + "\\"'";
      out({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command, aggregated_output: 'ok', exit_code: 0, status: 'completed' } });
    }
  }
  out({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: result } });
  fs.writeFileSync(argv[argv.indexOf('--output-last-message') + 1], result);
  const model = /^model = "(.*)"$/m.exec(config)?.[1] ?? 'gpt-default';
  const day = path.join(home, 'sessions', '2026', '11', '03');
  fs.mkdirSync(day, { recursive: true });
  fs.appendFileSync(path.join(day, 'rollout-2026-11-03T00-00-00-' + thread + '.jsonl'), JSON.stringify({ type: 'turn_context', payload: { model, cwd } }) + '\\n');
  // As Codex does, a resumed chat reports the tokens of the whole chat so far: 100 input and 20 output per message.
  const count = path.join(home, 'tokens-' + thread), before = fs.existsSync(count) ? Number(fs.readFileSync(count, 'utf8')) : 0;
  fs.writeFileSync(count, String(before + 1));
  out({ type: 'turn.completed', usage: { input_tokens: 100 * (before + 1), cached_input_tokens: 50 * (before + 1), output_tokens: 20 * (before + 1) } });
});
`, { mode: 0o700 });
  mkdirSync(join(process.env.HOME!, '.codex'), { recursive: true });
  writeFileSync(join(process.env.HOME!, '.codex', 'auth.json'), '{}');
  process.env.PATH = `${bin}:${path}`;
  return () => lines(join(root, 'codex-calls.jsonl'));
}
/** The fixture with Codex project arms on one Codex model. */
function codexFixture() {
  const made = fixture();
  const doc = JSON.parse(readFileSync(made.file, 'utf8'));
  writeFileSync(made.file, JSON.stringify({ ...doc, question: 'Does Codex keep corrections better with the Method plugin?',
    arms: { plain: { project: 'codex', model: 'gpt-6.1-sol' }, method: { project: 'codex', plugins: ['method'], model: 'gpt-6.1-sol' } } }));
  return made;
}

it('Claude Code and Codex project arms are compared together only when the comparison tests the model', () => {
  const { file } = codexFixture();
  const good = JSON.parse(readFileSync(file, 'utf8'));
  const check = (value: unknown) => { writeFileSync(file, JSON.stringify(value)); return () => readComparison(file); };
  expect(check(good)()).toBeTruthy();
  const mixed = { ...good, arms: { ...good.arms, plain: { project: 'claude', model: 'gpt-6.1-sol' } } };
  expect(check(mixed)).toThrow(/The project arms plain and method are Claude Code and Codex, which run on different models\. Make every project arm the same agent, or add tested: model\./);
  expect(check({ ...mixed, arms: { ...mixed.arms, plain: { project: 'claude', model: 'claude-sonnet-5-5' } }, tested: 'model' })()).toBeTruthy();
});

it('a Codex project chat is codex exec in the project folder, resumed by its thread for the correction, with the model in Codex\'s config, the Method plugin added from a marketplace, and Codex\'s home memory carried over', async () => {
  const { root, file } = codexFixture();
  const calls = codexStub(root);
  const compiled = await compileComparison(file);
  expect(compiled.spec.arms.map((a: any) => [a.id, a.name, a.agent])).toEqual([['plain', 'Codex project', 'codex'], ['method', 'Codex project with the Method plugin', 'codex']]);
  expect(compiled.spec.judge).toEqual({ agent: 'codex', model: 'gpt-6.1-sol' });
  const rules = compiled.spec.method_rules.map((r: any) => r.text).join(' ');
  expect(rules).toContain('only the Codex sign-in');
  expect(rules).toContain('A Method fix that a chat starts runs on Codex, on the same model.');
  expect(rules).not.toContain('Claude');
  const comparison = JSON.parse(readFileSync(compiled.inputs, 'utf8')).comparison as string;
  const plan = JSON.parse(comparison);
  expect(JSON.parse(readFileSync(plan.judge_method, 'utf8')).steps.work.do).toMatchObject({ kind: 'session', agent: 'codex', model: 'gpt-6.1-sol' });
  const treated = JSON.parse((await compareStage('treat', { comparison, go: true })).treatment as string);
  const all = calls(), chats = all.filter(c => c.args[0] === 'exec');
  // The Method plugin is added in the Method arm's rooms only, as the Method installer adds it to Codex.
  const plugin = all.filter(c => c.args[0] === 'plugin');
  expect(plugin.map(c => c.args.slice(0, 3).join(' '))).toEqual(Array(3).fill(['plugin marketplace add', 'plugin add method@method']).flat());
  for (const arm of ['plain', 'method']) {
    const own = chats.filter(c => c.hasMethod === (arm === 'method'));
    expect(own).toHaveLength(2 * 2 + 1);
    const [first, second, third, fourth] = own;
    expect(first.prompt).toBe('Our guide: answer with the number.\n\nHere is task 5. Save your answer as answer.txt.');
    expect(first.args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(first.args[first.args.indexOf('-C') + 1]).toBe(first.cwd);
    // The correction goes on in the same chat: codex exec resume with the thread that the first message started.
    expect(second.args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(second.prompt).toBe('It needs to be 6 because we add one.');
    expect(third.args[1]).not.toBe('resume');
    expect(fourth.prompt).toBe('That\'s right, thanks.');
    expect(first.files).toContain('docs/brief.md');
    expect(first.home).not.toBe(process.env.HOME);
    expect([root, realpathSync(root)].some(r => first.cwd.startsWith(r))).toBe(false);
    // Codex's config in the room: the arm's model, no web search, no account connectors or remote plugins.
    expect(first.config).toContain('model = "gpt-6.1-sol"');
    expect(first.config).toContain('web_search = "disabled"');
    expect(first.config).toContain('apps = false');
    expect(first.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(first.args.includes('--dangerously-bypass-hook-trust')).toBe(arm === 'method');
    expect(first.cache === null).toBe(arm === 'plain');
  }
  const first = chats.find(c => c.hasMethod === false)!, resumed = chats.filter(c => c.hasMethod === false)[1]!;
  expect(resumed.args[2]).toMatch(/^[0-9a-f-]{36}$/);
  expect(first.args).not.toContain(resumed.args[2]);
  const events = (arm: string) => treated.find((t: any) => t.arm === arm).learners[0].events;
  expect(events('plain').map((e: any) => [e.outcome, e.change.summary])).toEqual([['edited', 'Saved to Codex memory (AGENTS.md).'], ['was_right', 'Changed nothing in the project.']]);
  expect(events('plain')[0].change.diff).toContain('+++ Codex memory/AGENTS.md');
  // The task and its correction: 120 tokens each, counted once though the resumed chat reports 240.
  expect(events('plain')[0].tokens).toBe(240);
  // The Method arm's task chat started a method run: its step's 1,050 tokens count with the chat's 240.
  expect(events('method')[0].tokens).toBe(240 + 1050);
  expect(events('method').map((e: any) => [e.outcome, e.change.summary])).toEqual([
    ['edited', 'Wrote NOTES.md. Built a Method (review.method). Ran method judge (wrong).'], ['was_right', 'Ran method judge (wrong).']]);
  const learner = treated.find((t: any) => t.arm === 'plain').learners[0];
  expect(learner.snapshots['2'].probe).toBe('It needs to be 6 because we add one.\n');
  // A checkpoint's chat starts from Codex's memory at that point, and reports the model that Codex's saved chat names.
  const cells = ((await compareStage('plan', { comparison, go: true, treated: JSON.stringify(treated) })).cells as string[]).map(c => JSON.parse(c)).filter((c: any) => c.arm === 'plain');
  const runs = [];
  for (const cell of cells) runs.push(JSON.parse((await compareStage('cell', { cell: JSON.stringify(cell) })).full_run as string));
  expect(runs.map(r => [r.checkpoint, r.result])).toEqual([[0, '1'], [0, '2'], [2, '2'], [2, '3']]);
  expect(runs[0].models).toEqual(['gpt-6.1-sol']);
}, 600_000);

/**
 * A stand-in for the method CLI's redesign on PATH: `method redesign FILE --json` claims FILE as the Method's home in
 * its Method cache (as method redesign saves the file), or the path in ROOT/redesign-home when that file exists.
 */
function methodStub(root: string) {
  writeFileSync(join(root, 'bin', 'method'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const [command, file] = process.argv.slice(2);
if (command !== 'redesign') process.exit(1);
fs.appendFileSync(${JSON.stringify(join(root, 'redesigns.jsonl'))}, JSON.stringify({ file }) + '\\n');
const other = ${JSON.stringify(join(root, 'redesign-home'))};
const home = fs.existsSync(other) ? fs.readFileSync(other, 'utf8') : file;
fs.mkdirSync(path.join(process.env.METHOD_CACHE_DIR, 'homes'), { recursive: true });
fs.writeFileSync(path.join(process.env.METHOD_CACHE_DIR, 'homes', 'review.json'), JSON.stringify({ path: home }));
console.log(JSON.stringify({ line: 'Redesigned review.method.', tokens: 3 }));
`, { mode: 0o700 });
}
/** The fixture with fixed corrections and a redesign after the first, and fixes that change the Method's home. */
function redesignFixture() {
  const { root, file } = fixture();
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const { 'teaching/t1.json': _t1, 'teaching/t2.json': _t2, ...expected } = doc.expected;
  writeFileSync(file, JSON.stringify({ ...doc, expected, treatment: { checkpoints: [0, 2], redesign: [1],
    events: [{ correction: 'It needs to be 6 because we add one.', input: 'teaching/t1.json' }, { correction: 'It needs to be 7 because we add one.', input: 'teaching/t2.json' }] } }));
  writeFileSync(join(root, 'fixes-on'), '');
  const calls = claudeStub(root);
  methodStub(root);
  return { root, file, calls };
}
const methodLearner = (comparison: string) => {
  const plan = JSON.parse(comparison);
  const arm = join(plan.folder, 'arms', 'method');
  return join(arm, readdirSync(arm).find(d => d.startsWith('treatment-'))!, 'learner-1');
};

it('a fix after a redesign is kept in the project, as before the redesign: the redesign runs in the project\'s desk, where the chats run the Method', async () => {
  const { root, file, calls } = redesignFixture();
  const compiled = await compileComparison(file);
  const comparison = JSON.parse(readFileSync(compiled.inputs, 'utf8')).comparison as string;
  const treated = JSON.parse((await compareStage('treat', { comparison, go: true })).treatment as string);
  const learner = treated.find((t: any) => t.arm === 'method').learners[0];
  expect(learner.redesigns.map((r: any) => [r.at_event, r.received, r.line])).toEqual([[1, true, 'Redesigned review.method.']]);
  // The redesign changed the file that the chats work on, not the comparison's copy of the project.
  const [redesigned] = lines(join(root, 'redesigns.jsonl'));
  const chat = calls().find(c => c.hasMethod)!;
  expect(redesigned.file).toBe(join(chat.cwd, 'review.method'));
  expect(learner.events.map((e: any) => [e.index, e.outcome])).toEqual([[1, 'edited'], [2, 'edited']]);
  expect(learner.events[1].change.summary).toContain('cases/correction-2/case.json');
  // Both checks are in the project that the comparison keeps, and in its checkpoint.
  const project = join(methodLearner(comparison), 'project');
  expect(readdirSync(join(project, 'cases')).sort()).toEqual(['correction-1', 'correction-2']);
  expect(JSON.parse(readFileSync(join(project, 'cases', 'correction-2', 'case.json'), 'utf8')).note).toBe('It needs to be 7 because we add one.');
  expect(existsSync(join(methodLearner(comparison), 'after-2', 'project', 'cases', 'correction-2'))).toBe(true);
}, 600_000);

it('a fix that said Fixed but whose change the project does not keep stops the event as a product error, not as "not edited"', async () => {
  const { root, file } = redesignFixture();
  const compiled = await compileComparison(file);
  const comparison = JSON.parse(readFileSync(compiled.inputs, 'utf8')).comparison as string;
  // The Method's home goes outside the project's desk at the redesign, as it did when the redesign ran on the comparison's copy.
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(elsewhere);
  writeFileSync(join(root, 'redesign-home'), join(elsewhere, 'review.method'));
  const treated = JSON.parse((await compareStage('treat', { comparison, go: true })).treatment as string);
  const learner = treated.find((t: any) => t.arm === 'method').learners[0];
  expect(learner.events.map((e: any) => [e.index, e.outcome, e.received])).toEqual([[1, 'edited', true], [2, 'stopped', false]]);
  expect(learner.missing[0]).toMatchObject({ index: 2, reason: 'a product error: Method said Fixed, but the project does not keep the change' });
  expect(learner.missing[0].detail).toContain(join(elsewhere, 'review.method'));
  // Its start stays, so a rerun gives the event again from the same state.
  expect(existsSync(join(methodLearner(comparison), 'events', '2', 'start', 'project'))).toBe(true);
}, 600_000);

it('a correction with no fix after an earlier Fixed counts as not edited: only the fixes that this chat ended are checked, though the copy back gives every fix record a new time', async () => {
  const { root, file } = redesignFixture();
  writeFileSync(join(root, 'no-fix-found'), '');
  const compiled = await compileComparison(file);
  const comparison = JSON.parse(readFileSync(compiled.inputs, 'utf8')).comparison as string;
  const treated = JSON.parse((await compareStage('treat', { comparison, go: true })).treatment as string);
  const learner = treated.find((t: any) => t.arm === 'method').learners[0];
  expect(learner.events.map((e: any) => [e.index, e.outcome, e.received])).toEqual([[1, 'edited', true], [2, 'not_edited', true]]);
  expect(learner.missing).toEqual([]);
  // A rerun gives nothing again.
  const again = JSON.parse((await compareStage('treat', { comparison, go: true })).treatment as string);
  expect(again.find((t: any) => t.arm === 'method').learners[0].events.map((e: any) => e.outcome)).toEqual(['edited', 'not_edited']);
}, 600_000);

it('a chat ends only when the fix that its judgment started has ended, also before the fix takes its lock', async () => {
  const { spawn } = await import('node:child_process');
  const cache = mkdtempSync(join(tmpdir(), 'method-fixes-'));
  try {
    // method judge marked the correction as being fixed by a process that has not taken the Method's lock yet.
    const fix = spawn('sleep', ['1']);
    const outcomes = join(cache, 'fixes', 'wf_' + 'a'.repeat(32), 'outcomes');
    mkdirSync(outcomes, { recursive: true });
    writeFileSync(join(outcomes, 'jdg_1.json'), JSON.stringify({ status: 'working', pid: fix.pid }));
    // A record of a fix that ended does not hold the chat.
    writeFileSync(join(outcomes, 'jdg_0.json'), JSON.stringify({ status: 'done', pid: process.pid }));
    const started = Date.now();
    await waitForFixes(cache);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(fix.exitCode).toBe(0);
  } finally { rmSync(cache, { recursive: true, force: true }); }
});
