import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staticEffects } from '../../packages/sdk/src/explain-effects.js';
import { entityProblems, hasPython, makeCard, recordedInputs, sameOutput, scriptSha256, type Models } from '../../packages/sdk/src/explain.js';
import { MethodClient } from '../../packages/sdk/src/method-client.js';
import { methodMain } from '../../packages/sdk/src/method.js';
import { writePrivateJson } from '../../packages/sdk/src/files.js';
import { currentVersion, writeMethodId } from '../../packages/sdk/src/versions.js';
import { readDocument } from '../../packages/sdk/src/authoring.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temp = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), 'method-explain-test-'))); roots.push(root); return root; };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const python = hasPython();

const pythonSource = `import json, os, subprocess, sys
from pathlib import Path
import requests
API = "https://api.example.com/v1/leads"
data = json.load(sys.stdin)
key = os.environ["CRM_TOKEN"]
region = os.getenv("REGION", "us")
rows = requests.get(API, headers={"x": key}).json()
Path("cache/leads.json").write_text(json.dumps(rows))
with open("config.json") as f:
    cfg = json.load(f)
subprocess.run(["git", "status"])
limit = data["limit"]
owner = data.get("owner")
result = {"scored": rows[:limit]}
result["count"] = len(rows)
print(json.dumps(result))
`;
const nodeSource = `import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const input = JSON.parse(readFileSync(0, 'utf8'));
const token = process.env.CRM_TOKEN; const { REGION } = process.env;
// fetch('https://ignored.example.net') is a comment
const response = await fetch(\`https://api.example.org/leads?limit=\${input.limit}\`, { headers: { token } });
writeFileSync('out/leads.json', await response.text());
const config = readFileSync('config.json', 'utf8');
execFileSync('git', ['status', '--short']);
console.log(JSON.stringify({ scored: [], count: 0 }));
`;
const step = { name: 'Score leads', purpose: 'Keep the strong leads.', in: { leads: 'inputs.leads' }, do: { kind: 'run', runtime: 'python', entrypoint: 'score.py' }, out: { kept: { type: 'list', items: { type: 'record', fields: { name: { type: 'text' }, score: { type: 'number' } } }, description: 'Kept leads.' } } };

it.skipIf(!python)('finds the effects of a Python script with the ast module', () => {
  const found = staticEffects('python', [{ path: 'score.py', text: pythonSource }], step, ['CRM_TOKEN', 'UNUSED_KEY']);
  expect(found.effects).toEqual({ network: ['api.example.com'], secrets: ['CRM_TOKEN'], env: ['REGION'], reads: ['config.json'], writes: ['cache/leads.json'],
    runs: ['git status'], input_fields: ['leads'], output_fields: ['kept'] });
  expect(found.facts).toEqual({ stdin_keys: ['limit', 'owner'], output_keys: ['count', 'scored'] });
});
it('finds the effects of a Node script with a token scan', () => {
  const found = staticEffects('node', [{ path: 'score.mjs', text: nodeSource }], { ...step, do: { ...step.do, runtime: 'node', entrypoint: 'score.mjs' } }, ['CRM_TOKEN']);
  expect(found.effects).toEqual({ network: ['api.example.org'], secrets: ['CRM_TOKEN'], env: ['REGION'], reads: ['config.json'], writes: ['out/leads.json'],
    runs: ['git status --short'], input_fields: ['leads'], output_fields: ['kept'] });
  expect(found.facts).toEqual({ stdin_keys: ['limit'], output_keys: ['count', 'scored'] });
});
it('names each number, quoted name, and host that the code does not have', () => {
  const code = 'kept = [l for l in leads if l["score"] > 50][:10]\nURL = "https://api.example.com"';
  expect(entityProblems({ summary: 'Keep each lead in `leads` whose `score` is above 50.', steps: [{ text: 'Keep at most 10 leads from api.example.com.', lines: [1, 1] }], not_done: ['Ties at 50% are kept.'] }, code, step)).toEqual([]);
  expect(entityProblems({ summary: 'Keep leads above 75.', steps: [{ text: 'Read `rank` and call api.other.com.', lines: [1, 1] }], not_done: [] }, code, step)).toEqual([
    'The number 75 does not appear in the code.', '"rank" does not appear in the code.', 'Host api.other.com does not appear in the code.']);
});
it('compares outputs after sorting keys, on the declared fields', () => {
  expect(sameOutput({ kept: [{ a: 1, b: 2 }], debug: 1 }, { kept: [{ b: 2, a: 1 }] }, ['kept'])).toBe(true);
  expect(sameOutput({ kept: [1, 2] }, { kept: [2, 1] }, ['kept'])).toBe(false);
});

