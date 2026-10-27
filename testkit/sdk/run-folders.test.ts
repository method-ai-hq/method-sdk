import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findRunFolder, runFolderIndex } from '../../packages/sdk/src/local-judgments.js';
import { localRunId } from '../../packages/sdk/src/local-answer.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A finished run folder: its Method record and its account link. */
function runFolder(dir: string, accountRunId: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'method.json'), JSON.stringify({ name: 'Agent' }));
  writeFileSync(join(dir, 'method-sync.json'), JSON.stringify({ id: crypto.randomUUID(), dashboard_id: accountRunId }));
}

it('finds a run that ran with --run-dir outside the cache, as a comparison\'s training run does, by its account run ID', () => {
  const root = mkdtempSync(join(tmpdir(), 'method-run-folders-'));
  roots.push(root);
  vi.stubEnv('METHOD_CACHE_DIR', join(root, 'cache'));
  const cached = join(root, 'cache', 'runs', 'a1'), elsewhere = join(root, 'compare', 'events', '1', 'run');
  runFolder(cached, 'run_cached');
  runFolder(elsewhere, 'run_training');
  const id = localRunId(elsewhere);

  expect(findRunFolder('run_training')).toBe(elsewhere);
  expect(findRunFolder(id)).toBe(elsewhere);
  expect(findRunFolder('run_cached')).toBe(cached);
  const index = runFolderIndex();
  expect(index.get('run_training')).toBe(elsewhere);
  expect(index.get('run_cached')).toBe(cached);
  // A listed folder that is gone is not a run on this computer.
  rmSync(elsewhere, { recursive: true });
  expect(findRunFolder('run_training')).toBeUndefined();
  expect(runFolderIndex().has('run_training')).toBe(false);
});
