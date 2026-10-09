import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import packageInfo from '../package.json' with { type: 'json' };
import { methodCache } from './prepare.js';
import { writePrivateJson } from './files.js';

const day = 86_400_000;
const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map(v => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if ((x![i] ?? 0) !== (y![i] ?? 0)) return (x![i] ?? 0) > (y![i] ?? 0);
  return false;
};

/**
 * The newest release, from the version pointer that the installer reads, checked at most once a day.
 * Returns a one-line notice when it is newer than this CLI, or nothing. A network problem is never an error.
 */
export async function updateNotice(fetcher: typeof fetch = fetch, now = Date.now()) {
  const cache = join(methodCache(), 'latest.json');
  let latest: string | undefined;
  try {
    const saved = existsSync(cache) ? JSON.parse(readFileSync(cache, 'utf8')) : null;
    if (saved && now - saved.checked_at < day) latest = saved.version;
    else {
      const target = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
      const base = process.env.METHOD_DOWNLOAD_URL ?? 'https://app.withmethod.ai/downloads/cli';
      const response = await fetcher(`${base}/latest-${target}.txt`, { signal: AbortSignal.timeout(2000) });
      latest = response.ok ? /^version (\S+)$/m.exec(await response.text())?.[1] : undefined;
      writePrivateJson(cache, { checked_at: now, version: latest ?? null });
    }
  } catch { return undefined; }
  if (!latest || !newer(latest, packageInfo.version)) return undefined;
  return `Method ${latest} is available (you have ${packageInfo.version}). Update: curl -fsSL https://app.withmethod.ai/install.sh | sh`;
}
