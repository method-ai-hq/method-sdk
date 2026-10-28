import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { methodMain } from '../../packages/sdk/src/method.js';
import { MethodClient } from '../../packages/sdk/src/method-client.js';
import { writePrivateJson } from '../../packages/sdk/src/files.js';
import { Outbox } from '../../packages/sdk/src/outbox.js';
import { currentVersion, methodContent, prepareVersion, savedLine } from '../../packages/sdk/src/versions.js';
import { readDocument } from '../../packages/sdk/src/authoring.js';
import { fileHash } from '../../packages/sdk/src/method-files.js';
import { missingFileFailure } from '../../packages/sdk/src/current-runtime.js';

// Two people, two computers (each with its own cache and sign-in), one server: method run catches up with the newest
// version before it runs, combines changes step by step and file by file, and stops only for a true conflict.

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); process.exitCode = 0; roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

const step = (file: string, out: string, purpose = 'Returns a fixed text; changes nothing.') => ({ name: out.toUpperCase(), purpose, do: { kind: 'run', runtime: 'node', entrypoint: file }, out: { [out]: { type: 'text', description: 'The text.' } } });
const script = (out: string, text: string) => `for await (const c of process.stdin) {}; console.log(JSON.stringify({${out}: ${JSON.stringify(text)}}));`;

