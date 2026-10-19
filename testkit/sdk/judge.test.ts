import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { methodMain } from '../../packages/sdk/src/method.js';
import { MethodClient } from '../../packages/sdk/src/method-client.js';
import { caseFromCorrection, correctionCaseId, fixCorrections } from '../../packages/sdk/src/improve.js';
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
      if (verb === 'POST' && path === `/api/cli/methods/${METHOD_ID}/judgments/handled`) {
        const changed = body.ids.filter((id: string) => judgments.some(j => j.id === id && j.pending === body.handled));
        for (const j of judgments) if (changed.includes(j.id)) j.pending = !body.handled;
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
  expect(s.printed()).toBe('Recorded: right on step choose.\n');
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
  expect(s.printed()).toBe('Recorded: wrong on step choose. The Method file is not on this computer, so the next method run of it on a computer fixes it.\n');
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

// ---------- The loop on this computer, with a fake Claude Code and a fake improve.method ----------

/**
 * A signed-in fake Claude Code on PATH. It writes the rule sentences of a correction's case, votes as the rubric judge
 * (the sentences fail on the judged run) and as the conflict judge (no conflict), and logs every request.
 */
function fakeClaude(root: string) {
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:true}));process.exit(0);}
let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{
  fs.appendFileSync(${JSON.stringify(join(root, 'claude.log'))},JSON.stringify(prompt)+'\\n');
  const out=prompt.includes('Write 1 to 3 plain sentences')?{criteria:['The reply escalates the non-compete clause to Legal.']}
    :prompt.includes('Decide whether the text below meets each criterion')?{verdicts:['c1','c2','c3'].map(id=>({id,pass:false,quote:'',reason:'It does not escalate it.'}))}
    :prompt.includes('Find conflicts')?{conflicts:[]}:null;
  console.log(JSON.stringify({type:'result',subtype:'success',structured_output:out}));
});`, { mode: 0o700 });
  vi.stubEnv('PATH', [bin, '/usr/bin', '/bin'].join(':')); vi.stubEnv('CLAUDECODE', '1'); vi.stubEnv('CODEX_THREAD_ID', '');
  return () => existsSync(join(root, 'claude.log')) ? readFileSync(join(root, 'claude.log'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as string) : [];
}

/**
 * A fake improve.method: one script step that keeps the judgments it gets next to the Method file and returns the
 * outcome that FAKE_OUTCOME names: a change of the write step, or none.
 */
function fakeImprove(root: string, outcome: 'change' | 'none' | 'breaks') {
  const folder = join(root, 'improve'); mkdirSync(folder);
  const text = (description: string) => ({ type: 'text', description, default: '' });
  writeFileSync(join(folder, 'improve.method'), JSON.stringify({ format: 'method/3.4', name: 'Improve', goal: 'Return a fixed outcome.',
    inputs: { grant_id: text('g'), judgment_id: text('j'), method_file: text('m'), judgments_file: text('f'), run_folders: { type: 'list', items: 'text', description: 'r', default: [] } },
    secrets: { IMPROVE_API_KEY: 'Key.', IMPROVE_SERVER: 'Server.' },
    steps: { decide: { name: 'Decide', purpose: 'Returns the outcome.', in: { method_file: 'inputs.method_file', judgments_file: 'inputs.judgments_file' }, do: { kind: 'run', runtime: 'node', entrypoint: 'decide.mjs' },
      out: { proposal: { type: 'text', description: 'p' }, kind: { type: 'text', description: 'k' }, proposal_id: { type: 'text', description: 'i' }, capped: { type: 'text', description: 'c' } } } },
    result: { proposal: 'proposal', kind: 'kind', proposal_id: 'proposal_id', capped: 'capped' } }));
  writeFileSync(join(folder, 'decide.mjs'), `import{readFileSync,writeFileSync}from'node:fs';import{dirname,join}from'node:path';
