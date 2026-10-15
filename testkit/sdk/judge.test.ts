import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { methodMain } from '../../packages/sdk/src/method.js';
import { MethodClient } from '../../packages/sdk/src/method-client.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'method-judge-'))); roots.push(root);
  vi.stubEnv('METHOD_CACHE_DIR', join(root, 'cache')); vi.stubEnv('METHOD_CONFIG_DIR', join(root, 'config'));
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const printed = () => stdout.mock.calls.map(c => String(c[0])).join('');
  return { root, stdout, printed };
}
const judgment = (body: any) => ({ judgment: { id: 'jdg_1', run_id: 'run_1', method_id: 'wf_1', verdict: body.verdict, step_id: body.step_id ?? null, created_at: '2026-10-13T10:00:00Z' }, fixing: body.verdict === 'wrong' });
const fakeClient = (token: string | null = 'method_x') => ({
  server: 'https://example.test', token: () => token, calls: [] as { path: string; verb: string; body: any }[],
  async request(path: string, verb = 'GET', body?: any) {
    this.calls.push({ path, verb, body });
    if (verb === 'POST' && /^\/api\/cli\/runs\/[^/]+\/judgments$/.test(path)) return judgment(body);
    throw Error(`404: Run not found.`);
  },
}) as any;

it('records a wrong judgment with the step, the note, and a corrected JSON result, and says Method is fixing it', async () => {
  const s = setup(), client = fakeClient();
  writeFileSync(join(s.root, 'right.json'), '{"summary": "Acme renewed."}');
  await methodMain(['judge', '6f1c-run', 'wrong', '--step', 'choose', '--note', ' Name the customer. ', '--corrected', join(s.root, 'right.json')], () => client);
  expect(client.calls).toEqual([{ path: '/api/cli/runs/6f1c-run/judgments', verb: 'POST', body: { verdict: 'wrong', step_id: 'choose', note: 'Name the customer.', corrected: { summary: 'Acme renewed.' } } }]);
  expect(s.printed()).toBe('Recorded: wrong on step choose. Method is fixing it in the background.\n');
});

it('records a right judgment in one line, or prints the JSON with --json', async () => {
  const s = setup(), client = fakeClient();
  await methodMain(['judge', 'run_1', 'right'], () => client);
  expect(client.calls[0].body).toEqual({ verdict: 'right' });
  expect(s.printed()).toBe('Recorded: right.\n');
  s.stdout.mockClear();
  await methodMain(['judge', 'run_1', 'right', '--json'], () => client);
  expect(JSON.parse(s.printed())).toEqual({ judgment: { id: 'jdg_1', run_id: 'run_1', method_id: 'wf_1', verdict: 'right', step_id: null, created_at: '2026-10-13T10:00:00Z' }, fixing: false });
});

