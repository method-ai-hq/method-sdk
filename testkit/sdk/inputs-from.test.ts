import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { methodMain } from '../../packages/sdk/src/method.js';
import { inputsOfRun, withInputsFrom, withoutOptions } from '../../packages/sdk/src/inputs-from.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

const method = `format: method/3.4
name: Greet
goal: Greet a person.
inputs:
  greeting:
    type: text
    description: The greeting word.
  name:
    type: text
    description: The person's name.
steps:
  greet:
    name: Greet
    purpose: Join the greeting and the name; changes nothing.
    in:
      greeting: inputs.greeting
      name: inputs.name
    do:
      kind: run
      runtime: node
      entrypoint: greet.cjs
    out:
      line:
        type: text
        description: The greeting line.
result: line
`;
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'method-inputs-from-'))); roots.push(root);
  vi.stubEnv('METHOD_CACHE_DIR', join(root, 'cache')); vi.stubEnv('METHOD_CONFIG_DIR', join(root, 'config')); vi.stubEnv('METHOD_NO_EXPLAIN', '1');
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const file = join(root, 'greet.method');
  writeFileSync(file, method);
  writeFileSync(join(root, 'greet.cjs'), 'let t="";process.stdin.on("data",x=>t+=x);process.stdin.on("end",()=>{const i=JSON.parse(t);console.log(JSON.stringify({line:`${i.greeting}, ${i.name}`}))});\n');
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const result = () => JSON.parse(stdout.mock.calls.map(c => String(c[0])).join(''));
  return { root, file, stdout, result };
}
const fakeClient = (routes: Record<string, () => any>, token: string | null = 'method_x') => ({
  server: 'https://example.test', token: () => token, calls: [] as string[],
  async request(path: string) { this.calls.push(path); const route = routes[path]; if (!route) throw Error(`404: ${path}`); return route(); },
}) as any;

it('takes the inputs of an account run from the server, and --inputs replaces single values', async () => {
  const s = setup();
  const client = fakeClient({ '/api/workspace/runs/run_acct': () => ({ run: { status: 'succeeded', inspection: { inputs: { greeting: 'Hello', name: 'Maeby' } } } }) });
  expect(await inputsOfRun('run_acct', client, [])).toEqual({ greeting: 'Hello', name: 'Maeby' });
  expect(client.calls).toEqual(['/api/workspace/runs/run_acct']);
  writeFileSync(join(s.root, 'override.json'), '{"name":"George"}');
  const flags = await withInputsFrom({ 'inputs-from': 'run_acct', inputs: join(s.root, 'override.json') }, join(s.root, 'run'), s.file, client);
  expect(flags['inputs-from']).toBeUndefined();
  expect(JSON.parse(readFileSync(flags.inputs!, 'utf8'))).toEqual({ greeting: 'Hello', name: 'George' });
});

it('takes the inputs of a device run from its run folder, found by method-sync.json, and merges --inputs', async () => {
  const s = setup();
  writeFileSync(join(s.root, 'first.json'), '{"greeting":"Hello","name":"Maeby"}');
  await methodMain(['run', s.file, '--inputs', join(s.root, 'first.json'), '--run-dir', join(s.root, '.method-runs', 'first')]);
  expect(s.result()).toMatchObject({ status: 'completed', result: 'Hello, Maeby' });
  // The run's link to the dashboard: the saved dashboard ID is what the dashboard shows.
  writeFileSync(join(s.root, '.method-runs', 'first', 'method-sync.json'), JSON.stringify({ schema: 'method-sync/1', server: 'https://example.test', id: '00000000-0000-4000-8000-000000000001', workflow_id: 'wf_x', version_id: 'v_x', sequence: 2, dashboard_id: 'run_dev', device: true }));
  // The server keeps no content of a device run, so the inputs come from this computer.
  const client = fakeClient({ '/api/workspace/runs/run_dev': () => ({ run: { status: 'succeeded', inspection: { content: 'device', inputs: {} } } }) });
  expect(await inputsOfRun('run_dev', client, [join(s.root, '.method-runs')])).toEqual({ greeting: 'Hello', name: 'Maeby' });
  // Signed out, the run folder is found too; --inputs replaces one value.
  writeFileSync(join(s.root, 'override.json'), '{"greeting":"Goodbye"}');
  s.stdout.mockClear();
  await methodMain(['run', s.file, '--inputs-from', 'run_dev', '--inputs', join(s.root, 'override.json'), '--run-dir', join(s.root, '.method-runs', 'second')]);
  expect(s.result()).toMatchObject({ status: 'completed', result: 'Goodbye, Maeby' });
});

it('says where it looked when no run has the ID', async () => {
  const s = setup();
  await expect(inputsOfRun('run_none', fakeClient({}, null), [join(s.root, '.method-runs')])).rejects.toThrow(`No run folder for it (method-sync.json) is in ${join(s.root, '.method-runs')}`);
  await expect(withInputsFrom({ 'inputs-from': 'run_x', resume: true }, join(s.root, 'run'), s.file, undefined)).rejects.toThrow('keeps the inputs it started with');
});

it('removes options and their values from worker arguments', () => {
  expect(withoutOptions(['run', 'a.method', '--inputs-from', 'r1', '--inputs=x.json', '--fresh', '--inputs', 'y.json'], ['inputs-from', 'inputs'])).toEqual(['run', 'a.method', '--fresh']);
});