const input=JSON.parse(readFileSync(0,'utf8'));const judgments=JSON.parse(readFileSync(input.judgments_file,'utf8'));
writeFileSync(join(dirname(input.method_file),'received.json'),JSON.stringify(judgments));
const {id,...workflow}=JSON.parse(readFileSync(input.method_file,'utf8'));workflow.steps.write.purpose='Writes the reply and escalates each restriction that the playbook does not cover.';
const fresh=judgments.filter(j=>j.new).map(j=>j.case_id).filter(Boolean);
const evidence=${JSON.stringify(outcome)}!=='none'
  ?{kind:'change',steps:['write'],candidate:'rule: Escalates restrictions.',cases:[...fresh.map(id=>({id,before:'fail',after:'pass',target:true})),{id:'old-rule',before:'pass',after:${JSON.stringify(outcome === 'breaks' ? 'fail' : 'pass')},target:false},{id:'older-rule',before:'pass',after:'pass',target:false}],before_after:[],replay:{runs:3,wins:2,losses:0,ties:1},cost:null,prompt_growth_pct:12,budget:{model_calls:23,usd:null,minutes:2.4},judgments:null}
  :{kind:'none',steps:['write'],candidate:null,cases:[],before_after:[],replay:null,cost:null,prompt_growth_pct:null,budget:{model_calls:9,usd:null,minutes:1.1},judgments:null};
const proposal=evidence.kind==='change'?{cause:'The reply step did not escalate restrictions that the playbook does not cover.',workflow,evidence}:{cause:'No safe change was found. rule: It fixed 0 of 1 replays of the corrected run and made 1 worse; it needs more fixed than worse.',evidence};
console.log(JSON.stringify({proposal:JSON.stringify(proposal),kind:evidence.kind,proposal_id:'',capped:'rule: 2 replays and 0 earlier runs left out'}));`);
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

it('a wrong judgment fixes the Method in the foreground: a case from the note, the loop, the change applied and saved as a version to restore', async () => {
  const s = setup(), claude = fakeClaude(s.root);
  fakeImprove(s.root, 'change');
  const { folder, file, run } = await project(s.root);
  const before = methodContent(readDocument(file));
  // An earlier correction that a loop fixed, and an approved run.
  const client = fakeClient({ judgments: [
    { id: 'jdg_' + 'e'.repeat(32), run_id: 'run_0', method_id: METHOD_ID, step_id: null, verdict: 'wrong', note: 'Escalate exclusivity.', corrected: null, source: 'agent', created_at: '2026-10-12T10:00:00Z', pending: false },
    { id: 'jdg_' + 'f'.repeat(32), run_id: 'run_9', method_id: METHOD_ID, step_id: null, verdict: 'right', note: null, corrected: null, source: 'agent', created_at: '2026-10-12T11:00:00Z', pending: false },
  ] });
  await methodMain(['judge', '037a667b-e45d-4461-a319-edc2dc0f64c2', 'wrong', '--note', "it's not even redlined"], () => client);
  const id = 'jdg_' + 'a'.repeat(32), caseId = correctionCaseId(id);
  // The vague note became a case whose rule fails on the judged run.
  const recorded = JSON.parse(readFileSync(join(folder, 'cases', caseId, 'case.json'), 'utf8'));
  expect(recorded).toMatchObject({ id: caseId, status: 'active', note: "it's not even redlined", source: { run_dir: run },
    expect: [{ kind: 'rubric', ref: 'outputs.reply', criteria: [{ id: 'c1', text: 'The reply escalates the non-compete clause to Legal.' }] }] });
  // The conflict judge found no conflict, so none was accepted for the person.
  expect(recorded.accepted_conflicts).toBeUndefined();
  // improve.method got every judgment: the new one marked new, with its run folder and case.
  const received = JSON.parse(readFileSync(join(folder, 'received.json'), 'utf8'));
  expect(received.map((j: any) => [j.id.slice(0, 5), j.verdict, !!j.new])).toEqual([['jdg_e', 'wrong', false], ['jdg_f', 'right', false], ['jdg_a', 'wrong', true]]);
  expect(received[2]).toMatchObject({ note: "it's not even redlined", run_dir: run, case_id: caseId });
  // The change is in the file, its id: line kept, and saved as a new version; the version before is the one to restore.
  expect(methodContent(readDocument(file))).toEqual({ ...before, steps: { write: { ...before.steps.write, purpose: 'Writes the reply and escalates each restriction that the playbook does not cover.' } } });
  expect(readDocument(file).id).toBe(METHOD_ID);
  const puts = client.calls.filter((c: any) => c.verb === 'PUT');
  expect(puts).toHaveLength(2);
  const fixed = puts.find((c: any) => c.body.reason === 'Method fixed it from a correction: The reply step did not escalate restrictions that the playbook does not cover.');
  expect(fixed).toBeDefined();
  const earlier = puts.find((c: any) => c !== fixed)!, previous = earlier.path.split('/').pop();
  const number = 6 + puts.indexOf(earlier) + 1;
  expect(s.printed()).toBe(`Recorded: wrong. Changed step write of reply.method: The reply step did not escalate restrictions that the playbook does not cover. It fixes the corrected run and passes 2 earlier corrections. To undo it, restore version ${number}: https://example.test/methods/${METHOD_ID}?version=${previous} (23 model calls, 2 min)\n`);
  // The correction was taken before the loop and is no longer pending.
  expect(client.judgments.find((j: any) => j.id === id).pending).toBe(false);
  // Every model request ran on the user's Claude Code: the case writer and three rubric votes (a Method with no model
  // step has no instruction for the conflict judge). No hosted model.
  expect(claude().filter(p => p.includes('Write 1 to 3 plain sentences'))).toHaveLength(1);
  expect(claude()).toHaveLength(4);
  expect(client.calls.map((c: any) => c.path)).not.toContain('/api/cli/models/default');
  expect(readdirSync(join(folder, '.method', 'proposals'))).toHaveLength(1);
});

