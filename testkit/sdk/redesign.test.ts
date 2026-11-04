import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCase } from '@withmethod/runtime/cases.js';
import { learnerAgent } from '../../packages/sdk/src/learner.js';
import { keepRedesign, redesignLine, redesignMethod, redesignPrompt } from '../../packages/sdk/src/redesign.js';
import { runCases } from '../../packages/sdk/src/quality.js';
import { runCurrentMethod } from '../../packages/sdk/src/current-runtime.js';

// method redesign with a stub agent: the stub rewrites the private copy as a session would, and the gate runs the
// Method's real saved checks on it. Nothing here calls a real model.

const roots: string[] = [];
const session = learnerAgent.session;
afterEach(() => { learnerAgent.session = session; vi.restoreAllMocks(); vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const node = { allow_local_processes: true, runtimes: { node: { command: process.execPath, version: process.version } } };
const PROMPT = 'Write the reply to the request about the {{clause}} clause.\n\nNever accept a perpetual term.';

/**
 * A Method with one step whose script writes the reply, a prompt-like text in guide.md, and saved checks: the term
 * clause (check 1, which a redesign sees) and, unless one, the perpetual clause (check 2, held back).
 */
async function project(checks = 2) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'method-redesign-'))); roots.push(root);
  vi.stubEnv('METHOD_CACHE_DIR', join(root, 'cache')); vi.stubEnv('METHOD_CONFIG_DIR', join(root, 'config'));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const folder = join(root, 'project'); mkdirSync(folder);
  const file = join(folder, 'reply.method');
  writeFileSync(join(folder, 'guide.md'), PROMPT + '\n');
  writeFileSync(join(folder, 'write.mjs'), `import{readFileSync}from'node:fs';const{clause}=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({reply:\`We accept the \${clause} clause.\`}));\n`);
  const method = { format: 'method/3.4', name: 'Reply', goal: 'Write the reply to an NDA request.', inputs: { clause: { type: 'text', description: 'The clause.' } }, files: ['guide.md'],
    steps: { write: { name: 'Write', purpose: 'Writes the reply.', in: { clause: 'inputs.clause' }, do: { kind: 'run', runtime: 'node', entrypoint: 'write.mjs' }, out: { reply: { type: 'text', description: 'The reply.' } } } }, result: 'reply' };
  writeFileSync(file, JSON.stringify(method, null, 2) + '\n');
  const run = join(root, 'cache', 'runs', 'r1');
  await runCurrentMethod(file, node, { runDir: run, inputs: { clause: 'term' } });
  await createCase({ methodFile: file, passingRun: run, id: 'correction-term', note: 'Accept the term clause.', expect: [{ kind: 'equals', ref: 'outputs.reply', value: 'We accept the term clause.' }] } as any);
  if (checks > 1) {
    await new Promise(wait => setTimeout(wait, 5));
    const second = join(root, 'cache', 'runs', 'r2');
    await runCurrentMethod(file, node, { runDir: second, inputs: { clause: 'perpetual' } });
    await createCase({ methodFile: file, passingRun: second, id: 'correction-perpetual000', note: 'Name the perpetual clause.', expect: [{ kind: 'equals', ref: 'outputs.reply', value: 'We accept the perpetual clause.' }] } as any);
  }
  return { root, folder, file, run, method };
}
const stub = (...tries: Array<(dir: string) => void>) => {
  const prompts: string[] = [];
  learnerAgent.session = vi.fn(async ({ room, prompt }) => { prompts.push(prompt); (tries[prompts.length - 1] ?? tries.at(-1)!)(room); return { status: 'completed' as const, final_text: 'Done.' }; });
  return prompts;
};
const save = (dir: string, value: unknown) => writeFileSync(join(dir, '.fix', 'result.json'), JSON.stringify(value));

