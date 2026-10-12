import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { sha256 } from '../../contracts/src/identity.js';
import { writePrivateJson } from './files.js';
import { methodCache } from './prepare.js';
import { authoringPath } from './authoring.js';
import { fileHash } from './method-files.js';

/**
 * Each Method has one home file on this computer: the file its versions are saved from. A copy in a temporary folder,
 * or in another folder while the home file still exists, is not saved, so one Method never grows two histories.
 * Git worktrees and clones of one repository share a home. The home record also holds what the last save or checkout
 * wrote, so an unchanged home file can take a newer version from the account.
 */
export type Home = { path: string; key: string; version_id?: string; files?: Record<string, string> };
const homeFile = (server: string, methodId: string) => join(methodCache(), 'homes', `${sha256(`${server}\n${methodId}`).slice(0, 24)}.json`);
export function readHome(server: string, methodId: string): Home | undefined {
  try { return JSON.parse(readFileSync(homeFile(server, methodId), 'utf8')); } catch { return undefined; }
}

const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
const temporaryRoots = () => [...new Set([tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'].map(real))];
export const temporary = (path: string) => temporaryRoots().some(root => real(path).startsWith(root + sep));

/** The checkout folder that holds path, and the main folder of its Git repository (a worktree points to it). */
function repository(path: string) {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const git = join(dir, '.git');
    if (existsSync(git)) {
      if (statSync(git).isDirectory()) return { root: dir, main: dir };
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(git, 'utf8'))?.[1]?.trim();
      const main = pointer ? /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(resolve(dir, pointer))?.[1] : undefined;
      return { root: dir, main: main ?? dir };
    }
    if (dirname(dir) === dir) return undefined;
  }
}
/** The same file in every checkout of one repository has the same key. */
export function homeKey(file: string) {
  const path = real(authoringPath(file)), repo = repository(path);
  return repo ? `${repo.main}:${relative(repo.root, path)}` : path;
}

/** What a save or checkout wrote: the Method file and each package file, by hash. */
export function writtenFiles(file: string, packageFiles: Array<{ path: string; sha256: string }>) {
  const path = authoringPath(file);
  return { [relative(dirname(path), path)]: fileHash(readFileSync(path)), ...Object.fromEntries(packageFiles.map(f => [f.path, f.sha256])) };
}
export function recordHome(server: string, methodId: string, file: string, version?: { version_id: string; files: Record<string, string> }) {
  writePrivateJson(homeFile(server, methodId), { path: authoringPath(file), key: homeKey(file), ...version });
}

/**
 * Throws, with the home file named, when this file may not save the Method. Otherwise this file is the home after
 * the call. A home that is gone, holds another Method, or is a temporary copy gives way to a file outside a
 * temporary folder.
 */
export function claimHome(server: string, methodId: string, file: string) {
  const home = readHome(server, methodId), key = homeKey(file);
  if (home && home.key === key) { if (home.path !== authoringPath(file)) recordHome(server, methodId, file, home.version_id ? { version_id: home.version_id, files: home.files ?? {} } : undefined); return; }
  const homeLives = (() => { try { return home && new RegExp(`^id:\\s*${methodId}\\s*$`, 'm').test(readFileSync(home.path, 'utf8')); } catch { return false; } })();
  if (home && homeLives && (temporary(file) || !temporary(home.path)))
    throw Object.assign(Error(`This Method is saved from ${home.path}. Make the change in that file and run it there; this copy was not run or saved.`), { code: 'other_home', home: home.path });
  recordHome(server, methodId, file);
}

/** True when every file that the last save or checkout wrote is still unchanged in the home folder. */
export function unchangedSinceSave(home: Home) {
  if (!home.version_id || !home.files) return false;
  const root = dirname(home.path);
  return Object.entries(home.files).every(([name, hash]) => { try { return fileHash(readFileSync(join(root, name))) === hash; } catch { return false; } });
}

/**
 * Before a run of the home file: when nothing in it changed since the last save or checkout on this computer and the
 * account has a newer version (saved from another computer or folder), write that version here first. Says nothing;
 * any problem leaves the files as they are.
 */
export async function followAccount(client: { server: string; token(): string | null | undefined; request<T>(path: string): Promise<T>; transfer(path: string): Promise<Uint8Array> }, file: string) {
  const path = authoringPath(file);
  try {
    const id = (await import('./authoring.js')).readDocument(path).id;
    if (typeof id !== 'string' || !client.token()) return false;
    const home = readHome(client.server, id);
    if (!home || home.key !== homeKey(path) || !unchangedSinceSave(home)) return false;
    const latest = await client.request<any>(`/api/cli/methods/${encodeURIComponent(id)}`);
    if (!latest?.version_id || latest.version_id === home.version_id) return false;
    const { mkdtempSync, rmSync, copyFileSync, mkdirSync } = await import('node:fs');
    const { restorePackage } = await import('./method-files.js');
    const staging = mkdtempSync(join(methodCache(), 'follow-'));
    try {
      await restorePackage(latest, staging, client as any);
      const root = dirname(path), incoming = latest.package?.files ?? [];
      // A local file that the last save did not write, and that differs, is the user's: then nothing changes.
      for (const f of incoming) {
        const local = join(root, f.path);
        if (existsSync(local) && !home.files?.[f.path] && fileHash(readFileSync(local)) !== f.sha256) return false;
      }
      for (const f of incoming) { mkdirSync(dirname(join(root, f.path)), { recursive: true, mode: 0o700 }); copyFileSync(join(staging, f.path), join(root, f.path)); }
    } finally { rmSync(staging, { recursive: true, force: true }); }
    const { writeDocument } = await import('./authoring.js');
    const { methodContent, writeMethodId } = await import('./versions.js');
    writeDocument(path, methodContent(latest.workflow));
    (await import('./legacy.js')).convertLegacy(path);
    writeMethodId(path, id);
    (await import('./outbox.js')).recordCheckout(client.server, id, latest.version_id, latest.version_number, methodContent(latest.workflow));
    recordHome(client.server, id, path, { version_id: latest.version_id, files: writtenFiles(path, latest.package?.files ?? []) });
    return true;
  } catch { return false; }
}
