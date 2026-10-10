import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { methodMain } from '../../packages/sdk/src/method.js';
import { checkKey, checkTargets, checksDir, modelIssues, runChecks, stepText } from '../../packages/sdk/src/model-checks.js';
import { collectIssues, formatIssue, privacyIssues, publishIssues, shownIssues, hostedModelUses } from '../../packages/sdk/src/method-issues.js';
import { privateModels } from '../../packages/sdk/src/hosted-models.js';
import { MethodClient } from '../../packages/sdk/src/method-client.js';
import YAML from 'yaml';

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; });
vi.stubEnv('METHOD_NO_BACKGROUND_CHECKS', '1');

const method = (extra = '') => `format: method/3.4
name: Copy a message
goal: Copy the message.
inputs:
  message: {type: text, description: The message.}
steps:
  copy:
    name: Copy
    purpose: Returns the message unchanged and changes nothing.
    in: {message: inputs.message}
    do: {kind: run, runtime: node, entrypoint: copy.cjs}
    out:
      copied: {type: text, description: The copy.}
      spare: {type: text, description: Not used.}
${extra}result: copied
`;
const script = 'let t="";process.stdin.on("data",x=>t+=x);process.stdin.on("end",()=>console.log(JSON.stringify({copied:JSON.parse(t).message,spare:""})));\n';
function folder(text = method(), files: Record<string, string> = { 'copy.cjs': script }) {
  const dir = mkdtempSync(join(tmpdir(), 'method-issues-')); dirs.push(dir);
  for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), data);
  const file = join(dir, 'task.method'); writeFileSync(file, text);
  return { dir, file };
}
function printed() {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return () => { const text = out.mock.calls.map(call => String(call[0])).join(''); out.mockClear(); return JSON.parse(text); };
}

it('validate lists a warning with its fix and how to accept it, and exits 0', async () => {
  const { file } = folder(), result = printed();
  await methodMain(['validate', file]);
  const output = result();
  expect(process.exitCode ?? 0).toBe(0);
  expect(output).toMatchObject({ valid: true, issue_counts: { errors: 0, warnings: 1 } });
  expect(output.issues).toEqual([expect.objectContaining({ level: 'warning', code: 'unused_output', message: expect.stringContaining('spare'), fix: expect.any(String), accept: expect.stringContaining('accept:') })]);
  // The step did not change, so the next validate does not repeat the warning; --all lists it.
  await methodMain(['validate', file]);
  const again = result();
  expect(again.issues).toEqual([]); expect(again.more_warnings).toContain('--all');
  await methodMain(['validate', file, '--all']);
  expect(result().issues).toHaveLength(1);
});

it('an accepted warning is counted, not listed; an accept that no longer fires is a note shown only with --notes', async () => {
  const { file } = folder(method().replace('      spare: {type: text, description: Not used.}\n', '      spare: {type: text, description: Not used.}\n    accept: {unused_output: The user reads it in the run record., agent_without_tools: Old.}\n'));
  const result = printed();
  await methodMain(['validate', file]);
  const output = result();
  expect(output.issues).toEqual([]); expect(output.issue_counts).toMatchObject({ warnings: 0, accepted: 1, notes: 1 });
  await methodMain(['check', file, '--notes']);
  expect(result().issues).toEqual([expect.objectContaining({ level: 'note', code: 'accept_unused' })]);
});

it('a secret value of this computer in an uploaded file is an error: validate, check, and publish refuse; the value is never printed', async () => {
  const value = 'sk-test-0123456789abcdef';
  mkdirSync(join(homedir(), '.config', 'method'), { recursive: true });
  writeFileSync(join(homedir(), '.config', 'method', 'secrets.json'), JSON.stringify({ SERVICE_KEY: value }));
  const { file } = folder(method(), { 'copy.cjs': `const key = "${value}";\n${script}` }), result = printed();
  await methodMain(['validate', file]);
  const output = result();
  expect(process.exitCode).toBe(1); process.exitCode = 0;
  expect(output.issues[0]).toMatchObject({ level: 'error', code: 'secret_value', at: 'copy.cjs, line 1' });
  expect(JSON.stringify(output)).not.toContain(value);
  await methodMain(['check', file]); expect(result()).toMatchObject({ valid: false }); expect(process.exitCode).toBe(1);
  const client = new MethodClient('http://127.0.0.1:9');
  await expect(publishIssues(client, file)).rejects.toThrow(/Nothing was published\. Fix this error.*secret_value \(copy\.cjs, line 1\)/);
  await expect(publishIssues(client, file)).rejects.not.toThrow(value);
});

