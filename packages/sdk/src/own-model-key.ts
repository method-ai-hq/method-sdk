/**
 * Your own OpenRouter key on this computer (method config model-key). With it, every hosted model step (the Method's
 * models, model IDs, and the account default) and every classify step calls OpenRouter directly with that key, in
 * place of the account's model credit. The value stays in the device secret store; computer.json holds only its name.
 */
import { typesafeModel } from '@withmethod/runtime/classification.js';
import { readComputerSettings, updateComputerSettings } from './computer-settings.js';
import { resolveSecrets, setSecret } from './secrets.js';

export const ownKeyName = 'OPENROUTER_API_KEY';
// The output limit of a hosted request; a direct OpenRouter profile needs one.
const outputTokens = 16_000;

/** The name of this computer's own model key, or undefined. A local agent (--agent) replaces it for model steps. */
export const ownKeyEnv = () => readComputerSettings().model_key_env;

/** method config model-key [--off]: open the private form for the key, then use it for model and classify steps. */
export async function modelKeyCommand(args: string[], set: (name: string) => Promise<unknown> = setSecret) {
  if (args.length > 1 || (args[0] !== undefined && args[0] !== '--off')) throw Error('Use method config model-key, or method config model-key --off.');
  if (args[0] === '--off') {
    updateComputerSettings(settings => { delete settings.model_key_env; });
    process.stdout.write('Model and classify steps use the Method account again. The key stays in the secret store; method secret list shows it.\n');
    return;
  }
  if (!resolveSecrets([ownKeyName])[ownKeyName]) await set(ownKeyName);
  updateComputerSettings(settings => { settings.model_key_env = ownKeyName; });
  process.stdout.write(`Model and classify steps on this computer use your own OpenRouter key (${ownKeyName}). Turn it off with method config model-key --off.\n`);
}

/**
 * The resolved model profiles with each hosted profile (backend method) sent to OpenRouter with the own key. Other
 * profiles (a local agent) are unchanged. The key value is put into this process's environment from the device store,
 * so the runtime reads it by name; scripts receive only their declared secrets.
 */
export function withOwnKey(profiles: Record<string, any>, env: string): Record<string, any> {
  loadOwnKey(env);
  return Object.fromEntries(Object.entries(profiles).map(([name, profile]) => [name, profile?.backend === 'method'
    ? { backend: 'openrouter-chat', model: profile.model, api_key_env: env, max_output_tokens: profile.max_output_tokens ?? outputTokens, ...(profile.reasoning_effort ? { reasoning_effort: profile.reasoning_effort } : {}) }
    : profile]));
}

/** Put the own key's value into this process's environment (a shell value is used first). required: fail without one. */
export function loadOwnKey(env: string, required = true) {
  const value = resolveSecrets([env])[env];
  if (!value) {
    if (required) throw Object.assign(Error(`${env} has no value on this computer. Run method config model-key, or method config model-key --off.`), { code: 'needs_input' });
    return;
  }
  if (!process.env[env]) process.env[env] = value;
}

/** The classifier setting that calls Jev through OpenRouter with the own key. */
export const ownKeyClassification = (env: string) => ({ provider: 'typesafe', model: typesafeModel, api_key_env: env });

let announced = false;
/** The run's one line about the own key. */
export function announceOwnKey(write: (line: string) => void = line => process.stderr.write(line + '\n')) {
  if (announced) return;
  announced = true;
  write('Using your own OpenRouter key');
}
