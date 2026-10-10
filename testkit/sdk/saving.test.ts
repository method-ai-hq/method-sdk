import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { methodMain } from '../../packages/sdk/src/method.js';
import { MethodClient } from '../../packages/sdk/src/method-client.js';
import { writePrivateJson } from '../../packages/sdk/src/files.js';
import { Outbox } from '../../packages/sdk/src/outbox.js';
import { currentVersion, prepareVersion } from '../../packages/sdk/src/versions.js';
import { readDocument } from '../../packages/sdk/src/authoring.js';
import { readComputerSettings } from '../../packages/sdk/src/computer-settings.js';
import { loadWorkflow } from '../../packages/workflow-language/src/validate.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); process.exitCode = 0; roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

const method = (text: string) => ({ format: 'method/3.3', name: 'Echo', goal: 'Return a fixed text.', steps: { echo: { name: 'Echo', purpose: 'Return the fixed text; changes nothing.', do: { kind: 'run', runtime: 'node', entrypoint: 'echo.mjs' }, out: { text: { type: 'text', description: 'The text.' } } } }, result: 'text', run_label: undefined, _text: text });
function writeMethod(file: string, text: string) {
  const { _text, run_label, ...document } = method(text);
  writeFileSync(file, JSON.stringify(document, null, 2));
  writeFileSync(join(file, '..', 'echo.mjs'), `for await (const c of process.stdin) {}; console.log(JSON.stringify({text: ${JSON.stringify(text)}}));`);
}

