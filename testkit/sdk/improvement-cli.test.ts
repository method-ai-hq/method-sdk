import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeMethod, autoApply, proposalCommand, localProposals } from '../../packages/sdk/src/proposals.js';
import { improveCommand, judgmentsLine } from '../../packages/sdk/src/improve.js';
import { saveLocalJudgment } from '../../packages/sdk/src/local-judgments.js';
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

it('merges a change that Method applied, given its ID, and records it as applied', async () => {
  const base = method({ a: step('a', 'A.'), b: step('b', 'B.') }), proposed = method({ a: step('a', 'A better.'), b: step('b', 'B.') });
  const { file } = setup(base);
  const applied: any[] = [], client = fakeClient(accountRoutes(base, proposed, (await currentVersion(file))!.version_id, applied));
  const out = stdout();
  await proposalCommand(['apply', file, 'prop_1'], () => client);
  const result = printed(out);
  expect(result).toMatchObject({ status: 'applied', proposal_id: 'prop_1', steps: ['a'] });
  expect(methodContent(readDocument(file))).toEqual(proposed);
  expect(readDocument(file).id).toBe(METHOD_ID);
  expect(applied).toEqual([{ version_id: (await currentVersion(file))!.version_id }]);
  expect(result.version_id).toBe(applied[0].version_id);
});

