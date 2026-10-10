/**
 * Your own OpenRouter key on this computer (method config model-key). With it, every hosted model step (the Method's
 * models, model IDs, and the account default) and every classify step calls OpenRouter directly with that key, in
 * place of the account's model credit. The value stays in the device secret store; computer.json holds only its name.
 */
import { typesafeModel } from '@withmethod/runtime/classification.js';
import { readComputerSettings, updateComputerSettings } from './computer-settings.js';
import { findSecrets, importSecrets, resolveSecrets, setSecret } from './secrets.js';
import type { HostedModels } from '@withmethod/runtime';

export const ownKeyName = 'OPENROUTER_API_KEY';
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
  if (!resolveSecrets([ownKeyName])[ownKeyName]) {
    // One nearby key file holds the key (the team's .env, an old pipeline's): import it, without showing it. With
    // several, the person chooses in the form.
    const files = findSecrets([ownKeyName]).secrets?.[ownKeyName]?.in_files ?? [];
    const file = files.length === 1 ? files[0] : undefined;
    if (file) {
      importSecrets(file, [ownKeyName]);
      process.stdout.write(`Imported ${ownKeyName} from ${file}.\n`);
    } else await set(ownKeyName);
  }
  updateComputerSettings(settings => { settings.model_key_env = ownKeyName; });
  process.stdout.write(`Model and classify steps on this computer use your own OpenRouter key (${ownKeyName}). Turn it off with method config model-key --off.\n`);
}

/**
 * Hosted model requests sent to OpenRouter with the own key, in place of the account: the same request, with the same
 * private options as the account (no training on the data, zero data retention). Every hosted profile uses it, the
 * Method's own models too.
 */
export function ownKeyModels(env: string): HostedModels {
  loadOwnKey(env);
  return {
    async request(body: any, signal: AbortSignal) {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', signal, headers: { authorization: `Bearer ${process.env[env]}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, provider: { ...(body.provider ?? {}), data_collection: 'deny', zdr: true }, usage: { include: true } }),
      });
      const data: any = await response.json().catch(() => null);
      if (!response.ok) throw Object.assign(Error(`${response.status}: ${data?.error?.message ?? 'OpenRouter refused the request'} (your own key, ${env})`), { status: response.status });
      return data;
    },
  };
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
