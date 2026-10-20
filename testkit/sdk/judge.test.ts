import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { methodMain } from '../../packages/sdk/src/method.js';
import { MethodClient } from '../../packages/sdk/src/method-client.js';
import { backgroundFix, caseFromCorrection, correctionCaseId, fixCorrections } from '../../packages/sdk/src/improve.js';
import { fixStarter, storedOutcome } from '../../packages/sdk/src/fix-outcomes.js';
import { notHereLine, workingLine } from '../../packages/sdk/src/fix-lines.js';
import { methodContent } from '../../packages/sdk/src/versions.js';
import { readDocument } from '../../packages/sdk/src/authoring.js';
import { runCurrentMethod } from '../../packages/sdk/src/current-runtime.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'method-judge-'))); roots.push(root);
  vi.stubEnv('METHOD_CACHE_DIR', join(root, 'cache')); vi.stubEnv('METHOD_CONFIG_DIR', join(root, 'config'));
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const printed = () => stdout.mock.calls.map(c => String(c[0])).join('');
  return { root, stdout, stderr, printed };
}
const METHOD_ID = 'wf_' + '1'.repeat(32);
const judgment = (body: any) => ({ judgment: { id: 'jdg_' + 'a'.repeat(32), run_id: 'run_1', method_id: METHOD_ID, verdict: body.verdict, step_id: body.step_id ?? null, created_at: '2026-10-13T10:00:00Z' }, fixing: false });
/** A fake account: records judgments, lists the Method's judgments with pending ones, takes them, and saves versions. */
function fakeClient({ token = 'method_x' as string | null, judgments = [] as any[], runs = {} as Record<string, unknown>, versions = {} as Record<string, unknown>, held = false, outcomes = true, unique = false } = {}) {
  let version = 6, count = 0;
  const client = {
    server: 'https://example.test', token: () => token, calls: [] as { path: string; verb: string; body: any }[], judgments, outcomes: [] as any[],
    async request(path: string, verb = 'GET', body?: any) {
      this.calls.push({ path, verb, body });
      if (verb === 'GET' && versions[path]) return versions[path];
      if (verb === 'POST' && outcomes && path === `/api/cli/methods/${METHOD_ID}/judgments/outcomes`) { this.outcomes.push(...body.outcomes); return { changed: body.outcomes.map((o: any) => o.id) }; }
      if (verb === 'POST' && /^\/api\/judgments\/[^/]+\/settle$/.test(path)) {
        const kept = judgments.find(j => j.id === path.split('/')[3]);
        for (const j of judgments) if (j.held_with === kept.id) j.outcome = 'set_aside';
        Object.assign(kept, { outcome: null, held_with: null, pending: kept.verdict === 'wrong' });
        return { judgment: { ...kept, method_id: METHOD_ID } };
      }
      if (verb === 'POST' && /^\/api\/cli\/runs\/[^/]+\/judgments$/.test(path)) {
        const made = judgment(body);
        if (unique) made.judgment.id = 'jdg_' + (++count).toString(16).padStart(32, '0');
        if (held) { judgments.push({ ...made.judgment, note: body.note ?? null, noted_by: 'Ryan', outcome: 'held', held_with: 'jdg_' + 'g'.repeat(32), pending: false }); return { ...made, held: true }; }
        if (body.verdict === 'wrong') judgments.push({ ...made.judgment, note: body.note ?? null, corrected: body.corrected ?? null, source: 'agent', pending: true });
        return made;
      }
      if (verb === 'GET' && path === `/api/cli/methods/${METHOD_ID}/judgments`) return { judgments };
      if (verb === 'POST' && /^\/api\/cli\/judgments\/[^/]+\/answer$/.test(path)) {
        const answered = judgments.find(j => j.id === path.split('/')[4]);
        Object.assign(answered, { answer: body.answer ?? null, pending: true });
        return { judgment: { ...answered, method_id: METHOD_ID } };
      }
      if (verb === 'POST' && path === `/api/cli/methods/${METHOD_ID}/judgments/handled`) {
        const changed = body.ids.filter((id: string) => judgments.some(j => j.id === id && j.pending === body.handled));
        for (const j of judgments) if (changed.includes(j.id)) j.pending = !body.handled;
        return { changed };
      }
      if (verb === 'POST' && path === `/api/cli/methods/${METHOD_ID}/judgments/reopen`) {
        const changed = body.ids.filter((id: string) => judgments.some(j => j.id === id && !j.pending));
        for (const j of judgments) if (changed.includes(j.id)) Object.assign(j, { pending: true, outcome: null, outcome_detail: body.detail });
        return { changed };
      }
      if (verb === 'GET' && path.startsWith('/api/workspace/runs/') && runs[decodeURIComponent(path.slice(20))]) return { run: runs[decodeURIComponent(path.slice(20))] };
      if (verb === 'POST' && path === '/api/cli/files/check') return { present: body.hashes };
      const saved = /^\/api\/cli\/methods\/[^/]+\/versions\/([^/]+)$/.exec(path);
      if (verb === 'PUT' && saved) return { version_id: saved[1], version_number: ++version };
      throw Object.assign(Error(`404: ${verb} ${path}`), { status: 404 });
    },
    async transfer() { return Buffer.alloc(0); },
    async login() {},
  };
  return client as any;
}

it('records a right judgment in one line and fixes nothing, or prints the JSON with --json', async () => {
  const s = setup(), client = fakeClient();
  await methodMain(['judge', 'run_1', 'right', '--step', 'choose'], () => client);
  expect(client.calls).toEqual([{ path: '/api/cli/runs/run_1/judgments', verb: 'POST', body: { verdict: 'right', step_id: 'choose' } }]);
  expect(s.printed()).toBe('Noted: this result is right.\n');
  s.stdout.mockClear();
  await methodMain(['judge', 'run_1', 'right', '--json'], () => client);
  expect(JSON.parse(s.printed())).toEqual({ judgment: { id: 'jdg_' + 'a'.repeat(32), run_id: 'run_1', method_id: METHOD_ID, verdict: 'right', step_id: null, created_at: '2026-10-13T10:00:00Z' } });
});

