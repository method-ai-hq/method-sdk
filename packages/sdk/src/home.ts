import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { sha256 } from '../../contracts/src/identity.js';
import { writePrivateJson } from './files.js';
import { methodCache } from './prepare.js';
import { authoringPath, readDocument } from './authoring.js';
import { fileHash } from './method-files.js';

/**
 * Each Method has one home file on this computer: the file its versions are saved from. A copy in a temporary folder,
 * or in another folder while the home file still exists, is not saved, so one Method never grows two histories.
 * Git worktrees and clones of one repository share a home.
 */
export type Home = { path: string; key: string };
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

export function recordHome(server: string, methodId: string, file: string) {
  writePrivateJson(homeFile(server, methodId), { path: authoringPath(file), key: homeKey(file) });
}

/**
 * Throws, with the home file named, when this file may not save the Method. Otherwise this file is the home after
 * the call. A home that is gone, holds another Method, or is a temporary copy gives way to a file outside a
 * temporary folder.
 */
export function claimHome(server: string, methodId: string, file: string) {
  const home = readHome(server, methodId), key = homeKey(file);
  if (home && home.key === key) { if (home.path !== authoringPath(file)) recordHome(server, methodId, file); return; }
  const homeLives = (() => { try { return !!home && readDocument(home.path).id === methodId; } catch { return false; } })();
  if (home && homeLives && (temporary(file) || !temporary(home.path)))
    throw Object.assign(Error(`This Method is saved from ${home.path}. Make the change in that file and run it there; this copy was not run or saved.`), { code: 'other_home', home: home.path });
  recordHome(server, methodId, file);
}


type Saved = { workflow_id: string; version_id: string; version_number: number; workflow: any; package?: { files: Array<{ path: string; sha256: string; size: number }> } | null; saved_by?: string | null; saved_at?: string | null; merge_base?: string | null };
type Client = Pick<import('./method-client.js').MethodClient, 'server' | 'token' | 'request' | 'transfer'>;
/** Both texts of one part that this computer and a teammate changed in different ways. */
export type CombineConflict = { part: string; file: string; yours: unknown; theirs: unknown };
export type CatchUp = { status: 'skipped' | 'current' } | { status: 'offline' | 'updated'; line: string }
  | { status: 'conflict'; result: { status: 'needs_you'; failure: import('../../workflow-language/src/inspection.js').RunFailure; conflicts: CombineConflict[] } };

