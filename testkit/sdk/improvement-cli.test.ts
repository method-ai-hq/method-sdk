import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mergeMethod, autoApply, changesMain } from '../../packages/sdk/src/proposals.js';
import { methodMain } from '../../packages/sdk/src/method.js';
import { placementFlags, publishWithPlacement } from '../../packages/sdk/src/cloud.js';
import { buildPackage, runtimeVersion } from '../../packages/sdk/src/method-files.js';
import { currentVersion, methodContent, writeMethodId } from '../../packages/sdk/src/versions.js';
import { readDocument } from '../../packages/sdk/src/authoring.js';
import { packageDigest } from '../../packages/contracts/src/method-package.js';
import { loadWorkflow } from '../../packages/workflow-language/src/validate.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const METHOD_ID = `wf_${'a'.repeat(32)}`;
const step = (id: string, purpose: string) => ({ name: 'Echo', purpose, do: { kind: 'run', runtime: 'node', entrypoint: 'echo.mjs' }, out: { [`${id}_text`]: { type: 'text', description: 'The text.' } } });
const method = (steps: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ format: 'method/3.4', name: 'Echo', goal: 'Return a fixed text.', ...extra, steps, result: 'a_text' });

function setup(document: any, id: string | null = METHOD_ID) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'method-improve-'))); roots.push(root);
  vi.stubEnv('METHOD_CACHE_DIR', join(root, 'cache')); vi.stubEnv('METHOD_CONFIG_DIR', join(root, 'config'));
  const folder = join(root, 'project'); mkdirSync(folder);
  const file = join(folder, 'task.method');
  writeFileSync(file, JSON.stringify(document, null, 2) + '\n');
  writeFileSync(join(folder, 'echo.mjs'), 'console.log(JSON.stringify({text: "hi"}));\n');
  if (id) writeMethodId(file, id);
  return { root, folder, file };
}
const stderr = () => vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
const stdout = () => vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
const printed = (spy: ReturnType<typeof stdout>) => JSON.parse(spy.mock.calls.map(c => String(c[0])).join(''));
function fakeClient(routes: Record<string, (body: any) => any>, token = 'method_x') {
  const calls: { path: string; verb: string; body: any }[] = [];
  return { calls, server: 'https://example.test', token: () => token, login: vi.fn(async () => {}),
    request: vi.fn(async (path: string, verb = 'GET', body?: unknown) => {
      calls.push({ path, verb, body });
      const route = routes[`${verb} ${path}`];
      if (!route) throw Object.assign(Error(`404: ${verb} ${path}`), { status: 404, code: 'not_found' });
      return route(body);
    }),
    transfer: vi.fn(async (path: string) => { const route = routes[`GET ${path}`]; if (!route) throw Error(`404: ${path}`); return route(undefined); }) } as any;
}

it('merges per step and per top-level key, or lists the conflicts', () => {
  const base = method({ a: step('a', 'A.'), b: step('b', 'B.') });
  // Only theirs changed a step: take it.
  expect(mergeMethod(base, base, method({ a: step('a', 'A2.'), b: step('b', 'B.') }))).toEqual({ clean: true, workflow: method({ a: step('a', 'A2.'), b: step('b', 'B.') }) });
  // Only ours changed: keep ours.
  const ours = method({ a: step('a', 'A.'), b: step('b', 'B ours.') });
  expect(mergeMethod(base, ours, base)).toEqual({ clean: true, workflow: ours });
  // Different steps on each side: both changes, in the order of ours; a new step of theirs goes after its neighbour.
  const theirs = { ...method({ a: step('a', 'A2.'), n: step('n', 'New.'), b: step('b', 'B.') }), goal: 'A better goal.' };
  const merged = mergeMethod(base, ours, theirs) as any;
  expect(merged.clean).toBe(true);
  expect(Object.keys(merged.workflow.steps)).toEqual(['a', 'n', 'b']);
  expect(merged.workflow.steps.a.purpose).toBe('A2.'); expect(merged.workflow.steps.b.purpose).toBe('B ours.');
  expect(merged.workflow.goal).toBe('A better goal.');
  // A step removed by theirs and unchanged in ours goes.
  expect((mergeMethod(base, { ...base, name: 'Ours' }, method({ a: step('a', 'A.') })) as any).workflow.steps).toEqual({ a: step('a', 'A.') });
  // The same step and the same top-level key changed in different ways: conflicts.
  const conflict = mergeMethod(base, { ...ours, name: 'Ours' }, { ...method({ a: step('a', 'A.'), b: step('b', 'B theirs.') }), name: 'Theirs' });
  expect(conflict).toEqual({ clean: false, conflicts: [
    { path: 'name', base: 'Echo', ours: 'Ours', theirs: 'Theirs' },
    { path: 'steps.b', base: step('b', 'B.'), ours: step('b', 'B ours.'), theirs: step('b', 'B theirs.') },
  ] });
});