it('publish lists warnings and notes and does not block on them', async () => {
  const { file } = folder();
  expect(await publishIssues(new MethodClient('http://127.0.0.1:9'), file)).toEqual({ issues: [expect.objectContaining({ level: 'warning', code: 'unused_output' })] });
});

it('a format error is the only issue and exits 1', async () => {
  const { file } = folder(method().replace('result: copied', 'result: missing')), result = printed();
  await methodMain(['validate', file]);
  const output = result();
  expect(process.exitCode).toBe(1);
  expect(output).toMatchObject({ valid: false, definition: 'invalid', issue_counts: { errors: 1 } });
  expect(output.issues[0]).toMatchObject({ level: 'error', fix: expect.any(String) });
});

it('lists every warning on changed steps, errors first, notes only when asked', () => {
  const warning = (n: number) => ({ code: `w${n}`, level: 'warning' as const, step: 's', message: 'm', fix: 'f' });
  const report = { issues: [{ code: 'e', level: 'error' as const, message: 'm', fix: 'f' }, ...[1, 2].map(warning), { code: 'n', level: 'note' as const, message: 'm', fix: 'f' }],
    changed: new Set(['s']), pending: 2, notChecked: [] };
  const shown = shownIssues(report);
  expect(shown.issues.map(issue => issue.code)).toEqual(['e', 'w1', 'w2']);
  expect(shown).not.toHaveProperty('more_warnings'); expect(shown.checks).toBe('2 checks pending');
  expect(shownIssues(report, { notes: true }).issues.at(-1)!.code).toBe('n');
  expect(shownIssues({ ...report, changed: new Set() }).issues.map(issue => issue.code)).toEqual(['e']);
  expect(formatIssue(report.issues[0]!)).not.toHaveProperty('accept');
});

const classifyMethod = `format: method/3.4
name: Route
goal: Route a message.
inputs:
  message: {type: text, description: A message.}
steps:
  route:
    name: Route
    reading: {check: Route it}
    in: {message: inputs.message}
    do: {kind: classify, question: Which team?, options: {billing: Invoices, support: Help}}
    out: team
  draft:
    name: Draft
    in: {message: inputs.message, team: team.choice}
    do: {kind: call, model: writer, prompt: "Draft a reply to {{message}} for {{team}}."}
    out:
      reply: {type: text, description: The reply.}
models:
  writer: example/not-private
result: reply
`;

it('model checks: targets carry the exact inputs, display text and accepts do not change the key', () => {
  const doc = YAML.parse(classifyMethod);
  const targets = checkTargets(doc, () => undefined);
  const route = targets.find(target => target.step === 'route')!;
  expect(route.inputs.step).toBe(stepText('route', doc.steps.route)); expect(route.inputs.step).not.toContain("Route it");
  const accepted = { ...doc, steps: { ...doc.steps, route: { ...doc.steps.route, accept: { unused_output: 'Kept.' } } } };
  expect(checkTargets(accepted, () => undefined).find(target => target.step === 'route' && target.check === route.check)!.key).toBe(route.key);
  expect(checkKey('a', 1, { step: 'x' })).not.toBe(checkKey('a', 2, { step: 'x' }));
  // A script check reads the script.
  const scripted = checkTargets({ steps: { s: { do: { kind: 'run', runtime: 'node', entrypoint: 'a.mjs' } } } }, path => path === 'a.mjs' ? 'fetch()' : undefined);
  expect(scripted).toEqual([expect.objectContaining({ check: 'script_calls_model', inputs: { step: expect.any(String), script: 'fetch()' } })]);
});

