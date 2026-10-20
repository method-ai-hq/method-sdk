import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { changesMain } from '../../packages/sdk/src/proposals.js';
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

it('reads the result that improve.method returns: the proposal as JSON text, its kind, the outcomes as JSON text, the background cases, and the summary', async () => {
  const { readImproveResult, loopOutcome } = await import('../../packages/sdk/src/improve.js');
  // The form of apply_change's result (apps/improve/steps/apply-change.mjs) when no candidate fixes the corrected run.
  const recorded = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'improve-result.json'), 'utf8'));
  expect(Object.keys(recorded).sort()).toEqual(['background_cases', 'kind', 'outcomes', 'proposal', 'proposal_id', 'summary']);
  const read = readImproveResult(recorded);
  expect(read).toMatchObject({ workflow: null, files: [], capped: '', evidence: { kind: 'none' }, background_cases: [], outcomes: [{ id: 'jdg_' + 'a'.repeat(32), outcome: 'no_fix_found' }] });
  expect(read.cause).toMatch(/^I tried 3 changes/);
  expect(read.evidence.budget).toEqual({ model_calls: 12, usd: null, minutes: 0.03 });
  // A change carries the tested workflow; none has none. Other kinds are refused.
  const as = (kind: string, extra: object, workflow?: unknown, outcomes: unknown = [{ id: 'jdg_1', outcome: 'fixed' }], more: object = {}) => ({ kind, proposal_id: '',
    proposal: JSON.stringify({ cause: 'c', ...(workflow ? { workflow } : {}), evidence: { kind, steps: ['a'], ...extra } }), ...(outcomes === null ? {} : { outcomes: JSON.stringify(outcomes) }), ...more });
  expect(readImproveResult(as('change', {}, { steps: {} }, undefined, { background_cases: ['a', 'a', 'b'], summary: ' Fixed it. ' }))).toMatchObject({ workflow: { steps: {} }, outcomes: [{ id: 'jdg_1', outcome: 'fixed' }], background_cases: ['a', 'b'], summary: 'Fixed it.' });
  // Each correction needs an outcome the account knows; a pruning sweep has none, and its summary says what it did.
  expect(() => readImproveResult(as('none', {}, undefined, null))).toThrow('no outcome for each correction');
  expect(() => readImproveResult(as('none', {}, undefined, [{ id: 'jdg_1', outcome: 'no_change' }]))).toThrow('no outcome for each correction');
  const pruned = readImproveResult(as('change', {}, { steps: {} }, null, { background_cases: [], summary: 'Removed 2 rules that no longer changed any result.' }), { prune: true });
  expect(pruned).toMatchObject({ outcomes: [], summary: 'Removed 2 rules that no longer changed any result.' });
  expect(() => readImproveResult(as('change', {}))).toThrow();
  expect(() => readImproveResult(as('case', {}))).toThrow();
  expect(() => readImproveResult({ ...as('none', {}), kind: 'change' })).toThrow();
  // The loop's fields become the words of the lines: a fixed detail says what is different now; tests give how often.
  expect(loopOutcome({ id: 'jdg_1', outcome: 'fixed', detail: 'replies now include the redline', step_id: 'write', kind: 'rule',
    tests: { case: 'c', base: { passes: 0, runs: 2 }, candidate: { passes: 3, runs: 3 }, guards: [{ id: 'g1', before: 'pass', after: 'pass' }, { id: 'g2', before: 'pass', after: 'pass' }] }, background_cases: ['x'] }))
    .toEqual({ id: 'jdg_1', outcome: 'fixed', summary: 'replies now include the redline', tested: { times: 3, earlier: 2 } });
  expect(loopOutcome({ id: 'jdg_1', outcome: 'could_not_test', reason: 'can_send', detail: 'I added the note as a rule and will check it on the next runs.', learned_rule: 'lr_0123456789ab' }))
    .toEqual({ id: 'jdg_1', outcome: 'could_not_test', reason: 'can_send', detail: 'I added the note as a rule and will check it on the next runs.', rule_added: true });
  expect(loopOutcome({ id: 'jdg_1', outcome: 'held', held_with: 'Gráinne', detail: 'A fix for this breaks a result that Gráinne asked for.' })).toEqual({ id: 'jdg_1', outcome: 'held', by: 'Gráinne' });
  expect(loopOutcome({ id: 'jdg_1', outcome: 'no_fix_found', again: true, detail: 'Another fix changed the same step.' })).toMatchObject({ outcome: 'no_fix_found', again: true });
  expect(loopOutcome({ id: 'jdg_1', outcome: 'question', question: 'Which one?' })).toEqual({ id: 'jdg_1', outcome: 'question', question: 'Which one?' });
});