function accountRoutes(base: any, proposed: any, baseVersion: string, applied: any[]) {
  return {
    [`GET /api/methods/${METHOD_ID}/proposals?status=accepted`]: () => ({ proposals: [{ id: 'prop_1', status: 'accepted', created_at: '2026-10-09T00:00:00Z' }] }),
    'GET /api/proposals/prop_1': () => ({ proposal: { id: 'prop_1', method_id: METHOD_ID, base_version_id: baseVersion, status: 'accepted', cause: 'The summary named no customer.', evidence: { kind: 'change', steps: ['a'] }, created_at: '2026-10-09T00:00:00Z', base_workflow: base, proposed_workflow: proposed } }),
    'POST /api/proposals/prop_1/applied': (body: any) => { applied.push(body); return { proposal: { id: 'prop_1', status: 'applied' } }; },
  };
}

it('auto-applies a change made in the account before a file command: one line, a merge, or the conflict saved for the agent to merge', async () => {
  const base = method({ a: step('a', 'A.'), b: step('b', 'B.') }), proposed = method({ a: step('a', 'A better.'), b: step('b', 'B.') });
  // Unchanged file: apply and print one line.
  let { file } = setup(base);
  let applied: any[] = [];
  let client = fakeClient(accountRoutes(base, proposed, (await currentVersion(file))!.version_id, applied));
  let err = stderr();
  await autoApply(['run', file], () => client);
  expect(err.mock.calls.map(call => String(call[0])).join('')).toContain('prop_1');
  expect(methodContent(readDocument(file))).toEqual(proposed);
  expect(applied).toHaveLength(1);
  vi.restoreAllMocks();
  // Changed in another step: the merge keeps both changes.
  ({ file } = setup(method({ a: step('a', 'A.'), b: step('b', 'B ours.') })));
  applied = []; client = fakeClient(accountRoutes(base, proposed, 'v_' + '0'.repeat(32), applied));
  err = stderr();
  await autoApply(['test', file], () => client);
  expect(methodContent(readDocument(file))).toEqual(method({ a: step('a', 'A better.'), b: step('b', 'B ours.') }));
  expect(err).toHaveBeenCalled();
  vi.restoreAllMocks();
  // Changed in the same step: the file stays, and the line says what to resolve.
  const ours = method({ a: step('a', 'A ours.'), b: step('b', 'B.') });
  ({ file } = setup(ours));
  applied = []; client = fakeClient(accountRoutes(base, proposed, 'v_' + '0'.repeat(32), applied));
  err = stderr();
  await autoApply(['check', file], () => client);
  expect(methodContent(readDocument(file))).toEqual(ours);
  const line = String(err.mock.calls[0]![0]);
  expect(line).toContain('conflicts with your edits of');
  expect(line).toContain('in steps.a.');
  expect(line).not.toContain('method apply');
  // Both versions of each part are saved for the agent to merge, and the change is not merged again.
  const saved = JSON.parse(readFileSync(join(dirname(file), '.method', 'conflict-prop_1.json'), 'utf8'));
  expect(saved.conflicts).toEqual([{ path: 'steps.a', base: step('a', 'A.'), ours: step('a', 'A ours.'), theirs: step('a', 'A better.') }]);
  expect(statSync(join(dirname(file), '.method', 'conflict-prop_1.json')).mode & 0o777).toBe(0o600);
  expect(applied).toHaveLength(1);
});