it('sends the note and a corrected result, JSON as JSON and other text as text', async () => {
  const s = setup(), client = fakeClient();
  writeFileSync(join(s.root, 'right.json'), '{"summary": "Acme renewed."}');
  writeFileSync(join(s.root, 'right.md'), 'Acme renewed on 1 October.\n');
  await methodMain(['judge', '6f1c-run', 'wrong', '--step', 'choose', '--note', ' Name the customer. ', '--corrected', join(s.root, 'right.json')], () => client);
  expect(client.calls[0]).toEqual({ path: '/api/cli/runs/6f1c-run/judgments', verb: 'POST', body: { verdict: 'wrong', step_id: 'choose', note: 'Name the customer.', corrected: { summary: 'Acme renewed.' } } });
  // The run and the Method file are not on this computer: the correction waits for a run of the Method on a computer.
  expect(s.printed()).toBe(`${notHereLine}\n`);
  await methodMain(['judge', 'run_1', 'wrong', '--corrected', join(s.root, 'right.md')], () => client);
  expect(client.calls.at(-1)!.body).toEqual({ verdict: 'wrong', corrected: 'Acme renewed on 1 October.\n' });
});

it('refuses a bad verdict, a long note, a large corrected file, or a missing run ID before it sends anything', async () => {
  const s = setup(), client = fakeClient();
  await expect(methodMain(['judge', 'run_1', 'good'], () => client)).rejects.toThrow('Judge the result right or wrong');
  await expect(methodMain(['judge', 'run_1'], () => client)).rejects.toThrow('Use method judge RUN_ID right|wrong');
  await expect(methodMain(['judge', 'run_1', 'wrong', '--note', 'x'.repeat(4001)], () => client)).rejects.toThrow('the most is 4000');
  const large = join(s.root, 'large.json'); writeFileSync(large, ''); truncateSync(large, 1024 * 1024 + 1);
  await expect(methodMain(['judge', 'run_1', 'wrong', '--corrected', large], () => client)).rejects.toThrow('larger than 1 MB');
  await expect(methodMain(['judge', 'run_1', 'wrong', '--corrected', join(s.root, 'missing.json')], () => client)).rejects.toThrow('Cannot read');
  expect(client.calls).toEqual([]);
});

it('prints the server message for an error, and the sign-in message when signed out', async () => {
  setup();
  await expect(methodMain(['judge', 'run_1', 'wrong'], () => ({ ...fakeClient(), request: async () => { throw Error('404: Run not found.'); } }) as any)).rejects.toThrow('404: Run not found.');
  await expect(methodMain(['judge', 'run_1', 'wrong'], server => new MethodClient(server))).rejects.toThrow('Sign in with method login first.');
});

it('method improve and method apply are gone', async () => {
  setup();
  for (const command of ['improve', 'apply']) await expect(methodMain([command, 'task.method'], () => fakeClient())).rejects.toThrow(/Learn:|Usage/);
  const help = (await import('../../packages/sdk/src/method-help.js')).overviewHelp;
  expect(help).not.toMatch(/\bimprove\b|\bapply\b/);
});


// ---------- The fix in the background, with a fake Claude Code and a fake improve.method ----------

/**
 * A signed-in fake Claude Code on PATH. It writes the sentences of a correction's case, votes as the rubric judge (the
 * sentences fail on the judged run) and as the conflict judge (no conflict), and logs every request.
 */
function fakeClaude(root: string) {
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:true}));process.exit(0);}
let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{
  fs.appendFileSync(${JSON.stringify(join(root, 'claude.log'))},JSON.stringify(prompt)+'\\n');
  const out=prompt.includes('Write 1 to 3 plain sentences')?{criteria:[{text:'The reply escalates the non-compete clause to Legal.',ref:'result'}],check_script:'',check_says:''}
    :prompt.includes('Decide whether the text below meets each criterion')?{verdicts:['c1','c2','c3'].map(id=>({id,pass:false,quote:'',reason:'It does not escalate it.'}))}
    :prompt.includes('Find conflicts')?{conflicts:[]}:null;
  console.log(JSON.stringify({type:'result',subtype:'success',structured_output:out}));
});`, { mode: 0o700 });
  vi.stubEnv('PATH', [bin, '/usr/bin', '/bin'].join(':')); vi.stubEnv('CLAUDECODE', '1'); vi.stubEnv('CODEX_THREAD_ID', '');
  return () => existsSync(join(root, 'claude.log')) ? readFileSync(join(root, 'claude.log'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as string) : [];
}

/**
 * A fake improve.method: one script step that keeps the judgments it gets next to the Method file and returns the
 * outcome it is made with: a fix of the write step, none, a fix that breaks another case, or a question.
 */
function fakeImprove(root: string, outcome: 'change' | 'none' | 'breaks' | 'question' | 'again') {
  const folder = join(root, 'improve'); mkdirSync(folder);
  const text = (description: string) => ({ type: 'text', description, default: '' });
  writeFileSync(join(folder, 'improve.method'), JSON.stringify({ format: 'method/3.4', name: 'Improve', goal: 'Return a fixed outcome.',
    inputs: { grant_id: text('g'), judgment_id: text('j'), method_file: text('m'), judgments_file: text('f'), run_folders: { type: 'list', items: 'text', description: 'r', default: [] } },
    secrets: { IMPROVE_API_KEY: 'Key.', IMPROVE_SERVER: 'Server.' },
    steps: { decide: { name: 'Decide', purpose: 'Returns the outcome.', in: { method_file: 'inputs.method_file', judgments_file: 'inputs.judgments_file' }, do: { kind: 'run', runtime: 'node', entrypoint: 'decide.mjs' },
      out: { proposal: { type: 'text', description: 'p' }, kind: { type: 'text', description: 'k' }, proposal_id: { type: 'text', description: 'i' }, outcomes: { type: 'text', description: 'o' },
        background_cases: { type: 'list', items: 'text', description: 'b' }, summary: { type: 'text', description: 's' } } } },
    result: { proposal: 'proposal', kind: 'kind', proposal_id: 'proposal_id', outcomes: 'outcomes', background_cases: 'background_cases', summary: 'summary' } }));
  writeFileSync(join(folder, 'decide.mjs'), `import{readFileSync,writeFileSync,appendFileSync}from'node:fs';import{dirname,join}from'node:path';
