import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { checkedFile } from './files.js';
import type { MethodClient } from './method-client.js';
import { STORED_VALUE, storedValue, type AttachedFile } from '../../workflow-language/src/result-files.js';
import type { RunInspection } from '../../workflow-language/src/inspection.js';

/** Transfer declared artifacts independently; server receipts make retries resumable. */
export async function transferResults(client: MethodClient, directory: string, files: AttachedFile[]) {
  const local = files.filter(f => !f.stored);
  const invalid = local.find(f => f.status !== 'verified');
  if (invalid) throw Error(`Result upload pending: ${invalid.path}: ${invalid.reason}`);
  await sendMissing(client, [...new Map(local.map(f => [f.sha256, f])).values()].map(f => ({sha256: f.sha256, bytes: f.bytes ?? 0,
    read: () => checkedFile({path:resolve(directory, 'artifacts', f.path),sha256:f.sha256}, [join(directory, 'artifacts')]).bytes})));
  return files.map(({data, encoding, text, reason, ...file}) => ({...file, stored:true}));
}

/** Send the result files that the server does not have yet. */
async function sendMissing(client: MethodClient, unique: Array<{sha256: string; bytes: number; read: () => Uint8Array}>) {
  const missing = new Set<string>();
  for (let offset = 0; offset < unique.length; offset += 256) {
    const result = await client.request<{missing:string[]}>('/api/cli/result-files/missing', 'POST', {
      files: unique.slice(offset, offset + 256).map(f => ({sha256:f.sha256, bytes:f.bytes})),
    });
    result.missing.forEach(hash => missing.add(hash));
  }
  const send = (file: typeof unique[number]) => client.transfer(`/api/cli/result-files/${file.sha256}`, file.read());
  const needed = unique.filter(f => missing.has(f.sha256));
  // Avoid concurrent large buffers on the receiving Worker.
  for (const file of needed.filter(f => f.bytes > 4_000_000)) await send(file);
  const queue = needed.filter(f => f.bytes <= 4_000_000);
  let next = 0;
  const results = await Promise.allSettled(Array.from({length: Math.min(6, queue.length)}, async () => {
    while (next < queue.length) {
      const file = queue[next++]!;
      await send(file);
    }
  }));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
}

/** A run record above this size moves its largest step values to stored files. The server refuses a record above 40 MB. */
export const RECORD_BUDGET = 20_000_000;
/** A step value of this size or more is always stored, so a record that is sent again does not send it again. */
export const STORED_VALUE_BYTES = 256_000;
/** The largest stored value; the server refuses a larger result file. */
const MAX_STORED_VALUE_BYTES = 25_000_000;

/**
 * Move large step inputs and outputs out of a run record. Each moved value becomes a reference to a result file that
 * holds its JSON; equal values share one file. Values move largest first until the record fits the budget, and every
 * value of STORED_VALUE_BYTES or more moves. The same record always gives the same references.
 */
export function moveLargeValues(inspection: RunInspection, budget = RECORD_BUDGET) {
  const values = new Map<string, Uint8Array>();
  const slots: Array<{id: string; side: 'inputs' | 'outputs'; name: string; bytes: number}> = [];
  for (const [id, row] of Object.entries(inspection.invocations))
    for (const side of ['inputs', 'outputs'] as const)
      for (const [name, value] of Object.entries(row[side] ?? {}))
        if (!storedValue(value)) slots.push({id, side, name, bytes: Buffer.byteLength(JSON.stringify(value) ?? '')});
  slots.sort((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id) || a.side.localeCompare(b.side) || a.name.localeCompare(b.name));
  let size = Buffer.byteLength(JSON.stringify(inspection));
  const invocations = {...inspection.invocations};
  for (const slot of slots) {
    if (size <= budget && slot.bytes < STORED_VALUE_BYTES) break;
    const row = invocations[slot.id]!, value = row[slot.side]![slot.name];
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    if (bytes.byteLength > MAX_STORED_VALUE_BYTES)
      throw Error(`The ${slot.side === 'inputs' ? 'input' : 'output'} ${slot.name} of step ${row.step_id} is ${(bytes.byteLength / 1e6).toFixed(1)} MB. A step value can be at most 25 MB; put a larger value in a file output.`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    values.set(sha256, bytes);
    const reference = {[STORED_VALUE]: {sha256, bytes: bytes.byteLength}};
    invocations[slot.id] = {...row, [slot.side]: {...row[slot.side], [slot.name]: reference}};
    size -= slot.bytes - Buffer.byteLength(JSON.stringify(reference));
  }
  return {inspection: values.size ? {...inspection, invocations} : inspection, values};
}

/** Send the stored values of moveLargeValues that the server does not have yet. */
export async function transferValues(client: MethodClient, values: Map<string, Uint8Array>) {
  await sendMissing(client, [...values].map(([sha256, bytes]) => ({sha256, bytes: bytes.byteLength, read: () => bytes})));
}
