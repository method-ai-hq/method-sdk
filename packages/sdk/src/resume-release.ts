import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import runtimeInfo from '@withmethod/runtime/package.json' with { type: 'json' };

const read = (path: string) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; } };

/**
 * A run resumes with the runtime that started it. When the CLI updated itself since then, the command runs again with
 * the installed release that has that runtime (releases are kept), and returns its exit code. Undefined: run here.
 */
export function resumeWithOriginalRelease(args: string[]) {
  const at = args.indexOf('--run-dir'), releaseRoot = process.env.METHOD_RELEASE_ROOT;
  if (!args.includes('--resume') || at < 0 || !args[at + 1] || !releaseRoot) return undefined;
  const wanted = read(join(resolve(args[at + 1]!), 'checkpoint.json'))?.executor_version;
  if (typeof wanted !== 'string' || wanted === runtimeInfo.version) return undefined;
  const releases = dirname(releaseRoot);
  const match = readdirSync(releases).filter(name => existsSync(join(releases, name, 'method')))
    .filter(name => read(join(releases, name, 'sdk', 'node_modules', '@withmethod', 'runtime', 'package.json'))?.version === wanted)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  if (!match) return undefined;
  const result = spawnSync(join(releases, match, 'method'), args, { stdio: 'inherit', env: { ...process.env, METHOD_NO_UPDATE: '1' } });
  return result.status ?? 1;
}
