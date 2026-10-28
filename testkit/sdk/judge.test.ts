import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { methodMain } from '../../packages/sdk/src/method.js';
import { MethodClient } from '../../packages/sdk/src/method-client.js';
import { backgroundFix, correctionCaseId, fixCorrections, learnerModel } from '../../packages/sdk/src/improve.js';
import { learnerAgent } from '../../packages/sdk/src/learner.js';
import { createCase } from '@withmethod/runtime/cases.js';
import { fixStarter, storedOutcome } from '../../packages/sdk/src/fix-outcomes.js';
import { notHereLine, workingLine } from '../../packages/sdk/src/fix-lines.js';
import { methodContent } from '../../packages/sdk/src/versions.js';
import { readDocument } from '../../packages/sdk/src/authoring.js';
import { runCurrentMethod } from '../../packages/sdk/src/current-runtime.js';

const roots: string[] = [];
const realSession = learnerAgent.session;
afterEach(() => { learnerAgent.session = realSession; vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

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


// ---------- The fix in the background, with a stub learner ----------

const ESCALATED = 'Thanks. I escalated the non-compete to Legal.';
const escalating = `console.log(JSON.stringify({reply: ${JSON.stringify(ESCALATED)}}));\n`;
/** The person's words as the brief gives them to the learner. */
const noteOf = (room: string) => readFileSync(join(room, '.fix', 'correction.md'), 'utf8').split('\n\n')[2]!.trim();
/**
 * A stub learner in place of the agent session: it writes the check of the correction (the reply escalates), and then
 * changes the reply step (change), says no fix (none), asks a question until the person answered (question), or stops.
 * A Method that already escalates needs no change. It keeps each brief it read.
 */
function fakeLearner(root: string, kind: 'change' | 'none' | 'question' | 'stops') {
  const briefs: string[] = [], models: any[] = [];
  learnerAgent.session = vi.fn(async ({ room, model }) => {
    briefs.push(readFileSync(join(room, '.fix', 'correction.md'), 'utf8')); models.push(model);
    if (kind === 'stops') throw Error('Claude Code is not installed or not signed in on this computer. Sign in with claude, then run again.');
    const result = (value: unknown) => writeFileSync(join(room, '.fix', 'result.json'), JSON.stringify(value));
    if (kind === 'question' && !briefs.at(-1)!.includes('the person answered')) { result({ outcome: 'question', question: 'Should every counterparty NDA come back redlined, or only some?' }); return { status: 'completed' as const }; }
    if (kind === 'none') { result({ outcome: 'no_fix_found', detail: 'the reply needs the playbook, which the agent does not get' }); return { status: 'completed' as const }; }
    const id = readFileSync(join(room, '.fix', 'correction.md'), 'utf8').match(/has the ID (correction-[a-z0-9]+)/)![1]!;
    // Escalating already, unless this learner made it so in an earlier try (its notes say so).
    const done = readFileSync(join(room, 'write.mjs'), 'utf8') === escalating && !existsSync(join(room, '.fix', 'notes.md'));
    if (!existsSync(join(room, 'cases', id))) await createCase({ methodFile: join(room, 'reply.method'), runDir: join(room, '.fix', 'run'), id, note: noteOf(room), expect: [{ kind: 'equals', ref: 'outputs.reply', value: ESCALATED }] } as any);
    if (done) { result({ outcome: 'no_change_needed', detail: 'the reply already escalates the non-compete' }); return { status: 'completed' as const }; }
    writeFileSync(join(room, 'write.mjs'), escalating);
    writeFileSync(join(room, '.fix', 'notes.md'), 'The reply step now escalates.\n');
    result({ outcome: 'fixed', summary: 'replies now escalate restrictions that the playbook does not cover' });
    return { status: 'completed' as const };
  });
  return { briefs, models };
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
  const s = setup(), start = noStart(), learner = fakeLearner(s.root, 'change');
  const { folder, file, run } = await project(s.root);
  const before = methodContent(readDocument(file));
  const client = fakeClient({ judgments: [
    { id: 'jdg_' + 'e'.repeat(32), run_id: 'run_0', method_id: METHOD_ID, step_id: null, verdict: 'wrong', note: 'Escalate exclusivity.', corrected: null, source: 'agent', created_at: '2026-10-12T10:00:00Z', pending: false, outcome: 'no_fix_found' },
    { id: 'jdg_' + 'f'.repeat(32), run_id: 'run_9', method_id: METHOD_ID, step_id: null, verdict: 'right', note: null, corrected: null, source: 'agent', created_at: '2026-10-12T11:00:00Z', pending: false },
  ] });
  await methodMain(['judge', '037a667b-e45d-4461-a319-edc2dc0f64c2', 'wrong', '--note', "it's not even redlined"], () => client);
  // One line, and the fix started for this correction; nothing changed yet.
  expect(s.printed()).toBe(`${workingLine}\n`);
  expect(start).toHaveBeenCalledWith(file, METHOD_ID, [id], 'https://example.test');
  expect(storedOutcome(METHOD_ID, id)).toMatchObject({ status: 'working', shown: false });
  expect(methodContent(readDocument(file))).toEqual(before);
  // The background fix: the learner writes the check and the change; Method tests it and applies it as a version.
  await backgroundFix(client, file, [id]);
  expect(learner.briefs[0]).toContain("it's not even redlined");
  const caseId = correctionCaseId(id);
  expect(JSON.parse(readFileSync(join(folder, 'cases', caseId, 'case.json'), 'utf8'))).toMatchObject({ id: caseId, status: 'active', note: "it's not even redlined" });
  expect(readFileSync(join(folder, 'write.mjs'), 'utf8')).toBe(escalating);
  expect(readDocument(file).id).toBe(METHOD_ID);
  expect(client.calls.filter((c: any) => c.verb === 'PUT').map((c: any) => c.body.reason)).toContain('Method fixed it from a correction: replies now escalate restrictions that the playbook does not cover');
  expect(client.outcomes).toEqual([{ id, outcome: 'fixed', detail: 'replies now escalate restrictions that the playbook does not cover' }]);
  expect(storedOutcome(METHOD_ID, id)).toMatchObject({ status: 'done', outcome: { outcome: 'fixed', diff: expect.stringContaining(`+${escalating.trim()}`) } });
  expect(run).toBeTruthy();
  // method wait prints the person's line and what the fixed agent gives now, from the test.
  s.stdout.mockClear();
  await methodMain(['wait', id], () => client);
  expect(s.printed()).toBe([
    'Fixed: replies now escalate restrictions that the playbook does not cover. Tested 1 time on this result. Undo: method undo.',
    'What the fixed agent gives now (tested; nothing was sent):', ESCALATED, ''].join('\n'));
  // Seen once: the next method wait and the next run have nothing more to say about it.
  s.stdout.mockClear();
  await methodMain(['wait'], () => client);
  expect(s.printed()).toBe('Nothing is being fixed on this computer.\n');
  s.stdout.mockClear();
  await methodMain(['wait', id, '--json'], () => client);
  expect(JSON.parse(s.printed()).outcomes[0]).toMatchObject({ judgment: id, status: 'done', outcome: { outcome: 'fixed', tested: { times: 1, earlier: 0 } } });
}, 60_000);

it('method wait stops after its time limit while the fix goes on, and a stopped fix says so', async () => {
  const s = setup(); noStart();
  fakeLearner(s.root, 'none');
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

it('says No fix found yet in the learner\'s words, and leaves the Method as it was', async () => {
  const s = setup(); noStart(); fakeLearner(s.root, 'none');
  const { folder, file } = await project(s.root);
  const before = readFileSync(file, 'utf8');
  const client = fakeClient();
  await methodMain(['judge', 'run_1', 'wrong', '--note', 'the Ashby one is wrong'], () => client);
  await backgroundFix(client, file, [id]);
  s.stdout.mockClear();
  await methodMain(['wait'], () => client);
  expect(s.printed()).toBe("No fix found yet: the reply needs the playbook, which the agent does not get. I'll keep your note.\n");
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(existsSync(join(folder, 'cases', correctionCaseId(id)))).toBe(false);
  expect(client.calls.filter((c: any) => c.verb === 'PUT')).toEqual([]);
  expect(client.outcomes).toEqual([{ id, outcome: 'no_fix_found', detail: 'the reply needs the playbook, which the agent does not get' }]);
});

it('the learner thinks on the model of the Method\'s own agent steps: a session on Claude Opus 5.5 at high effort gives its learner that model', async () => {
  const s = setup();
  const { file } = await project(s.root);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  doc.steps.work = { name: 'Work', purpose: 'Does the task.', in: { room: 'inputs.room' }, out: 'session', do: { kind: 'session', agent: 'claude', model: 'claude-opus-5-5', reasoning_effort: 'high', prompt: 'Do it.', tools: ['read'], room: 'room' } };
  expect(await learnerModel(doc)).toEqual({ agent: 'claude', model: 'claude-opus-5-5', reasoning_effort: 'high' });
  // Steps that name no model give no one model: the learner is the user's own agent on its default model.
  const bin = join(s.root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}\nif(process.argv[2]==='auth')console.log(JSON.stringify({loggedIn:true}));\n`, { mode: 0o700 });
  vi.stubEnv('PATH', [bin, '/usr/bin', '/bin'].join(':')); vi.stubEnv('CLAUDECODE', '1'); vi.stubEnv('CODEX_THREAD_ID', '');
  expect(await learnerModel(JSON.parse(readFileSync(file, 'utf8')))).toEqual({ agent: 'claude' });
});

it('a correction that the Method already meets ends no change needed: only its check stays, and no version is saved', async () => {
  const s = setup(); noStart(); fakeLearner(s.root, 'change');
  const { folder, file } = await project(s.root);
  writeFileSync(join(folder, 'write.mjs'), escalating);
  const client = fakeClient();
  await methodMain(['judge', 'run_1', 'wrong', '--note', 'It needs to escalate the non-compete clause.'], () => client);
  await backgroundFix(client, file, [id]);
  expect(client.outcomes).toEqual([{ id, outcome: 'no_change_needed', detail: 'the reply already escalates the non-compete' }]);
  expect(existsSync(join(folder, 'cases', correctionCaseId(id), 'case.json'))).toBe(true);
  expect(client.calls.filter((c: any) => c.verb === 'PUT')).toEqual([]);
  s.stdout.mockClear();
  await methodMain(['wait'], () => client);
  expect(s.printed()).toBe('No change needed: the reply already escalates the non-compete. I kept your note as a check for later changes.\n');
});

it('a question goes to the person word for word; method answer sends their words and the fix starts again with them', async () => {
  const s = setup(), start = noStart(), learner = fakeLearner(s.root, 'question');
  const { file } = await project(s.root);
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
  client.judgments[0].question = 'Should every counterparty NDA come back redlined, or only some?';
  await methodMain(['answer', id, 'Every', 'counterparty', 'NDA.'], () => client);
  expect(client.calls.find((c: any) => c.path === `/api/cli/judgments/${id}/answer`)).toEqual({ path: `/api/cli/judgments/${id}/answer`, verb: 'POST', body: { answer: 'Every counterparty NDA.' } });
  expect(s.printed()).toBe("Thanks. Working on it with your answer. I'll test a fix on this run.\n");
  expect(start).toHaveBeenCalledWith(file, METHOD_ID, [id], 'https://example.test');
  // The learner reads the answer with the correction, and fixes it.
  await backgroundFix(client, file, [id]);
  expect(learner.briefs[1]).toContain('Asked "Should every counterparty NDA come back redlined, or only some?", the person answered:\n\nEvery counterparty NDA.');
  expect(storedOutcome(METHOD_ID, id)).toMatchObject({ status: 'done', outcome: { outcome: 'fixed' } });
}, 60_000);

it('keeps the note of a device run on this computer, sends the verdict only, and still fixes the Method here', async () => {
  const s = setup(); noStart();
  const learner = fakeLearner(s.root, 'change');
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
  // The account has no note; the learner takes it from this computer. Its tries stay as the log.
  expect(learner.briefs[0]).toContain('You missed the non-compete.');
  expect(storedOutcome(METHOD_ID, id)?.log).toBe(join(s.root, 'cache', 'fixes', METHOD_ID, 'learn', id));
}, 60_000);

it('on the next method run: outcomes not yet shown come first, and corrections from the dashboard start a fix in the background', async () => {
  const s = setup(), start = noStart(); fakeLearner(s.root, 'change');
  const { folder, file } = await project(s.root);
  const pending = (n: number, run: string) => ({ id: `jdg_${String(n).repeat(32)}`, run_id: run, method_id: METHOD_ID, step_id: null, verdict: 'wrong', note: `Correction ${n}.`, corrected: null, source: 'dashboard', created_at: `2026-10-1${n}T10:00:00Z`, pending: true, noted_by: 'Gráinne' });
  const client = fakeClient({ judgments: [pending(2, 'run_1'), pending(3, 'run_cloud'), pending(4, 'run_1')] });
  await methodMain(['run', file], () => client);
  const ids = [2, 3, 4].map(n => pending(n, '').id);
  expect(start).toHaveBeenCalledWith(file, METHOD_ID, ids, 'https://example.test');
  expect(s.stderr.mock.calls.map(c => String(c[0]))).toContain("Working on 3 corrections that were waiting. I'll test a fix for each.\n");
  // The run did not wait for the fix.
  expect(JSON.parse(s.printed())).toMatchObject({ status: 'completed' });
  await backgroundFix(client, file, ids);
  // One at a time, oldest first: the first fixes it, a run with no folder here cannot be tested, and the third finds it fixed.
  expect(client.outcomes.map((o: any) => [o.id, o.outcome])).toEqual([[ids[0], 'fixed'], [ids[1], 'could_not_test'], [ids[2], 'no_change_needed']]);
  expect(JSON.parse(readFileSync(join(folder, 'cases', correctionCaseId(ids[0]!), 'case.json'), 'utf8')).author).toBe('Gráinne');
  // The next run prints the three outcomes first, once. The fixed correction is watched on later runs.
  expect((await import('../../packages/sdk/src/watch.js')).watchedCorrections(file).map(w => w.judgment)).toEqual([ids[0]]);
  s.stderr.mockClear(); start.mockClear();
  await methodMain(['run', file], () => client);
  const lines = s.stderr.mock.calls.map(c => String(c[0]));
  expect(lines.slice(0, 3).map(line => line.split(':')[0])).toEqual(['Fixed', 'Could not test a fix safely', 'No change needed']);
  expect(start).not.toHaveBeenCalled();
  s.stderr.mockClear();
  await methodMain(['run', file], () => client);
  expect(s.stderr.mock.calls.map(c => String(c[0])).filter(line => line.startsWith('Fixed:'))).toEqual([]);
}, 60_000);

it('gives the corrections back when the learner stops, and method wait prints its cause in plain words', async () => {
  const s = setup(); noStart(); fakeLearner(s.root, 'stops');
  const { file } = await project(s.root);
  const client = fakeClient();
  await methodMain(['judge', 'run_1', 'wrong', '--note', 'Wrong.'], () => client);
  await backgroundFix(client, file, [id]);
  expect(client.judgments[0].pending).toBe(true);
  s.stdout.mockClear();
  await methodMain(['wait'], () => client);
  expect(s.printed()).toBe('The fix stopped: Claude Code is not installed or not signed in on this computer. Sign in with claude, then run again. I\'ll try again on the next run.\n');
});

it('corrections that arrive during a fix join it: ten corrections of one Method end in two passes, each with its own outcome', async () => {
  const s = setup(); noStart(); fakeLearner(s.root, 'change');
  const { file } = await project(s.root);
  const client = fakeClient({ unique: true });
  const ids: string[] = [];
  const judge = async (n: number) => { await methodMain(['judge', 'run_1', 'wrong', '--note', `Correction ${n}.`, '--json'], () => client); ids.push(JSON.parse(s.stdout.mock.calls.at(-1)![0] as string).judgment.id); };
  await judge(0);
  const first = backgroundFix(client, file, [ids[0]!]);
  // The first fix has started; nine more corrections arrive during it, each with its own background fix.
  while (!existsSync(join(s.root, 'cache', 'fixes', METHOD_ID, 'lock'))) await new Promise(done => setTimeout(done, 20));
  for (let n = 1; n < 10; n++) await judge(n);
  await Promise.all([first, ...ids.slice(1).map(i => backgroundFix(client, file, [i], { pollMs: 50 }))]);
  expect(s.stderr.mock.calls.map(c => String(c[0])).filter(line => line.startsWith('Testing fixes'))).toEqual([`Testing fixes for 1 correction of ${file}.\n`, `Testing fixes for 9 corrections of ${file}.\n`]);
  for (const i of ids) expect(storedOutcome(METHOD_ID, i)).toMatchObject({ status: 'done', outcome: { id: i, outcome: i === ids[0] ? 'fixed' : 'no_change_needed' } });
  expect(client.judgments.every((j: any) => !j.pending)).toBe(true);
  expect(existsSync(join(s.root, 'cache', 'fixes', METHOD_ID, 'lock'))).toBe(false);
}, 120_000);

it('a fix whose process stopped does not hold the Method: its lock is taken over', async () => {
  const s = setup(); noStart(); fakeLearner(s.root, 'none');
  const { file } = await project(s.root);
  mkdirSync(join(s.root, 'cache', 'fixes', METHOD_ID), { recursive: true });
  writeFileSync(join(s.root, 'cache', 'fixes', METHOD_ID, 'lock'), JSON.stringify({ pid: 2 ** 22 + 12345 }));
  const client = fakeClient();
  await methodMain(['judge', 'run_1', 'wrong', '--note', 'Wrong.'], () => client);
  await backgroundFix(client, file, [id]);
  expect(storedOutcome(METHOD_ID, id)).toMatchObject({ status: 'done', outcome: { outcome: 'no_fix_found' } });
}, 60_000);

// ---------- Several people: a step changed since the run, a fix that breaks another person's check, held pairs ----------

it('does not fix a correction of a part that someone changed after the run, and says who', async () => {
  const s = setup(); const learner = fakeLearner(s.root, 'change');
  const { file } = await project(s.root);
  const now = readDocument(file) as any, before = readFileSync(file, 'utf8');
  const old = { ...methodContent(now), steps: { write: { ...now.steps.write, purpose: 'Writes a short reply.' } } };
  const client = fakeClient({
    judgments: [{ id: 'jdg_' + '5'.repeat(32), run_id: 'run_old', method_id: METHOD_ID, step_id: 'write', verdict: 'wrong', note: 'Too short.', corrected: null, source: 'dashboard', created_at: '2026-10-12T10:00:00Z', pending: true, noted_by: 'Ryan' }],
    runs: { run_old: { id: 'run_old', status: 'succeeded', workflow_version_id: 'v_old', inspection: { invocations: {} } } },
    versions: { [`/api/cli/methods/${METHOD_ID}?version=v_old`]: { workflow: old }, [`/api/cli/methods/${METHOD_ID}`]: { workflow: methodContent(now), saved_by: 'Gráinne' } } });
  const fix = await fixCorrections(client, file);
  expect(fix).toMatchObject({ applied: 0, outcomes: [{ id: 'jdg_' + '5'.repeat(32), outcome: 'already_changed', by: 'Gráinne' }] });
  expect(client.outcomes).toEqual([{ id: 'jdg_' + '5'.repeat(32), outcome: 'already_changed', detail: 'Gráinne changed it after this run.' }]);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(learner.briefs).toEqual([]);
});

it('holds a fix that passes only by breaking another person\'s check, and applies nothing', async () => {
  const s = setup(); fakeLearner(s.root, 'change');
  const { file, run } = await project(s.root);
  // Gráinne's earlier check: the reply stays as it is.
  await createCase({ methodFile: file, passingRun: run, id: 'old-rule', note: 'The reply must say that no escalation is needed.', author: 'Gráinne', expect: [{ kind: 'equals', ref: 'outputs.reply', value: 'Thanks. No escalation was identified as needed.' }] } as any);
  const before = readFileSync(file, 'utf8');
  const held = 'jdg_' + '7'.repeat(32);
  const client = fakeClient({ judgments: [{ id: held, run_id: 'run_1', method_id: METHOD_ID, step_id: null, verdict: 'wrong', note: 'Escalate the non-compete.', corrected: null, source: 'dashboard', created_at: '2026-10-12T10:00:00Z', pending: true, noted_by: 'Ryan' }] });
  const fix = await fixCorrections(client, file);
  expect(fix?.outcomes).toEqual([{ id: held, outcome: 'held', by: 'Gráinne', detail: 'The reply must say that no escalation is needed.' }]);
  expect(client.outcomes).toEqual([{ id: held, outcome: 'held', detail: 'Gráinne: The reply must say that no escalation is needed.' }]);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(client.calls.filter((c: any) => c.verb === 'PUT')).toEqual([]);
}, 60_000);

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
