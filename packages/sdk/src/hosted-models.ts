import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { HostedModels } from '@withmethod/runtime';
import { MethodClient } from './method-client.js';

const Default = z.object({ provider: z.literal('openrouter'), model: z.string().trim().min(1) });
// A model service that is briefly unavailable gets three attempts in all, like classification.
const attempts = 3;

/** Where a run's hosted model requests go: this computer's own OpenRouter key when it has one, else the account. */
export async function hostedModelsFor(client: MethodClient): Promise<HostedModels> {
  const { ownKeyEnv, ownKeyModels } = await import('./own-model-key.js');
  const env = ownKeyEnv();
  return env ? ownKeyModels(env) : managedModels(client);
}

/** Hosted models through the signed-in Method account. The account's model credit pays for them. */
export function managedModels(client: MethodClient): HostedModels & { model(): Promise<string> } {
  return {
    async model() {
      return Default.parse(await client.request('/api/cli/models/default', 'GET', undefined, true, { stallMs: 30_000 })).model;
    },
    async request(body, signal) {
      const request = { request_id: randomUUID(), request: body };
      for (let attempt = 1; ; attempt++) {
        try {
          return await client.request('/api/cli/models/respond', 'POST', request, true, { signal, stallMs: 180_000, maxResponseBytes: 4 * 1024 * 1024 });
        } catch (error: any) {
          if (attempt >= attempts || signal.aborted || !(error.status === 503 || error.status === 429) || error.code === 'model_credit_used') throw error;
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
    },
  };
}

const PrivateModels = z.object({ models: z.array(z.object({ id: z.string(), providers: z.array(z.string()) })), default: z.string().nullable().optional(), checked_at: z.string() });
export type PrivateModelList = z.infer<typeof PrivateModels>;
const day = 24 * 60 * 60_000;
/**
 * The hosted models that work with the private options (no training, zero data retention), from the server. The list
 * is kept for a day under the Method cache; undefined when it cannot be fetched and no copy is saved.
 */
export async function privateModels(client: MethodClient, options: { refresh?: boolean; waitMs?: number } = {}): Promise<PrivateModelList | undefined> {
  const { methodCache } = await import('./prepare.js');
  const { createHash } = await import('node:crypto');
  const { existsSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { writePrivateJson } = await import('./files.js');
  const file = join(methodCache(), 'models', `private-${createHash('sha256').update(client.server).digest('hex').slice(0, 16)}.json`);
  let saved: PrivateModelList | undefined;
  try { saved = existsSync(file) ? PrivateModels.parse(JSON.parse(readFileSync(file, 'utf8'))) : undefined; } catch { saved = undefined; }
  if (saved && !options.refresh && Date.now() - Date.parse(saved.checked_at) < day) return saved;
  try {
    const signal = options.waitMs ? AbortSignal.timeout(options.waitMs) : undefined;
    const list = PrivateModels.parse(await client.request('/api/cli/models/private', 'GET', undefined, true, { stallMs: 15_000, ...(signal ? { signal } : {}) }));
    writePrivateJson(file, list);
    return list;
  } catch (error) { if (options.refresh && !saved) throw error; return saved; }
}

/** method models [--refresh] [--server URL]: the hosted models that work with the private options. */
export async function modelsCommand(args: string[], clientFactory: (server: string) => MethodClient) {
  const { parseArgs } = await import('node:util');
  const { DEFAULT_SERVER } = await import('./method-client.js');
  const { values } = parseArgs({ args, options: { refresh: { type: 'boolean' }, server: { type: 'string' } } });
  const client = clientFactory(values.server ?? DEFAULT_SERVER);
  if (!client.token()) throw Error('Run method login first. The list of private models comes from your Method account.');
  const list = await privateModels(client, { refresh: !!values.refresh });
  if (!list) throw Error('Method cannot be reached, and no saved list exists. Try again when online.');
  process.stdout.write(JSON.stringify({ private: 'Each model below has a provider that does not train on requests and keeps no copy (zero data retention). Hosted runs use only those providers.',
    default: list.default ?? null, checked_at: list.checked_at, models: list.models.map(model => model.id), use: 'Name a model ID on a step (model: provider/model) or in models:.' }, null, 2) + '\n');
}