/** A Method server in memory: files, content-addressed versions with parents, run records. */
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'method-saving-'))); roots.push(root);
  vi.stubEnv('METHOD_CACHE_DIR', join(root, 'cache')); vi.stubEnv('METHOD_CONFIG_DIR', join(root, 'config')); vi.stubEnv('METHOD_NO_EXPLAIN', '1');
  vi.stubEnv('METHOD_OUTBOX_STALL_MS', '2000');
  const server = { files: new Set<string>(), versions: new Map<string, { method_id: string; number: number; parent?: string; workflow: any }>(), runs: new Map<string, any>(),
    log: [] as string[], offline: false, failing: false, beforeFirst: undefined as undefined | (() => void) };
  const fetcher = vi.fn(async (url: any, init: any = {}) => {
    const path = new URL(String(url)).pathname, verb = init.method ?? 'GET';
    if (!server.log.some(line => line.includes(' /api/cli/')) && path.startsWith('/api/cli/')) server.beforeFirst?.();
    server.log.push(`${verb} ${path}`);
    if (server.offline) throw new TypeError('fetch failed');
    if (server.failing) return Response.json({ message: 'Unavailable' }, { status: 503 });
    const bytes = init.body === undefined ? undefined : new Uint8Array(await new Response(init.body).arrayBuffer());
    const body = bytes && init.headers?.['content-type'] === 'application/json' ? JSON.parse(new TextDecoder().decode(bytes)) : undefined;
    if (path === '/api/cli/me') return Response.json({ user: { id: 'user' }, organization: { keep_run_content_on_devices: false } });
    if (path === '/api/cli/files/check') return Response.json({ present: body.hashes.filter((h: string) => server.files.has(h)) });
    if (path.startsWith('/api/cli/files/')) { server.files.add(path.split('/').at(-1)!); return Response.json({ uploaded: true }); }
    const version = /^\/api\/cli\/methods\/([^/]+)\/versions\/([^/]+)$/.exec(path);
    if (version && verb === 'PUT') {
      const [, methodId, versionId] = version as unknown as [string, string, string];
      if (body.package.files.some((f: any) => !server.files.has(f.sha256))) return Response.json({ message: 'A package file is missing.' }, { status: 400 });
      const existing = server.versions.get(versionId);
      if (!existing) server.versions.set(versionId, { method_id: methodId, number: [...server.versions.values()].filter(v => v.method_id === methodId).length + 1, parent: body.parent_version_id, workflow: body.workflow });
      return Response.json({ version_id: versionId, version_number: server.versions.get(versionId)!.number });
    }
    const publish = /^\/api\/cli\/methods\/([^/]+)\/versions\/([^/]+)\/publish$/.exec(path);
    if (publish) return Response.json({ version_number: server.versions.get(publish[2]!)?.number, published_at: '2026-10-09T00:00:00Z', publish_reason: body.reason });
    if (path.startsWith('/api/cli/runs/')) {
      if (!server.versions.has(body.version_id)) return Response.json({ message: 'Method version not found.' }, { status: 404 });
      server.runs.set(path, body); return Response.json({ id: 'run_1', sequence: body.sequence });
    }
    throw Error(`Unexpected request: ${verb} ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const client = new MethodClient();
  writePrivateJson(client.credentialFile, { server: client.server, token: 'method_' + 'a'.repeat(43) });
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(text => { err.push(String(text)); return true; });
  const file = join(root, 'echo.method');
  const run = async (name: string, target = file) => { await methodMain(['run', target, '--run-dir', join(root, name)]); return JSON.parse(readFileSync(join(root, name, 'summary.json'), 'utf8')); };
  const puts = () => server.log.filter(line => /^PUT \/api\/cli\/methods\/.*\/versions\//.test(line));
  return { root, file, server, client, err, run, puts, fetcher };
}

it('saves the same content as the same version, and finds the existing version after a git revert', async () => {
  const s = setup(); writeMethod(s.file, 'first');
  await s.run('one');
  const first = (await currentVersion(s.file))!;
  expect(first.version_id).toMatch(/^v_[a-f0-9]{32}$/);
  expect(readFileSync(s.file, 'utf8')).toMatch(/^\{\n {2}"format": "method\/3\.4",\n {2}"id": "wf_[a-f0-9]{32}"/);
  expect(s.err.join('')).toContain('Saved as version 1');
  await s.run('two');
  expect(s.puts()).toHaveLength(1);
  const original = readFileSync(s.file, 'utf8');
  writeMethod(s.file, 'second'); writeFileSync(s.file, original.replace('"Echo"', '"Echo"')); writeFileSync(join(s.root, 'echo.mjs'), 'for await (const c of process.stdin) {}; console.log(JSON.stringify({text: "second"}));');
  await s.run('three');
  const second = (await currentVersion(s.file))!;
  expect(second.version_id).not.toBe(first.version_id);
  expect(s.server.versions.get(second.version_id)).toMatchObject({ number: 2, parent: first.version_id });
  // git checkout of the old files: the content is the first version again.
  writeFileSync(join(s.root, 'echo.mjs'), `for await (const c of process.stdin) {}; console.log(JSON.stringify({text: "first"}));`);
  expect((await currentVersion(s.file))!.version_id).toBe(first.version_id);
  await s.run('four');
  expect(s.puts()).toHaveLength(2);
  expect(s.err.join('')).toContain('Saved as version 1');
  expect(s.server.versions.size).toBe(2);
}, 30_000);

it('starts the run before any save request, and the run never waits for or fails on a save', async () => {
  const s = setup(); writeMethod(s.file, 'hello');
  let started: boolean | undefined;
  // The first account request comes after the runtime started the run.
  s.server.beforeFirst = () => { started = existsSync(join(s.root, 'one', 'events.jsonl')); };
  expect(await s.run('one')).toMatchObject({ status: 'completed', result: 'hello' });
  expect(started).toBe(true);
  // A server that fails every request: the run completes, and its records wait in the outbox.
  s.server.failing = true; writeFileSync(join(s.root, 'echo.mjs'), 'for await (const c of process.stdin) {}; console.log(JSON.stringify({text: "again"}));');
  expect(await s.run('two')).toMatchObject({ status: 'completed', result: 'again' });
  expect(process.exitCode ?? 0).toBe(0);
  expect(s.err.join('')).toContain('Will save when online.');
}, 30_000);

it('completes a run offline and the outbox sends the version and the run later', async () => {
  const s = setup(); writeMethod(s.file, 'offline');
  s.server.offline = true;
  expect(await s.run('one')).toMatchObject({ status: 'completed', result: 'offline' });
  expect(s.err.join('')).toContain('Will save when online.');
  expect(new Outbox(s.client).pending()).toBeGreaterThan(0);
  s.server.offline = false;
  // Any later signed-in command sends what is left, in the background.
  await methodMain(['list']).catch(() => {});
  await vi.waitFor(() => { expect(s.server.versions.size).toBe(1); expect(s.server.runs.size).toBe(1); }, { timeout: 5000 });
  await vi.waitFor(() => expect(new Outbox(s.client).pending()).toBe(0), { timeout: 5000 });
  expect([...s.server.runs.values()][0].inspection.status).toBe('succeeded');
}, 30_000);

it('keeps the Method of a renamed file through its id line', async () => {
  const s = setup(); writeMethod(s.file, 'name');
  await s.run('one');
  const before = (await currentVersion(s.file))!;
  const renamed = join(s.root, 'renamed.method'); renameSync(s.file, renamed);
  writeFileSync(join(s.root, 'echo.mjs'), 'for await (const c of process.stdin) {}; console.log(JSON.stringify({text: "renamed"}));');
  await s.run('two', renamed);
  const after = (await currentVersion(renamed))!;
  expect(after.method_id).toBe(before.method_id);
  expect(s.server.versions.get(after.version_id)).toMatchObject({ method_id: before.method_id, number: 2, parent: before.version_id });
  // A copy made a new Method keeps its content but not its ID.
  const copy = join(s.root, 'copy.method'); writeFileSync(copy, readFileSync(renamed));
  await methodMain(['new-id', copy]);
  expect(readDocument(copy).id).not.toBe(before.method_id);
}, 30_000);

it('two computers saving different content both succeed, each with its parent', async () => {
  const s = setup(); writeMethod(s.file, 'base');
  await s.run('one');
  const base = (await currentVersion(s.file))!;
  // The second computer: another cache, the same file with other content.
  const other = join(s.root, 'other'); mkdirSync(other); const otherFile = join(other, 'echo.method');
  writeFileSync(otherFile, readFileSync(s.file)); writeFileSync(join(other, 'echo.mjs'), 'for await (const c of process.stdin) {}; console.log(JSON.stringify({text: "other"}));');
  writeFileSync(join(s.root, 'echo.mjs'), 'for await (const c of process.stdin) {}; console.log(JSON.stringify({text: "mine"}));');
  const mine = new Outbox(s.client);
  const a = await prepareVersion(s.client, mine, s.file);
  vi.stubEnv('METHOD_CACHE_DIR', join(s.root, 'other-cache'));
  const theirs = new Outbox(s.client);
  const b = await prepareVersion(s.client, theirs, otherFile, 'Other change');
  await theirs.drain();
  vi.stubEnv('METHOD_CACHE_DIR', join(s.root, 'cache'));
  await mine.drain();
  expect(a.method_id).toBe(b.method_id);
  expect(s.server.versions.get(a.version_id)).toMatchObject({ parent: base.version_id });
  expect(s.server.versions.get(b.version_id)).toMatchObject({ parent: undefined });
  expect(s.server.versions.size).toBe(3);
}, 30_000);

it('a slow upload that keeps moving bytes does not time out; a stalled one stops', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'method-slow-'))); roots.push(root);
  const slow = async (_url: any, init: any) => {
    const reader = (init.body as ReadableStream<Uint8Array>).getReader(); let received = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; received += value.byteLength; await new Promise(r => setTimeout(r, 60)); }
    return Response.json({ received });
  };
  const client = new MethodClient('https://method.example', slow as typeof fetch, join(root, 'config'));
  writePrivateJson(client.credentialFile, { server: client.server, token: 'method_' + 'a'.repeat(43) });
  const progress: number[] = [];
  const bytes = new Uint8Array(1_000_000);
  // 16 chunks of 64 KiB at 60 ms each: about 1 s in all, with no pause longer than the 300 ms stall limit.
  const answer = JSON.parse(new TextDecoder().decode(await client.transfer('/api/cli/files/' + 'a'.repeat(64), bytes, { stallMs: 300, onProgress: sent => progress.push(sent), attempts: 1 })));
  expect(answer.received).toBe(bytes.length);
  expect(progress.at(-1)).toBe(bytes.length);
  const stalled = new MethodClient('https://method.example', (async (_url: any, init: any) => { await new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))); }) as unknown as typeof fetch, join(root, 'config'));
  await expect(stalled.transfer('/api/cli/files/' + 'a'.repeat(64), bytes, { stallMs: 200, attempts: 1 })).rejects.toThrow('No data moved');
});

it('publish uploads the current version, publishes that version ID, and needs --reason to accept a failing case', async () => {
  const s = setup(); writeMethod(s.file, 'publish');
  await methodMain(['publish', s.file, '--reason', 'First release']);
  const version = (await currentVersion(s.file))!;
  expect(s.server.log).toContain(`POST /api/cli/methods/${version.method_id}/versions/${version.version_id}/publish`);
  expect(s.server.versions.get(version.version_id)?.number).toBe(1);
  await expect(methodMain(['publish', s.file, '--accept-failing-case', 'one'])).rejects.toThrow('Give --reason with --accept-failing-case');
}, 30_000);
