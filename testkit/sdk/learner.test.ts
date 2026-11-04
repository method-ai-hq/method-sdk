import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createCase } from '@withmethod/runtime/cases.js';
import { changedUserText, learnCorrection, learnerAgent, learnerMethod, learnerPrompt, nextWritten, paragraphs, readWritten, textPlaces, type LearnerCorrection } from '../../packages/sdk/src/learner.js';
import { backgroundFix, correctionCaseId, fixCorrections } from '../../packages/sdk/src/improve.js';
import { runCases } from '../../packages/sdk/src/quality.js';
import { runCurrentMethod } from '../../packages/sdk/src/current-runtime.js';
import { readDocument } from '../../packages/sdk/src/authoring.js';
import { methodContent } from '../../packages/sdk/src/versions.js';
import { undoLast } from '../../packages/sdk/src/undo.js';
import { changesMain } from '../../packages/sdk/src/proposals.js';
import { storedOutcome } from '../../packages/sdk/src/fix-outcomes.js';
import { outcomeLine } from '../../packages/sdk/src/fix-lines.js';
import { textDiff } from '../../packages/sdk/src/text-diff.js';

// Method's learner with stub agents: each stub edits the private copy of the Method as a session would, and the gate
// runs the Method's real checks (method test) on it. Nothing here calls a real model.

const roots: string[] = [];
const session = learnerAgent.session;
afterEach(() => { learnerAgent.session = session; vi.restoreAllMocks(); vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const METHOD_ID = 'wf_' + '2'.repeat(32);
const node = { allow_local_processes: true, runtimes: { node: { command: process.execPath, version: process.version } } };

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'method-learner-'))); roots.push(root);
  vi.stubEnv('METHOD_CACHE_DIR', join(root, 'cache')); vi.stubEnv('METHOD_CONFIG_DIR', join(root, 'config'));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return root;
}

/**
 * A fake signed-in Claude Code on PATH for a call step: its reply names Legal when the prompt does. It logs each prompt.
 */
function fakeClaude(root: string) {
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:true}));process.exit(0);}
let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{
  fs.appendFileSync(${JSON.stringify(join(root, 'claude.log'))},JSON.stringify(prompt)+'\\n');
  const reply=prompt.includes('Legal')?'Thanks. The non-compete clause goes to Legal.':'Thanks. We accept the non-compete clause.';
  console.log(JSON.stringify({type:'result',subtype:'success',structured_output:{reply}}));
});`, { mode: 0o700 });
  vi.stubEnv('PATH', [bin, '/usr/bin', '/bin'].join(':')); vi.stubEnv('CLAUDECODE', '1'); vi.stubEnv('CODEX_THREAD_ID', '');
}

const GUIDE = 'Pawsome accepts standard clauses.\n\nNever accept a perpetual term.\n';

/**
 * A Method that writes the reply to one clause: kind script (write.mjs) or model (a call step), with the person's guide
 * (guide.md) and goal. Then two runs: one of the term clause, whose check Gráinne made earlier (it passes), and one of
 * the non-compete clause, which a person corrects.
 */
async function project(root: string, kind: 'script' | 'model' = 'script') {
  const folder = join(root, 'project'); mkdirSync(folder);
  const file = join(folder, 'reply.method');
  writeFileSync(join(folder, 'guide.md'), GUIDE);
  writeFileSync(join(folder, 'write.mjs'), `import{readFileSync}from'node:fs';const{clause}=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({reply:\`Thanks. We accept the \${clause} clause.\`}));\n`);
  const write = kind === 'script' ? { name: 'Write', purpose: 'Writes the reply.', in: { clause: 'inputs.clause' }, do: { kind: 'run', runtime: 'node', entrypoint: 'write.mjs' }, out: { reply: { type: 'text', description: 'The reply.' } } }
    : { name: 'Write', in: { clause: 'inputs.clause' }, do: { kind: 'call', prompt: 'Write the reply to the NDA request about the {{clause}} clause.\n\nKeep it to one sentence.' }, out: { reply: { type: 'text', description: 'The reply.' } } };
  writeFileSync(file, JSON.stringify({ format: 'method/3.4', id: METHOD_ID, name: 'Reply', goal: 'Write the reply to an NDA request.', inputs: { clause: { type: 'text', description: 'The clause.' } },
    files: ['guide.md'], steps: { write }, result: 'reply' }, null, 2) + '\n');
  const run = async (name: string, clause: string) => {
    const dir = join(root, 'cache', 'runs', name);
    await runCurrentMethod(file, node, { runDir: dir, inputs: { clause } });
    writeFileSync(join(dir, 'run-id.json'), JSON.stringify({ id: name }));
    writeFileSync(join(dir, 'method-sync.json'), JSON.stringify({ schema: 'method-sync/1', id: name, dashboard_id: `run_${name}` }));
    return dir;
  };
  const termRun = await run('aaaaaaaa-0000-4000-8000-000000000001', 'term');
  const badRun = await run('aaaaaaaa-0000-4000-8000-000000000002', 'non-compete');
  // Gráinne's earlier check, made from a run that was right.
  if (kind === 'script') await createCase({ methodFile: file, passingRun: termRun, id: 'correction-term', note: 'Accept the term clause.', author: 'Gráinne', expect: [{ kind: 'equals', ref: 'outputs.reply', value: 'Thanks. We accept the term clause.' }] } as any);
  return { folder, file, termRun, badRun };
}

const JUDGMENT = 'jdg_' + 'a'.repeat(32), CASE = correctionCaseId(JUDGMENT);
const correction = (run: string, extra: Partial<LearnerCorrection> = {}): LearnerCorrection => ({ id: JUDGMENT, run_dir: run, note: 'Non-competes go to Legal.', noted_by: 'Ryan', created_at: '2026-10-28T10:00:00Z', ...extra });
const learn = async (file: string, c: LearnerCorrection, root: string) => { const learned = await learnCorrection(file, [c], { earlier: [], caseIds: [CASE], model: { agent: 'claude' }, workDir: join(root, 'work'), runCases: runCases as any }); return { ...learned, outcome: learned.outcomes[0]! }; };

