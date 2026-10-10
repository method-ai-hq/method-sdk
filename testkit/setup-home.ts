// Every test runs with a temporary HOME: sign-ins, computer settings, the outbox, and run caches never touch this
// computer's real files. A write under the real home folder (outside this repository) throws.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const realHome = process.env.METHOD_TEST_REAL_HOME!;
const repository = resolve(process.cwd());
const home = mkdtempSync(join(tmpdir(), 'method-test-home-'));
process.env.HOME = home;
delete process.env.METHOD_CONFIG_DIR;
// Downloaded tools and prepared environments are large and keyed by content: share them read-mostly.
mkdirSync(join(home, '.cache', 'method'), { recursive: true });
for (const name of ['tools', 'environments']) if (existsSync(join(realHome, '.cache', 'method', name))) symlinkSync(join(realHome, '.cache', 'method', name), join(home, '.cache', 'method', name));

export const underRealHome = (path: unknown) => {
  if (typeof path !== 'string' && !(path instanceof URL)) return false;
  const full = resolve(path instanceof URL ? path.pathname : path);
  return (full === realHome || full.startsWith(realHome + sep)) && !full.startsWith(repository + sep) && full !== repository
    && !full.startsWith(join(home, '.cache', 'method') + sep);
};
const guard = (name: string, fn: (...args: any[]) => any, paths = [0]) => function (this: unknown, ...args: any[]) {
  for (const at of paths) if (underRealHome(args[at])) throw Error(`A test wrote under the real home folder: ${name} ${String(args[at])}`);
  return fn.apply(this, args);
};
const fs = createRequire(import.meta.url)('node:fs');
for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'mkdtempSync', 'symlinkSync', 'chmodSync'])
  fs[name] = guard(name, fs[name], name === 'symlinkSync' ? [1] : [0]);
for (const name of ['renameSync', 'copyFileSync', 'cpSync']) fs[name] = guard(name, fs[name], [0, 1].slice(name === 'renameSync' ? 0 : 1));
const open = fs.openSync;
fs.openSync = function (path: any, flags: any = 'r', ...rest: any[]) { if (flags !== 'r' && underRealHome(path)) throw Error(`A test wrote under the real home folder: openSync ${path}`); return open.call(this, path, flags, ...rest); };
for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename', 'copyFile', 'cp']) {
  const checked = guard(name, fs.promises[name], name === 'rename' || name === 'copyFile' || name === 'cp' ? [1] : [0]);
  fs.promises[name] = async function (this: unknown, ...args: any[]) { return checked.apply(this, args); };
}
syncBuiltinESMExports();
