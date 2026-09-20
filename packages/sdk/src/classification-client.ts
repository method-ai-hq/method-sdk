import { z } from 'zod';
import type { ClassificationProvider } from '@withmethod/runtime';
import { classificationByteLimit, validateClassification } from '@withmethod/runtime/classification.js';
import { MethodClient } from './method-client.js';

const Identity = z.strictObject({provider: z.literal('typesafe'), model: z.string().trim().min(1)});
/** Use the same Method account and server as the run. Each evaluation is one attempt. */
export function managedClassification(client: MethodClient): ClassificationProvider {
  const options = (signal: AbortSignal) => ({signal, timeoutMs: 30_000, maxResponseBytes: classificationByteLimit});
  return {
    async resolve(signal) {
      return Identity.parse(await client.request('/api/cli/classifications/model', 'GET', undefined, true, options(signal)));
    },
    async evaluate(request, signal) {
      if (Buffer.byteLength(JSON.stringify(request), 'utf8') > classificationByteLimit)
        throw Object.assign(Error('Classification input exceeds request limit.'), {code: 'input_limit'});
      let answer: Awaited<ReturnType<ClassificationProvider['evaluate']>>;
      try { answer = await client.request('/api/cli/classifications', 'POST', request, true, options(signal)); }
      catch (error: any) {
        if (error.status === 409) throw Object.assign(Error("This run's classifier version is unavailable. Start a new run to use the current default."), {code: 'classification_version_unavailable'});
        throw error;
      }
      validateClassification(answer, request.options, {provider: 'typesafe', model: request.model});
      return answer;
    },
  };
}