/** What a stub agent does in its room: write the check (as method case new does), edit files, and say its outcome. */
const room = {
  read: (dir: string, path: string) => readFileSync(join(dir, path), 'utf8'),
  write: (dir: string, path: string, text: string) => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text); },
  method: (dir: string) => JSON.parse(readFileSync(join(dir, 'reply.method'), 'utf8')),
  save: (dir: string, method: any) => writeFileSync(join(dir, 'reply.method'), JSON.stringify(method, null, 2) + '\n'),
  check: async (dir: string, value = 'Thanks. The non-compete clause goes to Legal.') => {
    if (existsSync(join(dir, 'cases', CASE, 'case.json'))) return;
    await createCase({ methodFile: join(dir, 'reply.method'), runDir: join(dir, '.fix', 'run'), id: CASE, note: 'Non-competes go to Legal.', expect: [{ kind: 'equals', ref: 'outputs.reply', value }] } as any);
  },
  result: (dir: string, value: unknown) => writeFileSync(join(dir, '.fix', 'result.json'), JSON.stringify(value)),
};
/** A stub agent: one function per try, in order (the last one again for later sessions). Each gets the room and the prompt of its try. */
function stub(...tries: Array<(dir: string, prompt: string) => Promise<void> | void>) {
  const prompts: string[] = [];
  learnerAgent.session = vi.fn(async ({ room: dir, prompt }) => { prompts.push(prompt); await (tries[prompts.length - 1] ?? tries.at(-1)!)(dir, prompt); return { status: 'completed' as const, final_text: 'Done.' }; });
  return prompts;
}
/** The change that fixes the script Method: a new run step with a data file of the clauses that go to Legal. */
async function codeStep(dir: string) {
  await room.check(dir);
  room.write(dir, 'legal.json', JSON.stringify(['non-compete']) + '\n');
  room.write(dir, 'route.mjs', `import{readFileSync}from'node:fs';const{clause}=JSON.parse(readFileSync(0,'utf8'));const legal=JSON.parse(readFileSync(new URL('./legal.json',import.meta.url),'utf8'));console.log(JSON.stringify({to_legal:legal.includes(clause)}));\n`);
  room.write(dir, 'write.mjs', `import{readFileSync}from'node:fs';const{clause,to_legal}=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({reply:to_legal?\`Thanks. The \${clause} clause goes to Legal.\`:\`Thanks. We accept the \${clause} clause.\`}));\n`);
  const method = room.method(dir);
  method.files = ['guide.md', 'legal.json'];
  method.steps = { route: { name: 'Route', purpose: 'Says whether the clause goes to Legal, from legal.json.', in: { clause: 'inputs.clause' }, do: { kind: 'run', runtime: 'node', entrypoint: 'route.mjs' }, out: { to_legal: { type: 'boolean', description: 'The clause goes to Legal.' } } },
    write: { ...method.steps.write, in: { clause: 'inputs.clause', to_legal: 'to_legal' } } };
  room.save(dir, method);
  room.result(dir, { outcome: 'fixed', summary: 'Replies now send non-compete clauses to Legal.' });
}

it('a stub learner adds a run step with a data file: the gate tests it for real, and the change comes with its summary and diff', async () => {
  const root = setup();
  const { file, badRun } = await project(root);
  const prompts = stub(codeStep);
  const learned = await learn(file, correction(badRun), root);
  expect(learned.outcome).toMatchObject({ id: JUDGMENT, outcome: 'fixed', summary: 'Replies now send non-compete clauses to Legal.', tested: { times: 1, earlier: 1 } });
  expect(learned.outcome.tested_output?.result).toBe('Thanks. The non-compete clause goes to Legal.');
  expect(learned.changed).toEqual(expect.arrayContaining(['legal.json', 'reply.method', 'route.mjs', 'write.mjs', `cases/${CASE}/case.json`]));
  expect(learned.diff).toContain('+++ legal.json');
  expect(learned.diff).toContain('+["non-compete"]');
  expect(learned.diff).not.toContain('cases/');
  // One session: it read the brief in its room, with the run, the earlier corrections and the guide.
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toBe(learnerPrompt('reply.method', [CASE]));
  const brief = join(root, 'work', 'room', '.fix');
  expect(readFileSync(join(brief, 'correction.md'), 'utf8')).toContain('Ryan wrote (2026-10-28):\n\nNon-competes go to Legal.');
  expect(readFileSync(join(brief, 'run.md'), 'utf8')).toContain('Thanks. We accept the non-compete clause.');
  expect(readFileSync(join(brief, 'guide.md'), 'utf8')).toContain('# A Method that just works');
  expect(existsSync(join(brief, 'run', 'events.jsonl'))).toBe(true);
  // The check is the person's, made from the run that they corrected.
  expect(JSON.parse(readFileSync(join(root, 'work', 'room', 'cases', CASE, 'case.json'), 'utf8'))).toMatchObject({ author: 'Ryan', source: { run_dir: badRun } });
});

