/**
 * Explicit end-to-end test on real Codex (your own Codex sign-in and usage; no Claude Code): a two-arm comparison of
 * Codex projects, plain and with the Method plugin, on one checking input and one teaching event with one correction,
 * measured at checkpoints 0 and 1. It checks that every chat ran on Codex with the arm's model, that the correction
 * was the second message of the same chat, and that each arm handed in its file. The Method arm's method command uses
 * this computer's Method sign-in. Run: npm run test:codex-project
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { compareStage, compileComparison } from '../../packages/sdk/src/compare.js';

const model = process.env.CODEX_MODEL ?? 'gpt-6.1-sol';
const root = mkdtempSync(join(tmpdir(), 'method-codex-project-'));
for (const [dir, id, n] of [['inputs', 'one', 3], ['teaching', 't1', 5]] as const) {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, `${id}.json`), JSON.stringify({ n }));
}
mkdirSync(join(root, 'expected'));
for (const [id, n] of [['one', 3], ['t1', 5]] as const) writeFileSync(join(root, 'expected', `${id}.json`), JSON.stringify({ answer: n * 2 }));
writeFileSync(join(root, 'message.md'), 'The number is {{n}}. Write only the answer number, no other text, to answer.txt in this folder. Keep it short.');
writeFileSync(join(root, 'writer.mjs'), `import{readFileSync}from'node:fs';const{output,expected}=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({correction:Number(String(output).trim())===expected.answer?null:'The answer is always the number doubled. Here it is '+expected.answer+'. Keep this rule for next time.',checked:'all'}))`);
writeFileSync(join(root, 'right.mjs'), `import{readFileSync}from'node:fs';const{output,expected}=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({score:Number(String(output??'').trim())===expected.answer?1:0}))`);
const file = join(root, 'tiny.compare');
writeFileSync(file, JSON.stringify({
  question: 'Does Codex keep a correction better with the Method plugin?',
  arms: { plain: { project: 'codex', model, effort: 'low' }, method: { project: 'codex', plugins: ['method'], model, effort: 'low' } },
  difference: 'The Method plugin.', inputs: ['inputs/one.json'], teaching: ['teaching/t1.json'], deliverable: 'answer.txt', message: 'message.md',
  expected: { 'inputs/one.json': 'expected/one.json', 'teaching/t1.json': 'expected/t1.json' },
  measure: { name: 'right', code: 'right.mjs' }, rule: { margin: 0.1, min_runs: 1, at: 1 }, runs: 1,
  treatment: { feedback_writers: { her: { code: 'writer.mjs' } }, checkpoints: [0, 1], events: [{ feedback: 'her', input: 'teaching/t1.json' }] },
}));
console.log(`Comparison in ${root}`);
const compiled = await compileComparison(file);
assert.deepEqual(compiled.spec.arms.map((a: any) => a.agent), ['codex', 'codex']);
const comparison = JSON.parse(readFileSync(compiled.inputs, 'utf8')).comparison as string;
const plan = JSON.parse(comparison);
console.log('Treatment: one chat per arm, with the correction as its second message');
const treated = (await compareStage('treat', { comparison, go: true })).treatment as string;
for (const arm of JSON.parse(treated)) {
  const event = arm.learners[0].events[0];
  console.log(`  ${arm.arm}: ${event.outcome}; ${event.change?.summary}; tokens ${event.tokens}`);
  assert.equal(event.received, true, `${arm.arm} did not receive its correction: ${event.reason ?? ''} ${event.detail ?? ''}`);
  // Two messages of one chat: the second resumed the first's thread.
  const work = join(plan.folder, 'arms', arm.arm);
  const learner = readdirSync(work).find(d => d.startsWith('treatment-'))!;
  const attempts = join(work, learner, 'learner-1', 'events', '1', 'artifacts', 'session');
  const threads = readdirSync(attempts).sort().map(a => readFileSync(join(attempts, a, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).find(e => e.type === 'thread.started')?.thread_id);
  assert.equal(threads.length, 2);
  assert.equal(threads[0], threads[1]);
}
console.log('Checkpoints 0 and 1: one new chat per arm each');
const cells = ((await compareStage('plan', { comparison, go: true, treated })).cells as string[]).map(c => JSON.parse(c));
for (const cell of cells) {
  const run = JSON.parse((await compareStage('cell', { cell: JSON.stringify(cell) })).full_run as string);
  console.log(`  ${cell.arm} after ${cell.checkpoint}: handed in ${JSON.stringify(run.result)}; models ${run.models.join(', ')}`);
  assert.equal(run.handed_in, true);
  assert.deepEqual(run.models, [model]);
}
assert(existsSync(plan.folder));
console.log('PASS: Codex project chats ran on Codex with the arm\'s model; the correction resumed its chat; every chat handed in its file.');