it('says No safe change found with the reason, leaves the file, and keeps the case', async () => {
  const s = setup();
  fakeClaude(s.root); fakeImprove(s.root, 'none');
  const { folder, file } = await project(s.root);
  const before = readFileSync(file, 'utf8');
  const client = fakeClient();
  await methodMain(['judge', 'run_1', 'wrong', '--note', 'the Ashby one is wrong'], () => client);
  expect(s.printed()).toBe('Recorded: wrong. No safe change found: rule: It fixed 0 of 1 replays of the corrected run and made 1 worse; it needs more fixed than worse. (9 model calls, 1 min)\n');
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(existsSync(join(folder, 'cases', correctionCaseId('jdg_' + 'a'.repeat(32)), 'case.json'))).toBe(true);
  expect(client.calls.filter((c: any) => c.verb === 'PUT')).toEqual([]);
});

it('keeps the note of a device run on this computer, sends the verdict only, and still fixes the Method here', async () => {
  const s = setup();
  fakeClaude(s.root); fakeImprove(s.root, 'change');
  const { folder } = await project(s.root, { device: true });
  const client = fakeClient();
  await methodMain(['judge', 'run_1', 'wrong', '--note', 'You missed the non-compete.', '--json'], () => client);
  expect(client.calls[0].body).toEqual({ verdict: 'wrong' });
  const path = join(folder, '.method', 'judgments.jsonl');
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(folder, '.method', '.gitignore'), 'utf8')).toBe('*\n');
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ note: 'You missed the non-compete.', file: 'reply.method' });
  // The account has no note; the loop takes it from this computer.
  const received = JSON.parse(readFileSync(join(folder, 'received.json'), 'utf8'));
  expect(received[0]).toMatchObject({ note: 'You missed the non-compete.', new: true });
  const printed = JSON.parse(s.printed());
  expect(printed.fix).toMatchObject({ kind: 'change', corrections: 1, steps: ['write'], usage: { model_calls: 23, usd: null }, capped: 'rule: 2 replays and 0 earlier runs left out' });
  expect(printed.fix.log).toMatch(/improve\.log$/);
});

