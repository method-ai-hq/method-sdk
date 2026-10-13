import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCurrentFile } from '../../packages/sdk/src/current-runtime.js';
import { inspectCurrentRun } from '../../packages/sdk/src/current-inspection.js';
import { waitForRun } from '../../packages/sdk/src/run-worker.js';
import { setupFailure, failureLines, unreadableRecord } from '../../packages/sdk/src/failure.js';
import { ownerText, FailureSchema } from '../../packages/workflow-language/src/inspection.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const method = { format: 'method/3.3', name: 'Search', goal: 'Search each topic.', inputs: { topics: { type: 'list', items: 'text', description: 'Topics.' } },
  steps: { search: { name: 'Search the web', purpose: 'Returns a note for each topic.', each: { topic: 'inputs.topics' }, do: { kind: 'run', runtime: 'node', entrypoint: 'search.mjs' }, out: { note: { type: 'text', description: 'The note.' } } } },
  result: 'note' };
const failure = { owner: 'agent_work', code: 'check_failed', headline: 'The check Sources open did not pass in task 2 of 3.', step: 'search', step_name: 'Search the web',
  iteration: 1, failed_iterations: [1], total: 3, phase: 'check', check_name: 'Sources open', next: { action: 'run_again', text: 'Run the Method again. Unchanged steps are reused.' },
  evidence: ['https://example.com/a does not open'], details: 'Declared check returned fail.' } as const;

/** A real run record, whose summary and events are then replaced with the runtime's shapes of the contract. */
async function record(summary: object, events: object[]) {
  const root = mkdtempSync(join(tmpdir(), 'method-run-failure-')); roots.push(root);
  writeFileSync(join(root, 'task.method'), JSON.stringify(method));
  writeFileSync(join(root, 'search.mjs'), `import{readFileSync}from'node:fs';const a=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({note:a.topic}))`);
  writeFileSync(join(root, 'inputs.json'), JSON.stringify({ topics: ['a', 'b', 'c'] }));
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  expect(await runCurrentFile(join(root, 'task.method'), { 'run-dir': join(root, 'run'), inputs: join(root, 'inputs.json') })).toMatchObject({ status: 'completed' });
  vi.restoreAllMocks();
  rmSync(join(root, 'run/setup.json'), { force: true });
  writeFileSync(join(root, 'run/summary.json'), JSON.stringify(summary));
  writeFileSync(join(root, 'run/events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  return realpathSync(join(root, 'run'));
}
const at = '2026-10-13T10:00:00.000Z';
const started = { event: 'run.started', at, elapsed_ms: 5, inputs: { topics: ['a', 'b', 'c'] }, message: 'The run started.' };
const failedSummary = { status: 'failed', run_dir: 'run', started_at: at, device_name: 'laptop', elapsed_ms: 900, invocations: 3, model_requests: 0, tool_calls: 0, failure };

it('maps each runtime status to one inspection status, and copies the failure record', async () => {
  const run = await record(failedSummary, [started, { event: 'run.failed', at, elapsed_ms: 900, message: failure.headline, ...failedSummary }]);
  const inspection = inspectCurrentRun(run);
  expect(inspection.status).toBe('failed');
  expect(inspection.failure).toEqual(failure);
  expect(inspection).not.toHaveProperty('error');
  for (const [runtime, shown] of [['completed', 'succeeded'], ['needs_input', 'waiting_for_you'], ['unconfirmed', 'unconfirmed'], ['failed', 'failed']]) {
    writeFileSync(join(run, 'summary.json'), JSON.stringify({ ...failedSummary, status: runtime, ...(['completed', 'unconfirmed'].includes(runtime) ? { failure: undefined } : {}) }));
    expect(inspectCurrentRun(run).status).toBe(shown);
  }
  writeFileSync(join(run, 'summary.json'), JSON.stringify({ ...failedSummary, status: 'needs_attention' }));
  expect(() => inspectCurrentRun(run)).toThrow('unknown status');
});

it('marks the failed tasks failed and other unfinished tasks stopped, without copying an error onto them', async () => {
  const step = (event: string, iteration: number, extra = {}) => ({ event, at, step: 'search', iteration, ...extra });
  const parallel = { ...failure, failed_iterations: [1, 2], iteration: 1 };
  const run = await record({ ...failedSummary, failure: parallel }, [started,
    step('step.started', 0, { total: 3, inputs: { topic: 'a' }, message: 'Search the web started task 1 of 3.' }),
    step('step.started', 1, { total: 3, inputs: { topic: 'b' } }), step('step.started', 2, { total: 3, inputs: { topic: 'c' } }), step('step.started', 3, { total: 3, inputs: { topic: 'd' } }),
    step('step.accepted', 0, { outputs: { note: 'a' }, state: {}, check: { status: 'unchecked' } }),
    step('step.candidate', 2, { candidate: { note: 'c' } }),
    { event: 'run.failed', at, elapsed_ms: 900, ...failedSummary, failure: parallel }]);
  const rows = inspectCurrentRun(run).invocations;
  expect(Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, row.status]))).toEqual({ 'search:0': 'passed', 'search:1': 'failed', 'search:2': 'failed', 'search:3': 'stopped' });
  for (const row of Object.values(rows)) expect(row).not.toHaveProperty('error');
  // A run that waits for an answer stops its other tasks; the waiting task waits.
  writeFileSync(join(run, 'summary.json'), JSON.stringify({ ...failedSummary, status: 'needs_input', failure: { ...failure, owner: 'needs_you', code: 'needs_input', next: { action: 'answer', text: 'Answer the question.' } } }));
  const waiting = inspectCurrentRun(run);
  expect(waiting.status).toBe('waiting_for_you');
  expect(waiting.invocations['search:1']!.status).toBe('stopped');
});