const input=JSON.parse(readFileSync(0,'utf8'));const judgments=JSON.parse(readFileSync(input.judgments_file,'utf8'));
writeFileSync(join(dirname(input.method_file),'received.json'),JSON.stringify(judgments));
appendFileSync(join(dirname(input.method_file),'passes.log'),judgments.filter(j=>j.new).length+'\\n');
const {id,...workflow}=JSON.parse(readFileSync(input.method_file,'utf8'));workflow.steps.write.purpose='Writes the reply and escalates each restriction that the playbook does not cover.';
const kind=${JSON.stringify(outcome)}, fresh=judgments.filter(j=>j.new);
const ids=fresh.map(j=>j.case_id).filter(Boolean);
const outcomes=fresh.map((j,i)=>kind==='again'&&i>0?{id:j.id,outcome:'no_fix_found',again:true,detail:'Another fix changed the same step; this correction is tried again on the new version.'}
  :kind==='question'&&!j.answer?{id:j.id,outcome:'question',question:'Should every counterparty NDA come back redlined, or only some?'}
  :kind==='none'?{id:j.id,outcome:'no_fix_found',detail:'I tried 3 changes; none fixed this reliably without breaking another result.',tried:3,subject:'reply'}
  :{id:j.id,outcome:'fixed',detail:'replies now escalate restrictions that the playbook does not cover',step_id:'write',tests:{case:j.case_id,base:{passes:0,runs:2},candidate:{passes:3,runs:3},guards:[{id:'old-rule',before:'pass',after:'pass'},{id:'older-rule',before:'pass',after:'pass'}]},subject:'reply',tested_output:{result:'Thanks. I escalated the non-compete to Legal.'}});
const change=outcomes.some(o=>o.outcome==='fixed');
const evidence=change
  ?{kind:'change',steps:['write'],candidate:'rule: Escalates restrictions.',cases:[...ids.map(id=>({id,before:'fail',after:'pass',target:true})),{id:'old-rule',before:'pass',after:${JSON.stringify(outcome === 'breaks' ? 'fail' : 'pass')},target:false},{id:'older-rule',before:'pass',after:'pass',target:false}],budget:{model_calls:23,usd:null,minutes:2.4}}
  :{kind:'none',steps:['write'],candidate:null,cases:[],budget:{model_calls:9,usd:null,minutes:1.1}};