it('fixes corrections from the dashboard first on the next method run, with one line, and a run of the cloud from its account record', async () => {
  const s = setup();
  fakeClaude(s.root); fakeImprove(s.root, 'change');
  const { folder, file } = await project(s.root);
  const pending = (n: number, run: string) => ({ id: `jdg_${String(n).repeat(32)}`, run_id: run, method_id: METHOD_ID, step_id: null, verdict: 'wrong', note: `Correction ${n}.`, corrected: null, source: 'dashboard', created_at: `2026-10-1${n}T10:00:00Z`, pending: true, noted_by: 'Gráinne' });
  const cloud = { id: 'run_cloud', status: 'succeeded', created_at: '2026-10-14T09:00:00Z', workflow_version_id: 'v_1', inspection: { invocations: {} } };
  const client = fakeClient({ judgments: [pending(2, 'run_1'), pending(3, 'run_cloud'), pending(4, 'run_1')], runs: { run_cloud: cloud } });
  await methodMain(['run', file], () => client);
  const lines = s.stderr.mock.calls.map(c => String(c[0])).join('');
  expect(lines).toMatch(/^3 corrections from the dashboard: fixed, passes 2 earlier corrections\. Changed step write of reply\.method: The reply step did not escalate/m);
  // Then the run goes on, on the fixed file.
  expect(JSON.parse(s.printed())).toMatchObject({ status: 'completed' });
  const fix = { cases: JSON.parse(readFileSync(readdirSync(join(folder, '.method', 'proposals')).map(name => join(folder, '.method', 'proposals', name))[0]!, 'utf8')).evidence.cases };
  const received = JSON.parse(readFileSync(join(folder, 'received.json'), 'utf8'));
  expect(received.map((j: any) => j.new)).toEqual([true, true, true]);
  // A run with no folder here comes as its account record; it gets no case, the others do.
  expect(received[1]).toMatchObject({ run: { id: 'run_cloud', inspection: { invocations: {} } } });
  expect(received[1].case_id).toBeUndefined();
  expect(fix.cases.filter((c: any) => c.target).map((c: any) => c.id)).toEqual([correctionCaseId(pending(2, '').id), correctionCaseId(pending(4, '').id)]);
  // A case made from a correction names the person who made the correction; each correction is reported fixed.
  expect(JSON.parse(readFileSync(join(folder, 'cases', correctionCaseId(pending(2, '').id), 'case.json'), 'utf8')).author).toBe('Gráinne');
  expect(client.outcomes).toEqual([2, 3, 4].map(n => ({ id: pending(n, '').id, outcome: 'fixed' })));
  // Nothing waits now: the next run fixes nothing and asks nothing more.
  expect(await fixCorrections(client, file)).toBeUndefined();
});

it('gives the corrections back when the loop stops, so the next run fixes them', async () => {
  const s = setup();
  fakeClaude(s.root);
  vi.stubEnv('METHOD_IMPROVE_METHOD', join(s.root, 'missing.method'));
  const { file } = await project(s.root);
  const client = fakeClient({ judgments: [{ id: 'jdg_' + '2'.repeat(32), run_id: 'run_1', method_id: METHOD_ID, step_id: null, verdict: 'wrong', note: 'Wrong.', corrected: null, source: 'dashboard', created_at: '2026-10-12T10:00:00Z', pending: true }] });
  await expect(fixCorrections(client, file)).rejects.toThrow('METHOD_IMPROVE_METHOD names');
  expect(client.judgments[0].pending).toBe(true);
});

it('makes a failing case from a vague note on the user\'s agent, and tries once more when a rule passes on the run', async () => {
  const s = setup(), claude = fakeClaude(s.root);
  const { folder, file, run } = await project(s.root);
  const made = await caseFromCorrection(file, { id: 'jdg_' + 'b'.repeat(32), note: "it's not even redlined" }, run);
  expect(made).toEqual({ id: correctionCaseId('jdg_' + 'b'.repeat(32)), made: true });
  const writer = claude().find(p => p.includes('Write 1 to 3 plain sentences'))!;
  // The writer reads the person's words and the run's result.
  expect(writer).toContain("it's not even redlined");
  expect(writer).toContain('No escalation was identified as needed.');
  expect(existsSync(join(folder, 'cases', made.id, 'recording.json'))).toBe(true);
  // A second call for the same correction keeps the case.
  expect(await caseFromCorrection(file, { id: 'jdg_' + 'b'.repeat(32), note: 'x' }, run)).toEqual({ id: made.id, made: false });
});