it('sends a corrected result that is not JSON as text', async () => {
  const s = setup(), client = fakeClient();
  writeFileSync(join(s.root, 'right.md'), 'Acme renewed on 1 October.\n');
  await methodMain(['judge', 'run_1', 'wrong', '--corrected', join(s.root, 'right.md')], () => client);
  expect(client.calls[0].body).toEqual({ verdict: 'wrong', corrected: 'Acme renewed on 1 October.\n' });
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

/** A run folder as method run writes it in the Method cache, for a Method whose run content stays on this computer. */
function deviceRun(root: string, { recordFile = true, device = true } = {}) {
  const project = join(root, 'project'), file = join(project, 'nda.method'), dir = join(root, 'cache', 'runs', 'aaaaaaaa-0000-4000-8000-000000000001');
  mkdirSync(project, { recursive: true }); mkdirSync(dir, { recursive: true });
  writeFileSync(file, 'format: method/3.4\nid: wf_' + '1'.repeat(32) + '\nname: NDA triage\nrun_data: device\n');
  writeFileSync(join(dir, 'method.json'), JSON.stringify({ format: 'method/3.4', id: 'wf_' + '1'.repeat(32), name: 'NDA triage', ...(device ? { run_data: 'device' } : {}) }));
  writeFileSync(join(dir, 'run-id.json'), JSON.stringify({ id: '037a667b-e45d-4461-a319-edc2dc0f64c2' }));
  writeFileSync(join(dir, 'method-sync.json'), JSON.stringify({ schema: 'method-sync/1', id: '037a667b-e45d-4461-a319-edc2dc0f64c2', ...(device ? { device: true } : {}), dashboard_id: 'run_91ce2a549f2a205ac804980391db6590' }));
  writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({ sequence: 1, event: 'run.started', execution_id: '95c938d1-cc47-4a49-854e-d39424b3bc65' }) + '\n');
  if (recordFile) writeFileSync(join(dir, 'method-file.json'), JSON.stringify({ path: file }));
  return { project, file, dir };
}

it('keeps the note and corrected result of a device run next to the Method file, and sends the account the verdict only', async () => {
  const s = setup(), client = fakeClient(), run = deviceRun(s.root);
  writeFileSync(join(s.root, 'right.json'), '{"escalate": ["non-compete"]}');
  await methodMain(['judge', '037a667b-e45d-4461-a319-edc2dc0f64c2', 'wrong', '--note', 'You missed the non-compete.', '--corrected', join(s.root, 'right.json')], () => client);
  expect(client.calls[0].body).toEqual({ verdict: 'wrong' });
  const path = join(run.project, '.method', 'judgments.jsonl');
  expect(s.printed()).toBe(`Recorded: wrong. Method is fixing it in the background. Its note stays on this computer in ${path}; method improve nda.method uses it.\n`);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(run.project, '.method', '.gitignore'), 'utf8')).toBe('*\n');
  expect(readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))).toEqual([{
    id: 'jdg_1', run_id: '037a667b-e45d-4461-a319-edc2dc0f64c2', account_run_id: 'run_1', run_dir: run.dir, method_id: 'wf_1', file: 'nda.method',
    step_id: null, verdict: 'wrong', note: 'You missed the non-compete.', corrected: { escalate: ['non-compete'] }, created_at: '2026-10-13T10:00:00Z' }]);
  // The account run ID, the execution ID, and the folder name find the same run; each judgment adds one line.
  for (const id of ['run_91ce2a549f2a205ac804980391db6590', '95c938d1-cc47-4a49-854e-d39424b3bc65', 'aaaaaaaa-0000-4000-8000-000000000001'])
    await methodMain(['judge', id, 'right', '--step', 'reply'], () => client);
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  expect(lines.map(j => [j.verdict, j.run_dir, j.step_id])).toEqual([['wrong', run.dir, null], ['right', run.dir, 'reply'], ['right', run.dir, 'reply'], ['right', run.dir, 'reply']]);
  expect(client.calls.slice(1).map((c: any) => c.body)).toEqual([1, 2, 3].map(() => ({ verdict: 'right', step_id: 'reply' })));
});

it('finds the Method file of an older device run in this folder, and refuses a note it cannot keep before it sends anything', async () => {
  const s = setup(), client = fakeClient(), run = deviceRun(s.root, { recordFile: false });
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(run.project);
  await methodMain(['judge', 'run_91ce2a549f2a205ac804980391db6590', 'wrong', '--note', 'Escalate the exclusivity clause.'], () => client);
  expect(JSON.parse(readFileSync(join(run.project, '.method', 'judgments.jsonl'), 'utf8'))).toMatchObject({ run_id: 'run_91ce2a549f2a205ac804980391db6590', note: 'Escalate the exclusivity clause.', run_dir: run.dir });
  cwd.mockReturnValue(s.root);
  await expect(methodMain(['judge', 'run_91ce2a549f2a205ac804980391db6590', 'wrong', '--note', 'Again.'], () => client)).rejects.toThrow('Run method judge in the folder of the Method file.');
  expect(client.calls).toHaveLength(1);
});

it('sends the note of a run whose content the account keeps, and keeps nothing on this computer', async () => {
  const s = setup(), client = fakeClient(), run = deviceRun(s.root, { device: false });
  await methodMain(['judge', '037a667b-e45d-4461-a319-edc2dc0f64c2', 'wrong', '--note', 'Name the customer.'], () => client);
  expect(client.calls[0].body).toEqual({ verdict: 'wrong', note: 'Name the customer.' });
  expect(existsSync(join(run.project, '.method'))).toBe(false);
});
