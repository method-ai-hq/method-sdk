import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@withmethod/runtime/cases.js', async original => ({ ...await original<any>(), outcomeOfRun: vi.fn(async () => ({ status: 'completed', result: 'Thanks.', outputs: {} })) }));
const { watchRun, watchedCorrections } = await import('../../packages/sdk/src/watch.js');
const { saveOutcome, unshownLines } = await import('../../packages/sdk/src/fix-outcomes.js');
const { correctionCaseId } = await import('../../packages/sdk/src/improve.js');

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const METHOD_ID = 'wf_' + '3'.repeat(32);

it('after a run, judges its output against each recently fixed correction, sends held, and says so when the account reopens a problem that came back on 2 runs', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'method-watch-'))); roots.push(root);
  vi.stubEnv('METHOD_CACHE_DIR', join(root, 'cache'));
  const folder = join(root, 'project'); mkdirSync(folder);
  const file = join(folder, 'reply.method');
  writeFileSync(file, JSON.stringify({ format: 'method/3.4', id: METHOD_ID, name: 'Reply', goal: 'Reply.', steps: {}, result: 'reply' }));
  const fixed = 'jdg_' + '1'.repeat(32), old = 'jdg_' + '2'.repeat(32), other = 'jdg_' + '3'.repeat(32);
  for (const j of [fixed, old, other]) {
    mkdirSync(join(folder, 'cases', correctionCaseId(j)), { recursive: true });
    writeFileSync(join(folder, 'cases', correctionCaseId(j), 'case.json'), JSON.stringify({ id: correctionCaseId(j), note: 'it is not even redlined', expect: [{ kind: 'rubric', ref: 'result', criteria: [{ id: 'c1', text: 'Redlined.' }] }] }));
  }
  saveOutcome(METHOD_ID, file, { id: fixed, outcome: 'fixed', summary: 'replies are redlined' });
  saveOutcome(METHOD_ID, file, { id: other, outcome: 'no_fix_found' });
  // A fix from 40 days ago is no longer watched.
  saveOutcome(METHOD_ID, file, { id: old, outcome: 'fixed' });
  const record = join(root, 'cache', 'fixes', METHOD_ID, 'outcomes', `${old}.json`), aged = JSON.parse((await import('node:fs')).readFileSync(record, 'utf8'));
  writeFileSync(record, JSON.stringify({ ...aged, finished_at: new Date(Date.now() - 40 * 86_400_000).toISOString() }));
  for (const line of unshownLines(METHOD_ID)) void line;
  expect(watchedCorrections(file).map(w => w.judgment)).toEqual([fixed]);

  const calls: any[] = [];
  // The account reopens the correction when the problem came back on 2 runs.
  const client = { server: 'https://example.test', token: () => 'method_x', async request(path: string, verb = 'GET', body?: any) { calls.push({ path, verb, body }); return { reopened: calls.filter(c => c.body?.held === false).length === 2 }; } } as any;
  const judged: string[] = [];
  const fails = async (expect: any[], _outcome: any, caseDir: string) => { judged.push(caseDir); return { status: expect.length ? 'fail' : 'pass' }; };
  mkdirSync(join(root, 'run-1')); writeFileSync(join(root, 'run-1', 'run-id.json'), JSON.stringify({ id: 'b7e1c0de-0000-4000-8000-000000000001' }));
  expect(await watchRun(client, file, join(root, 'run-1'), fails)).toEqual([{ judgment: fixed, held: false }]);
  expect(calls).toEqual([{ path: `/api/cli/judgments/${fixed}/watch`, verb: 'POST', body: { held: false, run_id: 'b7e1c0de-0000-4000-8000-000000000001' } }]);
  expect(judged).toEqual([join(folder, 'cases', correctionCaseId(fixed))]);
  expect(unshownLines(METHOD_ID)).toEqual([]);
  // The second time the account reopens the correction, and the next run says the problem came back.
  await watchRun(client, file, join(root, 'run-2'), fails);
  expect(calls.slice(1)).toEqual([{ path: `/api/cli/judgments/${fixed}/watch`, verb: 'POST', body: { held: false } }]);
  expect(unshownLines(METHOD_ID)).toEqual(['A problem you corrected came back twice ("it is not even redlined"). I\'ll test a new fix. To go back to how it worked before the last change: method undo.']);
  // A run that holds sends held; a run that cannot show the result is skipped.
  calls.length = 0;
  await watchRun(client, file, join(root, 'run-3'), async () => ({ status: 'pass' }));
  await watchRun(client, file, join(root, 'run-4'), async () => ({ status: 'unverifiable' }));
  expect(calls).toEqual([{ path: `/api/cli/judgments/${fixed}/watch`, verb: 'POST', body: { held: true } }]);
});