it('gives only the final run event a duration, maps notices with their key, and keeps a task total without a count', async () => {
  const notice = { event: 'notice', at, step: 'search', iteration: 1, key: 'search:1:retry:model', kind: 'retry', message: 'The model service did not answer (timeout). Method tries again: attempt 2 of 3.', attempt: 2, attempts: 3 };
  const run = await record(failedSummary, [started,
    { event: 'step.started', at, step: 'search', iteration: 1, total: 3, inputs: { topic: 'b' }, message: 'Search the web started task 2 of 3.' }, notice,
    { event: 'step.retry', at, step: 'search', iteration: 1, attempt: 2, attempts: 2, reason: 'A page did not open.', evidence: ['x'], message: 'The check Sources open did not pass. Method tries again: attempt 2 of 2.' },
    { event: 'notice', at, key: 'run:limit:time', kind: 'limit', message: 'This run has used 24 of 30 minutes.' },
    { event: 'run.failed', at, elapsed_ms: 900, ...failedSummary }]);
  const inspection = inspectCurrentRun(run);
  expect(inspection.events!.map(e => [e.type, e.duration_ms])).toEqual([['run_started', undefined], ['notice', undefined], ['run_failed', 900]]);
  expect(inspection.events![1]).toMatchObject({ type: 'notice', key: 'run:limit:time', detail: 'This run has used 24 of 30 minutes.' });
  const events = inspection.invocations['search:1']!.events;
  expect(events[0]).toMatchObject({ type: 'step_started', total: 3, detail: 'Search the web started task 2 of 3.' });
  expect(events[0]).not.toHaveProperty('completed');
  expect(events[1]).toEqual({ at, type: 'notice', key: notice.key, attempt: 2, attempts: 3, detail: notice.message });
  expect(events[2]).toMatchObject({ type: 'step_retry', attempt: 2, attempts: 2, detail: 'The check Sources open did not pass. Method tries again: attempt 2 of 2.' });
});