it('auto-applies before a file command: one line for an unchanged file, a merge for a changed file, and the conflict to resolve', async () => {
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
  expect(applied).toEqual([]);
  expect(String(err.mock.calls[0]![0])).toContain('conflicts with your edits of');
  expect(String(err.mock.calls[0]![0])).toContain('in steps.a.');
  expect(String(err.mock.calls[0]![0])).toContain('--resolved');
  // method apply prints both versions and exits 1.
  const out = stdout();
  await proposalCommand(['apply', file, 'prop_1'], () => client);
  expect(printed(out)).toMatchObject({ status: 'conflict', conflicts: [{ path: 'steps.a', ours: step('a', 'A ours.'), theirs: step('a', 'A better.') }] });
  expect(process.exitCode).toBe(1);
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

it('starts nothing for account run data: judgments start fixes', async () => {
  const { file } = setup(method({ a: step('a', 'A.'), b: step('b', 'B.') }));
  const client = fakeClient({ 'GET /api/cli/me': () => ({ organization: { keep_run_content_on_devices: false } }) });
  const out = stdout();
  await improveCommand([file, '--step', 'a', '--note', 'Name the customer.'], () => client, async () => { throw Error('Must not run locally'); });
  expect(out.mock.calls.map(c => String(c[0])).join('')).toBe(`${judgmentsLine}\n`);
  expect(judgmentsLine).toBe('Method fixes this Method from your judgments. Record the person\'s reaction: method judge RUN_ID wrong --note "...".');
  expect(client.calls.map((c: any) => `${c.verb} ${c.path}`)).toEqual(['GET /api/cli/me']);
  expect(process.exitCode ?? 0).toBe(0);
  await expect(improveCommand([file, '--step', 'missing'], () => client)).rejects.toThrow('Step missing is not in');
});

it('improves on this computer when the organization keeps run content on devices', async () => {
  const { file } = setup(method({ a: step('a', 'A.') }));
  const client = fakeClient({ 'GET /api/cli/me': () => ({ organization: { keep_run_content_on_devices: true } }) });
  stdout(); stderr();
  // The local flow starts: it asks for improve.method, which this fake server does not have.
  await expect(improveCommand([file], () => client, async () => { throw Error('not reached'); })).rejects.toThrow('404: GET /api/cli/improve/method');
});

it('changes lists the changes that Method applied, with cause, date, and version', async () => {
  const { file } = setup(method({ a: step('a', 'A.') }));
  const client = fakeClient({
    [`GET /api/methods/${METHOD_ID}/proposals?status=accepted`]: () => ({ proposals: [
      { id: 'prop_1', status: 'accepted', cause: 'The summary named no customer.', created_at: '2026-10-09T08:00:00Z', published_version_id: 'v_1', evidence: { kind: 'change', steps: ['a'] } },
      { id: 'prop_2', status: 'accepted', cause: 'The date was in the wrong form.', created_at: '2026-10-12T08:00:00Z', published_version_id: 'v_2', evidence: { kind: 'change', steps: ['a'] } }] }),
  });
  const out = stdout();
  await proposalCommand(['changes', file], () => client);
  expect(out.mock.calls.map(c => String(c[0])).join('')).toBe('2026-10-12  v_2  The date was in the wrong form.\n2026-10-09  v_1  The summary named no customer.\n');
  out.mockClear();
  await proposalCommand(['changes', file, '--json'], () => client);
  expect(printed(out).changes[0]).toEqual({ id: 'prop_2', source: 'account', cause: 'The date was in the wrong form.', date: '2026-10-12T08:00:00Z', version_id: 'v_2', steps: ['a'] });
  const none = fakeClient({ [`GET /api/methods/${METHOD_ID}/proposals?status=accepted`]: () => ({ proposals: [] }) });
  out.mockClear();
  await proposalCommand(['changes', file], () => none);
  expect(out.mock.calls.map(c => String(c[0])).join('')).toBe(`Method has not changed ${file} yet.\n`);
  // method proposals is gone.
  await expect(proposalCommand(['proposals', file], () => client)).rejects.toThrow();
});

it('runs improve.method on this computer for device run data and saves a local proposal', async () => {
  const document = method({ a: step('a', 'A.'), b: step('b', 'B.') }, { run_data: 'device' });
  const { file, root, folder } = setup(document);
  const script = new TextEncoder().encode('print("improve")\n');
  const sha256 = createHash('sha256').update(script).digest('hex');
  const improveWorkflow = method({ a: step('a', 'Improve.') });
  const files = [{ path: 'improve.py', sha256, size: script.length }];
  const pack = { schema: 'method-package/1', runtime: runtimeVersion, files, digest: packageDigest(improveWorkflow, { runtime: runtimeVersion, files }) };
  const versionId = 'v_' + 'b'.repeat(32);
  const client = fakeClient({
    'GET /api/cli/improve/method': () => ({ workflow_id: `wf_${'c'.repeat(32)}`, version_id: versionId, workflow: improveWorkflow, package: pack }),
    [`GET /api/cli/improve/files/${sha256}`]: () => script,
  });
  const proposed = method({ a: step('a', 'A better.'), b: step('b', 'B.') }, { run_data: 'device' });
  const run = vi.fn(async (improveFile: string, flags: any, sync: unknown, _event: unknown, given: unknown, _base: unknown, secrets: Record<string, string>) => {
    expect(improveFile).toBe(join(root, 'cache', 'improve', versionId, 'improve.method'));
    expect(readFileSync(join(root, 'cache', 'improve', versionId, 'improve.py'), 'utf8')).toBe('print("improve")\n');
    expect(JSON.parse(readFileSync(flags.inputs, 'utf8'))).toMatchObject({ method_file: file, note: 'Too long.', judgment_id: '' });
    expect(sync).toBeUndefined(); expect(given).toBe(client);
    // The run gets the signed-in key and server as improve.method's secrets, for this run only.
    expect(secrets).toEqual({ IMPROVE_API_KEY: 'method_x', IMPROVE_SERVER: 'https://example.test' });
    process.stdout.write('{"run":"result"}\n');
    return { status: 'completed', result: { proposal: JSON.stringify({ cause: 'Step a wrote too much.', workflow: proposed, evidence: { kind: 'change', steps: ['a'] } }), kind: 'change', proposal_id: '' } };
  });
  const out = stdout(); stderr();
  await improveCommand([file, '--note', 'Too long.'], () => client, run);
  expect(client.calls.map((c: any) => c.path)).toEqual(['/api/cli/improve/method']);
  const result = printed(out);
  expect(result).toMatchObject({ source: 'local', kind: 'change', cause: 'Step a wrote too much.', steps: ['a'] });
  const saved = JSON.parse(readFileSync(result.proposal_file, 'utf8'));
  expect(result.proposal_file).toBe(join(folder, '.method', 'proposals', `${result.proposal_id}.json`));
  expect(statSync(result.proposal_file).mode & 0o777).toBe(0o600);
  expect(saved).toMatchObject({ status: 'open', base_version_id: (await currentVersion(file))!.version_id, proposed_workflow: proposed, base_workflow: document });
  expect(readFileSync(join(folder, '.method', '.gitignore'), 'utf8')).toBe('*\n');
  // The file is unchanged until method apply; local apply marks the proposal file applied and sends nothing.
  expect(methodContent(readDocument(file))).toEqual(document);
  out.mockClear();
  const offline = fakeClient({}, null as any);
  await proposalCommand(['apply', file, result.proposal_id], () => offline);
  expect(printed(out)).toMatchObject({ status: 'applied', steps: ['a'] });
  expect(methodContent(readDocument(file))).toEqual(proposed);
  expect(localProposals(file)[0]).toMatchObject({ status: 'applied' });
  expect(offline.request).not.toHaveBeenCalled();
  // A second improve reuses the cached files.
  await improveCommand([file], () => client, run.mockImplementationOnce(async () => ({ status: 'completed', result: { proposal: JSON.stringify({ cause: 'No change.', evidence: { kind: 'none' } }), kind: 'none', proposal_id: '' } })));
  expect(client.transfer).toHaveBeenCalledTimes(1);
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

it('reads the result that improve.method records: the proposal as JSON text, its kind, and the proposal ID', async () => {
  const { readImproveResult } = await import('../../packages/sdk/src/improve.js');
  // Recorded from `method improve` on the tiny fixture of improve.method, against a fake Method server.
  const recorded = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'improve-result.json'), 'utf8'));
  expect(Object.keys(recorded).sort()).toEqual(['kind', 'proposal', 'proposal_id']);
  const read = readImproveResult(recorded);
  expect(read).toMatchObject({ workflow: null, evidence: { kind: 'none', steps: ['summarize'] } });
  expect(read.cause).toMatch(/^No safe change was found\./);
  expect(read.evidence.budget).toMatchObject({ model_calls: expect.any(Number) });
  // A change carries the tested workflow; none has none. Other kinds are refused.
  const as = (kind: string, extra: object, workflow?: unknown) => ({ kind, proposal_id: '', proposal: JSON.stringify({ cause: 'c', ...(workflow ? { workflow } : {}), evidence: { kind, steps: ['a'], ...extra } }) });
  expect(readImproveResult(as('change', {}, { steps: {} })).workflow).toEqual({ steps: {} });
  expect(() => readImproveResult(as('change', {}))).toThrow();
  expect(() => readImproveResult(as('case', {}))).toThrow();
  expect(() => readImproveResult({ ...as('none', {}), kind: 'change' })).toThrow();
});

/** A finished run folder of the Method in the Method cache, as method run writes it. */
function cachedRun(root: string, name: string, methodId = METHOD_ID) {
  const dir = join(root, 'cache', 'runs', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'method.json'), JSON.stringify({ format: 'method/3.4', id: methodId, name: 'Echo', run_data: 'device' }));
  writeFileSync(join(dir, 'checkpoint.json'), '{}');
  writeFileSync(join(dir, 'events.jsonl'), '');
  return dir;
}