const list = (word: string, items: string[]) => items.length ? `${word}${items.length === 1 ? '' : 's'} ${items.join(', ')}` : '';
const parts = (steps: string[], files: string[]) => [list('step', steps), list('file', files)].filter(Boolean).join(' and ');
const clock = (at?: string | null) => { const date = at ? new Date(at) : undefined; return date && !isNaN(+date) ? ` from ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : ''; };
const clip = (text: string) => text.length > 20_000 ? `${text.slice(0, 20_000)}…` : text;
const unreachable = (error: any) => error?.code === 'network' || error?.code === 'stalled' || error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.status >= 500 || error?.status === 429;

/**
 * Before a run, a fix or a publish of a Method file: bring the file to the newest version of its Method. base is the
 * version this computer last saved or got, ours the file, theirs the newest version. An unchanged file takes theirs;
 * a changed one combines step by step and file by file (an empty base when this computer has none). A part that both
 * sides changed in different ways is a conflict: nothing changes, and the result has both texts. Offline, the file
 * runs as it is. Signed out, a file with no id: line, or a Method with no version yet: nothing.
 */
export async function catchUp(client: Client, file: string, doing = 'running'): Promise<CatchUp> {
  const path = authoringPath(file), root = dirname(path);
  const { methodContent, methodIdPattern, versionIdFor } = await import('./versions.js');
  let document: any;
  try { document = readDocument(path); if (typeof document.id !== 'string' || !methodIdPattern.test(document.id) || !client.token()) return { status: 'skipped' }; }
  catch { return { status: 'skipped' }; }
  const id: string = document.id, options = { signal: AbortSignal.timeout(5000), stallMs: 5000 };
  const methodPath = `/api/cli/methods/${encodeURIComponent(id)}`;
  const { lastSaved, recordCheckout } = await import('./outbox.js');
  const record = lastSaved(client.server, id);
  // merge_base: the newest version that the server has as an ancestor of both this computer's version and the newest one.
  let theirs: Saved;
  try { theirs = await client.request<Saved>(record?.version_id ? `${methodPath}?base=${encodeURIComponent(record.version_id)}` : methodPath, 'GET', undefined, true, options); }
  catch (error) { return unreachable(error) ? { status: 'offline', line: `Could not check for a newer version; ${doing} this file.` } : { status: 'skipped' }; }
  const { loadWorkflow } = await import('../../workflow-language/src/validate.js');
  const { buildPackage } = await import('./method-files.js');
  // A file that does not load fails its run with its own error.
  let ours: { workflow: any; files: Array<{ path: string; sha256: string }>; version_id: string };
  try { const workflow = loadWorkflow(methodContent(document)), { pack } = await buildPackage(path, workflow); ours = { workflow, files: pack.files, version_id: versionIdFor(id, pack.digest) }; }
  catch { return { status: 'skipped' }; }
  const savedBy = theirs.saved_by ?? null;
  if (ours.version_id === theirs.version_id) {
    if (record?.version_id !== theirs.version_id) recordCheckout(client.server, id, theirs.version_id, theirs.version_number, theirs.workflow, { saved_by: savedBy });
    return { status: 'current' };
  }
  if (record?.version_id === theirs.version_id) return { status: 'current' };
  let base: { workflow: any; files: Array<{ path: string; sha256: string }> } = { workflow: {}, files: [] };
  // An older server sends no merge_base: then the version this computer last saved or got is the base.
  const baseId = theirs.merge_base !== undefined ? theirs.merge_base : record?.version_id;
  // This computer's version was kept beside the newest one (an earlier CLI recorded it as its last save): it is combined now.
  const beside = record?.version_id && baseId !== record.version_id ? record.version_id : undefined;
  if (record?.version_id && baseId) {
    try { const saved = await client.request<Saved>(`${methodPath}?version=${encodeURIComponent(baseId)}`, 'GET', undefined, true, options); base = { workflow: saved.workflow, files: saved.package?.files ?? [] }; }
    catch (error) { if (unreachable(error)) return { status: 'offline', line: `Could not check for a newer version; ${doing} this file.` }; base = { workflow: record.workflow ?? {}, files: [] }; }
  }
  const { mergeMethod, mergeFiles, changedSteps } = await import('./merge.js');
  const theirFiles = theirs.package?.files ?? [];
  const steps = mergeMethod(base.workflow, ours.workflow, theirs.workflow), files = mergeFiles(base.files, ours.files, theirFiles);
  const ourHashes = new Map(ours.files.map(f => [f.path, f.sha256]));
  // Files that come from theirs. A file here that no save wrote and that differs is the person's own: a conflict too.
  const incoming = files.files.filter(f => ourHashes.get(f.path) !== f.sha256);
  const local = (name: string) => { try { return fileHash(readFileSync(join(root, name))); } catch { return undefined; } };
  const { isDeepStrictEqual } = await import('node:util');
  // After a combine stopped, a part whose text changed on this computer since then is combined by the person: theirs is used.
  const stop = record?.conflict?.theirs === theirs.version_id ? record.conflict : undefined;
  const combinedStep = (at: string, now: unknown) => !!stop && at in stop.parts && !isDeepStrictEqual(now, stop.parts[at]);
  const combinedFile = (at: string) => !!stop && at in stop.files && (local(at) ?? null) !== stop.files[at];
  const fileConflicts = [...files.conflicts.map(c => c.path), ...incoming.filter(f => !ourHashes.has(f.path) && local(f.path) !== undefined && local(f.path) !== f.sha256).map(f => f.path)];
  const stepConflicts = steps.clean ? [] : steps.conflicts;
  const openSteps = stepConflicts.filter(c => !combinedStep(c.path, c.ours)), openFiles = fileConflicts.filter(at => !combinedFile(at));
  const keepLocal = new Set(fileConflicts.filter(combinedFile));
  const take = incoming.filter(f => !keepLocal.has(f.path));
  const download = async (f: { path: string; sha256: string }) => {
    const bytes = await client.transfer(`${methodPath}/files/${f.sha256}?version=${encodeURIComponent(theirs.version_id)}`);
    if (fileHash(bytes) !== f.sha256) throw Error(`The newer version's file ${f.path} does not match its checksum.`);
    return bytes;
  };
  const who = savedBy ?? 'A teammate', name = relative(root, path);
  if (openSteps.length || openFiles.length) {
    // Remember this computer's text of each part, so that the next run sees which parts the person combined.
    const { recordCombineStop } = await import('./outbox.js');
    recordCombineStop(client.server, id, {
      theirs: theirs.version_id,
      parts: Object.fromEntries(stepConflicts.map(c => [c.path, combinedStep(c.path, c.ours) ? stop!.parts[c.path] : c.ours])),
      files: Object.fromEntries(fileConflicts.map(at => [at, combinedFile(at) ? stop!.files[at]! : local(at) ?? null])),
    });
    const conflicts: CombineConflict[] = [];
    for (const c of openSteps) conflicts.push({ part: c.path.replace(/^steps\./, 'step '), file: name, yours: c.ours, theirs: c.theirs });
    for (const at of openFiles) {
      const theirFile = theirFiles.find(f => f.path === at);
      const text = async () => { try { return clip(Buffer.from(await download(theirFile!)).toString('utf8')); } catch (error) { return `(not read: ${(error as Error).message})`; } };
      conflicts.push({ part: `file ${at}`, file: at, yours: (() => { try { return clip(readFileSync(join(root, at), 'utf8')); } catch { return null; } })(), theirs: theirFile ? await text() : null });
    }
    const where = [...new Set(conflicts.map(c => c.file))];
    const headline = `${who} also changed ${conflicts.map(c => c.part).join(', ')}. Combine the two texts in ${where.join(' and ')}, then run again.`;
    return { status: 'conflict', result: { status: 'needs_you', failure: combineFailure(headline, conflicts, who), conflicts } };
  }
  try { loadWorkflow(steps.workflow); }
  catch (error) {
    const headline = `Your changes and ${savedBy ? `${savedBy}'s` : 'the newest'} version combine into a Method that does not load: ${(error as Error).message} Combine them in ${name} by hand, then run again.`;
    return { status: 'conflict', result: { status: 'needs_you', failure: combineFailure(headline, [], who), conflicts: [] } };
  }
  // Every file is read before any file changes, so a failed download changes nothing.
  let written: Array<{ path: string; bytes: Uint8Array }>;
  try { written = await Promise.all(take.map(async f => ({ path: f.path, bytes: await download(f) }))); }
  catch (error) { return unreachable(error) ? { status: 'offline', line: `Could not check for a newer version; ${doing} this file.` } : { status: 'skipped' }; }
  const { mkdirSync, renameSync, writeFileSync } = await import('node:fs');
  const { packagePath } = await import('../../contracts/src/method-package.js');
  for (const f of written) {
    const target = resolve(root, packagePath(f.path));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(`${target}.download`, f.bytes, { mode: 0o600 }); renameSync(`${target}.download`, target);
  }
  if (!isDeepStrictEqual(steps.workflow, ours.workflow)) (await import('./proposals.js')).writeMethodFile(path, id, steps.workflow);
  (await import('./legacy.js')).convertLegacy(path);
  const fileChanges = (from: Array<{ path: string; sha256: string }>, to: Array<{ path: string; sha256: string }>) => [...new Set([...from, ...to].map(f => f.path))].filter(at => from.find(f => f.path === at)?.sha256 !== to.find(f => f.path === at)?.sha256);
  const yours = parts(changedSteps(base.workflow, ours.workflow), fileChanges(base.files, ours.files));
  const kept = !isDeepStrictEqual(ours.workflow, base.workflow) || fileChanges(base.files, ours.files).length > 0;
  // theirs is the parent of the next save; a side version of this computer that the file now combines goes with it.
  recordCheckout(client.server, id, theirs.version_id, theirs.version_number, theirs.workflow, { saved_by: savedBy, ...(kept && (record?.side_version_id ?? beside) ? { merged_version_id: (record?.side_version_id ?? beside)! } : {}) });
  const changed = parts(changedSteps(base.workflow, theirs.workflow), fileChanges(base.files, theirFiles));
  return { status: 'updated', line: `Updated to ${savedBy ? `${savedBy}'s` : 'the newest'} version${clock(theirs.saved_at)}${changed ? ` (changed ${changed})` : ''}.${kept ? ` Your changes${yours ? ` to ${yours}` : ''} are kept.` : ''}` };
}

/** The failure record of a combine that needs the person: needs_you, with both texts of each part as evidence. */
function combineFailure(headline: string, conflicts: CombineConflict[], who: string) {
  const text = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value);
  return { owner: 'needs_you' as const, code: 'combine_versions', headline, step: null, step_name: null, iteration: null, failed_iterations: [], total: null, phase: 'setup' as const, check_name: null,
    next: { action: 'fix_method' as const, text: 'Edit the file so that each part keeps both changes, then run again. No run started and no file changed.' },
    evidence: conflicts.flatMap(c => [`Your ${c.part}: ${text(c.yours)}`, `${who}'s ${c.part}: ${text(c.theirs)}`]) };
}