it('skips auto-apply silently when signed out, offline, or without an id: line', async () => {
  const base = method({ a: step('a', 'A.'), b: step('b', 'B.') });
  const { file } = setup(base);
  const err = stderr();
  const signedOut = fakeClient({}, null as any);
  await autoApply(['run', file], () => signedOut);
  expect(signedOut.request).not.toHaveBeenCalled();
  const offline = fakeClient({}); offline.request.mockRejectedValue(new TypeError('fetch failed'));
  await autoApply(['run', file], () => offline);
  await autoApply(['run', file], () => { throw Error('No client'); });
  const { file: plain } = setup(base, null);
  const noId = fakeClient({});
  await autoApply(['run', plain], () => noId);
  expect(noId.request).not.toHaveBeenCalled();
  expect(err).not.toHaveBeenCalled();
  expect(methodContent(readDocument(file))).toEqual(base);
});

it('sets the placement after a publish with --cloud or --workers', async () => {
  expect(placementFlags(['--reason', 'x'])).toBeUndefined();
  expect(placementFlags(['--cloud'])).toEqual({ placement: 'cloud', environment: 'production' });
  expect(placementFlags(['--workers', '--env', 'staging'])).toEqual({ placement: 'workers', environment: 'staging' });
  expect(() => placementFlags(['--cloud', '--workers'])).toThrow('not both');
  const client = fakeClient({ [`PUT /api/methods/${METHOD_ID}/placements/staging`]: body => ({ environment: 'staging', placement: body.placement, updated_at: '2026-10-09T00:00:00Z' }) });
  const publish = vi.fn(async () => ({ workflow_id: METHOD_ID, version_id: 'v_1' }));
  expect(await publishWithPlacement(client, ['--cloud', '--env=staging'], publish)).toEqual({ workflow_id: METHOD_ID, version_id: 'v_1', placement: { environment: 'staging', placement: 'cloud' } });
  expect(client.calls).toEqual([{ path: `/api/methods/${METHOD_ID}/placements/staging`, verb: 'PUT', body: { placement: 'cloud' } }]);
  // Bad flags stop before the publish.
  publish.mockClear();
  await expect(publishWithPlacement(client, ['--cloud', '--workers'], publish)).rejects.toThrow();
  expect(publish).not.toHaveBeenCalled();
  // Not enabled: the version stays published, and the result says why.
  const denied = fakeClient({}); denied.request.mockRejectedValue(Object.assign(Error('403: Method Cloud is not enabled.'), { code: 'cloud_not_enabled' }));
  expect(await publishWithPlacement(denied, ['--cloud'], publish)).toMatchObject({ version_id: 'v_1', placement: { environment: 'production', error: expect.stringContaining('not on for your organization') } });
  expect(process.exitCode).toBe(1);
});

