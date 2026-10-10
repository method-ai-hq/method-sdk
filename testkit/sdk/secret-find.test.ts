import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSecrets } from '../../packages/sdk/src/secrets.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

it('finds key names in nearby files and prints the import command, never a value', () => {
  const root = mkdtempSync(join(tmpdir(), 'method-find-')); roots.push(root);
  vi.stubEnv('HOME', join(root, 'home'));
  const project = join(root, 'cuties'), other = join(root, 'community-archive');
  mkdirSync(join(project, 'node_modules', 'pkg'), { recursive: true }); mkdirSync(other);
  writeFileSync(join(other, '.env'), 'export ARCHIVE_TOKEN="value-one-secret"\nOPENROUTER_API_KEY=value-two-secret\nEMPTY=\n');
  writeFileSync(join(project, 'node_modules', 'pkg', '.env'), 'IGNORED=1\n');
  const result = findSecrets(['ARCHIVE_TOKEN', 'MISSING_KEY'], project);
  expect(result.files.map((file: any) => file.path)).toEqual(['../community-archive/.env']);
  expect(result.next).toEqual(['method secret import "../community-archive/.env" ARCHIVE_TOKEN']);
  expect(result.not_found).toEqual(['MISSING_KEY']);
  expect(JSON.stringify(result)).not.toMatch(/value-one|value-two/);
});