it('gives improve.method every judgment kept on this computer, their run folders first, and the note', async () => {
  const document = method({ a: step('a', 'A.'), b: step('b', 'B.') }, { run_data: 'device' });
  const { file, root, folder } = setup(document);
  const judged = cachedRun(root, 'aaaaaaaa-0000-4000-8000-000000000001'), newer = cachedRun(root, 'aaaaaaaa-0000-4000-8000-000000000002');
  cachedRun(root, 'aaaaaaaa-0000-4000-8000-000000000003', `wf_${'d'.repeat(32)}`);
  utimesSync(join(judged, 'checkpoint.json'), new Date('2026-10-01'), new Date('2026-10-01'));
  const base = { account_run_id: 'run_x', method_id: METHOD_ID, file: 'task.method', step_id: null, created_at: '2026-10-15T10:00:00Z' };
  saveLocalJudgment(file, { ...base, id: 'jdg_1', run_id: '037a667b-e45d-4461-a319-edc2dc0f64c2', run_dir: judged, verdict: 'wrong', note: 'You missed the non-compete.', corrected: { escalate: ['x'] } });
  saveLocalJudgment(file, { ...base, id: 'jdg_2', run_id: 'run_91ce', run_dir: newer, verdict: 'right', note: null });
  // A judgment of another Method file in the same folder is not used.
  saveLocalJudgment(file, { ...base, id: 'jdg_3', file: 'other.method', run_id: 'r', run_dir: newer, verdict: 'wrong', note: 'Other.' });
  vi.stubEnv('METHOD_IMPROVE_METHOD', join(folder, 'improve.method'));
  writeFileSync(join(folder, 'improve.method'), '{}');
  const client = fakeClient({});
  let given: any, judgments: any;
  const run = vi.fn(async (improveFile: string, flags: any) => {
    // The developer override runs the local improve.method from its own folder; nothing is downloaded.
    expect(improveFile).toBe(join(folder, 'improve.method')); expect(flags.workspace).toBe(folder);
    given = JSON.parse(readFileSync(flags.inputs, 'utf8'));
    if (given.judgments_file) { judgments = JSON.parse(readFileSync(given.judgments_file, 'utf8')); expect(statSync(given.judgments_file).mode & 0o777).toBe(0o600); }
    return { status: 'completed', result: { proposal: JSON.stringify({ cause: 'No change.', evidence: { kind: 'none' } }), kind: 'none', proposal_id: '' } };
  });
  stdout(); stderr();
  await improveCommand([file, '--note', 'Escalate restrictions.'], () => client, run);
  expect(client.calls).toEqual([]);
  expect(given).toMatchObject({ method_file: file, note: 'Escalate restrictions.', run_id: newer, run_folders: [judged, newer] });
  expect(judgments).toEqual([
    { id: 'jdg_1', run_id: '037a667b-e45d-4461-a319-edc2dc0f64c2', run_dir: judged, step_id: null, verdict: 'wrong', note: 'You missed the non-compete.', corrected: { escalate: ['x'] }, created_at: '2026-10-15T10:00:00Z' },
    { id: 'jdg_2', run_id: 'run_91ce', run_dir: newer, step_id: null, verdict: 'right', note: null, created_at: '2026-10-15T10:00:00Z' }]);
  // Without judgments and a note, the inputs say so.
  rmSync(join(folder, '.method', 'judgments.jsonl'));
  await improveCommand([file], () => client, run);
  expect(given).toMatchObject({ note: '', run_id: '', judgments_file: '', run_folders: [newer, judged] });
  vi.stubEnv('METHOD_IMPROVE_METHOD', join(folder, 'missing.method'));
  await expect(improveCommand([file], () => client, run)).rejects.toThrow('METHOD_IMPROVE_METHOD names');
});
