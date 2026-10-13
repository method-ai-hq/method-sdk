import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
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