it('model checks run in parallel, cache their answers, and leave slow ones pending; shadow checks are never shown', async () => {
  const targets = checkTargets({ steps: { a: { do: { kind: 'run', runtime: 'node', entrypoint: 'a.mjs' } }, b: { do: { kind: 'run', runtime: 'node', entrypoint: 'b.mjs' } } } },
    path => path === 'a.mjs' ? 'fast' : 'slow');
  let open = 0, most = 0;
  const provider = { resolve: async () => ({ provider: 'typesafe' as const, model: 'jev-test' }),
    evaluate: vi.fn(async (request: any, signal: AbortSignal) => {
      open++; most = Math.max(most, open);
      await new Promise((resolve, reject) => { const timer = setTimeout(resolve, request.inputs.script === 'slow' ? 5_000 : 10); signal.addEventListener('abort', () => { clearTimeout(timer); reject(Error('aborted')); }); });
      open--; return { choice: 'yes', probabilities: { yes: 0.9, no: 0.1 } } as any;
    }) };
  const first = await runChecks(provider, targets, 200);
  expect(first.done.map(result => result.step)).toEqual(['a']); expect(first.pending.map(target => target.step)).toEqual(['b']);
  expect(most).toBe(2);
  expect(existsSync(join(checksDir(), `${targets[0]!.key}.json`))).toBe(true);
  const again = await runChecks(provider, targets.slice(0, 1), 200);
  expect(again.done).toHaveLength(1); expect(provider.evaluate).toHaveBeenCalledTimes(2);
  expect(modelIssues(first.done, [])).toEqual([]);
  expect(modelIssues(first.done, ['script_calls_model'])).toEqual([expect.objectContaining({ code: 'script_calls_model', level: 'warning', step: 'a', evidence: { probability: 0.9, check: 'script_calls_model@1' } })]);
  // Without a provider (no sign-in) nothing is asked.
  expect(await runChecks(undefined, targets.slice(1), 10)).toMatchObject({ done: [], pending: [expect.anything()] });
});

it('model_not_private: a step that names a hosted model without a private provider gets a warning, also from validate when signed in', async () => {
  const doc = YAML.parse(classifyMethod);
  expect(hostedModelUses(doc)).toEqual([{ step: 'draft', field: 'do.model', model: 'example/not-private', name: 'writer' }]);
  expect(privacyIssues(doc, new Set(['example/private']))).toEqual([expect.objectContaining({ code: 'model_not_private', level: 'warning', step: 'draft', field: 'do.model', fix: 'Choose a model from method models.' })]);
  expect(privacyIssues(doc, new Set(['example/not-private']))).toEqual([]);
  // A local-agent entry is not a hosted model.
  doc.models.writer = { agent: 'codex', model: 'gpt-local' };
  expect(hostedModelUses(doc)).toEqual([]);
  const { file, dir } = folder(classifyMethod, {});
  vi.stubEnv('METHOD_CACHE_DIR', join(dir, 'cache'));
  const client: any = { server: 'https://example.test', token: () => 'token',
    request: vi.fn(async (path: string) => { if (path === '/api/cli/models/private') return { models: [{ id: 'example/private', providers: [] }], checked_at: new Date().toISOString() }; throw Object.assign(Error('offline'), { status: 503 }); }) };
  const report = await collectIssues(file, { client, waitMs: 200, background: false });
  expect(report.issues.filter(issue => issue.code === 'model_not_private')).toHaveLength(1);
});

it('the private model list comes from the server and is kept for a day; method models prints it', async () => {
  const list = { models: [{ id: 'example/private', providers: ['One'] }], default: 'example/private', checked_at: new Date().toISOString() };
  const client: any = { server: 'https://example.test', token: () => 'token', request: vi.fn(async () => list) };
  expect(await privateModels(client)).toEqual(list);
  expect(await privateModels(client)).toEqual(list);
  expect(client.request).toHaveBeenCalledTimes(1);
  expect(client.request.mock.calls[0][0]).toBe('/api/cli/models/private');
  const result = printed();
  await methodMain(['models', '--refresh'], () => client);
  expect(result()).toMatchObject({ models: ['example/private'], default: 'example/private' });
  expect(client.request).toHaveBeenCalledTimes(2);
  await expect(methodMain(['models'], () => ({ ...client, token: () => null }))).rejects.toThrow('method login');
});

it('validate reports runtime.json and a sidecar as errors and changes no file', async () => {
  const { dir, file } = folder(method().replace('format: method/3.4', 'format: method/3.3'), { 'copy.cjs': script,
    'runtime.json': JSON.stringify({ models: { researcher: { backend: 'codex' } }, limits: { timeout_ms: 5000 } }) });
  writeFileSync(`${file}.method.json`, JSON.stringify({ workflow_id: `wf_${'a'.repeat(32)}` }));
  const snapshot = () => Object.fromEntries(readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), 'utf8')]));
  const before = snapshot(), result = printed();
  await methodMain(['validate', file]);
  const output = result();
  expect(process.exitCode).toBe(1);
  expect(output.valid).toBe(false);
  const codes = output.issues.map((issue: any) => issue.code);
  expect(codes).toEqual(expect.arrayContaining(['legacy_runtime_json', 'legacy_sidecar']));
  await methodMain(['check', file]);
  expect(result().valid).toBe(false);
  expect(snapshot()).toEqual(before);
});