it('a stub learner edits a prompt: the changed model step runs live 3 times, and the new paragraph is Method\'s own', async () => {
  const root = setup(); fakeClaude(root);
  const { file, badRun } = await project(root, 'model');
  stub(async dir => {
    await room.check(dir);
    const method = room.method(dir);
    method.steps.write.do.prompt += '\n\nSend each non-compete clause to Legal, and say so in the reply.';
    room.save(dir, method);
    room.result(dir, { outcome: 'fixed', summary: 'Replies now send non-compete clauses to Legal.' });
  });
  const learned = await learn(file, correction(badRun), root);
  expect(learned.outcome).toMatchObject({ outcome: 'fixed', tested: { times: 3, earlier: 0 } });
  expect(learned.diff).toContain('Send each non-compete clause to Legal');
  // Method wrote the new paragraph; the person's paragraphs stay theirs.
  expect(learned.written!.places['steps.write.do.prompt']).toHaveLength(1);
  const prompts = readFileSync(join(root, 'claude.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(prompts.filter(p => p.includes('Send each non-compete clause to Legal'))).toHaveLength(3);
}, 60_000);

it('a stub learner adds a check to a model step: its retry fixes the reply', async () => {
  const root = setup(); fakeClaude(root);
  const { file, badRun } = await project(root, 'model');
  stub(async dir => {
    await room.check(dir);
    room.write(dir, 'check-legal.mjs', `import{readFileSync}from'node:fs';const{outputs}=JSON.parse(readFileSync(0,'utf8'));const ok=outputs.reply.includes('Legal');console.log(JSON.stringify({status:ok?'pass':'fail',reason:ok?'It names Legal.':'A reply about a non-compete clause must say that it goes to Legal.',evidence:[]}));\n`);
    const method = room.method(dir);
    method.steps.write.check = { kind: 'run', runtime: 'node', entrypoint: 'check-legal.mjs' };
    room.save(dir, method);
    room.result(dir, { outcome: 'fixed', summary: 'A check makes each reply about a non-compete clause name Legal.' });
  });
  const learned = await learn(file, correction(badRun), root);
  expect(learned.outcome).toMatchObject({ outcome: 'fixed' });
  expect(learned.changed).toEqual(expect.arrayContaining(['check-legal.mjs', 'reply.method']));
}, 60_000);

it('refuses a change to the person\'s own words with the exact failure; the next try keeps them and adds its own', async () => {
  const root = setup();
  const { file, badRun } = await project(root);
  const prompts = stub(async dir => {
    await codeStep(dir);
    room.write(dir, 'guide.md', 'Pawsome accepts standard clauses, except non-competes.\n\nNever accept a perpetual term.\n');
  }, async dir => {
    room.write(dir, 'guide.md', `${GUIDE}\nNon-compete clauses go to Legal.\n`);
    room.result(dir, { outcome: 'fixed', summary: 'Replies now send non-compete clauses to Legal.' });
  });
  const learned = await learn(file, correction(badRun), root);
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain('This is try 2 of 3.');
  // A later try reads its notes and the failure, not the brief and the guide again.
  expect(prompts[0]).toContain('Read these first:');
  expect(prompts[1]).not.toContain('Read these first:');
  expect(prompts[1]).toContain('Read only .fix/notes.md, .fix/correction.md, reply.method');
  expect(prompts[1]).toContain('do not read .fix/guide.md whole again, and do not run method authoring');
  expect(prompts[1]).toContain('You changed the person\'s own words in the file guide.md: "Pawsome accepts standard clauses.". Put the paragraph back word for word.');
  expect(learned.outcome).toMatchObject({ outcome: 'fixed' });
  expect(learned.tries).toBe(2);
  expect(learned.written!.places['file:guide.md']).toHaveLength(1);
}, 60_000);

it('changes the person\'s words only after they answered a question that quotes them', async () => {
  const root = setup();
  const { file, badRun } = await project(root);
  stub(dir => room.result(dir, { outcome: 'question', question: 'Your guide says "Pawsome accepts standard clauses." May I add "except non-competes, which go to Legal"?' }));
  const asked = await learn(file, correction(badRun), root);
  expect(asked.outcome).toEqual({ id: JUDGMENT, outcome: 'question', question: 'Your guide says "Pawsome accepts standard clauses." May I add "except non-competes, which go to Legal"?' });
  expect(asked.changed).toEqual([]);
  stub(async dir => {
    await codeStep(dir);
    room.write(dir, 'guide.md', 'Pawsome accepts standard clauses, except non-competes, which go to Legal.\n\nNever accept a perpetual term.\n');
  });
  const answered = await learn(file, correction(badRun, { question: asked.outcome.question!, answer: 'Yes, do that.' }), root);
  expect(answered.outcome.outcome).toBe('fixed');
  expect(answered.diff).toContain('-Pawsome accepts standard clauses.');
});

it('a change that breaks an earlier check gets the failure, tries again, and ends held for the other person after 3 tries', async () => {
  const root = setup();
  const { file, badRun } = await project(root);
  const had: boolean[] = [];
  const everyClauseToLegal = async (dir: string) => {
    had.push(existsSync(join(dir, 'cases', 'correction-term', 'case.json')));
    await room.check(dir);
    room.write(dir, 'write.mjs', `import{readFileSync}from'node:fs';const{clause}=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({reply:\`Thanks. The \${clause} clause goes to Legal.\`}));\n`);
    room.result(dir, { outcome: 'fixed', summary: 'Replies now send clauses to Legal.' });
  };
  const prompts = stub(everyClauseToLegal, everyClauseToLegal, everyClauseToLegal);
  const learned = await learn(file, correction(badRun), root);
  expect(prompts).toHaveLength(3);
  expect(prompts[1]).toContain('Your change breaks the check correction-term, from Gráinne\'s correction ("Accept the term clause")');
  // The first try did not have the earlier check; the next tries have the one that broke, to read and test it.
  expect(had).toEqual([false, true, true]);
  expect(prompts[1]).toContain('This check is now in cases/ for your next try: cases/correction-term. Read it, and test it with method test --case ID.');
  expect(learned.outcome).toEqual({ id: JUDGMENT, outcome: 'held', by: 'Gráinne', detail: 'Accept the term clause.' });
  expect(learned.changed).toEqual([]);
  // The exact failures stay in the work folder.
  expect(readFileSync(join(root, 'work', 'tries', '3', 'gate.txt'), 'utf8')).toContain('correction-term');
  // From the same person it is no fix found, in plain words.
  stub(everyClauseToLegal, everyClauseToLegal, everyClauseToLegal);
  const own = await learn(file, correction(badRun, { noted_by: 'Gráinne' }), root);
  expect(own.outcome).toMatchObject({ outcome: 'no_fix_found' });
  expect(outcomeLine(own.outcome)).toBe("No fix found yet: I tried 3 changes, and none fixed this result without breaking another one or your own words. I'll keep your note.");
}, 60_000);

it('a check that passes on the Method as it was is refused: it does not show the mistake', async () => {
  const root = setup();
  const { file, badRun } = await project(root);
  const prompts = stub(async dir => {
    await createCase({ methodFile: join(dir, 'reply.method'), passingRun: join(dir, '.fix', 'run'), id: CASE, note: 'Non-competes go to Legal.', expect: [{ kind: 'equals', ref: 'outputs.reply', value: 'Thanks. We accept the non-compete clause.' }] } as any);
    room.result(dir, { outcome: 'fixed', summary: 'Nothing.' });
  }, async () => { throw Object.assign(Error('You have hit your usage limit.'), { code: 'usage_limit' }); });
  // The second try stops at the usage limit: a plain error, with nothing applied.
  await expect(learn(file, correction(badRun), root)).rejects.toThrow('usage limit');
  expect(prompts[1]).toContain('passes on the Method as it was, so it does not show the mistake');
});

it('no change needed: the check passes on the run, and only the check stays', async () => {
  const root = setup();
  const { file, badRun } = await project(root);
  stub(async dir => {
    await createCase({ methodFile: join(dir, 'reply.method'), passingRun: join(dir, '.fix', 'run'), id: CASE, note: 'Name the clause.', expect: [{ kind: 'equals', ref: 'outputs.reply', value: 'Thanks. We accept the non-compete clause.' }] } as any);
    room.write(dir, 'write.mjs', 'console.log("{}")\n');
    room.result(dir, { outcome: 'no_change_needed', detail: 'the reply already names the clause' });
  });
  const learned = await learn(file, correction(badRun), root);
  expect(learned.outcome).toEqual({ id: JUDGMENT, outcome: 'no_change_needed', detail: 'the reply already names the clause' });
  expect(learned.changed.every(p => p.startsWith(`cases/${CASE}/`))).toBe(true);
  expect(learned.diff).toBe('');
});

it('a question and a no fix found from the agent end at once, with nothing changed', async () => {
  const root = setup();
  const { file, badRun } = await project(root);
  stub(dir => room.result(dir, { outcome: 'no_fix_found', detail: 'the request named the wrong clause, which the agent cannot know' }));
  expect((await learn(file, correction(badRun), root)).outcome).toEqual({ id: JUDGMENT, outcome: 'no_fix_found', detail: 'the request named the wrong clause, which the agent cannot know' });
  const prompts = stub(() => {}, dir => room.result(dir, { outcome: 'question', question: 'Which clauses go to Legal?' }));
  expect((await learn(file, correction(badRun), root)).outcome).toMatchObject({ outcome: 'question' });
  expect(prompts[1]).toContain('There is no .fix/result.json with your outcome');
});

// ---------- The loop: apply, record, undo ----------

function fakeClient(judgments: any[]) {
  let version = 3;
  const client = {
    server: 'https://example.test', token: () => 'method_x', calls: [] as any[], outcomes: [] as any[],
    async request(path: string, verb = 'GET', body?: any) {
      this.calls.push({ path, verb, body });
      if (verb === 'GET' && path === `/api/cli/methods/${METHOD_ID}/judgments`) return { judgments };
      if (verb === 'POST' && path === `/api/cli/methods/${METHOD_ID}/judgments/handled`) {
        const changed = body.ids.filter((id: string) => judgments.some(j => j.id === id && j.pending === body.handled));
        for (const j of judgments) if (changed.includes(j.id)) j.pending = !body.handled;
        return { changed };
      }
      if (verb === 'POST' && path === `/api/cli/methods/${METHOD_ID}/judgments/outcomes`) {
        this.outcomes.push(...body.outcomes);
        for (const o of body.outcomes) { const j = judgments.find(j => j.id === o.id); if (j) j.outcome = o.outcome; }
        return { changed: [] };
      }
      if (verb === 'POST' && path === '/api/cli/files/check') return { present: body.hashes };
      const saved = /^\/api\/cli\/methods\/[^/]+\/versions\/([^/]+)$/.exec(path);
      if (verb === 'PUT' && saved) return { version_id: saved[1], version_number: ++version };
      throw Object.assign(Error(`404: ${verb} ${path}`), { status: 404 });
    },
    async transfer() { return Buffer.alloc(0); }, async login() {},
  };
  return client as any;
}

it('the loop applies a tested change with undo, saves a version, records its correction, summary and diff, and method wait says it', async () => {
  const root = setup();
  const { folder, file, badRun } = await project(root);
  const before = readFileSync(file, 'utf8');
  const client = fakeClient([{ id: JUDGMENT, run_id: 'run_aaaaaaaa-0000-4000-8000-000000000002', step_id: null, verdict: 'wrong', note: 'Non-competes go to Legal.', corrected: null, source: 'agent', created_at: '2026-10-28T10:00:00Z', pending: true, noted_by: 'Ryan' }]);
  stub(codeStep);
  await backgroundFix(client, file, [JUDGMENT], { runCases: runCases as any });
  expect(storedOutcome(METHOD_ID, JUDGMENT)).toMatchObject({ status: 'done', outcome: { outcome: 'fixed', summary: 'Replies now send non-compete clauses to Legal.', diff: expect.stringContaining('+++ route.mjs') } });
  expect(client.outcomes).toEqual([{ id: JUDGMENT, outcome: 'fixed', detail: 'Replies now send non-compete clauses to Legal.' }]);
  expect(readDocument(file).id).toBe(METHOD_ID);
  expect(Object.keys(methodContent(readDocument(file)).steps)).toEqual(['route', 'write']);
  expect(readFileSync(join(folder, 'legal.json'), 'utf8')).toBe('["non-compete"]\n');
  expect(existsSync(join(folder, 'cases', CASE, 'case.json'))).toBe(true);
  expect(readFileSync(join(folder, 'guide.md'), 'utf8')).toBe(GUIDE);
  expect(client.calls.filter((c: any) => c.verb === 'PUT').map((c: any) => c.body.reason)).toEqual(['Method fixed it from a correction: Replies now send non-compete clauses to Legal.']);
  // The learner's copies are gone; its tries stay for the log.
  expect(existsSync(join(root, 'cache', 'fixes', METHOD_ID, 'learn', JUDGMENT, 'room'))).toBe(false);
  // method changes shows the change with its correction and diff.
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await changesMain([file, '--json'], () => ({ ...client, request: async () => ({ proposals: [] }) }));
  const change = JSON.parse(out.mock.calls.map(c => String(c[0])).join('')).changes[0];
  expect(change).toMatchObject({ source: 'local', cause: 'Replies now send non-compete clauses to Legal.', judgment: JUDGMENT, note: 'Non-competes go to Legal.', diff: expect.stringContaining('+["non-compete"]') });
  // method undo restores the Method, takes out the new files and the check, and forgets what Method wrote.
  undoLast(file);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(existsSync(join(folder, 'legal.json'))).toBe(false);
  expect(existsSync(join(folder, 'route.mjs'))).toBe(false);
  expect(existsSync(join(folder, 'cases', CASE))).toBe(false);
  expect(readWritten(folder).places).toEqual({});
}, 60_000);

it('the loop gives the correction back when the agent hits a usage limit, and method wait says why', async () => {
  const root = setup();
  const { file } = await project(root);
  const judgments = [{ id: JUDGMENT, run_id: 'run_aaaaaaaa-0000-4000-8000-000000000002', step_id: null, verdict: 'wrong', note: 'Non-competes go to Legal.', corrected: null, source: 'agent', created_at: '2026-10-28T10:00:00Z', pending: true }];
  const client = fakeClient(judgments);
  stub(async () => { throw Object.assign(Error('Claude Code reached the usage limit of your plan. It resets at 4pm.'), { code: 'usage_limit' }); });
  await expect(fixCorrections(client, file, { runCases: runCases as any })).rejects.toThrow('usage limit');
  expect(judgments[0]!.pending).toBe(true);
  await backgroundFix(client, file, [JUDGMENT], { runCases: runCases as any });
  expect(storedOutcome(METHOD_ID, JUDGMENT)).toMatchObject({ status: 'stopped', error: 'Claude Code reached the usage limit of your plan. It resets at 4pm.' });
});

it('a give-back or a report that does not reach the account is sent by the next fix, so no correction is lost', async () => {
  const root = setup();
  const { file } = await project(root);
  const judgments = [{ id: JUDGMENT, run_id: 'run_aaaaaaaa-0000-4000-8000-000000000002', step_id: null, verdict: 'wrong', note: 'Non-competes go to Legal.', corrected: null, source: 'agent', created_at: '2026-10-28T10:00:00Z', pending: true, outcome: null as string | null }];
  const client = fakeClient(judgments), request = client.request;
  // The connection drops after the fix took the correction: the agent stops, and the give-back and the report fail.
  let down = false;
  client.request = async function (path: string, verb = 'GET', body?: any) {
    if (down && verb === 'POST' && /judgments\/(handled|outcomes)$/.test(path)) throw Object.assign(Error('fetch failed: read ECONNRESET'), { code: 'network' });
    return request.call(this, path, verb, body);
  };
  stub(async () => { down = true; throw Error('fetch failed: read ECONNRESET'); });
  await backgroundFix(client, file, [JUDGMENT], { runCases: runCases as any });
  expect(storedOutcome(METHOD_ID, JUDGMENT)).toMatchObject({ status: 'stopped' });
  expect(judgments[0]).toMatchObject({ pending: false, outcome: null });
  // The next fix takes it again and fixes it, though the account still shows it as taken.
  down = false;
  stub(codeStep);
  await backgroundFix(client, file, [JUDGMENT], { runCases: runCases as any });
  expect(storedOutcome(METHOD_ID, JUDGMENT)).toMatchObject({ status: 'done', outcome: { outcome: 'fixed' } });
  expect(judgments[0]!.outcome).toBe('fixed');
  // A report that fails is sent by the next fix, and the correction is not fixed twice.
  judgments[0]!.outcome = null;
  writeFileSync(join(root, 'cache', 'fixes', METHOD_ID, 'taken.json'), JSON.stringify({ [JUDGMENT]: { id: JUDGMENT, outcome: 'fixed', summary: 'Replies now send non-compete clauses to Legal.' } }));
  stub(async () => { throw Error('the learner ran again'); });
  expect(await fixCorrections(client, file, { runCases: runCases as any })).toBeUndefined();
  expect(judgments[0]!.outcome).toBe('fixed');
  expect(existsSync(join(root, 'cache', 'fixes', METHOD_ID, 'taken.json'))).toBe(false);
}, 60_000);

// ---------- The parts ----------

it('the person\'s words: every paragraph of the prompts, the goal and the .md and .txt files, except what Method wrote', () => {
  const doc = { goal: 'Reply.', steps: { a: { do: { kind: 'call', prompt: 'One.\n\nTwo.' } }, b: { do: { kind: 'classify', question: 'Which?', options: { yes: 'Yes.', no: 'No.' } } } } };
  const before = new Map([...textPlaces(doc, '/nonexistent')]);
  expect([...before.keys()]).toEqual(['goal', 'steps.a.do.prompt', 'steps.b.do.question', 'steps.b.do.options.yes', 'steps.b.do.options.no']);
  expect(paragraphs('One.\n\n  Two\n words.\n \nThree.')).toEqual(['One.', 'Two words.', 'Three.']);
  const after = new Map(before); after.set('steps.a.do.prompt', 'One.\n\nTwo.\n\nMine.');
  expect(changedUserText(before, after, { format: 'method-written/1', places: {} })).toEqual([]);
  const written = nextWritten(before, after, { format: 'method-written/1', places: {} });
  expect(Object.keys(written.places)).toEqual(['steps.a.do.prompt']);
  // Method may change its own paragraph later, not the person's.
  const later = new Map(after); later.set('steps.a.do.prompt', 'One.\n\nMine, better.');
  expect(changedUserText(after, later, written)).toEqual([{ place: 'steps.a.do.prompt', paragraph: 'Two.' }]);
  expect(changedUserText(after, later, written, 'May I remove "Two."?')).toEqual([]);
});

it('a paragraph of the person\'s that moves, unchanged, to another step or file is kept, and stays theirs there', () => {
  const none = { format: 'method-written/1' as const, places: {} };
  const before = new Map([['steps.answer.do.prompt', 'Answer each question.\n\nQuote the NDA word for word.'], ['file:questions.md', 'Q1.\n\nQ2.']]);
  // The prompt is split into two steps, and a question moves to a file of its own.
  const after = new Map([['steps.read.do.prompt', 'Find the sentences.\n\nQuote the NDA word for word.'], ['steps.decide.do.prompt', 'Answer each question.'], ['file:questions.md', 'Q1.'], ['file:q2.md', 'Q2.']]);
  expect(changedUserText(before, after, none)).toEqual([]);
  const written = nextWritten(before, after, none);
  expect(written.places).toEqual({ 'steps.read.do.prompt': [createHash('sha256').update('Find the sentences.').digest('hex')] });
  // Moved, it is still the person's: a later change that drops it is refused.
  const later = new Map(after); later.set('steps.read.do.prompt', 'Find the sentences.');
  expect(changedUserText(after, later, written)).toEqual([{ place: 'steps.read.do.prompt', paragraph: 'Quote the NDA word for word.' }]);
  // A changed word is not a move.
  const reworded = new Map(after); reworded.set('steps.decide.do.prompt', 'Answer every question.');
  expect(changedUserText(before, reworded, none)).toEqual([{ place: 'steps.answer.do.prompt', paragraph: 'Answer each question.' }]);
});

it('the session runs on the agent, model and effort that it is given, with the file and shell tools', () => {
  expect(learnerMethod({ agent: 'claude', model: 'claude-opus-5-5', reasoning_effort: 'high' }, 60_000).steps.learn.do).toEqual({ kind: 'session', agent: 'claude', model: 'claude-opus-5-5', reasoning_effort: 'high', prompt: '{{prompt}}', tools: ['read', 'write', 'edit', 'search', 'shell'], room: 'room' });
  expect(learnerMethod({ agent: 'codex' }, 60_000).limits).toEqual({ timeout_ms: 120_000, step: { timeout_ms: 60_000 } });
});

it('a diff shows each changed line with 2 lines around it', () => {
  expect(textDiff('a\nb\nc\nd\ne\nf\ng\nh\ni', 'a\nb\nC\nd\ne\nf\ng\nh\ni\nj', 'x', 'x')).toBe(['--- x', '+++ x', '@@ -1,5 +1,5 @@', ' a', ' b', '-c', '+C', ' d', ' e', '@@ -8,2 +8,3 @@', ' h', ' i', '+j'].join('\n'));
  expect(textDiff('same', 'same')).toBe('');
});

// ---------- A faster fix ----------

it('the learner tests only its new check; Method tests the new check first, and the earlier ones only when it passes', async () => {
  const root = setup();
  const { file, badRun } = await project(root);
  const calls: any[] = [];
  const spy = (async (f: string, flags: any, options: any) => { calls.push(options); return runCases(f, flags, options); }) as any;
  // A check that still fails on the change: no earlier check runs.
  const prompts = stub(async dir => { await room.check(dir, 'Thanks. The non-compete clause goes to Legal today.'); await codeStep(dir); }, async dir => { rmSync(join(dir, 'cases', CASE), { recursive: true }); await codeStep(dir); });
  await learnCorrection(file, [correction(badRun)], { earlier: [], caseIds: [CASE], model: { agent: 'claude' }, workDir: join(root, 'work'), runCases: spy });
  expect(prompts[0]).toContain(`method test reply.method --case ${CASE}. The checks of earlier corrections are not in this folder: when you finish, Method tests every earlier check itself`);
  expect(prompts[0]).not.toMatch(/method test reply\.method\. Every check/);
  expect(calls[0]).toMatchObject({ ids: [CASE], newIds: [CASE], gate: true });
  // The failed new check went back to the agent before any earlier check ran; its next try passed, and then the earlier one ran once.
  expect(calls.map(c => c.ids)).toEqual([[CASE], [CASE], ['correction-term']]);
  expect(calls[2]).toMatchObject({ gate: true, baseline: expect.stringContaining('base') });
}, 60_000);

it('two corrections that wait together go to one session, and one change fixes both', async () => {
  const root = setup();
  const { file, badRun, termRun } = await project(root);
  const other = 'jdg_' + 'b'.repeat(32), otherCase = correctionCaseId(other);
  const prompts = stub(async (dir, prompt) => {
    expect(prompt).toContain('People corrected 2 of its runs');
    for (const [k, id] of [CASE, otherCase].entries()) await createCase({ methodFile: join(dir, 'reply.method'), runDir: join(dir, '.fix', `run-${k + 1}`), id, note: 'Non-competes go to Legal.', expect: [{ kind: 'equals', ref: 'outputs.reply', value: 'Thanks. The non-compete clause goes to Legal.' }] } as any);
    await codeStep(dir);
    room.result(dir, { outcomes: { [CASE]: { outcome: 'fixed', summary: 'Replies now send non-compete clauses to Legal.' }, [otherCase]: { outcome: 'fixed', summary: 'Replies now send non-compete clauses to Legal.' } } });
  });
  const learned = await learnCorrection(file, [correction(badRun), correction(badRun, { id: other, noted_by: 'Gráinne' })], { earlier: [], caseIds: [CASE, otherCase], model: { agent: 'claude' }, workDir: join(root, 'work'), runCases: runCases as any });
  expect(prompts).toHaveLength(1);
  expect(learned.outcomes.map(o => [o.id, o.outcome])).toEqual([[JUDGMENT, 'fixed'], [other, 'fixed']]);
  expect(readFileSync(join(root, 'work', 'room', '.fix', 'correction.md'), 'utf8')).toContain(`Its run is .fix/run-2 (.fix/run-2.md). Its check has the ID ${otherCase}.`);
  expect(JSON.parse(readFileSync(join(root, 'work', 'room', 'cases', otherCase, 'case.json'), 'utf8'))).toMatchObject({ author: 'Gráinne', source: { run_dir: badRun } });
  expect(termRun).toBeTruthy();
  // A batch that does not pass its gate is split: each half is fixed again on its own.
  stub(dir => room.result(dir, { outcomes: {} }));
  const split = await learnCorrection(file, [correction(badRun), correction(badRun, { id: other })], { earlier: [], caseIds: [CASE, otherCase], model: { agent: 'claude' }, workDir: join(root, 'work'), runCases: runCases as any });
  expect(split).toMatchObject({ split: true, outcomes: [], tries: 1 });
}, 60_000);

it('the loop splits waiting corrections that found no change together, and fixes each half on its own', async () => {
  const root = setup();
  const { file } = await project(root);
  const other = 'jdg_' + 'b'.repeat(32);
  const judgment = (id: string, at: string) => ({ id, run_id: 'run_aaaaaaaa-0000-4000-8000-000000000002', step_id: null, verdict: 'wrong', note: 'Non-competes go to Legal.', corrected: null, source: 'agent', created_at: at, pending: true, noted_by: 'Ryan' });
  const client = fakeClient([judgment(JUDGMENT, '2026-10-28T10:00:00Z'), judgment(other, '2026-10-28T10:05:00Z')]);
  const prompts = stub(dir => room.result(dir, { outcome: 'fixed' }), codeStep, async dir => {
    await createCase({ methodFile: join(dir, 'reply.method'), runDir: join(dir, '.fix', 'run'), id: correctionCaseId(other), note: 'Non-competes go to Legal.', expect: [{ kind: 'equals', ref: 'outputs.reply', value: 'Thanks. The non-compete clause goes to Legal.' }] } as any);
    room.result(dir, { outcome: 'no_change_needed', detail: 'the reply already sends it to Legal' });
  });
  await backgroundFix(client, file, [JUDGMENT, other], { runCases: runCases as any });
  expect(prompts).toHaveLength(3);
  expect(prompts[0]).toContain('People corrected 2 of its runs');
  expect(prompts[1]).toContain('A person corrected one of its runs');
  expect(client.outcomes.map((o: any) => [o.id, o.outcome])).toEqual([[JUDGMENT, 'fixed'], [other, 'no_change_needed']]);
}, 60_000);

it('a fix reads only what its correction needs: the same brief at 1 and at 12 earlier checks, which Method tests itself', async () => {
  const brief = async (earlierChecks: number) => {
    const root = setup();
    const { file, termRun, badRun } = await project(root);
    for (let i = 2; i <= earlierChecks; i++) await createCase({ methodFile: file, passingRun: termRun, id: `correction-term-${i}`, note: `Accept the term clause (${i}).`, author: 'Gráinne', expect: [{ kind: 'equals', ref: 'outputs.reply', value: 'Thanks. We accept the term clause.' }] } as any);
    let seen: { cases: string[]; bytes: number } | undefined;
    const prompts = stub(async dir => {
      const { readdirSync, statSync } = await import('node:fs');
      // What the session can read: every file of its room except the corrected run's own folder.
      const size = (path: string): number => statSync(path).isDirectory() ? readdirSync(path).filter(n => !['run', 'node_modules'].includes(n)).reduce((t, n) => t + size(join(path, n)), 0) : statSync(path).size;
      seen = { cases: existsSync(join(dir, 'cases')) ? readdirSync(join(dir, 'cases')) : [], bytes: size(dir) - size(join(dir, '.fix', 'corrections.md')) };
      await codeStep(dir);
    });
    const earlier = Array.from({ length: earlierChecks }, (_, i) => ({ id: 'jdg_' + String(i).repeat(32).slice(0, 32), note: 'Accept the term clause.', noted_by: 'Gráinne', created_at: '2026-10-27T10:00:00Z', outcome: 'fixed' }));
    const learned = await learnCorrection(file, [correction(badRun)], { earlier, caseIds: [CASE], model: { agent: 'claude' }, workDir: join(root, 'work'), runCases: runCases as any });
    return { seen: seen!, prompt: prompts[0]!, outcome: learned.outcomes[0]!, corrections: readFileSync(join(root, 'work', 'room', '.fix', 'corrections.md'), 'utf8') };
  };
  const one = await brief(1), twelve = await brief(12);
  // The session had only its new check, and the same files, whatever the number of earlier checks.
  expect(one.seen.cases).toEqual([]);
  expect(twelve.seen.cases).toEqual([]);
  expect(twelve.seen.bytes).toBe(one.seen.bytes);
  expect(twelve.prompt).toBe(one.prompt);
  expect(one.prompt).not.toContain('cases/ (the checks of earlier corrections)');
  // Each earlier correction is one short entry; the gate still tested every earlier check.
  expect(twelve.corrections).toContain('Their checks are not in this folder.');
  expect(twelve.corrections.length - one.corrections.length).toBeLessThan(11 * 200);
  expect(one.outcome).toMatchObject({ outcome: 'fixed', tested: { earlier: 1 } });
  expect(twelve.outcome).toMatchObject({ outcome: 'fixed', tested: { earlier: 12 } });
}, 120_000);

it('the brief has the guide of a fix, not the whole manual, and a long step output is cut with the whole value in a file', async () => {
  const root = setup();
  const { file } = await project(root);
  const dir = join(root, 'cache', 'runs', 'aaaaaaaa-0000-4000-8000-000000000003');
  await runCurrentMethod(file, node, { runDir: dir, inputs: { clause: 'x'.repeat(6000) } });
  stub(async dir => room.result(dir, { outcome: 'no_fix_found', detail: 'Nothing.' }));
  await learnCorrection(file, [correction(dir)], { earlier: [], caseIds: [CASE], model: { agent: 'claude' }, workDir: join(root, 'work'), runCases: runCases as any });
  const fix = join(root, 'work', 'room', '.fix');
  const guide = readFileSync(join(fix, 'guide.md'), 'utf8');
  expect(guide).toContain('# A Method that just works');
  expect(guide).toContain('## case new');
  expect(guide).not.toContain('# Comparisons');
  expect(guide).not.toContain('# Command reference');
  expect(guide.length).toBeLessThan(60_000);
  const run = readFileSync(join(fix, 'run.md'), 'utf8');
  expect(run).toContain('The first 4000 of');
  expect(run).toContain('the whole value is in .fix/run-outputs/reply.json.');
  expect(readFileSync(join(fix, 'run-outputs', 'reply.json'), 'utf8')).toContain('x'.repeat(6000));
}, 60_000);

// ---------- A general fix ----------

const NDA_A = 'Acme may share Confidential Information with a third party only with the written approval of the Discloser. The Recipient shall return all copies on request.';
const NDA_B = 'Beta Corp shall obtain the written approval of the Discloser before it discloses any Confidential Information to a third party. Nothing here survives termination.';
/** The answer script: question 1 (sharing allowed) and question 2 (return), each with a quote. rule decides question 1. */
const answerScript = (rule = `'yes'`) => `import{readFileSync}from'node:fs';const{text}=JSON.parse(readFileSync(0,'utf8'));
const q1=${rule};const q2=text.includes('return')?'yes':'not mentioned';
console.log(JSON.stringify({answers:[{question:1,answer:q1,quote:text.split('. ')[0]},{question:2,answer:q2,quote:q2==='yes'?text.split('. ')[1]:''}]}));\n`;
/**
 * A Method that answers 2 questions about an NDA. Gráinne's earlier check on NDA A covers only question 2 (it passes).
 * The run on NDA B answers question 1 "yes"; the person corrects it to "no": sharing that needs written approval is a
 * restriction. NDA A says the same, so the rule holds there too, though its check does not test it.
 */
async function review(root: string) {
  const folder = join(root, 'project'); mkdirSync(folder);
  const file = join(folder, 'reply.method');
  writeFileSync(join(folder, 'answer.mjs'), answerScript());
  writeFileSync(file, JSON.stringify({ format: 'method/3.4', id: METHOD_ID, name: 'NDA questions', goal: 'Answer 2 questions about an NDA.', inputs: { text: { type: 'text', description: 'The NDA.' } },
    steps: { answer: { name: 'Answer', purpose: 'Answers the questions.', in: { text: 'inputs.text' }, do: { kind: 'run', runtime: 'node', entrypoint: 'answer.mjs' }, out: { answers: { type: 'list', fields: { question: 'number', answer: 'text', quote: 'text' }, description: 'The answers.' } } } }, result: 'answers' }, null, 2) + '\n');
  const run = async (name: string, text: string) => {
    const dir = join(root, 'cache', 'runs', name);
    await runCurrentMethod(file, node, { runDir: dir, inputs: { text } });
    writeFileSync(join(dir, 'run-id.json'), JSON.stringify({ id: name }));
    return dir;
  };
  const runA = await run('aaaaaaaa-0000-4000-8000-00000000000a', NDA_A), runB = await run('aaaaaaaa-0000-4000-8000-00000000000b', NDA_B);
  await createCase({ methodFile: file, passingRun: runA, id: 'correction-return', note: 'Question 2 is yes.', author: 'Gráinne', expect: [{ kind: 'parts', ref: 'outputs.answers', key: 'question', kept: { 2: { answer: 'yes' } } }] } as any);
  return { folder, file, runB };
}
const ndaNote = 'Question 1 (Sharing with third parties) needs to be "no", not "yes": sharing only after written approval is a restriction.';
/** The check of the NDA correction: question 1 is corrected, question 2 was left; with every_input, the rule for every NDA as a script. */
async function ndaCheck(dir: string, { copy = false, everyInput = false } = {}) {
  if (existsSync(join(dir, 'cases', CASE, 'case.json'))) return;
  const rule = 'import{readFileSync}from"node:fs";const o=JSON.parse(readFileSync(0,"utf8"));const t=o.inputs.text,a=o.outputs.answers?.find(x=>x.question===1)?.answer;const applies=/written approval/.test(t);console.log(JSON.stringify({pass:!applies||a==="no",reason:applies?`question 1 is ${a} where sharing needs written approval`:"no approval clause"}));\n';
  if (everyInput) room.write(dir, 'approval-rule.mjs', rule);
  const expect = copy ? [{ kind: 'equals', ref: 'outputs.answers', value: [{ question: 1, answer: 'no', quote: NDA_B.split('. ')[0] }, { question: 2, answer: 'not mentioned', quote: '' }] }]
    : [{ kind: 'parts', ref: 'outputs.answers', key: 'question', corrected: { 1: { answer: 'no' } }, kept: { 2: { answer: 'not mentioned' } } },
      ...(everyInput ? [{ kind: 'predicate', scope: 'every_input', runtime: 'node', entrypoint: 'approval-rule.mjs' }] : [])];
  await createCase({ methodFile: join(dir, 'reply.method'), runDir: join(dir, '.fix', 'run'), id: CASE, note: ndaNote, expect, config: node } as any);
}
const ndaCorrection = (run: string) => correction(run, { note: ndaNote });

it('a check that copies the whole result is refused; the next try checks the corrected and the kept parts as labels', async () => {
  const root = setup();
  const { file, runB } = await review(root);
  const fix = (copy: boolean) => async (dir: string) => {
    if (!copy) rmSync(join(dir, 'cases', CASE), { recursive: true, force: true });
    await ndaCheck(dir, { copy });
    room.write(dir, 'answer.mjs', answerScript(`/written approval/.test(text)?'no':'yes'`));
    room.result(dir, { outcome: 'fixed', summary: 'Sharing that needs written approval is now a no.' });
  };
  const prompts = stub(fix(true), fix(false));
  const learned = await learn(file, ndaCorrection(runB), root);
  expect(prompts[1]).toContain(`The check ${CASE} requires outputs.answers to equal a copy of a whole result. Check what the correction says instead: a parts check`);
  expect(learned.outcome).toMatchObject({ outcome: 'fixed', tested: { earlier: 1 } });
  // The saved check compares labels: the corrected part and the part that the person left, not the quotes.
  expect(JSON.parse(readFileSync(join(root, 'work', 'room', 'cases', CASE, 'case.json'), 'utf8')).expect[0]).toMatchObject({ kind: 'parts', corrected: { 1: { answer: 'no' } }, kept: { 2: { answer: 'not mentioned' } } });
});

it('a change that copies the text of the corrected input is refused as a rule for one input; the general rule passes', async () => {
  const root = setup();
  const { file, runB } = await review(root);
  const lookup = async (dir: string) => {
    await ndaCheck(dir);
    room.write(dir, 'rules.json', JSON.stringify([{ question: 1, answer: 'no', evidence: NDA_B.split('. ')[0] }]) + '\n');
    // A data file that a step reads is one of the Method's files.
    const method = room.method(dir); room.save(dir, { ...method, files: [...(method.files ?? []), 'rules.json'] });
    room.write(dir, 'answer.mjs', answerScript(`JSON.parse(readFileSync(new URL('./rules.json',import.meta.url),'utf8')).some(r=>text.includes(r.evidence))?'no':'yes'`));
    room.result(dir, { outcome: 'fixed', summary: 'Answers follow your corrections.' });
  };
  const general = async (dir: string) => {
    rmSync(join(dir, 'rules.json'), { force: true });
    const method = room.method(dir); room.save(dir, { ...method, files: (method.files ?? []).filter((f: string) => f !== 'rules.json') });
    room.write(dir, 'answer.mjs', answerScript(`/written approval/.test(text)?'no':'yes'`));
    room.result(dir, { outcome: 'fixed', summary: 'Sharing that needs written approval is now a no.' });
  };
  const prompts = stub(lookup, general);
  const learned = await learn(file, ndaCorrection(runB), root);
  expect(prompts[1]).toMatch(new RegExp(`rules\\.json copies text of the input of the check ${CASE} \\("shall obtain the written approval of the discloser.*"\\)\\. A rule that applies to one input only is refused`));
  expect(learned.outcome).toMatchObject({ outcome: 'fixed', summary: 'Sharing that needs written approval is now a no.' });
  expect(learned.changed).not.toContain('rules.json');
  // The learner is told what a general fix is.
  expect(prompts[0]).toContain('a rule that applies to one input only is refused');
  expect(prompts[0]).toContain('--every-input');
});

it('leave-one-out: a rule for every input must hold on an earlier check\'s input that the change was not taught on', async () => {
  const root = setup();
  const { file, runB } = await review(root);
  // A narrow fix: it keys on the party of NDA B (too short to be a copy), so NDA A, which needs written approval too, stays "yes".
  const narrow = async (dir: string) => {
    await ndaCheck(dir, { everyInput: true });
    room.write(dir, 'answer.mjs', answerScript(`text.startsWith('Beta Corp')?'no':'yes'`));
    room.result(dir, { outcome: 'fixed', summary: 'Answers follow your correction.' });
  };
  const general = async (dir: string) => {
    room.write(dir, 'answer.mjs', answerScript(`/written approval/.test(text)?'no':'yes'`));
    room.result(dir, { outcome: 'fixed', summary: 'Sharing that needs written approval is now a no.' });
  };
  const prompts = stub(narrow, general);
  const learned = await learn(file, ndaCorrection(runB), root);
  expect(prompts[1]).toContain('Your rule for every input does not hold on the input of the check correction-return, from Gráinne\'s correction ("Question 2 is yes"), which your change was not taught on: question 1 is yes where sharing needs written approval.');
  expect(learned.outcome).toMatchObject({ outcome: 'fixed', tested: { earlier: 1 } });
  // The copies of the earlier checks are gone; the real check is as it was.
  expect(existsSync(join(root, 'work', 'held-out'))).toBe(false);
  expect(JSON.parse(readFileSync(join(root, 'work', 'room', 'cases', 'correction-return', 'case.json'), 'utf8')).expect).toHaveLength(1);
}, 60_000);
