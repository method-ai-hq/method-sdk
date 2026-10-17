import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { writePrivateJson } from './files.js';

/** METHOD_CONFIG_DIR selects another folder for sign-ins and computer settings (tests use a temporary one). */
export const configRoot = () => process.env.METHOD_CONFIG_DIR || join(homedir(), '.config', 'method');
export const computerFile = () => join(configRoot(), 'computer.json');

// Only settings of this computer. Run limits belong to each Method (format 3.4 limits), never to the computer.
const Settings = z.object({
  // METHOD_ID -> connection name -> a folder path, or a connection value (URL or method-browser:NAME).
  bindings: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  // The environment variable with this computer's own OpenRouter key: classify then calls Jev directly with it.
  classification_key_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  // The name of this computer's own OpenRouter key (method config model-key): hosted model and classify steps use it.
  model_key_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
});
export type ComputerSettings = z.infer<typeof Settings>;

/** The settings of this computer: connection bindings and an own model key. Nothing in a Method file. */
export function readComputerSettings(): ComputerSettings {
  const file = computerFile();
  if (!existsSync(file)) return { bindings: {} };
  try { return Settings.parse(JSON.parse(readFileSync(file, 'utf8'))); }
  catch (error) { throw Error(`${file} is not valid: ${(error as Error).message.slice(0, 300)} Fix or delete the file.`); }
}
export function updateComputerSettings(change: (settings: ComputerSettings) => void): ComputerSettings {
  const settings = readComputerSettings();
  change(settings);
  const parsed = Settings.parse(settings);
  writePrivateJson(computerFile(), parsed);
  return parsed;
}
export function bindConnectionValue(methodId: string, name: string, value: string) {
  updateComputerSettings(settings => { settings.bindings[methodId] = { ...settings.bindings[methodId], [name]: value }; });
}

/** method config: print the computer settings, or turn the own model key on or off. */
export async function configCommand(args: string[]) {
  const [key] = args;
  if (!key) { process.stdout.write(JSON.stringify({ file: computerFile(), ...readComputerSettings() }, null, 2) + '\n'); return; }
  if (key === 'model-key') return (await import('./own-model-key.js')).modelKeyCommand(args.slice(1));
  throw Error('Use method config, or method config model-key [--off].');
}
