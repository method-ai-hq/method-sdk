import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import packageInfo from '../package.json' with { type: 'json' };
import { methodCache } from './prepare.js';
import { writePrivateJson } from './files.js';

const day = 86_400_000, installWindow = 30 * 60_000;
const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map(v => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if ((x![i] ?? 0) !== (y![i] ?? 0)) return (x![i] ?? 0) > (y![i] ?? 0);
  return false;
};
const read = (path: string) => { try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined; } catch { return undefined; } };

/** Run the installer in its own process; this command does not wait for it, and it prints nothing. */
function startInstaller() {
  const url = process.env.METHOD_INSTALL_URL ?? 'https://app.withmethod.ai/install.sh';
  spawn('/bin/sh', ['-c', 'curl -fsSL "$1" | sh', 'method-update', url], { detached: true, stdio: 'ignore', env: { ...process.env, METHOD_SKIP_PLUGIN: '1' } }).unref();
}

/**
 * Keep an installed CLI current with no message: at most once a day it reads the newest release from the version
 * pointer that the installer reads, and when that is newer it installs it in the background. The command that started
 * the check continues on this release; the next command uses the new one, and running commands keep their release.
 * Only an installed release updates itself (not a development or npm copy). METHOD_NO_UPDATE=1 turns it off.
 */
export async function updateInBackground(fetcher: typeof fetch = fetch, now = Date.now(), install = startInstaller) {
  if (process.env.METHOD_NO_UPDATE || !process.env.METHOD_RELEASE_ROOT) return false;
  const cache = join(methodCache(), 'latest.json'), lock = join(methodCache(), 'update.json');
  let latest: string | undefined;
  try {
    const saved = read(cache);
    if (saved && now - saved.checked_at < day) latest = saved.version;
    else {
      const target = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
      const base = process.env.METHOD_DOWNLOAD_URL ?? 'https://app.withmethod.ai/downloads/cli';
      const response = await fetcher(`${base}/latest-${target}.txt`, { signal: AbortSignal.timeout(2000) });
      latest = response.ok ? /^version (\S+)$/m.exec(await response.text())?.[1] : undefined;
      writePrivateJson(cache, { checked_at: now, version: latest ?? null });
    }
    if (!latest || !newer(latest, packageInfo.version)) return false;
    // One installer at a time; a failed one is tried again after the window.
    const running = read(lock);
    if (running?.version === latest && now - running.started_at < installWindow) return false;
    writePrivateJson(lock, { version: latest, started_at: now });
    install();
    return true;
  } catch { return false; }
}
