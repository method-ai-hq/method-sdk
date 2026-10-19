import { isDeepStrictEqual } from 'node:util';

// The three-way merge of Methods. The CLI combines a teammate's newer version with the file on this computer, and the
// server undoes one change and keeps later work, with the same rules: a part that only one side changed takes that
// change; a part that both sides changed in different ways is a conflict.

export type MergeConflict = { path: string; base: unknown; ours: unknown; theirs: unknown };
/** Not clean: workflow keeps ours at each conflict. */
export type MergeResult = { clean: true; workflow: any } | { clean: false; conflicts: MergeConflict[]; workflow: any };

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Keys of ours in their order; a key that only theirs has goes after the key before it in theirs. */
function keyOrder(ours: Record<string, unknown>, theirs: Record<string, unknown>) {
  const keys = Object.keys(ours), theirKeys = Object.keys(theirs);
  theirKeys.forEach((key, index) => {
    if (keys.includes(key)) return;
    const before = theirKeys.slice(0, index).reverse().find(other => keys.includes(other));
    keys.splice(before === undefined ? 0 : keys.indexOf(before) + 1, 0, key);
  });
  return keys;
}
/**
 * Three-way merge of Method documents, per step and per top-level key. base is the version both sides started from
 * (an empty base when there is none), ours is the local file, and theirs is the other version.
 */
export function mergeMethod(base: any, ours: any, theirs: any): MergeResult {
  if (isDeepStrictEqual(ours, base)) return { clean: true, workflow: theirs };
  if (isDeepStrictEqual(theirs, base) || isDeepStrictEqual(ours, theirs)) return { clean: true, workflow: ours };
  const conflicts: MergeConflict[] = [];
  const pick = (path: string, b: unknown, o: unknown, t: unknown) => {
    if (isDeepStrictEqual(o, t) || isDeepStrictEqual(b, t)) return o;
    if (isDeepStrictEqual(b, o)) return t;
    conflicts.push({ path, base: b, ours: o, theirs: t });
    return o;
  };
  const merge = (path: string, b: any, o: any, t: any, nested: (key: string) => boolean) => {
    const result: Record<string, unknown> = {};
    for (const key of keyOrder(o, t)) {
      const at = path ? `${path}.${key}` : key;
      const value = nested(key) && isObject(o[key]) && isObject(t[key]) && isObject(b?.[key] ?? {})
        ? merge(at, b?.[key] ?? {}, o[key], t[key], () => false) : pick(at, b?.[key], o[key], t[key]);
      if (value !== undefined) result[key] = value;
    }
    return result;
  };
  const workflow = merge('', isObject(base) ? base : {}, ours, theirs, key => key === 'steps');
  return conflicts.length ? { clean: false, conflicts, workflow } : { clean: true, workflow };
}

export type PackageFile = { path: string; sha256: string };
export type FilesMergeResult<T extends PackageFile = PackageFile> = { clean: boolean; files: T[]; conflicts: { path: string }[] };
/**
 * Three-way merge of a Method's package files, by path and sha256. A file that only one side added, changed or removed
 * takes that change; a file that both sides changed in different ways is a conflict (ours stays in files).
 */
export function mergeFiles<T extends PackageFile>(base: T[], ours: T[], theirs: T[]): FilesMergeResult<T> {
  const byPath = (list: T[]) => new Map(list.map(f => [f.path, f]));
  const b = byPath(base), o = byPath(ours), t = byPath(theirs);
  const files: T[] = [], conflicts: { path: string }[] = [];
  for (const path of [...new Set([...o.keys(), ...t.keys(), ...b.keys()])].sort()) {
    const [bs, os, ts] = [b.get(path)?.sha256, o.get(path)?.sha256, t.get(path)?.sha256];
    const kept = os === ts || bs === ts ? o.get(path) : bs === os ? t.get(path) : (conflicts.push({ path }), o.get(path));
    if (kept) files.push(kept);
  }
  return { clean: !conflicts.length, files, conflicts };
}

/** The steps whose definition differs between two documents. */
export function changedSteps(before: any, after: any) {
  return [...new Set([...Object.keys(before?.steps ?? {}), ...Object.keys(after?.steps ?? {})])].filter(id => !isDeepStrictEqual(before?.steps?.[id], after?.steps?.[id]));
}
