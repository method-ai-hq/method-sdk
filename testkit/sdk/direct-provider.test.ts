import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { methodMain } from '../../packages/sdk/src/method.js';
import { hostedModelUses } from '../../packages/sdk/src/method-issues.js';
import { accountNeeds, resolveAgentProfiles } from '../../packages/sdk/src/capabilities.js';
import { modelKeyCommand, ownKeyName } from '../../packages/sdk/src/own-model-key.js';

// A Method whose model step calls Anthropic directly with the operator's own key: no request goes through the Method
// account or OpenRouter.
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); process.exitCode = 0; });
vi.stubEnv('METHOD_NO_BACKGROUND_CHECKS', '1');

const key = 'sk-ant-test-direct-0123456789abcdef';
const text = (secrets = '  ANTHROPIC_API_KEY: Anthropic API key for the extractor model.\n') => `format: method/3.4
name: Read the vendor
goal: Read the vendor of a bill.
models:
  extractor: {provider: anthropic, model: claude-sonnet-4-6, key: ANTHROPIC_API_KEY, max_output_tokens: 16000}
${secrets ? `secrets:\n${secrets}` : ''}inputs:
  notes: {type: text, description: The text of the bill.}
steps:
  extract:
    name: Extract
    purpose: Reads the vendor name from the bill text. Changes nothing.
    in: {notes: inputs.notes}
    do: {kind: call, model: extractor, prompt: "Return the vendor name of this bill: {{notes}}"}
    out:
      vendor: {type: text, description: The vendor name.}
result: vendor
`;
function computer(methodText = text()) {
  const root = mkdtempSync(join(tmpdir(), 'method-direct-')); roots.push(root);
  vi.stubEnv('HOME', root); vi.stubEnv('METHOD_CONFIG_DIR', join(root, 'config')); vi.stubEnv(ownKeyName, '');
  vi.stubEnv('CLAUDECODE', ''); vi.stubEnv('CODEX_THREAD_ID', ''); vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.spyOn(process, 'cwd').mockReturnValue(join(root, 'work'));
  mkdirSync(join(root, 'work'), { recursive: true });
  const file = join(root, 'work', 'vendor.method');
  writeFileSync(file, methodText);
  return { root, file };
}
function printed() {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return () => { const all = out.mock.calls.map(call => String(call[0])).join(''); out.mockClear(); return JSON.parse(all); };
}
/** Every fetch of the test: Anthropic answers, anything else fails the test. */
function anthropic() {
  const sent: { url: string; headers: any; body: any }[] = [];
  vi.stubGlobal('fetch', async (url: any, init: any) => {
    sent.push({ url: String(url), headers: init?.headers, body: init?.body ? JSON.parse(init.body) : undefined });
    if (String(url) !== 'https://api.anthropic.com/v1/messages') throw Error(`Unexpected request: ${url}`);
    return Response.json({ type: 'message', role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ vendor: 'Acme Supply' }) }], usage: { input_tokens: 20, output_tokens: 6 } });
  });
  return sent;
}

it('a direct provider entry is not a hosted model and needs no Method account', () => {
  const doc = YAML.parse(text());
  expect(hostedModelUses(doc)).toEqual([]);
  expect(accountNeeds(doc, {}).models).toBe(false);
});

it('validate accepts a declared key and says the step calls Anthropic with your own key', async () => {
  const { file } = computer();
  vi.stubEnv('ANTHROPIC_API_KEY', key);
  const result = printed();
  await methodMain(['validate', file]);
  const output = result();
  expect(process.exitCode ?? 0).toBe(0);
  expect(output).toMatchObject({ valid: true, issue_counts: { errors: 0 } });
  expect(output.steps).toEqual([{ id: 'extract', runs: 'claude-sonnet-4-6 at Anthropic with your own key (ANTHROPIC_API_KEY)' }]);
});

it('validate names the missing key of a direct provider as what the step needs', async () => {
  const { file } = computer();
  const result = printed();
  await methodMain(['validate', file]);
  const output = result();
  expect(output.steps).toEqual([expect.objectContaining({ id: 'extract', needs: ['secret ANTHROPIC_API_KEY'] })]);
  expect(output.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'missing_secret' })]));
});

it('validate refuses a direct provider key that the Method does not declare', async () => {
  const { file } = computer(text(''));
  const result = printed();
  await methodMain(['validate', file]);
  const output = result();
  expect(process.exitCode).toBe(1);
  expect(output.valid).toBe(false);
  expect(JSON.stringify(output)).toContain('undeclared_model_key');
});

it('with an own OpenRouter key, a direct provider still calls the provider, not OpenRouter', async () => {
  computer();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await modelKeyCommand([], async () => {});
  vi.stubEnv(ownKeyName, 'sk-or-test');
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const profiles = await resolveAgentProfiles(YAML.parse(text()), {});
  expect(profiles.extractor).toEqual({ backend: 'anthropic-messages', model: 'claude-sonnet-4-6', api_key_env: 'ANTHROPIC_API_KEY', max_output_tokens: 16000 });
});

it('method run sends the step to api.anthropic.com with the key from the environment, and the key stays out of the run records', async () => {
  const { root, file } = computer();
  vi.stubEnv('ANTHROPIC_API_KEY', key);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const sent = anthropic();
  const inputs = join(root, 'inputs.json');
  writeFileSync(inputs, JSON.stringify({ notes: 'INVOICE from Acme Supply, net 30.' }));
  const runDir = join(root, 'run');
  const result = printed();
  await methodMain(['run', file, '--inputs', inputs, '--run-dir', runDir]);
  const output = result();
  expect(output.status, JSON.stringify(output.failure)).toBe('completed');
  expect(output.result).toBe('Acme Supply');
  // One request, to Anthropic only: nothing went to the Method account or OpenRouter.
  expect(sent.map(request => request.url)).toEqual(['https://api.anthropic.com/v1/messages']);
  expect(sent[0]!.headers['x-api-key']).toBe(key);
  expect(sent[0]!.body).toMatchObject({ model: 'claude-sonnet-4-6', max_tokens: 16000 });
  const files = readdirSync(runDir, { recursive: true }).map(String).map(name => join(runDir, name)).filter(path => existsSync(path) && statSync(path).isFile());
  for (const path of files) expect(readFileSync(path, 'utf8').includes(key), path).toBe(false);
});