const proposal=change?{cause:'The reply step did not escalate restrictions that the playbook does not cover.',workflow,evidence}:{cause:'No safe change was found.',evidence};
console.log(JSON.stringify({proposal:JSON.stringify(proposal),kind:evidence.kind,proposal_id:'',outcomes:JSON.stringify(outcomes),background_cases:[],summary:proposal.cause}));`);
  vi.stubEnv('METHOD_IMPROVE_METHOD', join(folder, 'improve.method'));
}

/** A Method file that writes a reply, and one finished run of it in the Method cache, as method run leaves them. */
async function project(root: string, { device = false } = {}) {
  const folder = join(root, 'project'); mkdirSync(folder);
  const file = join(folder, 'reply.method');
  writeFileSync(join(folder, 'write.mjs'), 'console.log(JSON.stringify({reply: "Thanks. No escalation was identified as needed."}));\n');
  writeFileSync(file, JSON.stringify({ format: 'method/3.4', id: METHOD_ID, name: 'Reply', goal: 'Write the reply to an NDA request.', ...(device ? { run_data: 'device' } : {}),
    steps: { write: { name: 'Write', purpose: 'Writes the reply.', do: { kind: 'run', runtime: 'node', entrypoint: 'write.mjs' }, out: { reply: { type: 'text', description: 'The reply.' } } } }, result: 'reply' }, null, 2) + '\n');
  const run = join(root, 'cache', 'runs', 'aaaaaaaa-0000-4000-8000-000000000001');
  await runCurrentMethod(file, { allow_local_processes: true, runtimes: { node: { command: process.execPath, version: process.version } } }, { runDir: run, inputs: {} });
  writeFileSync(join(run, 'run-id.json'), JSON.stringify({ id: '037a667b-e45d-4461-a319-edc2dc0f64c2' }));
  writeFileSync(join(run, 'method-sync.json'), JSON.stringify({ schema: 'method-sync/1', id: '037a667b-e45d-4461-a319-edc2dc0f64c2', ...(device ? { device: true } : {}), dashboard_id: 'run_1' }));
  writeFileSync(join(run, 'method-file.json'), JSON.stringify({ path: file }));
  return { folder, file, run };
}
/** fixStarter.start runs nothing in a test; the test runs the background fix itself. */
const noStart = () => vi.spyOn(fixStarter, 'start').mockImplementation(async () => {});
const id = 'jdg_' + 'a'.repeat(32);

it('a wrong judgment returns at once; the fix in the background writes the outcome, and method wait prints it with the tested output', async () => {
  const s = setup(), claude = fakeClaude(s.root), start = noStart();
  fakeImprove(s.root, 'change');
  const { folder, file, run } = await project(s.root);
  const before = methodContent(readDocument(file));
  const client = fakeClient({ judgments: [
    { id: 'jdg_' + 'e'.repeat(32), run_id: 'run_0', method_id: METHOD_ID, step_id: null, verdict: 'wrong', note: 'Escalate exclusivity.', corrected: null, source: 'agent', created_at: '2026-10-12T10:00:00Z', pending: false },
    { id: 'jdg_' + 'f'.repeat(32), run_id: 'run_9', method_id: METHOD_ID, step_id: null, verdict: 'right', note: null, corrected: null, source: 'agent', created_at: '2026-10-12T11:00:00Z', pending: false },
  ] });
  await methodMain(['judge', '037a667b-e45d-4461-a319-edc2dc0f64c2', 'wrong', '--note', "it's not even redlined"], () => client);
  // One line, and the fix started for this correction; nothing changed yet.
  expect(s.printed()).toBe(`${workingLine}\n`);
  expect(start).toHaveBeenCalledWith(file, METHOD_ID, [id], 'https://example.test');
  expect(storedOutcome(METHOD_ID, id)).toMatchObject({ status: 'working', shown: false });
  expect(methodContent(readDocument(file))).toEqual(before);
  // The background fix: a case from the note, the loop, the change applied and saved as a version.
  await backgroundFix(client, file, [id]);
  const caseId = correctionCaseId(id);
  const recorded = JSON.parse(readFileSync(join(folder, 'cases', caseId, 'case.json'), 'utf8'));
  expect(recorded).toMatchObject({ id: caseId, status: 'active', note: "it's not even redlined", source: { run_dir: run },
    expect: [{ kind: 'rubric', ref: 'result', criteria: [{ id: 'c1', text: 'The reply escalates the non-compete clause to Legal.' }] }] });
  const received = JSON.parse(readFileSync(join(folder, 'received.json'), 'utf8'));
  expect(received.map((j: any) => [j.id.slice(0, 5), j.verdict, !!j.new])).toEqual([['jdg_e', 'wrong', false], ['jdg_f', 'right', false], ['jdg_a', 'wrong', true]]);
  expect(received[2]).toMatchObject({ note: "it's not even redlined", run_dir: run, case_id: caseId });
  expect(methodContent(readDocument(file)).steps.write.purpose).toBe('Writes the reply and escalates each restriction that the playbook does not cover.');
  expect(readDocument(file).id).toBe(METHOD_ID);
  expect(client.calls.filter((c: any) => c.verb === 'PUT').map((c: any) => c.body.reason)).toContain('Method fixed it from a correction: The reply step did not escalate restrictions that the playbook does not cover.');
  expect(client.outcomes).toEqual([{ id, outcome: 'fixed', detail: 'replies now escalate restrictions that the playbook does not cover' }]);
  expect(storedOutcome(METHOD_ID, id)).toMatchObject({ status: 'done', outcome: { outcome: 'fixed' } });
  // The case writer and three rubric votes ran on the user's Claude Code; the votes were not paid twice.
  expect(claude().filter(p => p.includes('Write 1 to 3 plain sentences'))).toHaveLength(1);
  expect(claude()).toHaveLength(4);
  // method wait prints the person's line and what the fixed agent gives now, from the test.
  s.stdout.mockClear();
  await methodMain(['wait', id], () => client);
  expect(s.printed()).toBe([
    'Fixed: replies now escalate restrictions that the playbook does not cover. Tested 3 times on this reply and on 2 earlier ones. Undo: method undo.',
    'What the fixed agent gives now (tested; nothing was sent):', 'Thanks. I escalated the non-compete to Legal.', ''].join('\n'));
  // Seen once: the next method wait and the next run have nothing more to say about it.
  s.stdout.mockClear();
  await methodMain(['wait'], () => client);
  expect(s.printed()).toBe('Nothing is being fixed on this computer.\n');
  s.stdout.mockClear();
  await methodMain(['wait', id, '--json'], () => client);
  expect(JSON.parse(s.printed()).outcomes[0]).toMatchObject({ judgment: id, status: 'done', outcome: { outcome: 'fixed', tested: { times: 3, earlier: 2 } } });
});

it('method wait stops after its time limit while the fix goes on, and a stopped fix says so', async () => {
  const s = setup(); noStart();
  fakeClaude(s.root); fakeImprove(s.root, 'none');
  await project(s.root);
  await methodMain(['judge', 'run_1', 'wrong', '--note', 'Wrong.'], () => fakeClient());
  // A live fix process: this test process.
  (await import('../../packages/sdk/src/fix-outcomes.js')).setWorker(METHOD_ID, [id], process.pid);
  s.stdout.mockClear();
  await methodMain(['wait', '--timeout', '0'], () => fakeClient());
  expect(s.printed()).toBe('Still working on it. Run method wait again.\n');
  // The fix process stopped before it finished.
  (await import('../../packages/sdk/src/fix-outcomes.js')).setWorker(METHOD_ID, [id], 2 ** 22 + 12345);
  s.stdout.mockClear();
  await methodMain(['wait'], () => fakeClient());
  expect(s.printed()).toBe("The fix stopped before it finished. I'll try again on the next run.\n");
});

it('says No fix found yet, leaves the file, and keeps the case', async () => {
  const s = setup(); noStart();
  fakeClaude(s.root); fakeImprove(s.root, 'none');
  const { folder, file } = await project(s.root);
  const before = readFileSync(file, 'utf8');
  const client = fakeClient();
  await methodMain(['judge', 'run_1', 'wrong', '--note', 'the Ashby one is wrong'], () => client);
  await backgroundFix(client, file, [id]);
  s.stdout.mockClear();
  await methodMain(['wait'], () => client);
  expect(s.printed()).toBe("No fix found yet: I tried 3 changes; none fixed this reply reliably. I'll keep your note.\n");
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(existsSync(join(folder, 'cases', correctionCaseId(id), 'case.json'))).toBe(true);
  expect(client.calls.filter((c: any) => c.verb === 'PUT')).toEqual([]);
  expect(client.outcomes).toEqual([{ id, outcome: 'no_fix_found', detail: 'I tried 3 changes; none fixed this reliably without breaking another result.' }]);
});

it('a question goes to the person word for word; method answer sends their words and the fix starts again with them', async () => {
  const s = setup(), start = noStart();
  fakeClaude(s.root); fakeImprove(s.root, 'question');
  const { folder, file } = await project(s.root);
  const client = fakeClient();
  await methodMain(['judge', 'run_1', 'wrong', '--note', "it's not even redlined"], () => client);
  await backgroundFix(client, file, [id]);
  expect(client.outcomes).toEqual([{ id, outcome: 'question', question: 'Should every counterparty NDA come back redlined, or only some?' }]);
  s.stdout.mockClear();
  await methodMain(['wait', id], () => client);
  expect(s.printed()).toBe([
    'I have one question before I change anything: Should every counterparty NDA come back redlined, or only some?',
    `Show this question to the person word for word, and do not answer it yourself. Send their answer with: method answer ${id} "THEIR WORDS"`, ''].join('\n'));
  s.stdout.mockClear(); start.mockClear();
  await methodMain(['answer', id, 'Every', 'counterparty', 'NDA.'], () => client);
  expect(client.calls.find((c: any) => c.path === `/api/cli/judgments/${id}/answer`)).toEqual({ path: `/api/cli/judgments/${id}/answer`, verb: 'POST', body: { answer: 'Every counterparty NDA.' } });
  expect(s.printed()).toBe("Thanks. Working on it with your answer. I'll test a fix on this run.\n");
  expect(start).toHaveBeenCalledWith(file, METHOD_ID, [id], 'https://example.test');
  // The loop gets the answer with the correction, and fixes it.
  await backgroundFix(client, file, [id]);
  expect(JSON.parse(readFileSync(join(folder, 'received.json'), 'utf8')).find((j: any) => j.id === id)).toMatchObject({ new: true, answer: 'Every counterparty NDA.' });
  expect(storedOutcome(METHOD_ID, id)).toMatchObject({ status: 'done', outcome: { outcome: 'fixed' } });
});

it('keeps the note of a device run on this computer, sends the verdict only, and still fixes the Method here', async () => {
  const s = setup(); noStart();
  fakeClaude(s.root); fakeImprove(s.root, 'change');
  const { folder, file } = await project(s.root, { device: true });
  const client = fakeClient();
  await methodMain(['judge', 'run_1', 'wrong', '--note', 'You missed the non-compete.', '--json'], () => client);
  expect(client.calls[0].body).toEqual({ verdict: 'wrong' });
  expect(JSON.parse(s.printed())).toMatchObject({ judgment: { id }, fix: { status: 'working', wait: `method wait ${id}` } });
  const path = join(folder, '.method', 'judgments.jsonl');
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(folder, '.method', '.gitignore'), 'utf8')).toBe('*\n');
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ note: 'You missed the non-compete.', file: 'reply.method' });
  await backgroundFix(client, file, [id]);
  // The account has no note; the loop takes it from this computer.
  const received = JSON.parse(readFileSync(join(folder, 'received.json'), 'utf8'));
  expect(received[0]).toMatchObject({ note: 'You missed the non-compete.', new: true });
  expect(storedOutcome(METHOD_ID, id)?.log).toMatch(/improve\.log$/);
});

it('on the next method run: outcomes not yet shown come first, and corrections from the dashboard start a fix in the background', async () => {
  const s = setup(), start = noStart();
  fakeClaude(s.root); fakeImprove(s.root, 'change');
  const { folder, file } = await project(s.root);
  const pending = (n: number, run: string) => ({ id: `jdg_${String(n).repeat(32)}`, run_id: run, method_id: METHOD_ID, step_id: null, verdict: 'wrong', note: `Correction ${n}.`, corrected: null, source: 'dashboard', created_at: `2026-10-1${n}T10:00:00Z`, pending: true, noted_by: 'Gráinne' });
  const cloud = { id: 'run_cloud', status: 'succeeded', created_at: '2026-10-14T09:00:00Z', workflow_version_id: 'v_1', inspection: { invocations: {} } };
  const client = fakeClient({ judgments: [pending(2, 'run_1'), pending(3, 'run_cloud'), pending(4, 'run_1')], runs: { run_cloud: cloud } });
  await methodMain(['run', file], () => client);
  const ids = [2, 3, 4].map(n => pending(n, '').id);
  expect(start).toHaveBeenCalledWith(file, METHOD_ID, ids, 'https://example.test');
  expect(s.stderr.mock.calls.map(c => String(c[0]))).toContain("Working on 3 corrections that were waiting. I'll test a fix for each.\n");
  // The run did not wait for the fix.
  expect(JSON.parse(s.printed())).toMatchObject({ status: 'completed' });
  await backgroundFix(client, file, ids);
  const received = JSON.parse(readFileSync(join(folder, 'received.json'), 'utf8'));
  expect(received.map((j: any) => j.new)).toEqual([true, true, true]);
  // A run with no folder here comes as its account record; it gets no case, the others do.
  expect(received[1]).toMatchObject({ run: { id: 'run_cloud', inspection: { invocations: {} } }, noted_by: 'Gráinne' });
  expect(received[1].case_id).toBeUndefined();
  expect(JSON.parse(readFileSync(join(folder, 'cases', correctionCaseId(ids[0]!), 'case.json'), 'utf8')).author).toBe('Gráinne');
  expect(client.outcomes.map((o: any) => [o.id, o.outcome])).toEqual(ids.map(i => [i, 'fixed']));
  // The next run prints the three outcomes first, once. The fixed corrections are watched on later runs.
  expect((await import('../../packages/sdk/src/watch.js')).watchedCorrections(file).map(w => w.judgment)).toEqual([ids[0], ids[2]]);
  s.stderr.mockClear(); start.mockClear();
  await methodMain(['run', file], () => client);
  const lines = s.stderr.mock.calls.map(c => String(c[0]));
  expect(lines.slice(0, 3).every(line => line.startsWith('Fixed: replies now escalate restrictions'))).toBe(true);
  expect(start).not.toHaveBeenCalled();
  s.stderr.mockClear();
  await methodMain(['run', file], () => client);
  expect(s.stderr.mock.calls.map(c => String(c[0])).filter(line => line.startsWith('Fixed:'))).toEqual([]);
}, 60_000);

it('gives the corrections back when the loop stops, and method wait prints the error', async () => {
  const s = setup(); noStart();
  fakeClaude(s.root);
  vi.stubEnv('METHOD_IMPROVE_METHOD', join(s.root, 'missing.method'));
  const { file } = await project(s.root);
  const client = fakeClient();
  await methodMain(['judge', 'run_1', 'wrong', '--note', 'Wrong.'], () => client);
  await backgroundFix(client, file, [id]);
  expect(client.judgments[0].pending).toBe(true);
  s.stdout.mockClear();
  await methodMain(['wait'], () => client);
  expect(s.printed()).toMatch(/^The fix stopped: METHOD_IMPROVE_METHOD names .*\. I'll try again on the next run\.\n$/);
});

it('makes a failing case from a vague note on the user\'s agent, judged on the result', async () => {
  const s = setup(), claude = fakeClaude(s.root);
  const { folder, file, run } = await project(s.root);
  const made = await caseFromCorrection(file, { id: 'jdg_' + 'b'.repeat(32), note: "it's not even redlined" }, run);
  expect(made).toEqual({ id: correctionCaseId('jdg_' + 'b'.repeat(32)), made: true });
  const writer = claude().find(p => p.includes('Write 1 to 3 plain sentences'))!;
  // The writer reads the person's words and what the person saw, by name.
  expect(writer).toContain("it's not even redlined");
  expect(writer).toContain('[result]');
  expect(writer).toContain('No escalation was identified as needed.');
  expect(existsSync(join(folder, 'cases', made.id, 'recording.json'))).toBe(true);
  expect(await caseFromCorrection(file, { id: 'jdg_' + 'b'.repeat(32), note: 'x' }, run)).toEqual({ id: made.id, made: false });
});

it('corrections that arrive during a fix join it: ten corrections of one Method end in two passes, each with its own outcome', async () => {
  const s = setup(); noStart();
  fakeClaude(s.root); fakeImprove(s.root, 'change');
  const { folder, file } = await project(s.root);
  const client = fakeClient({ unique: true });
  const ids: string[] = [];
  const judge = async (n: number) => { await methodMain(['judge', 'run_1', 'wrong', '--note', `Correction ${n}.`, '--json'], () => client); ids.push(JSON.parse(s.stdout.mock.calls.at(-1)![0] as string).judgment.id); };
  await judge(0);
  const first = backgroundFix(client, file, [ids[0]!]);
  // The first fix has started; nine more corrections arrive during it, each with its own background fix.
  while (!existsSync(join(s.root, 'cache', 'fixes', METHOD_ID, 'lock'))) await new Promise(done => setTimeout(done, 20));
  for (let n = 1; n < 10; n++) await judge(n);
  await Promise.all([first, ...ids.slice(1).map(i => backgroundFix(client, file, [i], { pollMs: 50 }))]);
  expect(readFileSync(join(folder, 'passes.log'), 'utf8')).toBe('1\n9\n');
  for (const i of ids) expect(storedOutcome(METHOD_ID, i)).toMatchObject({ status: 'done', outcome: { id: i, outcome: 'fixed' } });
  expect(client.judgments.every((j: any) => !j.pending)).toBe(true);
  expect(existsSync(join(s.root, 'cache', 'fixes', METHOD_ID, 'lock'))).toBe(false);
}, 120_000);

it('a fix whose process stopped does not hold the Method: its lock is taken over', async () => {
  const s = setup(); noStart();
  fakeClaude(s.root); fakeImprove(s.root, 'none');
  const { file } = await project(s.root);
  mkdirSync(join(s.root, 'cache', 'fixes', METHOD_ID), { recursive: true });
  writeFileSync(join(s.root, 'cache', 'fixes', METHOD_ID, 'lock'), JSON.stringify({ pid: 2 ** 22 + 12345 }));
  const client = fakeClient();
  await methodMain(['judge', 'run_1', 'wrong', '--note', 'Wrong.'], () => client);
  await backgroundFix(client, file, [id]);
  expect(storedOutcome(METHOD_ID, id)).toMatchObject({ status: 'done', outcome: { outcome: 'no_fix_found' } });
}, 60_000);

// ---------- Several people: a step changed since the run, a fix that breaks another person's case, held pairs ----------

it('does not fix a correction of a part that someone changed after the run, and says who', async () => {
  const s = setup();
  fakeClaude(s.root); fakeImprove(s.root, 'change');
  const { file } = await project(s.root);
  const now = readDocument(file) as any, before = readFileSync(file, 'utf8');
  const old = { ...methodContent(now), steps: { write: { ...now.steps.write, purpose: 'Writes a short reply.' } } };
  const client = fakeClient({
    judgments: [{ id: 'jdg_' + '5'.repeat(32), run_id: 'run_old', method_id: METHOD_ID, step_id: 'write', verdict: 'wrong', note: 'Too short.', corrected: null, source: 'dashboard', created_at: '2026-10-12T10:00:00Z', pending: true, noted_by: 'Ryan' }],
    runs: { run_old: { id: 'run_old', status: 'succeeded', workflow_version_id: 'v_old', inspection: { invocations: {} } } },
    versions: { [`/api/cli/methods/${METHOD_ID}?version=v_old`]: { workflow: old }, [`/api/cli/methods/${METHOD_ID}`]: { workflow: methodContent(now), saved_by: 'Gráinne' } } });
  const fix = await fixCorrections(client, file);
  expect(fix).toMatchObject({ kind: 'none', outcomes: [{ id: 'jdg_' + '5'.repeat(32), outcome: 'already_changed', by: 'Gráinne' }] });
  expect(client.outcomes).toEqual([{ id: 'jdg_' + '5'.repeat(32), outcome: 'already_changed', detail: 'Gráinne changed it after this run.' }]);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(existsSync(join(s.root, 'project', 'received.json'))).toBe(false);
});

it('holds a fix that passes only by breaking another person\'s case, and applies nothing', async () => {
  const s = setup();
  fakeClaude(s.root); fakeImprove(s.root, 'breaks');
  const { folder, file } = await project(s.root);
  mkdirSync(join(folder, 'cases', 'old-rule'), { recursive: true });
  writeFileSync(join(folder, 'cases', 'old-rule', 'case.json'), JSON.stringify({ format: 'method-case/1', id: 'old-rule', status: 'active', method_file: 'other.method', note: 'The reply must stay under 100 words.', author: 'Gráinne' }));
  const before = readFileSync(file, 'utf8');
  const held = 'jdg_' + '7'.repeat(32);
  const client = fakeClient({ judgments: [{ id: held, run_id: 'run_1', method_id: METHOD_ID, step_id: null, verdict: 'wrong', note: 'Escalate the non-compete.', corrected: null, source: 'dashboard', created_at: '2026-10-12T10:00:00Z', pending: true, noted_by: 'Ryan' }] });
  const fix = await fixCorrections(client, file);
  expect(fix?.outcomes).toEqual([{ id: held, outcome: 'held', by: 'Gráinne', detail: 'The reply must stay under 100 words.' }]);
  expect(client.outcomes).toEqual([{ id: held, outcome: 'held', detail: 'Gráinne: The reply must stay under 100 words.' }]);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(client.calls.filter((c: any) => c.verb === 'PUT')).toEqual([]);
});

it('shows a held pair with both people and both choices, and method judge RUN keep ID keeps one', async () => {
  const s = setup();
  const other = { id: 'jdg_' + 'g'.repeat(32), run_id: 'run_1', method_id: METHOD_ID, step_id: 'write', verdict: 'right', note: 'This is fine.', noted_by: 'Gráinne', outcome: 'held', held_with: id, pending: false };
  const client = fakeClient({ judgments: [other], held: true });
  await methodMain(['judge', 'run_1', 'wrong', '--step', 'write', '--note', 'Too short.'], () => client);
  expect(s.printed()).toBe(`Noted.\nTwo people disagree about this result: Ryan says it is wrong ("Too short"); Gráinne says it is right ("This is fine"). Nothing changes until one is kept.\nAsk the person which one is right, then keep it: method judge run_1 keep ${id} (Ryan's) or method judge run_1 keep ${other.id} (Gráinne's).\n`);
  s.stdout.mockClear();
  await methodMain(['judge', 'run_1', 'keep', other.id], () => client);
  expect(client.calls.at(-1)).toEqual({ path: `/api/judgments/${other.id}/settle`, verb: 'POST', body: { keep: true } });
  expect(s.printed()).toBe("Kept Gráinne's view: the result is right.\n");
  expect(client.judgments.find((j: any) => j.id === id).outcome).toBe('set_aside');
});

// ---------- What improve.method hands back: again, background cases, the pruning sweep ----------

it('a correction given back with again is fixed in the next pass, on the changed file, and is reported once', async () => {
  const s = setup(); noStart();
  fakeClaude(s.root); fakeImprove(s.root, 'again');
  const { folder, file } = await project(s.root);
  const pending = (n: string) => ({ id: 'jdg_' + n.repeat(32), run_id: 'run_1', method_id: METHOD_ID, step_id: null, verdict: 'wrong', note: `Correction ${n}.`, corrected: null, source: 'dashboard', created_at: '2026-10-12T10:00:00Z', pending: true });
  const client = fakeClient({ judgments: [pending('7'), pending('8')] });
  const { fixWaiting } = await import('../../packages/sdk/src/improve.js');
  const fixes = await fixWaiting(client, file);
  expect(readFileSync(join(folder, 'passes.log'), 'utf8')).toBe('2\n1\n');
  expect(fixes!.map(f => f.fixed.map(x => x.id))).toEqual([['jdg_' + '7'.repeat(32)], ['jdg_' + '8'.repeat(32)]]);
  for (const n of ['7', '8']) expect(storedOutcome(METHOD_ID, 'jdg_' + n.repeat(32))).toMatchObject({ status: 'done', outcome: { outcome: 'fixed' } });
  // The account hears each correction once, with its real outcome; the given-back one was never reported as retry.
  expect(client.outcomes.map((o: any) => [o.id.slice(0, 5), o.outcome])).toEqual([['jdg_7', 'fixed'], ['jdg_8', 'fixed']]);
}, 60_000);

it('the later check: a failing case of a retired rule brings the rule back; another failure undoes the fix and opens its correction again', async () => {
  const s = setup();
  fakeClaude(s.root);
  const { folder, file, run } = await project(s.root);
  const { checkBackground } = await import('../../packages/sdk/src/improve.js');
  const { recordChange, snapshot } = await import('../../packages/sdk/src/undo.js');
  const ruleCase = (await caseFromCorrection(file, { id: 'jdg_' + 'c'.repeat(32), note: 'Escalate exclusivity.' }, run)).id;
  const otherCase = (await caseFromCorrection(file, { id: 'jdg_' + 'd'.repeat(32), note: 'Escalate non-competes.' }, run)).id;
  const rule = { id: 'lr_0123456789ab', when: null, then: 'Escalate exclusivity clauses.', by: 'Gráinne', from: { judgment: 'jdg_' + 'c'.repeat(32), case: ruleCase },
    status: 'retired', created: '2026-10-01T00:00:00Z', retired_at: '2026-10-10T00:00:00Z', retired_reason: 'not needed: every case passes without it' };
  writeFileSync(join(folder, 'learned.json'), JSON.stringify({ format: 'method-learned/1', steps: { write: [rule] } }, null, 2));
  // A fix that changed the write step, with its undo record, as fixCorrections leaves it.
  const fixedId = 'jdg_' + '9'.repeat(32);
  const client = fakeClient({ judgments: [{ id: fixedId, run_id: 'run_1', method_id: METHOD_ID, step_id: null, verdict: 'wrong', note: 'Escalate restrictions.', corrected: null, source: 'agent', created_at: '2026-10-12T10:00:00Z', pending: false, outcome: 'fixed' }] });
  const fixedText = () => methodContent(readDocument(file)).steps.write.purpose;
  const fixAgain = (purpose: string) => {
    const before = snapshot(file, ['learned.json']);
    const doc = JSON.parse(readFileSync(file, 'utf8')); doc.steps.write.purpose = purpose; writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
    return recordChange(file, 'fix', 'Escalates restrictions.', 'the fix for "Escalate restrictions."', before).id;
  };
  const fix = (undoId: string) => ({ background_cases: [ruleCase, otherCase, 'gone-case'], undo_id: undoId, fixed: [{ id: fixedId, note: 'Escalate restrictions.' }], cause: 'Escalates restrictions.' });
  const verdicts = (failing: string[]) => async (_file: string, _flags: object, options: { ids: string[] }) => {
    expect(options.ids).toEqual([ruleCase, otherCase]);
    return { cases: options.ids.map(id => ({ id, verdict: failing.includes(id) ? 'fail' : 'pass' })) };
  };
  // Only the retired rule's case fails: the rule is active again, and the fix stays.
  const kept = await checkBackground(client, file, fix(fixAgain('Writes the reply and escalates restrictions.')), { runCases: verdicts([ruleCase]) });
  expect(kept).toMatchObject({ failed: [ruleCase], restored: ['lr_0123456789ab'], undone: false, reopened: [] });
  expect(JSON.parse(readFileSync(join(folder, 'learned.json'), 'utf8')).steps.write[0]).toMatchObject({ status: 'active', retired_at: null, retired_reason: null });
  expect(fixedText()).toBe('Writes the reply and escalates restrictions.');
  // Another case fails: the fix is undone and its correction is open again.
  const undone = await checkBackground(client, file, fix(fixAgain('Writes the reply, escalates restrictions, and says why.')), { runCases: verdicts([otherCase]) });
  expect(undone).toMatchObject({ failed: [otherCase], restored: [], undone: true, reopened: [fixedId] });
  expect(fixedText()).toBe('Writes the reply and escalates restrictions.');
  expect(client.judgments[0]).toMatchObject({ pending: true, outcome: null });
  const { unshownLines } = await import('../../packages/sdk/src/fix-outcomes.js');
  expect(unshownLines(METHOD_ID)).toEqual([
    'I put back the rule "Escalate exclusivity clauses": without it, a problem you corrected came back.',
    'I undid the fix for your correction ("Escalate restrictions"): it changed a result that was right before. I\'ll try a new fix on the next run.']);
}, 60_000);

it('the pruning sweep: a change applies with undo and says the summary; a sweep with no change still says what nothing checks', async () => {
  const s = setup();
  const { file } = await project(s.root);
  const folder = join(s.root, 'improve'); mkdirSync(folder);
  const text = (description: string) => ({ type: 'text', description, default: '' });
  writeFileSync(join(folder, 'improve.method'), JSON.stringify({ format: 'method/3.4', name: 'Improve', goal: 'Return a sweep.',
    inputs: { grant_id: text('g'), judgment_id: text('j'), method_file: text('m'), judgments_file: text('f'), run_folders: { type: 'list', items: 'text', description: 'r', default: [] }, mode: text('m') },
    secrets: { IMPROVE_API_KEY: 'Key.', IMPROVE_SERVER: 'Server.' },
    steps: { sweep: { name: 'Sweep', purpose: 'Returns the sweep.', in: { method_file: 'inputs.method_file', mode: 'inputs.mode' }, do: { kind: 'run', runtime: 'node', entrypoint: 'sweep.mjs' },
      out: { proposal: { type: 'text', description: 'p' }, kind: { type: 'text', description: 'k' }, proposal_id: { type: 'text', description: 'i' }, outcomes: { type: 'text', description: 'o' },
        background_cases: { type: 'list', items: 'text', description: 'b' }, summary: { type: 'text', description: 's' } } } },
    result: { proposal: 'proposal', kind: 'kind', proposal_id: 'proposal_id', outcomes: 'outcomes', background_cases: 'background_cases', summary: 'summary' } }));
  writeFileSync(join(folder, 'sweep.mjs'), `import{readFileSync,existsSync}from'node:fs';import{dirname,join}from'node:path';
