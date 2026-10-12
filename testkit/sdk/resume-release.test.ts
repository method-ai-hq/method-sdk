import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeWithOriginalRelease } from '../../packages/sdk/src/resume-release.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function release(releases: string, name: string, runtime: string, log: string) {
  const dir = join(releases, name), runtimeDir = join(dir, 'sdk', 'node_modules', '@withmethod', 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, 'package.json'), JSON.stringify({ version: runtime }));
  writeFileSync(join(dir, 'method'), `#!/bin/sh\necho "${name} $*" > ${JSON.stringify(log)}\nexit 2\n`, { mode: 0o755 });
  return dir;
}

it('resumes a run with the installed release whose runtime started it', () => {
  const root = mkdtempSync(join(tmpdir(), 'method-resume-')); roots.push(root);
  const releases = join(root, 'releases'), log = join(root, 'log'), runDir = join(root, 'run');
  release(releases, '0.12.1-darwin-arm64', '0.10.0', log);
  vi.stubEnv('METHOD_RELEASE_ROOT', release(releases, '0.14.3-darwin-arm64', '0.12.0', log));
  mkdirSync(runDir); writeFileSync(join(runDir, 'checkpoint.json'), JSON.stringify({ executor_version: '0.10.0' }));
  const args = ['run', 'task.method', '--resume', '--run-dir', runDir];
  expect(resumeWithOriginalRelease(args)).toBe(2);
  expect(readFileSync(log, 'utf8').trim()).toBe(`0.12.1-darwin-arm64 ${args.join(' ')}`);
  // Not a resume, no release with that runtime, or the same runtime: this release runs it.
  expect(resumeWithOriginalRelease(['run', 'task.method', '--run-dir', runDir])).toBeUndefined();
  writeFileSync(join(runDir, 'checkpoint.json'), JSON.stringify({ executor_version: '0.9.9' }));
  expect(resumeWithOriginalRelease(args)).toBeUndefined();
});
