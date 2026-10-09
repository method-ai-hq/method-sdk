import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { HostedModels } from '@withmethod/runtime';
import { MethodClient } from './method-client.js';

const Default = z.object({ provider: z.literal('openrouter'), model: z.string().trim().min(1) });
// A model service that is briefly unavailable gets three attempts in all, like classification.
const attempts = 3;

/** Hosted models through the signed-in Method account. The account's model credit pays for them. */
export function managedModels(client: MethodClient): HostedModels & { model(): Promise<string> } {
  return {
    async model() {
      return Default.parse(await client.request('/api/cli/models/default', 'GET', undefined, true, { timeoutMs: 30_000 })).model;
    },
    async request(body, signal) {
      const request = { request_id: randomUUID(), request: body };
      for (let attempt = 1; ; attempt++) {
        try {
          return await client.request('/api/cli/models/respond', 'POST', request, true, { signal, timeoutMs: 180_000, maxResponseBytes: 4 * 1024 * 1024 });
        } catch (error: any) {
          if (attempt >= attempts || signal.aborted || !(error.status === 503 || error.status === 429) || error.code === 'model_credit_used') throw error;
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
    },
  };
}
