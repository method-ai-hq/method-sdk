import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateNotice } from '../../packages/sdk/src/update.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

it('names a newer release once a day, and stays silent when offline or current', async () => {
  const root = mkdtempSync(join(tmpdir(), 'method-update-')); roots.push(root);
  vi.stubEnv('METHOD_CACHE_DIR', root);
  const fetcher = vi.fn(async () => new Response('version 99.0.0\nruntime 1.0.0\n')) as unknown as typeof fetch;
  expect(await updateNotice(fetcher, 1000)).toMatch(/^Method 99\.0\.0 is available \(you have /);
  expect(await updateNotice(fetcher, 2000)).toMatch(/99\.0\.0/);
  expect(fetcher).toHaveBeenCalledTimes(1);
  vi.stubEnv('METHOD_CACHE_DIR', join(root, 'other'));
  expect(await updateNotice((async () => { throw Error('offline'); }) as unknown as typeof fetch)).toBeUndefined();
  vi.stubEnv('METHOD_CACHE_DIR', join(root, 'third'));
  expect(await updateNotice((async () => new Response('version 0.0.1\n')) as unknown as typeof fetch)).toBeUndefined();
});
