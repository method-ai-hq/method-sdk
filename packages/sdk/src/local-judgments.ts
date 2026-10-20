import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { readDocument } from './authoring.js';
import { methodCache } from './prepare.js';

/**
 * A judgment that method judge keeps on this computer, for a Method whose run content stays here (run_data: device, or
 * an organization that keeps run content on devices). The account keeps the judgment without its note and corrected
 * result; this record keeps them, for the improvement loop on this computer.
 */
export type LocalJudgment = {
  id: string; run_id: string; account_run_id: string | null; run_dir: string; method_id: string | null; file: string;
  step_id: string | null; verdict: 'right' | 'wrong'; note: string | null; corrected?: unknown; created_at: string;
  /** The person's answer to the fix's question; a later line of the same judgment adds it. */
  answer?: string;
};

/** The file that a run folder records: the Method file that method run ran. */
export const methodFileRecord = 'method-file.json';

const readJson = (path: string) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; } };
/** The first line of a file, read without the rest. */
function firstLine(path: string) {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(64 * 1024), size = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, size).toString('utf8').split('\n')[0] ?? '';
  } catch { return ''; } finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * Every ID that names a run folder: the ID that method run printed (run-id.json), the account run ID and sync ID
 * (method-sync.json), request.json run_id, the execution ID (run.started in events.jsonl), the folder, and its name.
 */
export function runFolderIds(dir: string) {
  const folder = resolve(dir), sync = readJson(join(folder, 'method-sync.json')) ?? {};
  let started: any = {};
  try { started = JSON.parse(firstLine(join(folder, 'events.jsonl'))); } catch { /* no events yet */ }
  return [...new Set([readJson(join(folder, 'run-id.json'))?.id, sync.id, sync.dashboard_id, readJson(join(folder, 'request.json'))?.run_id,
    started?.event === 'run.started' ? started.execution_id : undefined, folder, basename(folder)].filter((id): id is string => typeof id === 'string' && !!id))];
}

/** The run folder on this computer that a run ID names, from the Method cache and .method-runs in this folder. */
export function findRunFolder(runId: string) {
  const direct = resolve(runId);
  if (existsSync(join(direct, 'method.json'))) return direct;
  for (const root of [join(methodCache(), 'runs'), join(process.cwd(), '.method-runs')]) {
    let names: string[] = [];
    try { names = readdirSync(root); } catch { continue; }
    // A folder named by the ID is the quick match; the others need their records read.
    if (names.includes(runId) && existsSync(join(root, runId, 'method.json'))) return join(root, runId);
    for (const name of names) {
      const dir = join(root, name);
      if (existsSync(join(dir, 'method.json')) && runFolderIds(dir).includes(runId)) return dir;
    }
  }
  return undefined;
}

/** Every run folder on this computer by each of its IDs, read once (for many judgments). */
export function runFolderIndex() {
  const index = new Map<string, string>();
  for (const root of [join(process.cwd(), '.method-runs'), join(methodCache(), 'runs')]) {
    let names: string[] = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names) {
      const dir = join(root, name);
      if (existsSync(join(dir, 'method.json'))) for (const id of runFolderIds(dir)) index.set(id, dir);
    }
  }
  return index;
}

/** Whether a run folder's Method keeps run content on this computer. */
export function deviceRun(dir: string) {
  return readJson(join(dir, 'method-sync.json'))?.device === true || readJson(join(dir, 'method.json'))?.run_data === 'device';
}

/** The Method file that a run ran: its record in the run folder, else a .method file in this folder with the run's Method ID (or name). */
export function methodFileOfRun(dir: string) {
  const recorded = readJson(join(dir, methodFileRecord))?.path;
  if (typeof recorded === 'string' && existsSync(recorded)) return recorded;
  const method = readJson(join(dir, 'method.json')) ?? {};
  let names: string[] = [];
  try { names = readdirSync(process.cwd()).filter(name => name.endsWith('.method')); } catch { return undefined; }
  for (const name of names.sort()) {
    const file = join(process.cwd(), name);
    try {
      const document = readDocument(file);
      if (typeof method.id === 'string' ? document.id === method.id : document.name === method.name) return file;
    } catch { /* not a readable Method */ }
  }
  return undefined;
}

/** The private .method folder next to a Method file. It is not for Git: its files can hold run content. */
export function localMethodFolder(file: string) {
  const folder = join(dirname(file), '.method'), ignore = join(folder, '.gitignore');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n', { mode: 0o600 });
  return folder;
}
export const localJudgmentsFile = (file: string) => join(dirname(file), '.method', 'judgments.jsonl');

/** Add a judgment to the Method's judgments file, one JSON line each. */
export function saveLocalJudgment(file: string, judgment: LocalJudgment) {
  localMethodFolder(file);
  const path = localJudgmentsFile(file);
  appendFileSync(path, JSON.stringify(judgment) + '\n', { mode: 0o600 });
  return path;
}

/** The judgments kept on this computer for this Method file, oldest first. */
export function localJudgments(file: string): LocalJudgment[] {
  const path = localJudgmentsFile(file);
  if (!existsSync(path) || !statSync(path).isFile()) return [];
  const id = readDocument(file).id;
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
    .filter(j => j && j.file === basename(file) && (typeof id !== 'string' || !j.method_id || j.method_id === id));
}
