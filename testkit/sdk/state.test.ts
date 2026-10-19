import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSaved, stateWait } from '../../packages/sdk/src/run-saved.js';
import { bindConnectionValue } from '../../packages/sdk/src/computer-settings.js';

// A second run of a Method with shared state waits for the run that holds it, and starts when it is free.

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; stateWait.pollMs = 10_000; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** The saved 0.7.0 fixture (it counts in shared state) against a server whose state another run holds for a while. */
function setup(owners: Array<{ status: string } | null>) {
  const original = JSON.parse(readFileSync(new URL('../fixtures/runtime-upgrades/0.7.0.json', import.meta.url), 'utf8'));
  const root = mkdtempSync(join(tmpdir(), 'method-state-')); roots.push(root);
  const records = join(root, 'records'); mkdirSync(records); writeFileSync(join(records, 'message.txt'), 'Hello from a local binding\n');
  vi.stubEnv('METHOD_CACHE_DIR', join(root, 'cache')); vi.stubEnv('METHOD_CONFIG_DIR', join(root, 'config'));
  bindConnectionValue(original.saved.workflow_id, 'records', records);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const err: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(text => { err.push(String(text)); return true; });
  stateWait.pollMs = 10;
  const acquires: number[] = [];
  const client: any = { server: 'https://example.test', credentialFile: join(root, 'credentials.json'), transfer: vi.fn(async (path: string) => Buffer.from(original.blobs[path.split('/').at(-1)!.split('?')[0]!], 'base64')),
    request: vi.fn(async (path: string, verb = 'GET', body?: any) => {
      if (path === '/api/cli/me') return { user: { id: 'user' }, organization: { keep_run_content_on_devices: false } };
      if (path.endsWith('/state') && verb === 'GET') return { enabled: true, revision: 0, value: { count: 0 }, owner_run: null };
      if (path.endsWith('/state') && body.action === 'acquire') {
        acquires.push(Date.now());
        const owner = owners.shift();
        if (owner) throw Object.assign(Error('409: Shared state is owned by another run.'), { status: 409, code: 'state_owned',
          body: { code: 'state_owned', message: 'Shared state is owned by another run.', owner: { run_id: 'run_ryan', started_by: 'Ryan', started_at: '2026-10-19T10:02:00', link: 'https://example.test/runs/run_ryan', ...owner } } });
        return { enabled: true, revision: 0, value: { count: 0 }, owner_run: body.run_id };
      }
      if (path.endsWith('/state') && body.action === 'commit') return { revision: body.revision + 1 };
      if (path.endsWith('/state')) return { enabled: true };
      if (path.endsWith('/bindings')) return {};
      if (path.startsWith('/api/cli/runs/')) return { id: 'run_test' };
      throw Error(`Unexpected API request: ${path}`);
    }) };
  return { root, client, err, acquires, saved: original.saved, flags: { 'run-dir': join(root, 'run') } };
}

it('waits while another run holds the shared state, says so once, and starts when it is free', async () => {
  const s = setup([{ status: 'running' }, { status: 'disconnected' }, { status: 'running' }]);
  expect(await runSaved(s.saved, s.flags, s.client)).toMatchObject({ status: 'completed' });
  expect(s.acquires).toHaveLength(4);
  expect(s.err.filter(line => line.startsWith('Waiting'))).toEqual(["Waiting for Ryan's run (started 10:02) to finish with the shared state: https://example.test/runs/run_ryan\n"]);
  expect(JSON.parse(readFileSync(join(s.flags['run-dir'], 'state.json'), 'utf8'))).toEqual({ count: 1 });
});

it('stops with the owner\'s name when the run that holds the state stopped', async () => {
  for (const status of ['finished', 'failed']) {
    const s = setup([{ status }]);
    await expect(runSaved(s.saved, s.flags, s.client)).rejects.toMatchObject({ owner: 'setup',
      message: "Ryan's run stopped while it held the shared state. Ryan must check its actions, then run `method state " + s.saved.workflow_id + ' --release run_ryan`.' });
    expect(s.acquires).toHaveLength(1);
    expect(s.err.some(line => line.startsWith('Waiting'))).toBe(false);
  }
});

it('a free state starts at once, as before', async () => {
  const s = setup([]);
  expect(await runSaved(s.saved, s.flags, s.client)).toMatchObject({ status: 'completed' });
  expect(s.acquires).toHaveLength(1);
  expect(s.err.some(line => line.startsWith('Waiting'))).toBe(false);
});