type Version = { method_id: string; number: number; parent?: string; merged?: string; workflow: any; package: any; saved_by: string; saved_at: string };
/** The server: content-addressed files and versions; a save becomes newest only on top of the newest version. */
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'method-catch-up-'))); roots.push(root);
  vi.stubEnv('METHOD_NO_EXPLAIN', '1'); vi.stubEnv('METHOD_OUTBOX_STALL_MS', '2000');
  const people: Record<string, string> = {};
  const server = { blobs: new Map<string, Uint8Array>(), versions: new Map<string, Version>(), current: new Map<string, string>(), runs: new Map<string, any>(), workspaceRuns: [] as any[], workflows: [] as any[], log: [] as string[], offline: false };
  const answer = (v: Version, id: string) => ({ workflow_id: v.method_id, version_id: id, version_number: v.number, workflow: v.workflow, package: v.package, saved_by: v.saved_by, saved_at: v.saved_at, newest: server.current.get(v.method_id) === id });
  vi.stubGlobal('fetch', vi.fn(async (url: any, init: any = {}) => {
    const address = new URL(String(url)), path = address.pathname, verb = init.method ?? 'GET';
    server.log.push(`${verb} ${path}${address.search}`);
    if (server.offline) throw new TypeError('fetch failed');
    const who = people[String(init.headers?.authorization ?? '').replace('Bearer ', '')] ?? 'Nobody';
    const bytes = init.body === undefined ? undefined : new Uint8Array(await new Response(init.body).arrayBuffer());
    const body = bytes && init.headers?.['content-type'] === 'application/json' ? JSON.parse(new TextDecoder().decode(bytes)) : undefined;
    if (path === '/api/cli/me') return Response.json({ user: { id: who, name: who }, organization: { keep_run_content_on_devices: false } });
    if (path === '/api/cli/files/check') return Response.json({ present: body.hashes.filter((h: string) => server.blobs.has(h)) });
    if (path.startsWith('/api/cli/files/')) { server.blobs.set(path.split('/').at(-1)!, bytes!); return Response.json({ uploaded: true }); }
    const file = /^\/api\/cli\/methods\/[^/]+\/files\/([a-f0-9]{64})$/.exec(path);
    if (file) return new Response(server.blobs.get(file[1]!));
    const save = /^\/api\/cli\/methods\/([^/]+)\/versions\/([^/]+)$/.exec(path);
    if (save && verb === 'PUT') {
      const [, methodId, id] = save as unknown as [string, string, string];
      if (!server.versions.has(id)) {
        const newest = !server.current.has(methodId) || body.parent_version_id === server.current.get(methodId);
        server.versions.set(id, { method_id: methodId, number: [...server.versions.values()].filter(v => v.method_id === methodId).length + 1, parent: body.parent_version_id, merged: body.merged_version_id, workflow: body.workflow, package: body.package, saved_by: who, saved_at: new Date().toISOString() });
        if (newest) server.current.set(methodId, id);
      }
      const current = server.current.get(methodId)!, newest = current === id, newer = server.versions.get(current)!;
      return Response.json({ version_id: id, version_number: server.versions.get(id)!.number, newest, ...(newest ? {} : { newer: { version_id: current, version_number: newer.number, saved_by: newer.saved_by, saved_at: newer.saved_at } }) });
    }
    const method = /^\/api\/cli\/methods\/([^/]+)$/.exec(path);
    if (method && verb === 'GET') {
      const id = address.searchParams.get('version') ?? server.current.get(method[1]!), v = id ? server.versions.get(id) : undefined;
      return v ? Response.json(answer(v, id!)) : Response.json({ message: 'Method not found.' }, { status: 404 });
    }
    const history = /^\/api\/workspace\/methods\/([^/]+)\/versions$/.exec(path);
    if (history) return Response.json({ versions: [...server.versions].filter(([, v]) => v.method_id === history[1]).sort(([, x], [, y]) => y.number - x.number).map(([id, v]) => ({ id, version_number: v.number })) });
    if (/^\/api\/cli\/methods\/[^/]+\/judgments$/.test(path)) return Response.json({ judgments: [] });
    if (/^\/api\/cli\/methods\/[^/]+\/state$/.test(path)) return Response.json({ enabled: false });
    if (/^\/api\/cli\/methods\/[^/]+\/bindings$/.test(path)) return Response.json({});
    if (path === '/api/methods') return Response.json({ workflows: server.workflows, next_cursor: null });
    if (path === '/api/workspace/runs') return Response.json({ runs: server.workspaceRuns });
    if (path.startsWith('/api/cli/runs/')) { server.runs.set(path, body); return Response.json({ id: path.split('/').at(-1), sequence: body.sequence }); }
    throw Error(`Unexpected request: ${verb} ${path}`);
  }));
  const err: string[] = [], out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(text => { out.push(String(text)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(text => { err.push(String(text)); return true; });
  /** A person's computer: its own cache, sign-in and folder. */
  const person = (name: string) => {
    const home = join(root, name.toLowerCase()), token = 'method_' + name[0]!.toLowerCase().repeat(43);
    people[token] = name;
    const use = () => { vi.stubEnv('METHOD_CACHE_DIR', join(home, 'cache')); vi.stubEnv('METHOD_CONFIG_DIR', join(home, 'config')); };
    use();
    const client = new MethodClient(); writePrivateJson(client.credentialFile, { server: client.server, token });
    const folder = join(home, 'project'); mkdirSync(folder, { recursive: true });
    const file = join(folder, 'two.method');
    let runs = 0;
    return { name, folder, file, client, use,
      run: async (...extra: string[]) => { use(); err.length = 0; out.length = 0; const dir = join(home, `run-${++runs}`); await methodMain(['run', file, '--run-dir', dir, ...extra]); return { dir, summary: existsSync(join(dir, 'summary.json')) ? JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) : undefined }; },
      get: async (id: string) => { use(); rmSync(folder, { recursive: true, force: true }); mkdirSync(folder, { recursive: true }); await methodMain(['get', id, '--out', file]); },
      edit: (change: (doc: any) => void) => { const doc = readDocument(file); change(doc); writeFileSync(file, JSON.stringify(doc, null, 2)); },
      script: (name: string, out: string, text: string) => writeFileSync(join(folder, name), script(out, text)) };
  };
  const ryan = person('Ryan'), grainne = person('Gráinne');
  ryan.use();
  writeFileSync(ryan.file, JSON.stringify({ format: 'method/3.4', name: 'Two', goal: 'Return two texts.', steps: { first: step('first.mjs', 'a'), second: step('second.mjs', 'b') }, result: { a: 'a', b: 'b' } }, null, 2));
  ryan.script('first.mjs', 'a', 'A'); ryan.script('second.mjs', 'b', 'B');
  return { root, server, err, out, ryan, grainne, text: () => err.join(''), printed: () => out.join('') };
}
/** Ryan saves version 1 and Gráinne gets it: both computers start from the same version. */
async function shared() {
  const s = setup();
  await s.ryan.run();
  const id = readDocument(s.ryan.file).id as string;
  await s.grainne.get(id);
  return { ...s, id };
}
const purpose = (file: string, stepId: string) => readDocument(file).steps[stepId].purpose;

it('an unchanged file takes the newest version, prints one line, and the run uses it', async () => {
  const s = await shared();
  s.grainne.edit(doc => { doc.steps.first.purpose = 'Returns the first text; changes nothing.'; });
  s.grainne.script('first.mjs', 'a', 'A from Gráinne');
  expect((await s.grainne.run()).summary).toMatchObject({ status: 'completed' });
  const newest = s.server.current.get(s.id)!;
  // Ryan's file did not change since his save: his next run takes Gráinne's version.
  const { summary } = await s.ryan.run();
  expect(s.text()).toMatch(/^Updated to Gráinne's version from \d\d:\d\d \(changed step first and file first\.mjs\)\.$/m);
  expect(summary).toMatchObject({ status: 'completed', result: { a: 'A from Gráinne', b: 'B' } });
  expect(purpose(s.ryan.file, 'first')).toBe('Returns the first text; changes nothing.');
  expect((await currentVersion(s.ryan.file))!.version_id).toBe(newest);
  // Nothing new to take: no line, no new version.
  await s.ryan.run();
  expect(s.text()).not.toContain('Updated to');
  expect(s.server.versions.size).toBe(2);
}, 60_000);

it('combines changes of different steps and different script files, and the next save has the newest version as its parent', async () => {
  const s = await shared();
  s.grainne.edit(doc => { doc.steps.first.purpose = 'Gráinne: returns the first text.'; });
  s.grainne.script('first.mjs', 'a', 'A from Gráinne');
  await s.grainne.run();
  const hers = s.server.current.get(s.id)!;
  s.ryan.use();
  s.ryan.edit(doc => { doc.steps.second.purpose = 'Ryan: returns the second text.'; });
  s.ryan.script('second.mjs', 'b', 'B from Ryan');
  const { summary } = await s.ryan.run();
  expect(s.text()).toMatch(/Updated to Gráinne's version from \d\d:\d\d \(changed step first and file first\.mjs\)\. Your changes to step second and file second\.mjs are kept\./);
  expect(summary).toMatchObject({ status: 'completed', result: { a: 'A from Gráinne', b: 'B from Ryan' } });
  expect([purpose(s.ryan.file, 'first'), purpose(s.ryan.file, 'second')]).toEqual(['Gráinne: returns the first text.', 'Ryan: returns the second text.']);
  const combined = s.server.current.get(s.id)!;
  expect(s.server.versions.get(combined)).toMatchObject({ parent: hers, saved_by: 'Ryan', number: 3 });
  // Gráinne's next run takes the combined version: both files are equal.
  await s.grainne.run();
  expect(readFileSync(s.grainne.file, 'utf8')).toBe(readFileSync(s.ryan.file, 'utf8'));
  expect(readFileSync(join(s.grainne.folder, 'second.mjs'), 'utf8')).toBe(readFileSync(join(s.ryan.folder, 'second.mjs'), 'utf8'));
}, 60_000);

/** This computer forgets every version it saved or got, as when a run with another cache saved the file. */
const forget = (s: { root: string }, name: string) => rmSync(join(s.root, name, 'cache', 'versions'), { recursive: true, force: true });

it('a file of the newest version with no record on this computer keeps its changes and does not stop', async () => {
  const s = await shared();
  s.grainne.edit(doc => { doc.steps.first.purpose = 'Gráinne: returns the first text.'; });
  await s.grainne.run();
  const hers = s.server.current.get(s.id)!;
  await s.ryan.run();
  forget(s, 'ryan');
  s.ryan.edit(doc => { doc.steps.second.purpose = 'Ryan: returns the second text.'; });
  s.ryan.script('second.mjs', 'b', 'B from Ryan');
  const { summary } = await s.ryan.run();
  expect(process.exitCode).toBeFalsy();
  expect(s.text()).not.toContain('Updated to');
  expect(summary).toMatchObject({ status: 'completed', result: { a: 'A', b: 'B from Ryan' } });
  expect(s.server.versions.get(s.server.current.get(s.id)!)).toMatchObject({ parent: hers, saved_by: 'Ryan' });
}, 60_000);

it('an older copy with no record on this computer takes the newer parts and keeps its own changes', async () => {
  const s = await shared();
  s.grainne.edit(doc => { doc.steps.first.purpose = 'Gráinne: returns the first text.'; });
  s.grainne.script('first.mjs', 'a', 'A from Gráinne');
  await s.grainne.run();
  s.ryan.use(); forget(s, 'ryan');
  s.ryan.edit(doc => { doc.steps.second.purpose = 'Ryan: returns the second text.'; });
  const { summary } = await s.ryan.run();
  expect(s.text()).toMatch(/Updated to Gráinne's version from \d\d:\d\d \(changed step first and file first\.mjs\)\. Your changes to step second are kept\./);
  expect(summary).toMatchObject({ status: 'completed', result: { a: 'A from Gráinne', b: 'B' } });
  expect([purpose(s.ryan.file, 'first'), purpose(s.ryan.file, 'second')]).toEqual(['Gráinne: returns the first text.', 'Ryan: returns the second text.']);
}, 60_000);

it('the same step changed on both sides: no run, no file change, both texts in the result, exit code 2', async () => {
  const s = await shared();
  s.grainne.edit(doc => { doc.steps.first.purpose = 'Gráinne: returns the first text.'; });
  await s.grainne.run();
  s.ryan.use();
  s.ryan.edit(doc => { doc.steps.first.purpose = 'Ryan: returns the first text.'; });
  const before = readFileSync(s.ryan.file, 'utf8'), runs = s.server.runs.size;
  const { dir, summary } = await s.ryan.run();
  expect(summary).toBeUndefined(); expect(existsSync(dir)).toBe(false);
  expect(s.server.runs.size).toBe(runs);
  expect(readFileSync(s.ryan.file, 'utf8')).toBe(before);
  expect(process.exitCode).toBe(2);
  const result = JSON.parse(s.printed());
  expect(result).toMatchObject({ status: 'needs_you', failure: { owner: 'needs_you', headline: 'Gráinne also changed step first. Combine the two texts in two.method, then run again.' },
    conflicts: [{ part: 'step first', file: 'two.method', yours: { purpose: 'Ryan: returns the first text.' }, theirs: { purpose: 'Gráinne: returns the first text.' } }] });
  expect(s.text()).toContain('Failed: Gráinne also changed step first.');
}, 60_000);

it('after a stop, the person combines the texts and the next run goes on with every other change of the teammate', async () => {
  const s = await shared();
  s.grainne.edit(doc => { doc.steps.first.purpose = 'Gráinne: returns the first text.'; doc.goal = 'Gráinne changed the goal.'; });
  await s.grainne.run();
  s.ryan.use();
  s.ryan.edit(doc => { doc.steps.first.purpose = 'Ryan: returns the first text.'; });
  await s.ryan.run();
  expect(process.exitCode).toBe(2);
  // Running again without combining stops again.
  process.exitCode = undefined;
  await s.ryan.run();
  expect(process.exitCode).toBe(2);
  process.exitCode = undefined;
  s.ryan.edit(doc => { doc.steps.first.purpose = 'Ryan and Gráinne: returns the first text.'; });
  const { summary } = await s.ryan.run();
  expect(process.exitCode).toBeUndefined();
  expect(summary).toBeDefined();
  const doc = readDocument(s.ryan.file);
  expect(doc.steps.first.purpose).toBe('Ryan and Gráinne: returns the first text.');
  expect(doc.goal).toBe('Gráinne changed the goal.');
}, 60_000);

it("after a stop on a script file, the person's combined file is kept", async () => {
  const s = await shared();
  s.grainne.script('first.mjs', 'a', 'A from Gráinne');
  await s.grainne.run();
  s.ryan.use(); s.ryan.script('first.mjs', 'a', 'A from Ryan');
  await s.ryan.run();
  expect(process.exitCode).toBe(2);
  process.exitCode = undefined;
  s.ryan.script('first.mjs', 'a', 'A from both');
  await s.ryan.run();
  expect(process.exitCode).toBeUndefined();
  expect(readFileSync(join(s.ryan.folder, 'first.mjs'), 'utf8')).toContain('A from both');
}, 60_000);

it('the same script file changed on both sides is a conflict that shows both texts', async () => {
  const s = await shared();
  s.grainne.script('first.mjs', 'a', 'A from Gráinne');
  await s.grainne.run();
  s.ryan.use(); s.ryan.script('first.mjs', 'a', 'A from Ryan');
  await s.ryan.run();
  expect(process.exitCode).toBe(2);
  const result = JSON.parse(s.printed());
  expect(result.failure.headline).toBe('Gráinne also changed file first.mjs. Combine the two texts in first.mjs, then run again.');
  expect(result.conflicts[0]).toMatchObject({ part: 'file first.mjs', file: 'first.mjs', yours: expect.stringContaining('A from Ryan'), theirs: expect.stringContaining('A from Gráinne') });
  expect(readFileSync(join(s.ryan.folder, 'first.mjs'), 'utf8')).toContain('A from Ryan');
}, 60_000);

it('--resume and an offline server change nothing; offline runs the file with one line', async () => {
  const s = await shared();
  s.grainne.edit(doc => { doc.steps.first.purpose = 'Gráinne: returns the first text.'; });
  await s.grainne.run();
  s.ryan.use();
  const before = readFileSync(s.ryan.file, 'utf8');
  s.server.offline = true;
  expect((await s.ryan.run()).summary).toMatchObject({ status: 'completed' });
  expect(s.text()).toContain('Could not check for a newer version; running this file.\n');
  expect(readFileSync(s.ryan.file, 'utf8')).toBe(before);
  s.server.offline = false;
  // A resumed run never changes its file.
  const resumed = join(s.root, 'ryan', 'run-1');
  s.server.log.length = 0;
  await methodMain(['run', s.ryan.file, '--run-dir', resumed, '--resume']).catch(() => {});
  expect(s.server.log.filter(line => line.startsWith(`GET /api/cli/methods/${s.id}`))).toEqual([]);
  expect(readFileSync(s.ryan.file, 'utf8')).toBe(before);
}, 60_000);

it('the save race: a save beside a newer version says so, and the next run combines the two', async () => {
  const s = await shared();
  const first = s.server.current.get(s.id)!;
  s.grainne.edit(doc => { doc.steps.first.purpose = 'Gráinne: returns the first text.'; });
  await s.grainne.run();
  const hers = s.server.current.get(s.id)!;
  // Ryan saves from version 1 after Gráinne's save, as if she saved between his catch-up and his save.
  s.ryan.use(); s.ryan.edit(doc => { doc.steps.second.purpose = 'Ryan: returns the second text.'; });
  const outbox = new Outbox(s.ryan.client, { write: () => {} });
  const side = await prepareVersion(s.ryan.client, outbox, s.ryan.file);
  await outbox.drain();
  expect(s.server.versions.get(side.version_id)).toMatchObject({ parent: first });
  expect(s.server.current.get(s.id)).toBe(hers);
  expect(savedLine(s.ryan.client, outbox, side)).toBe("Saved beside Gráinne's newer version; your next run combines them.");
  // The next run combines the side version with Gráinne's, and its save names both.
  await s.ryan.run();
  expect(s.text()).toContain("Updated to Gráinne's version");
  const combined = s.server.current.get(s.id)!;
  expect(s.server.versions.get(combined)).toMatchObject({ parent: hers, merged: side.version_id });
  expect(methodContent(readDocument(s.ryan.file)).steps).toMatchObject({ first: { purpose: 'Gráinne: returns the first text.' }, second: { purpose: 'Ryan: returns the second text.' } });
}, 60_000);

it('a file that came without method get combines on the saved version nearest to it', async () => {
  const s = await shared();
  // Ryan adds a step and saves. Gráinne's copy has no record of a version on her computer: its base is version 1.
  s.ryan.use(); s.ryan.edit(doc => { doc.steps.third = step('third.mjs', 'c'); doc.result.c = 'c'; }); s.ryan.script('third.mjs', 'c', 'C');
  await s.ryan.run();
  s.grainne.use(); rmSync(join(s.root, 'gráinne', 'cache', 'versions'), { recursive: true, force: true });
  s.grainne.edit(doc => { doc.steps.extra = step('extra.mjs', 'e'); doc.result.e = 'e'; }); s.grainne.script('extra.mjs', 'e', 'E');
  // The result map changed on both sides in different ways: that is the one conflict.
  await s.grainne.run();
  expect(JSON.parse(s.printed()).conflicts.map((c: any) => c.part)).toEqual(['result']);
  // With the same result on both sides, steps on one side only are kept.
  s.grainne.edit(doc => { doc.result = { a: 'a', b: 'b', c: 'c' }; doc.steps.third = step('third.mjs', 'c'); }); s.grainne.script('third.mjs', 'c', 'C');
  process.exitCode = 0;
  const { summary } = await s.grainne.run();
  expect(summary).toMatchObject({ status: 'completed', result: { a: 'A', b: 'B', c: 'C' } });
  expect(Object.keys(readDocument(s.grainne.file).steps)).toEqual(['first', 'second', 'extra', 'third']);
  expect(fileHash(readFileSync(join(s.grainne.folder, 'third.mjs')))).toBe(fileHash(readFileSync(join(s.ryan.folder, 'third.mjs'))));
}, 60_000);

it('a version saved in an older format combines with a file in the current format: the format is not a change', async () => {
  const s = await shared();
  // An older CLI saved the newest version: format 3.2, a runtime.json in its files, and a new purpose for step first.
  const first = s.server.current.get(s.id)!, v1 = s.server.versions.get(first)!;
  const runtime = new TextEncoder().encode(JSON.stringify({ allow_local_processes: true, runtimes: { node: { command: 'node', version: '20', env: ['HOME'] } } }));
  s.server.blobs.set(fileHash(runtime), runtime);
  const workflow = { ...structuredClone(v1.workflow), format: 'method/3.2', files: ['runtime.json'] };
  workflow.steps.first.purpose = 'Older CLI: returns the first text.';
  s.server.versions.set('version_older', { ...v1, number: 2, parent: first, workflow, package: { ...v1.package, files: [...v1.package.files, { path: 'runtime.json', sha256: fileHash(runtime), size: runtime.length }] } });
  s.server.current.set(s.id, 'version_older');
  // Gráinne's copy has no record of a version, so the base is empty; she already has the same purpose for step first.
  s.grainne.use(); rmSync(join(s.root, 'gráinne', 'cache', 'versions'), { recursive: true, force: true });
  s.grainne.edit(doc => { doc.steps.first.purpose = 'Older CLI: returns the first text.'; });
  const { summary } = await s.grainne.run();
  expect(summary).toMatchObject({ status: 'completed' });
  const doc = readDocument(s.grainne.file);
  expect([doc.format, doc.files, existsSync(join(s.grainne.folder, 'runtime.json'))]).toEqual(['method/3.4', undefined, false]);
}, 60_000);

// ---------- A teammate's first runs: the same run going, a Method by its name, missing keys and files ----------

it('says when the same run is already going, never for other inputs, and sends no inputs hash for a device run', async () => {
  const s = await shared();
  s.ryan.use();
  s.ryan.edit(doc => { doc.inputs = { x: { type: 'number', description: 'A number.', default: 0 } }; });
  await s.ryan.run();
  const version = (await currentVersion(s.ryan.file))!.version_id;
  const sent = [...s.server.runs.values()].at(-1);
  // The run record carries the hash of its inputs.
  const { inputsSha256 } = await import('../../packages/sdk/src/method-sync.js');
  expect(sent.inputs_sha256).toBe(inputsSha256({}));
  s.server.workspaceRuns = [{ id: 'run_g', status: 'running', workflow_version_id: version, inputs_sha256: inputsSha256({}), started_by: 'Gráinne', created_at: new Date(Date.now() - 12 * 60_000).toISOString() }];
  await s.ryan.run();
  expect(s.text()).toMatch(/^Gráinne started this same run 12 minutes ago: [^ ]+\/runs\/run_g\. This run starts too\.$/m);
  // Other inputs: no line.
  writeFileSync(join(s.root, 'inputs.json'), JSON.stringify({ x: 1 }));
  await s.ryan.run('--inputs', join(s.root, 'inputs.json'));
  expect(s.text()).not.toContain('same run');
  // A Method whose run content stays on devices sends no hash and asks nothing.
  s.ryan.edit(doc => { doc.run_data = 'device'; });
  s.server.log.length = 0;
  await s.ryan.run();
  expect(s.server.log.filter(line => line.startsWith('GET /api/workspace/runs'))).toEqual([]);
  expect([...s.server.runs.values()].at(-1).inputs_sha256).toBeUndefined();
}, 60_000);

it('method run NAME runs the newest version of the Method with that name; an unclear name lists the matches', async () => {
  const s = await shared();
  s.server.workflows = [{ id: s.id, name: 'Two', archived_at: null }, { id: 'wf_' + 'c'.repeat(32), name: 'Other', archived_at: null }];
  s.grainne.use();
  s.server.log.length = 0;
  await methodMain(['run', 'two', '--run-dir', join(s.root, 'by-name')]);
  expect(s.server.log).toContain(`GET /api/cli/methods/${s.id}`);
  expect(JSON.parse(readFileSync(join(s.root, 'by-name', 'summary.json'), 'utf8'))).toMatchObject({ status: 'completed', result: { a: 'A', b: 'B' } });
  // Two Methods with the name: no run, the names and IDs, exit code 2.
  s.server.workflows.push({ id: 'wf_' + 'd'.repeat(32), name: 'TWO', archived_at: null });
  s.out.length = 0; s.server.log.length = 0;
  await methodMain(['run', 'Two']);
  expect(process.exitCode).toBe(2);
  expect(JSON.parse(s.printed())).toEqual({ status: 'needs_you', message: expect.stringContaining('2 Methods are named "Two"'), matches: [{ name: 'Two', id: s.id }, { name: 'TWO', id: 'wf_' + 'd'.repeat(32) }] });
  expect(s.server.log.filter(line => line.startsWith('GET /api/cli/methods/'))).toEqual([]);
  // No such name and no such Method: a clear error.
  process.exitCode = 0;
  await expect(methodMain(['run', 'Nothing here'])).rejects.toThrow('No Method named "Nothing here" in your workspace');
}, 60_000);

it('lists every key that is not on this computer before the first step, and names a missing file and who saved the version', async () => {
  const s = await shared();
  vi.stubEnv('HOME', join(s.root, 'gráinne'));
  // Ryan's version reads a file that is not saved in the Method.
  s.ryan.use();
  writeFileSync(join(s.ryan.folder, 'first.mjs'), `import {readFileSync} from 'node:fs'; for await (const c of process.stdin) {}; console.log(JSON.stringify({a: readFileSync('capture/pages.json', 'utf8')}));`);
  await s.ryan.run();
  await s.grainne.get(s.id);
  const { summary } = await s.grainne.run();
  expect(summary.failure).toMatchObject({ owner: 'setup', headline: 'This Method reads capture/pages.json. It is not on this computer and is not saved in the Method. Ask Ryan (who saved this version) for it.' });
  expect(s.text()).toContain('Failed: This Method reads capture/pages.json.');
  // Keys that the Method declares and this computer lacks: one list, each with its command, before the first step.
  s.grainne.edit(doc => { doc.secrets = { ARCHIVE_TOKEN: 'The archive key.', MAIL_KEY: 'The mail key.' }; });
  await expect(s.grainne.run()).rejects.toMatchObject({ code: 'missing_secret', message: 'This Method needs keys that are not on this computer: ARCHIVE_TOKEN, MAIL_KEY. Run `method secret set ARCHIVE_TOKEN`, then `method secret set MAIL_KEY`' });
  expect([...s.server.runs.values()].at(-1).inspection).toMatchObject({ status: 'failed', failure: { owner: 'setup', code: 'missing_secret' } });
}, 60_000);

it('names a missing file from a Python FileNotFoundError too, and leaves other failures as they are', () => {
  const failure = { owner: 'method_code', code: 'process_failed', headline: 'In step "Read", the script exited with code 1.', next: { action: 'fix_method', text: 'x' }, details: 'exit 1',
    diagnostics: "Traceback (most recent call last):\nFileNotFoundError: [Errno 2] No such file or directory: 'capture/pages.json'" };
  expect(missingFileFailure(failure, '/work/m/m.method', null)).toMatchObject({ owner: 'setup', headline: 'This Method reads capture/pages.json. It is not on this computer and is not saved in the Method.' });
  expect(missingFileFailure({ ...failure, diagnostics: "Error: ENOENT: no such file or directory, open '/work/m/data/x.csv'" }, '/work/m/m.method', 'Ryan').headline).toBe('This Method reads data/x.csv. It is not on this computer and is not saved in the Method. Ask Ryan (who saved this version) for it.');
  const other = { ...failure, diagnostics: 'TypeError: x is undefined' };
  expect(missingFileFailure(other, '/work/m/m.method', 'Ryan')).toBe(other);
});