// ---------- Round trip with a fake hosted model ----------

const script = `import json, sys
data = json.load(sys.stdin)
leads = data["leads"]
kept = sorted([lead for lead in leads if lead["score"] > 50], key=lambda lead: -lead["score"])
print(json.dumps({"kept": kept}))
`;
const rightProgram = `import json, sys
leads = json.load(sys.stdin)["leads"]
print(json.dumps({"kept": sorted([l for l in leads if l["score"] > 50], key=lambda l: -l["score"])}))
`;
const wrongProgram = `import json, sys
leads = json.load(sys.stdin)["leads"]
print(json.dumps({"kept": [l for l in leads if l["score"] >= 50]}))
`;
const draft = (threshold = 50) => ({ summary: `Keep each lead in \`leads\` whose \`score\` is above ${threshold}.`, changes: 'nothing',
  steps: [{ text: 'Read `leads` from the input.', lines: [2, 3] }, { text: `Keep each lead whose \`score\` is above ${threshold}, highest first.`, lines: [4, 4] },
    { text: 'If `leads` is empty, print an empty `kept` list.', lines: [5, 5] }], not_done: ['Leads without `score` stop the script.'] });
const method = { format: 'method/3.3', name: 'Leads', goal: 'Keep strong leads.', inputs: { leads: { type: 'list', items: { type: 'record', fields: { name: { type: 'text' }, score: { type: 'number' } } }, description: 'Leads.' } },
  steps: { score: step }, result: 'kept' };
function fakeModels(drafts: object[], program: string) {
  const requests: any[] = [];
  const models: Models = {
    async model() { return 'test/model'; },
    async request(body) {
      requests.push(body);
      const content = body.response_format.json_schema.name === 'method_program' ? { code: program } : drafts.shift();
      return { model: 'test/model-1', choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] };
    },
  };
  return { models, requests };
}
function recordRun(root: string, inputs: unknown[]) {
  const dir = join(root, '.method-runs', 'run-1'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), [{ event: 'run.started', method }, ...inputs.map(value => ({ event: 'step.started', step: 'score', inputs: value }))].map(e => JSON.stringify(e)).join('\n') + '\n');
}
const leads = [{ leads: [{ name: 'a', score: 70 }, { name: 'b', score: 50 }, { name: 'c', score: 90 }] }, { leads: [] }, { leads: [{ name: 'd', score: 51 }] }, { leads: [{ name: 'e', score: 1 }] }];

it.skipIf(!python)('replays up to 3 recorded inputs through the script and a program written from the steps', async () => {
  const root = temp(); writeFileSync(join(root, 'score.py'), script); recordRun(root, [leads[0], leads[0], leads[1], leads[2], leads[3]]);
  expect(recordedInputs('score', 'score.py', [join(root, '.method-runs')])).toEqual([leads[0], leads[1], leads[2]]);
  const context = { method, id: 'score', root, sources: [{ path: 'score.py', text: script }], scriptHash: sha('x'), roundTrip: true, runRoots: [join(root, '.method-runs')] };
  const right = fakeModels([draft(60), draft()], rightProgram);
  const made = await makeCard({ ...context, models: right.models });
  expect(right.requests).toHaveLength(3);
  expect(JSON.stringify(right.requests[1].messages)).toContain('The number 60 does not appear in the code.');
  expect(made.card).toMatchObject({ schema: 'method-script-card/1', step_id: 'score', entrypoint: 'score.py', changes: 'nothing', model: 'test/model-1',
    effects: { network: [], input_fields: ['leads'], output_fields: ['kept'] }, checks: { entities: 'passed', entity_problems: [], round_trip: 'passed', round_trip_inputs: 3 } });
  const wrong = fakeModels([draft(60), draft(60)], wrongProgram);
  expect((await makeCard({ ...context, models: wrong.models })).card.checks).toEqual({ entities: 'failed', entity_problems: ['The number 60 does not appear in the code.'], round_trip: 'failed', round_trip_inputs: 1 });
});
it.skipIf(!python)('does not replay a script that calls the network', async () => {
  const root = temp(), text = 'import json, sys, urllib.request\nurllib.request.urlopen("https://api.example.com")\nprint(json.dumps({"kept": []}))\n';
  writeFileSync(join(root, 'score.py'), text); recordRun(root, [leads[0]]);
  const fake = fakeModels([draft(), draft()], rightProgram);
  const made = await makeCard({ method, id: 'score', root, sources: [{ path: 'score.py', text }], scriptHash: sha('x'), roundTrip: true, runRoots: [join(root, '.method-runs')], models: fake.models });
  expect(made.card.checks).toMatchObject({ round_trip: 'not_run', round_trip_inputs: 0 });
  expect(made.note).toContain('api.example.com');
  expect(fake.requests.map(r => r.response_format.json_schema.name)).toEqual(['method_script_card', 'method_script_card']);
});

