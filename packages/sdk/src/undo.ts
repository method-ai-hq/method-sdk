import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { packagePath } from '../../contracts/src/method-package.js';
import { authoringPath, readDocument } from './authoring.js';
import { DEFAULT_SERVER, type MethodClient } from './method-client.js';
import { fileHash } from './method-files.js';
import { writePrivateJson } from './files.js';
import { localMethodFolder } from './local-judgments.js';
import { lastChangedFile, recordLastChange } from './fix-outcomes.js';
import { undoneLine } from './fix-lines.js';
import { methodIdPattern } from './versions.js';

// The changes that Method made to a Method file on this computer (a fix, a pruning change, a removed learned rule), so
// method undo can restore the file and its changed files as they were before the last one. The records are private
// files in .method/undo/ next to the Method file.

export type UndoRecord = {
  id: string; file: string; kind: 'fix' | 'prune' | 'learned'; created_at: string; cause: string;
  /** What the person reads after undo: what is no longer in effect. */
  what: string;
  before: { text: string; files: Record<string, string | null> };
  after: { sha256: string; files: Record<string, string | null> };
  undone_at?: string;
};

const undoFolder = (file: string) => join(dirname(resolve(file)), '.method', 'undo');
const hashOf = (path: string) => existsSync(path) ? fileHash(readFileSync(path)) : null;
const inFolder = (file: string, path: string) => {
  const folder = dirname(resolve(file)), full = resolve(folder, packagePath(path));
  if (!full.startsWith(folder + sep)) throw Error(`The change names a file outside the Method folder: ${path}`);
  return full;
};

/** Take what the file and the named files are now, before a change is written. */
export function snapshot(file: string, paths: string[]) {
  return { text: readFileSync(file, 'utf8'), files: Object.fromEntries(paths.map(path => { const full = inFolder(file, path); return [path, existsSync(full) ? readFileSync(full).toString('base64') : null]; })) };
}

/** Record a change after it was written, so method undo can restore the state before it. */
export function recordChange(file: string, kind: UndoRecord['kind'], cause: string, what: string, before: UndoRecord['before']) {
  localMethodFolder(file);
  mkdirSync(undoFolder(file), { recursive: true, mode: 0o700 });
  const record: UndoRecord = { id: `un_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`, file: basename(file), kind, created_at: new Date().toISOString(), cause, what, before,
    after: { sha256: fileHash(readFileSync(file)), files: Object.fromEntries(Object.keys(before.files).map(path => [path, hashOf(inFolder(file, path))])) } };
  writePrivateJson(join(undoFolder(file), `${record.id}.json`), record);
  recordLastChange(file);
  return record;
}

/** The changes of this file that can be undone, newest first. */
export function undoRecords(file: string): (UndoRecord & { path: string })[] {
  const folder = undoFolder(file);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter(name => name.endsWith('.json')).map(name => ({ ...JSON.parse(readFileSync(join(folder, name), 'utf8')), path: join(folder, name) }))
    .filter(record => record.file === basename(file) && !record.undone_at).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * Restore the Method file, and the files the change wrote, as they were before the last change Method made (or before
 * the change `id`, which must be the last one). A file that changed after that change is not overwritten. Returns the
 * undone record; the caller saves the restored file as a new version.
 */
export function undoLast(file: string, id?: string) {
  const last = undoRecords(file)[0];
  if (!last || (id && last.id !== id)) throw Error(`Method has not changed ${basename(file)} on this computer${id ? ' since that change' : ''}, so there is nothing to undo.`);
  if (fileHash(readFileSync(file)) !== last.after.sha256 || Object.entries(last.after.files).some(([path, sha]) => hashOf(inFolder(file, path)) !== sha))
    throw Error(`${basename(file)} changed after Method's last change, so undo would lose that work. Undo the change by hand, or restore an earlier version on the Method page.`);
  writeFileSync(file, last.before.text);
  for (const [path, content] of Object.entries(last.before.files)) {
    const full = inFolder(file, path);
    if (content === null) rmSync(full, { force: true }); else { mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, Buffer.from(content, 'base64')); }
  }
  writePrivateJson(last.path, { ...stripPath(last), undone_at: new Date().toISOString() });
  return last;
}

/**
 * `method undo [FILE] [--json]`: restore the Method file, and the files the change wrote, as they were before the last
 * fix, pruning change, or removed learned rule. The restored file is saved as a new version.
 */
export async function undoCommand(args: string[], clientFactory: (server: string) => MethodClient) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' }, server: { type: 'string' } } });
  if (positionals.length > 1) throw Error('Use method undo [FILE].');
  const file = positionals[0] ? authoringPath(positionals[0]) : defaultFile();
  const last = undoLast(file);
  const version = await saveVersion(clientFactory(values.server ?? DEFAULT_SERVER), file, `Undid Method's change: ${last.cause}`.slice(0, 500));
  const line = undoneLine(last.what);
  process.stdout.write(values.json ? JSON.stringify({ undone: { kind: last.kind, cause: last.cause, created_at: last.created_at }, version: version ?? null, line }, null, 2) + '\n' : line + '\n');
}
const stripPath = ({ path: _path, ...record }: UndoRecord & { path: string }) => record;

function defaultFile() {
  const here = readdirSync(process.cwd()).filter(name => name.endsWith('.method'));
  if (here.length === 1) return resolve(here[0]!);
  const last = lastChangedFile();
  if (last) return last;
  throw Error('Name the Method file: method undo FILE.');
}

/** Save a changed file as a new version when this computer is signed in. Undefined when it cannot be saved now. */
export async function saveVersion(client: MethodClient, file: string, reason: string) {
  const id = readDocument(file).id;
  if (typeof id !== 'string' || !methodIdPattern.test(id) || !client.token()) return undefined;
  try {
    const { Outbox } = await import('./outbox.js');
    const { prepareVersion } = await import('./versions.js');
    const outbox = new Outbox(client);
    const version = await prepareVersion(client, outbox, file, reason);
    await outbox.drain();
    return await outbox.whenSaved(version.version_id) ? { version_id: version.version_id, url: version.url } : undefined;
  } catch { return undefined; }
}