it('changes lists the changes that Method applied, with cause, date, and version', async () => {
  const { file } = setup(method({ a: step('a', 'A.') }));
  const client = fakeClient({
    [`GET /api/methods/${METHOD_ID}/proposals?status=accepted`]: () => ({ proposals: [
      { id: 'prop_1', status: 'accepted', cause: 'The summary named no customer.', created_at: '2026-10-09T08:00:00Z', published_version_id: 'v_1', evidence: { kind: 'change', steps: ['a'] } },
      { id: 'prop_2', status: 'accepted', cause: 'The date was in the wrong form.', created_at: '2026-10-12T08:00:00Z', published_version_id: 'v_2', evidence: { kind: 'change', steps: ['a'] } }] }),
  });
  const out = stdout();
  await changesMain([file], () => client);
  expect(out.mock.calls.map(c => String(c[0])).join('')).toBe('2026-10-12  v_2  The date was in the wrong form.\n2026-10-09  v_1  The summary named no customer.\n');
  out.mockClear();
  await changesMain([file, '--json'], () => client);
  expect(printed(out).changes[0]).toEqual({ id: 'prop_2', source: 'account', cause: 'The date was in the wrong form.', date: '2026-10-12T08:00:00Z', version_id: 'v_2', steps: ['a'] });
  const none = fakeClient({ [`GET /api/methods/${METHOD_ID}/proposals?status=accepted`]: () => ({ proposals: [] }) });
  out.mockClear();
  await changesMain([file], () => none);
  expect(out.mock.calls.map(c => String(c[0])).join('')).toBe(`Method has not changed ${file} yet.\n`);
  // method improve, method apply, and method proposals are gone.
  for (const command of ['improve', 'apply', 'proposals']) await expect(methodMain([command, file], () => client)).rejects.toThrow(/Usage|method COMMAND|Learn:/);
});

it('saves the cases folder with the version for account run data only', async () => {
  const { file, folder } = setup(method({ a: step('a', 'A.'), b: step('b', 'B.') }));
  mkdirSync(join(folder, 'cases', 'late-order'), { recursive: true });
  writeFileSync(join(folder, 'cases', 'late-order', 'case.json'), '{}');
  writeFileSync(join(folder, 'cases', '.hidden'), 'x');
  // A file over the 20 MB package limit is named, not dropped silently.
  writeFileSync(join(folder, 'cases', 'large.bin'), ''); truncateSync(join(folder, 'cases', 'large.bin'), 20_000_001);
  const account = await buildPackage(file, loadWorkflow(methodContent(readDocument(file))));
  expect(account.pack.files.map(f => f.path)).toEqual(['cases/late-order/case.json', 'echo.mjs']);
  expect(account.tooLarge).toEqual(['cases/large.bin']);
  const device = await buildPackage(file, { ...loadWorkflow(methodContent(readDocument(file))), run_data: 'device' });
  expect(device.pack.files.map(f => f.path)).toEqual(['echo.mjs']);
});

it('reads the result that improve.method records: the proposal as JSON text, its kind, the proposal ID, and what was capped', async () => {
  const { readImproveResult } = await import('../../packages/sdk/src/improve.js');
  // The form of improve.method's result on the tiny fixture when no candidate fixes the corrected run, on a subscription.
  const recorded = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'improve-result.json'), 'utf8'));
  expect(Object.keys(recorded).sort()).toEqual(['capped', 'kind', 'proposal', 'proposal_id']);
  const read = readImproveResult(recorded);
  expect(read).toMatchObject({ workflow: null, files: [], capped: '', evidence: { kind: 'none', steps: ['summarize'] } });
  expect(read.cause).toMatch(/^No safe change was found\./);
  expect(read.evidence.budget).toEqual({ model_calls: 12, usd: null, minutes: 0.03 });
  // A change carries the tested workflow; none has none. Other kinds are refused.
  const as = (kind: string, extra: object, workflow?: unknown) => ({ kind, proposal_id: '', proposal: JSON.stringify({ cause: 'c', ...(workflow ? { workflow } : {}), evidence: { kind, steps: ['a'], ...extra } }) });
  expect(readImproveResult(as('change', {}, { steps: {} })).workflow).toEqual({ steps: {} });
  expect(() => readImproveResult(as('change', {}))).toThrow();
  expect(() => readImproveResult(as('case', {}))).toThrow();
  expect(() => readImproveResult({ ...as('none', {}), kind: 'change' })).toThrow();
});
