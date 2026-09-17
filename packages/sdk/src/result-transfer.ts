import { join } from 'node:path';
import { checkedFile } from './files.js';
import type { MethodClient } from './method-client.js';
import type { AttachedFile } from '../../workflow-language/src/result-files.js';

/** Transfer declared artifacts independently; server receipts make retries resumable. */
export async function transferResults(client: MethodClient, directory: string, files: AttachedFile[]) {
  const local = files.filter(f => !f.stored);
  const invalid = local.find(f => f.status !== 'verified');
  if (invalid) throw Error(`Result upload pending: ${invalid.path}: ${invalid.reason}`);
  const unique = [...new Map(local.map(f => [f.sha256, f])).values()];
  const missing = new Set<string>();
  for (let offset = 0; offset < unique.length; offset += 256) {
    const result = await client.request<{missing:string[]}>('/api/cli/result-files/missing', 'POST', {
      files: unique.slice(offset, offset + 256).map(f => ({sha256:f.sha256, bytes:f.bytes})),
    });
    result.missing.forEach(hash => missing.add(hash));
  }
  const send = async (file: AttachedFile) => {
    const bytes = checkedFile({path:join(directory, 'artifacts', file.path),sha256:file.sha256}, [join(directory, 'artifacts')]).bytes;
    await client.transfer(`/api/cli/result-files/${file.sha256}`, bytes);
  };
  const needed = unique.filter(f => missing.has(f.sha256));
  // Avoid concurrent large buffers on the receiving Worker.
  for (const file of needed.filter(f => (f.bytes ?? 0) > 4_000_000)) await send(file);
  const queue = needed.filter(f => (f.bytes ?? 0) <= 4_000_000);
  let next = 0;
  const results = await Promise.allSettled(Array.from({length: Math.min(6, queue.length)}, async () => {
    while (next < queue.length) {
      const file = queue[next++]!;
      await send(file);
    }
  }));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
  return files.map(({data, encoding, text, reason, ...file}) => ({...file, stored:true}));
}