it('corrections that arrive during a fix join it: ten judges of one Method end in two passes, and each prints its own outcome', async () => {
  const s = setup();
  fakeClaude(s.root); fakeImprove(s.root, 'change');
  const { folder } = await project(s.root);
  const client = fakeClient({ unique: true });
  const judge = (n: number) => methodMain(['judge', 'run_1', 'wrong', '--note', `Correction ${n}.`, ...(n % 2 ? ['--json'] : [])], () => client);
  const first = judge(0);
  // The first fix has started; nine more corrections arrive during it.
  while (!s.stderr.mock.calls.some(c => String(c[0]).startsWith('Fixing reply.method from 1 correction'))) await new Promise(done => setTimeout(done, 20));
  await Promise.all([first, ...Array.from({ length: 9 }, (_, i) => judge(i + 1))]);
  // Two passes: the first correction, then the nine that waited.
  expect(readdirSync(join(folder, '.method', 'proposals'))).toHaveLength(2);
  expect(s.stderr.mock.calls.map(c => String(c[0])).filter(line => line.startsWith('Fixing'))).toEqual([
    'Fixing reply.method from 1 correction on this computer. This takes a few minutes.\n', 'Fixing reply.method from 9 corrections on this computer. This takes a few minutes.\n']);
  expect(s.stderr.mock.calls.filter(c => String(c[0]).includes('this correction joins that fix'))).toHaveLength(9);
  // Each judge printed one outcome, of the fix that took its own correction.
  const printed = s.stdout.mock.calls.map(c => String(c[0]));
  expect(printed).toHaveLength(10);
  const lines = printed.filter(p => p.startsWith('Recorded:')), json = printed.filter(p => p.startsWith('{')).map(p => JSON.parse(p));
  expect(lines[0]).toMatch(/^Recorded: wrong\. Changed step write of reply\.method: .* It fixes the corrected run/);
  expect(lines.slice(1)).toHaveLength(4);
  for (const line of lines.slice(1)) expect(line).toMatch(/^Recorded: wrong\. 9 corrections: fixed, passes \d+ earlier corrections\. Changed /);
  expect(json).toHaveLength(5);
  for (const out of json) expect(out.fix.judgments).toContain(out.judgment.id);
  expect(new Set(json.map(out => out.judgment.id)).size).toBe(5);
  expect(client.judgments.every((j: any) => !j.pending)).toBe(true);
  // Every outcome was read by its judge; only nothing is left but the folder.
  expect(readdirSync(join(s.root, 'cache', 'fixes', METHOD_ID))).toEqual([]);
}, 120_000);

it('a fix that stops leaves every correction it took waiting, and each judge that joined it prints the error', async () => {
  const s = setup();
  fakeClaude(s.root);
  vi.stubEnv('METHOD_IMPROVE_METHOD', join(s.root, 'missing.method'));
  await project(s.root);
  const client = fakeClient({ unique: true });
  const results = await Promise.allSettled([1, 2, 3].map(n => methodMain(['judge', 'run_1', 'wrong', '--note', `Correction ${n}.`], () => client)));
  for (const result of results) expect(result).toMatchObject({ status: 'rejected', reason: { message: expect.stringContaining('METHOD_IMPROVE_METHOD names') } });
  expect(client.judgments.map((j: any) => j.pending)).toEqual([true, true, true]);
  // One pass took them all; the lock is gone, so the next run or judge fixes them.
  expect(s.stderr.mock.calls.filter(c => String(c[0]).startsWith('Fixing'))).toHaveLength(1);
  expect(existsSync(join(s.root, 'cache', 'fixes', METHOD_ID, 'lock'))).toBe(false);
}, 60_000);

it('a fix whose process stopped does not hold the Method: its lock is taken over', async () => {
  const s = setup();
  fakeClaude(s.root); fakeImprove(s.root, 'none');
  await project(s.root);
  mkdirSync(join(s.root, 'cache', 'fixes', METHOD_ID), { recursive: true });
  writeFileSync(join(s.root, 'cache', 'fixes', METHOD_ID, 'lock'), JSON.stringify({ pid: 2 ** 22 + 12345 }));
  await methodMain(['judge', 'run_1', 'wrong', '--note', 'Wrong.'], () => fakeClient());
  expect(s.printed()).toMatch(/^Recorded: wrong\. No safe change found/);
}, 60_000);

