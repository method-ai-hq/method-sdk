import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The runtime's case functions and the model are mocked: the test checks what caseFromCorrection asks and keeps.
const runtime = vi.hoisted(() => ({ created: [] as any[], scriptExisted: false, evaluated: [] as any[] }));
vi.mock('@withmethod/runtime/cases.js', async original => ({
  ...await original<any>(),
  outcomeOfRun: vi.fn(async (dir: string) => dir.endsWith('bad') ? badOutcome(dir) : goodOutcome(dir)),
  createCase: vi.fn(async (input: any) => { runtime.created.push(input); runtime.scriptExisted = existsSync(join(input.methodFile, '..', input.expect.find((e: any) => e.kind === 'predicate')?.entrypoint ?? 'none')); return { id: input.id }; }),
  // Claude and Codex judge (the runtime's judges option): c1 fails on the corrected run and passes on the approved one;
  // c2 fails on both; on c3 the two judges disagree on the corrected run, which the runtime reports as unsure. The check
  // script fails on the corrected run and passes on the approved one.
  evaluate: vi.fn(async (expect: any[], outcome: any, context: any) => {
    const judges: any[] = context.options?.judges ?? [context.config.models.judge];
    runtime.evaluated.push({ judges: judges.map(j => j.backend), run: outcome.name });
    const results = expect.map(item => item.kind === 'predicate' ? { kind: 'predicate', status: outcome.name === 'bad' ? 'fail' : 'pass' } : (() => {
      const criteria = item.criteria.map((c: any) => {
        const votes = judges.map(j => outcome.name === 'bad' ? (c.id === 'c3' && j.backend === 'codex') : c.id !== 'c2');
        const unsure = votes.some(Boolean) && !votes.every(Boolean);
        return { id: c.id, text: c.text, pass: votes.every(Boolean), ...(unsure ? { unsure: true, reason: 'unsure' } : {}) };
      });
      return { kind: 'rubric', status: criteria.every((c: any) => c.pass) ? 'pass' : 'fail', criteria };
    })());
    return { status: results.every(r => r.status === 'pass') ? 'pass' : 'fail', results };
  }),
}));
const model = vi.hoisted(() => ({ requests: [] as any[] }));
vi.mock('../../packages/sdk/src/model-call.js', async original => ({
  ...await original<any>(),
  callModel: vi.fn(async (request: any) => { model.requests.push(request); return { value: {
    criteria: [{ text: 'The NDA has tracked changes.', ref: 'file:redline.md' }, { text: 'The email names the counterparty.', ref: 'effect:send_email' }, { text: 'The result says the NDA was sent.', ref: 'not-a-ref' }],
    check_script: 'const input = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(JSON.stringify({pass: input.tool_calls.some(c => c.arguments.attachments.length)}));',
    check_says: 'The email has an attachment.' }, agent: 'claude', usd: null, duration_ms: 1 }; }),
}));
vi.mock('../../packages/sdk/src/quality.js', async original => ({
  ...await original<any>(),
  preparedConfig: vi.fn(async () => ({ config: { models: { judge: { backend: 'claude' } }, runtimes: { node: { command: process.execPath } } }, processPath: '' })),
  judgeProfiles: vi.fn(async () => [{ backend: 'claude' }, { backend: 'codex' }]),
}));

const { caseFromCorrection, correctionCaseId } = await import('../../packages/sdk/src/improve.js');

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
let artifacts = '';
const badOutcome = (dir: string) => ({ name: 'bad', status: 'completed', result: { deliverable: 'The NDA is attached.', saved: true }, outputs: { deliverable: 'The NDA is attached.' },
  artifacts: join(dir, 'artifacts'), files: {}, tool_calls: [{ tool: 'send_email', arguments: { to: 'counsel@acme.test', attachments: [] } }], effect_inputs: [] });
const goodOutcome = (dir: string) => ({ ...badOutcome(dir), name: 'good', tool_calls: [{ tool: 'send_email', arguments: { to: 'counsel@acme.test', attachments: ['redline.docx'] } }] });

it('judges what the person saw: a result with several values, the files the run wrote, and the email it sent; keeps only what fails on the corrected run and passes on approved runs', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'method-case-'))); roots.push(root);
  const folder = join(root, 'project'); mkdirSync(folder);
  const file = join(folder, 'nda.method');
  writeFileSync(file, JSON.stringify({ format: 'method/3.4', name: 'NDA', goal: 'Redline an NDA and send it back.', steps: {}, result: { deliverable: 'deliverable', saved: 'saved' } }));
  artifacts = join(root, 'bad', 'artifacts'); mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, 'redline.md'), 'Clean copy of the NDA with no changes.');
  const id = 'jdg_' + 'c'.repeat(32);
  const made = await caseFromCorrection(file, { id, note: "it's not even redlined", noted_by: 'Gráinne' }, join(root, 'bad'), { approvedRuns: [join(root, 'good')] });
  expect(made).toEqual({ id: correctionCaseId(id), made: true });
  // The writer saw the whole result, the file, and the email, each by the name that a case uses.
  const user = model.requests[0].user as string;
  for (const ref of ['[result]', '[outputs.deliverable]', '[file:redline.md]', '[effect:send_email]']) expect(user).toContain(ref);
  expect(user).toContain('Clean copy of the NDA with no changes.');
  expect(user).toContain('counsel@acme.test');
  // The judge sees only the thing a sentence is about, so the writer puts the facts in the sentence; and it never asks for a
  // detail that the run did not have, because a right result would have to invent it.
  const system = model.requests[0].system as string;
  expect(system).toContain('it does not see the run\'s inputs, sources or materials');
  expect(system).toContain('write the facts in the sentence');
  expect(system).toContain('do not require a detail');
  expect(system).toContain('a clear placeholder for it is right');
  // Both judges judged both runs; c2 fails on the approved run and c3 is unsure, so only c1 and the check script stay.
  expect(runtime.evaluated.map(e => `${e.judges.join('+')}:${e.run}`).sort()).toEqual(['claude+codex:bad', 'claude+codex:good']);
  const created = runtime.created[0];
  expect(created).toMatchObject({ methodFile: file, id: correctionCaseId(id), author: 'Gráinne', note: "it's not even redlined" });
  expect(created.expect).toEqual([
    { kind: 'rubric', ref: 'file:redline.md', criteria: [{ id: 'c1', text: 'The NDA has tracked changes.' }] },
    { kind: 'predicate', runtime: 'node', entrypoint: `check-${correctionCaseId(id)}.mjs`, text: 'The email has an attachment.' },
  ]);
  // The check script was beside the Method file while the case was made, and is gone after.
  expect(runtime.scriptExisted).toBe(true);
  expect(existsSync(join(folder, `check-${correctionCaseId(id)}.mjs`))).toBe(false);
});
