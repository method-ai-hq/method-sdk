import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importSecrets, listSecrets, resolveSecrets, setSecret } from '../../packages/sdk/src/secrets.js';
import { runCurrentFile } from '../../packages/sdk/src/current-runtime.js';
import { deviceOnly } from '../../packages/sdk/src/method-sync.js';
import { publish } from '../../packages/sdk/src/versions.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); process.exitCode = 0; roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function home() {
  const root = mkdtempSync(join(tmpdir(), 'method-secrets-')); roots.push(root);
  vi.stubEnv('HOME', root); vi.stubEnv('ARCHIVE_TOKEN', '');
  return root;
}

it('imports named values from a file the user names, keeps them private, and prints no value', () => {
  const root = home();
  writeFileSync(join(root, '.env'), '# keys\nexport ARCHIVE_TOKEN="tok en"\nOTHER=x # note\n');
  expect(importSecrets(join(root, '.env'), ['ARCHIVE_TOKEN', 'OTHER']).saved).toEqual(['ARCHIVE_TOKEN', 'OTHER']);
  expect(resolveSecrets(['ARCHIVE_TOKEN', 'OTHER', 'MISSING'])).toEqual({ ARCHIVE_TOKEN: 'tok en', OTHER: 'x' });
  expect(statSync(join(root, '.config/method/secrets.json')).mode & 0o777).toBe(0o600);
  expect(() => importSecrets(join(root, '.env'), ['NOT_THERE'])).toThrow('Not found');
  vi.stubEnv('OTHER', 'from shell');
  expect(resolveSecrets(['OTHER'])).toEqual({ OTHER: 'from shell' });
  expect(listSecrets(['ARCHIVE_TOKEN', 'OTHER', 'MISSING']).map(s => s.source)).toEqual(['this computer', 'shell', 'missing']);
});

it('saves a value entered in the private browser form', async () => {
  home();
  const saved = setSecret('ARCHIVE_TOKEN', async url => {
    expect((await fetch(url.replace(/\/[^/]+$/, '/wrong'))).status).toBe(404);
    await fetch(url, { method: 'POST', body: new URLSearchParams({ value: 'typed-value' }) });
  });
  await saved;
  expect(resolveSecrets(['ARCHIVE_TOKEN'])).toEqual({ ARCHIVE_TOKEN: 'typed-value' });
});

it('gives declared secrets to scripts, and stops before the first step when one is missing', async () => {
  const root = home();
  writeFileSync(join(root, 'task.method'), JSON.stringify({ format: 'method/3.3', name: 'Secret', goal: 'Read a secret.', secrets: { ARCHIVE_TOKEN: 'Archive token.' },
    steps: { read: { name: 'Read', purpose: 'Returns the token length.', do: { kind: 'run', runtime: 'node', entrypoint: 'read.mjs' }, out: { length: { type: 'number', description: 'Length.' } } } }, result: 'length' }));
  writeFileSync(join(root, 'read.mjs'), 'console.log(JSON.stringify({length:process.env.ARCHIVE_TOKEN.length}))');
  await expect(runCurrentFile(join(root, 'task.method'), { 'run-dir': join(root, 'runs/one') })).rejects.toMatchObject({ code: 'missing_secret', missing: ['ARCHIVE_TOKEN'] });
  writeFileSync(join(root, '.env'), 'ARCHIVE_TOKEN=abcdef\n'); importSecrets(join(root, '.env'), ['ARCHIVE_TOKEN']);
  expect(await runCurrentFile(join(root, 'task.method'), { 'run-dir': join(root, 'runs/two') })).toMatchObject({ status: 'completed', result: 6 });
  expect(readFileSync(join(root, 'runs/two/events.jsonl'), 'utf8')).not.toContain('abcdef');
});

it('a device-only inspection keeps the run shape and drops its content', () => {
  const inspection: any = { schema: 'workflow-inspection/2', workflow: { format: 'method/3.3' }, run_id: 'r', status: 'succeeded', device_name: 'laptop', inputs: { member: 'Maeby' },
    resources: { notes: { description: 'Notes', path: '/private/notes' } }, files: [{ name: 'x' }], events: [{ at: 't', type: 'step_started', detail: 'private text' }],
    invocations: { 'write:0': { step_id: 'write', status: 'passed', inputs: { a: 1 }, outputs: { b: 2 }, prompts: [{}], checks: [{ id: 'c', result: 'pass', summary: 'private', evidence: ['quote'], method: 'agent' }], changes: { x: 1 }, events: [{ at: 't', type: 'model_response', detail: 'answer' }] } } };
  const shown = deviceOnly(inspection);
  expect(shown).toMatchObject({ content: 'device', inputs: {}, device_name: 'laptop', resources: { notes: { description: 'Notes' } }, invocations: { 'write:0': { step_id: 'write', status: 'passed', changes: {} } } });
  expect(JSON.stringify(shown)).not.toMatch(/Maeby|private|quote|answer|outputs|prompts|files/);
});

it('publish checks cases, saves the version, and marks it published', async () => {
  const root = home();
  writeFileSync(join(root, 'task.method'), JSON.stringify({ format: 'method/3.3', name: 'Publish', goal: 'Publish a version.', steps: { ask: { ask: 'What is your name?', out: { name: { type: 'text', description: 'Name.' } } } }, result: 'name' }));
  let workflow: any, pack: any;
  const client: any = { server: 'https://example.test', token: () => 'test-token', transfer: vi.fn(), request: vi.fn(async (path: string, verb: string, body: any) => {
    if (path === '/api/cli/files/check') return { present: [] };
    if (path.endsWith('/publish')) return { published_at: '2026-10-09T00:00:00Z', publish_reason: body.reason };
    if (verb === 'POST') { workflow = body.workflow; pack = body.package; return { workflow_id: 'wf_test', version_id: 'v_test' }; }
    return { version_id: 'v_test', version_number: 1, workflow, package: pack };
  }) };
  expect(await publish(client, join(root, 'task.method'), 'First release')).toMatchObject({ workflow_id: 'wf_test', version_id: 'v_test', published_at: '2026-10-09T00:00:00Z', publish_reason: 'First release' });
});
