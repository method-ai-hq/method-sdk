import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateInBackground } from '../../packages/sdk/src/update.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function installed() {
  const root = mkdtempSync(join(tmpdir(), 'method-update-')); roots.push(root);
  vi.stubEnv('METHOD_CACHE_DIR', root); vi.stubEnv('METHOD_RELEASE_ROOT', join(root, 'release')); vi.stubEnv('METHOD_NO_UPDATE', '');
  return root;
}

it('installs a newer release in the background once, checking at most once a day', async () => {
  installed();
  const fetcher = vi.fn(async () => new Response('version 99.0.0\nruntime 1.0.0\n')) as unknown as typeof fetch, install = vi.fn();
  expect(await updateInBackground(fetcher, 1000, install)).toBe(true);
  expect(await updateInBackground(fetcher, 2000, install)).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(install).toHaveBeenCalledTimes(1);
  // An installer that did not finish is tried again later.
  expect(await updateInBackground(fetcher, 1000 + 31 * 60_000, install)).toBe(true);
});

it('does nothing when current, offline, turned off, or not an installed release', async () => {
  const install = vi.fn();
  installed();
  expect(await updateInBackground((async () => new Response('version 0.0.1\n')) as unknown as typeof fetch, 1000, install)).toBe(false);
  installed();
  expect(await updateInBackground((async () => { throw Error('offline'); }) as unknown as typeof fetch, 1000, install)).toBe(false);
  installed(); vi.stubEnv('METHOD_NO_UPDATE', '1');
  expect(await updateInBackground((async () => new Response('version 99.0.0\n')) as unknown as typeof fetch, 1000, install)).toBe(false);
  installed(); vi.stubEnv('METHOD_RELEASE_ROOT', '');
  expect(await updateInBackground((async () => new Response('version 99.0.0\n')) as unknown as typeof fetch, 1000, install)).toBe(false);
  expect(install).not.toHaveBeenCalled();
});