const input=JSON.parse(readFileSync(0,'utf8'));if(input.mode!=='prune')throw Error('not a sweep');
const {id,...workflow}=JSON.parse(readFileSync(input.method_file,'utf8'));const change=!existsSync(join(dirname(input.method_file),'swept'));
workflow.steps.write.purpose='Writes.';
const evidence={kind:change?'change':'none',steps:['write'],candidate:null,cases:[],budget:null};
const proposal=change?{cause:'Removed 2 rules that no longer changed any result.',workflow,evidence}:{cause:'Nothing to prune.',evidence};
const summary=change?'Removed 2 rules that no longer changed any result.':'1 part of the instructions is not checked by any saved result, so I left it.';
console.log(JSON.stringify({proposal:JSON.stringify(proposal),kind:evidence.kind,proposal_id:'',outcomes:'[]',background_cases:[],summary}));`);
  vi.stubEnv('METHOD_IMPROVE_METHOD', join(folder, 'improve.method'));
  const client = fakeClient();
  const { pruneMethod } = await import('../../packages/sdk/src/improve.js');
  const { unshownLines } = await import('../../packages/sdk/src/fix-outcomes.js');
  expect(await pruneMethod(client, file)).toEqual({ changed: true });
  expect(methodContent(readDocument(file)).steps.write.purpose).toBe('Writes.');
  expect(unshownLines(METHOD_ID)).toEqual(['Removed 2 rules that no longer changed any result. Undo: method undo.']);
  writeFileSync(join(dirname(file), 'swept'), '');
  expect(await pruneMethod(client, file)).toEqual({ changed: false });
  expect(unshownLines(METHOD_ID)).toEqual(['1 part of the instructions is not checked by any saved result, so I left it.']);
  await methodMain(['undo', file], () => client);
  expect(methodContent(readDocument(file)).steps.write.purpose).toBe('Writes the reply.');
}, 60_000);