// ---------- The command, with the server stubbed ----------

it.skipIf(!python)('makes, uploads, and then reuses cards through method explain', async () => {
  const root = temp(); vi.stubEnv('METHOD_CACHE_DIR', join(root, 'cache'));
  const file = join(root, 'leads.method');
  writeFileSync(file, JSON.stringify(method)); writeFileSync(join(root, 'score.py'), script); recordRun(root, [leads[0]]);
  writeMethodId(file, `wf_${'a'.repeat(32)}`);
  const current = (await currentVersion(file))!, wf = current.method_id, v1 = current.version_id;
  const hash = scriptSha256(method, 'score', { 'score.py': sha(script) })!;
  const stored: any[] = []; const drafts = [draft()];
  const fetcher = vi.fn(async (url: any, init: any) => {
    const path = String(url).replace('https://method.example', ''), body = init.body ? JSON.parse(init.body) : undefined;
    if (path === `/api/cli/methods/${wf}?version=${v1}`) return Response.json({ workflow_id: wf, version_id: v1, workflow: method, package: { files: [{ path: 'score.py', sha256: sha(script), size: script.length }] } });
    if (path === `/api/workspace/methods/${wf}/versions/${v1}/script-cards`) return Response.json({ cards: stored });
    if (path === '/api/cli/models/default') return Response.json({ provider: 'openrouter', model: 'test/model' });
    if (path === '/api/cli/models/respond') {
      const content = body.request.response_format.json_schema.name === 'method_program' ? { code: rightProgram } : drafts.shift();
      return Response.json({ model: 'test/model-1', choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] });
    }
    if (path === `/api/cli/methods/${wf}/versions/${v1}/script-cards` && init.method === 'PUT') { stored.push(...body.cards); return Response.json({ saved: body.cards.map((c: any) => c.step_id) }); }
    throw Error(`Unexpected request: ${init.method} ${path}`);
  });
  const client = new MethodClient('https://method.example', fetcher as typeof fetch, join(root, 'credentials'));
  const out: string[] = []; vi.spyOn(process.stdout, 'write').mockImplementation(text => { out.push(String(text)); return true; });
  const anonymous = new MethodClient('https://method.example', fetcher as typeof fetch, join(root, 'nobody'));
  await methodMain(['explain', file], () => anonymous);
  expect(out.join('')).toContain('Script cards skipped: not signed in.');
  expect(fetcher).not.toHaveBeenCalled();
  writePrivateJson(client.credentialFile, { server: client.server, token: 'method_' + 'a'.repeat(43) });
  await methodMain(['explain', file], () => client);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ step_id: 'score', script_sha256: hash, checks: { entities: 'passed', round_trip: 'passed', round_trip_inputs: 1 } });
  expect(out.join('')).toContain('score: Keep each lead in `leads` whose `score` is above 50. [entities passed; round trip passed on 1 input]');
  await methodMain(['explain', file, '--no-round-trip'], () => client);
  expect(out.at(-1)).toBe('score: card exists.\n');
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/models/respond'))).toHaveLength(2);
  expect(readDocument(file)).toEqual({ ...method, format: 'method/3.4', id: wf });
});