it('a redesign may split steps and move the person\'s words, unchanged, when every saved check still passes', async () => {
  const { root, file, run } = await project();
  const prompts = stub(dir => {
    // Two steps: code picks the clause's kind; the words of guide.md move, unchanged, to rules.md.
    writeFileSync(join(dir, 'rules.md'), readFileSync(join(dir, 'guide.md'), 'utf8'));
    rmSync(join(dir, 'guide.md'));
    writeFileSync(join(dir, 'kind.mjs'), `import{readFileSync}from'node:fs';const{clause}=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({kind:clause}));\n`);
    const m = JSON.parse(readFileSync(join(dir, 'reply.method'), 'utf8'));
    m.files = ['rules.md'];
    m.steps = { kind: { name: 'Kind', purpose: 'Finds the kind of clause.', in: { clause: 'inputs.clause' }, do: { kind: 'run', runtime: 'node', entrypoint: 'kind.mjs' }, out: { kind: { type: 'text', description: 'The kind.' } } },
      write: { ...m.steps.write, in: { clause: 'kind' } } };
    writeFileSync(join(dir, 'reply.method'), JSON.stringify(m, null, 2) + '\n');
    writeFileSync(join(dir, '.fix', 'design.md'), 'One clause in, one reply out.\n');
    save(dir, { outcome: 'redesigned', summary: 'The kind of clause is found first.' });
  });
  let seen: string[] = [];
  const session = learnerAgent.session;
  learnerAgent.session = async input => { seen = readdirSync(join(input.room, 'cases')); return session(input); };
  const corrections = [{ id: 'jdg_' + 'a'.repeat(32), note: 'Accept the term clause.', run_dir: run, created_at: '2026-11-03T10:00:00Z', outcome: 'fixed' },
    { id: 'jdg_perpetual0000000000000000000', note: 'Name the perpetual clause.', run_dir: run, created_at: '2026-11-03T11:00:00Z', outcome: 'fixed' }];
  const result = await redesignMethod(file, { corrections, model: { agent: 'codex' }, workDir: join(root, 'work'), runCases: runCases as any });
  expect(result.outcome).toBe('redesigned');
  expect(result.checks).toBe(1);
  // Check 1 was seen; check 2 and its correction were held back, and A and B ran once on its input: both pass it.
  expect(seen).toEqual(['correction-term']);
  expect(readFileSync(join(result.room!, '.fix', 'corrections.md'), 'utf8')).not.toContain('perpetual');
  expect(result.held_back).toMatchObject({ checks: 1, a: { passed: 1, tokens: 0 }, b: { passed: 1, tokens: 0 } });
  // Its tokens: the stub session and the script Method's test runs report none.
  expect(result.tokens).toBe(0);
  expect(result.changed).toEqual(expect.arrayContaining(['guide.md', 'kind.mjs', 'reply.method', 'rules.md']));
  // The session read the guide and every correction with its run, and was told it may move the person's words.
  expect(prompts[0]).toBe(redesignPrompt('reply.method'));
  expect(prompts[0]).toContain('You may move one of their paragraphs, unchanged');
  expect(readFileSync(join(result.room!, '.fix', 'guide.md'), 'utf8')).toContain('# Design from the problem');
  expect(readFileSync(join(result.room!, '.fix', 'corrections.md'), 'utf8')).toContain('Accept the term clause.');
  expect(redesignLine('reply.method', result)).toMatch(/^Rewrote reply\.method from the problem: The kind of clause is found first\. Every correction that it saw still holds \(1 checked\)\. On 1 held-back check that the rewrite did not see, the new version passed 1 with 0 tokens in \d+ s, and the version before passed 1 with 0 tokens in \d+ s\.$/);
});

it('a redesign that rewords the person\'s words or breaks a saved check goes back to the agent, and is not applied after 3 tries', async () => {
  const { root, file, run } = await project();
  const prompts = stub(dir => {
    writeFileSync(join(dir, 'guide.md'), 'Write a short reply about the {{clause}} clause.\n\nNever accept a perpetual term.\n');
    writeFileSync(join(dir, 'write.mjs'), `console.log(JSON.stringify({reply:'No.'}));\n`);
    save(dir, { outcome: 'redesigned', summary: 'Shorter replies.' });
  });
  const result = await redesignMethod(file, { corrections: [{ id: 'jdg_' + 'b'.repeat(32), note: 'Accept the term clause.', run_dir: run }], model: { agent: 'claude' }, workDir: join(root, 'work'), runCases: runCases as any });
  expect(result.outcome).toBe('no_redesign_found');
  expect(prompts).toHaveLength(3);
  expect(prompts[1]).toContain('You changed the person\'s own words in the file guide.md: "Write the reply to the request about the {{clause}} clause."');
  expect(readFileSync(join(root, 'project', 'write.mjs'), 'utf8')).toContain('We accept');
});

it('a redesign that passes fewer held-back checks than the Method as it is is discarded, with both counts', async () => {
  const { root, file } = await project();
  stub(dir => {
    // It keeps the check it sees (the term clause) and changes the reply to the clause it does not see.
    writeFileSync(join(dir, 'write.mjs'), `import{readFileSync}from'node:fs';const{clause}=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({reply:clause==='term'?'We accept the term clause.':'We refuse the '+clause+' clause.'}));\n`);
    save(dir, { outcome: 'redesigned', summary: 'Unknown clauses are refused.' });
  });
  const result = await redesignMethod(file, { corrections: [], model: { agent: 'claude' }, workDir: join(root, 'work'), runCases: runCases as any });
  expect(result.outcome).toBe('discarded');
  expect(result.held_back).toMatchObject({ checks: 1, a: { passed: 1 }, b: { passed: 0 } });
  expect(redesignLine('reply.method', result)).toMatch(/^Redesign tried and discarded: reply\.method is unchanged\. On 1 held-back check that the rewrite did not see, the new version passed 0 with 0 tokens in \d+ s, and the version before passed 1 with 0 tokens/);
});

it('a redesign needs at least 2 saved checks: with 1 there is nothing to hold back, and no session runs', async () => {
  const { root, file } = await project(1);
  const prompts = stub(() => { throw Error('no session'); });
  const result = await redesignMethod(file, { corrections: [], model: { agent: 'claude' }, workDir: join(root, 'work'), runCases: runCases as any });
  expect(result).toMatchObject({ outcome: 'not_tried', tries: 0 });
  expect(prompts).toEqual([]);
  expect(redesignLine('reply.method', result)).toBe('Redesign not tried: a redesign is tested on the checks that it does not see, and reply.method has only 1 saved check; it needs at least 2.');
});

it('B is kept when it passes more held-back checks, or as many with no more than 1.2 times the tokens', () => {
  const run = (passed: number, tokens: number) => ({ passed, tokens, seconds: 1 });
  expect(keepRedesign({ checks: 4, a: run(2, 100), b: run(3, 500) })).toBe(true);
  expect(keepRedesign({ checks: 4, a: run(3, 100), b: run(3, 120) })).toBe(true);
  expect(keepRedesign({ checks: 4, a: run(3, 100), b: run(3, 121) })).toBe(false);
  expect(keepRedesign({ checks: 4, a: run(3, 100), b: run(2, 10) })).toBe(false);
});