it('prints three plain lines on stderr for a failed run and keeps the JSON alone on stdout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'method-run-failure-')); roots.push(root);
  writeFileSync(join(root, 'task.method'), JSON.stringify({ format: 'method/3.3', name: 'Broken', goal: 'Fail.', steps: { finish: { name: 'Finish', purpose: 'Returns a total.', do: { kind: 'run', runtime: 'node', entrypoint: 'finish.mjs' }, out: { total: { type: 'number', description: 'The total.' } } } }, result: 'total' }));
  writeFileSync(join(root, 'finish.mjs'), 'console.log(JSON.stringify({wrong:1}))');
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true), err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const result = await runCurrentFile(join(root, 'task.method'), { 'run-dir': join(root, 'run') });
  expect(result.status).toBe('failed');
  const printed = JSON.parse(String(out.mock.calls.at(-1)![0]));
  expect(FailureSchema.parse(printed.failure)).toMatchObject({ step: 'finish', code: 'invalid_output' });
  for (const removed of ['code', 'error', 'failed_step', 'iteration', 'diagnostics', 'fix', 'recovery']) expect(printed).not.toHaveProperty(removed);
  const lines = err.mock.calls.map(call => String(call[0])).join('').trimEnd().split('\n').slice(-3);
  expect(lines).toEqual([`Failed: ${printed.failure.headline}`, `Whose problem: ${ownerText(printed.failure.owner)}`, `Next: ${printed.failure.next.text}`]);
});

it('method wait ends with the run status and the headline of a failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'method-run-failure-')); roots.push(root);
  writeFileSync(join(root, 'worker.json'), JSON.stringify({ status: 'finished', pid: 1, exit_code: 1 }));
  writeFileSync(join(root, 'summary.json'), JSON.stringify(failedSummary));
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  expect(await waitForRun(root)).toEqual({ status: 'failed', run_dir: root, exit_code: 1, headline: failure.headline });
  writeFileSync(join(root, 'worker.json'), JSON.stringify({ status: 'finished', pid: 1, exit_code: 0 }));
  writeFileSync(join(root, 'summary.json'), JSON.stringify({ status: 'completed', result: 1 }));
  expect(await waitForRun(root)).toEqual({ status: 'succeeded', run_dir: root, exit_code: 0 });
  writeFileSync(join(root, 'worker.json'), JSON.stringify({ status: 'finished', pid: 1, exit_code: 1 }));
  rmSync(join(root, 'summary.json'));
  expect(await waitForRun(root)).toMatchObject({ status: 'failed', headline: "Method could not read this run's record." });
});

it('gives a setup failure and an unreadable record their owner and next action', () => {
  expect(setupFailure(Object.assign(Error('Supply the required Method inputs with --inputs FILE.'), { code: 'needs_input' }))).toMatchObject({ owner: 'needs_you', next: { action: 'answer' }, phase: 'setup' });
  expect(setupFailure(Object.assign(Error('Missing ARCHIVE_TOKEN.'), { code: 'missing_secret', missing: ['ARCHIVE_TOKEN'] }))).toMatchObject({ owner: 'setup', code: 'missing_secret', next: { action: 'fix_setup', text: expect.stringContaining('method secret find'), command: 'method secret set ARCHIVE_TOKEN' } });
  expect(setupFailure(new TypeError('x is undefined'))).toMatchObject({ owner: 'method_platform', next: { action: 'report_bug' }, details: 'x is undefined' });
  expect(FailureSchema.parse(unreadableRecord(Error('bad json')))).toMatchObject({ owner: 'method_platform', headline: "Method could not read this run's record.", details: 'bad json' });
  const unreadable = unreadableRecord('x');
  expect(failureLines(unreadable)).toBe(`Failed: Method could not read this run's record.\nWhose problem: A problem in Method\nNext: ${unreadable.next.text}\n`);
  // A runtime error carries its own record.
  const own = { ...unreadable, owner: 'setup', code: 'run_locked' } as const;
  expect(setupFailure(Object.assign(Error('locked'), { failure: own }))).toBe(own);
  expect(['method_code', 'agent_work', 'outside_service', 'limit', 'setup', 'needs_you', 'method_platform'].map(o => ownerText(o as any))).toEqual(["Problem in the Method's code", "The agent's work did not pass", 'A service outside Method', 'A limit was reached', 'Your setup', 'Needs your answer', 'A problem in Method']);
});
