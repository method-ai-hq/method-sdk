import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountNeeds, resolveAgentProfiles } from '../../packages/sdk/src/capabilities.js';
import { configCommand } from '../../packages/sdk/src/computer-settings.js';
import { modelKeyCommand, ownKeyName } from '../../packages/sdk/src/own-model-key.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function computer() {
  const root = mkdtempSync(join(tmpdir(), 'method-own-key-')); roots.push(root);
  // The secret store is under HOME; computer.json is under METHOD_CONFIG_DIR.
  vi.stubEnv('HOME', root); vi.stubEnv('METHOD_CONFIG_DIR', join(root, 'config')); vi.stubEnv(ownKeyName, '');
  vi.stubEnv('CLAUDECODE', ''); vi.stubEnv('CODEX_THREAD_ID', '');
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return root;
}
const settings = (root: string) => JSON.parse(readFileSync(join(root, 'config', 'computer.json'), 'utf8'));
const method = {
  format: 'method/3.4', name: 'Route', goal: 'Route a message.', models: { writer: { model: 'anthropic/claude-luna', reasoning_effort: 'low' } },
  steps: {
    kind: { name: 'Kind', do: { kind: 'classify', question: 'Which team?', options: { a: 'A.', b: 'B.' } }, out: 'kind' },
    write: { name: 'Write', do: { kind: 'call', prompt: 'Write.' }, out: { text: { type: 'text' } } },
    polish: { name: 'Polish', do: { kind: 'call', model: 'writer', prompt: 'Polish.' }, out: { final: { type: 'text' } } },
  },
  result: 'final',
};

it('method config model-key opens the private form for the key, saves only its name, and --off removes it', async () => {
  const root = computer(), asked: string[] = [];
  await modelKeyCommand([], async name => { asked.push(name); });
  expect(asked).toEqual([ownKeyName]);
  expect(settings(root).model_key_env).toBe(ownKeyName);
  expect(readFileSync(join(root, 'config', 'computer.json'), 'utf8')).not.toContain('sk-');
  await configCommand(['model-key', '--off']);
  expect(settings(root).model_key_env).toBeUndefined();
  await expect(modelKeyCommand(['--on'])).rejects.toThrow(/model-key --off/);
});

it('with the own key, hosted model steps and classify call OpenRouter with it, and the run says so once', async () => {
  computer();
  await modelKeyCommand([], async () => {});
  vi.stubEnv(ownKeyName, 'sk-or-test');
  const lines: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => { lines.push(String(chunk)); return true; });
  const config: any = {};
  expect(accountNeeds(method, config).classification).toBe(false);
  const profiles = await resolveAgentProfiles(method, config, undefined, 'openai/gpt-6-luna');
  expect(profiles.default).toMatchObject({ backend: 'openrouter-chat', model: 'openai/gpt-6-luna', api_key_env: ownKeyName });
  expect(profiles.writer).toMatchObject({ backend: 'openrouter-chat', model: 'anthropic/claude-luna', api_key_env: ownKeyName, reasoning_effort: 'low' });
  expect(config.classification).toMatchObject({ provider: 'typesafe', api_key_env: ownKeyName });
  await resolveAgentProfiles(method, {}, undefined, 'openai/gpt-6-luna');
  expect(lines.filter(line => line.includes('OpenRouter'))).toHaveLength(1);
  // A local agent runs the model steps; the own key still classifies.
  const agentConfig: any = {};
  const local = await resolveAgentProfiles(method, agentConfig, 'codex');
  expect(local.default).toEqual({ backend: 'codex' });
  expect(agentConfig.classification).toMatchObject({ api_key_env: ownKeyName });
});

it('a missing key value stops the run with the command that sets it', async () => {
  computer();
  await modelKeyCommand([], async () => {});
  await expect(resolveAgentProfiles(method, {}, undefined, 'openai/gpt-6-luna')).rejects.toThrow(/method config model-key/);
});