// ---------- Several people: a step changed since the run, a fix that breaks another person's case, held pairs ----------

it('does not fix a correction of a step that someone changed after the run, and says who', async () => {
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
  expect(fix).toMatchObject({ kind: 'none', line: 'Not fixed: Gráinne changed step write after this run.' });
  expect(client.outcomes).toEqual([{ id: 'jdg_' + '5'.repeat(32), outcome: 'already_changed', detail: 'Gráinne changed step write after this run.' }]);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(existsSync(join(s.root, 'project', 'received.json'))).toBe(false);
  // An older server has no outcomes route: the loop goes on as before.
  const older = fakeClient({ judgments: [{ ...client.judgments[0], pending: true }], runs: { run_old: { workflow_version_id: 'v_old' } }, versions: { [`/api/cli/methods/${METHOD_ID}?version=v_old`]: { workflow: old } }, outcomes: false });
  expect(await fixCorrections(older, file)).toMatchObject({ line: 'Not fixed: Step write changed after this run.' });
});

it('holds a fix that passes only by breaking another person\'s case, and applies nothing', async () => {
  const s = setup();
  fakeClaude(s.root); fakeImprove(s.root, 'breaks');
  const { folder, file } = await project(s.root);
  mkdirSync(join(folder, 'cases', 'old-rule'), { recursive: true });
  writeFileSync(join(folder, 'cases', 'old-rule', 'case.json'), JSON.stringify({ format: 'method-case/1', id: 'old-rule', status: 'active', method_file: 'other.method', note: 'The reply must stay under 100 words.', author: 'Gráinne' }));
  const before = readFileSync(file, 'utf8');
  const client = fakeClient({ judgments: [{ id: 'jdg_' + '7'.repeat(32), run_id: 'run_1', method_id: METHOD_ID, step_id: null, verdict: 'wrong', note: 'Escalate the non-compete.', corrected: null, source: 'dashboard', created_at: '2026-10-12T10:00:00Z', pending: true, noted_by: 'Ryan' }] });
  const fix = await fixCorrections(client, file);
  const detail = "A fix for Ryan's correction breaks Gráinne's case old-rule: The reply must stay under 100 words.";
  expect(fix).toMatchObject({ kind: 'none', line: `Held, nothing changed: ${detail} Decide which result is right with them.` });
  expect(client.outcomes).toEqual([{ id: 'jdg_' + '7'.repeat(32), outcome: 'held', detail }]);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(client.calls.filter((c: any) => c.verb === 'PUT')).toEqual([]);
});

it('shows a held pair with both people and both choices, and method judge RUN keep ID keeps one', async () => {
  const s = setup();
  const other = { id: 'jdg_' + 'g'.repeat(32), run_id: 'run_1', method_id: METHOD_ID, step_id: 'write', verdict: 'right', note: 'This is fine.', noted_by: 'Gráinne', outcome: 'held', held_with: 'jdg_' + 'a'.repeat(32), pending: false };
  const client = fakeClient({ judgments: [other], held: true });
  await methodMain(['judge', 'run_1', 'wrong', '--step', 'write', '--note', 'Too short.'], () => client);
  expect(s.printed()).toBe(`Recorded: wrong on step write.\nHeld: step write of run run_1. Ryan says it is wrong ("Too short."); Gráinne says it is right ("This is fine."). Nothing is fixed until one is kept: method judge run_1 keep jdg_${'a'.repeat(32)} (Ryan's) or method judge run_1 keep ${other.id} (Gráinne's).\n`);
  // Keeping Gráinne's right judgment sets Ryan's aside; nothing to fix.
  s.stdout.mockClear();
  await methodMain(['judge', 'run_1', 'keep', other.id], () => client);
  expect(client.calls.at(-1)).toEqual({ path: `/api/judgments/${other.id}/settle`, verb: 'POST', body: { keep: true } });
  expect(s.printed()).toBe("Kept Gráinne's judgment (right); the other one is set aside.\n");
  expect(client.judgments.find((j: any) => j.id === 'jdg_' + 'a'.repeat(32)).outcome).toBe('set_aside');
});
