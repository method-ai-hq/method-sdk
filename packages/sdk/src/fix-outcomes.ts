import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { methodCache } from './prepare.js';
import { writePrivateJson } from './files.js';
import { valueText } from '@withmethod/runtime/rubric.js';
import { type CorrectionOutcome, answerNext, errorLine, heldBackHeading, outcomeLine, stoppedLine, testedOutputHeading, waitsForComputerLine, workingForLine, workingLine } from './fix-lines.js';

// What a fix in the background did with each correction, kept on this computer:
// ~/.cache/method/fixes/<methodId>/outcomes/<judgmentId>.json. method judge writes a working record and starts the fix;
// the fix writes the outcome; method wait and the next method run of the Method print the outcomes not yet shown.

export type StoredOutcome = {
  judgment: string; method_id: string; file: string; status: 'working' | 'done' | 'stopped';
  started_at: string; pid?: number | undefined; finished_at?: string; outcome?: CorrectionOutcome; error?: string; log?: string; shown: boolean;
  /** A record that is not about one correction: a fix that stopped holding. */
  kind?: 'came_back'; line?: string;
};

export const fixFolder = (methodId: string) => join(methodCache(), 'fixes', methodId);
const outcomesDir = (methodId: string) => join(fixFolder(methodId), 'outcomes');
const recordPath = (methodId: string, id: string) => join(outcomesDir(methodId), `${id}.json`);
/** The whole output of a fix's tested run, beside its record: the files that it wrote, and its result when that is long. */
const outputDir = (methodId: string, id: string) => join(outcomesDir(methodId), `${id}.output`);
const resultPath = (methodId: string, id: string) => join(outcomesDir(methodId), `${id}.result`, 'result.json');
/** method wait shows at most this many characters of the result and of each file. */
const CLIP = 4000;
const read = (path: string): StoredOutcome | undefined => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; } };
function write(record: StoredOutcome) {
  mkdirSync(outcomesDir(record.method_id), { recursive: true, mode: 0o700 });
  const path = recordPath(record.method_id, record.judgment), temporary = `${path}.${process.pid}.tmp`;
  writePrivateJson(temporary, record); renameSync(temporary, path);
}

/** Mark corrections as being fixed now: method wait waits for them. */
export function markWorking(methodId: string, file: string, ids: string[], pid?: number) {
  for (const id of ids) write({ judgment: id, method_id: methodId, file: resolve(file), status: 'working', started_at: new Date().toISOString(), ...(pid ? { pid } : {}), shown: false });
}
/** The fix process that works on these corrections. */
export function setWorker(methodId: string, ids: string[], pid: number) {
  for (const id of ids) { const record = read(recordPath(methodId, id)); if (record?.status === 'working') write({ ...record, pid }); }
}
export function saveOutcome(methodId: string, file: string, outcome: CorrectionOutcome, log?: string) {
  const before = read(recordPath(methodId, outcome.id));
  keepOutput(methodId, outcome);
  write({ judgment: outcome.id, method_id: methodId, file: resolve(file), status: 'done', started_at: before?.started_at ?? new Date().toISOString(), finished_at: new Date().toISOString(), outcome, ...(log ? { log } : {}), shown: false });
}
/**
 * Keep the whole output of a fixed correction's tested run as files, so that the agent copies a file from its path:
 * method wait shows each file only once and at most CLIP characters of it. A name that leaves the folder is not kept.
 */
function keepOutput(methodId: string, outcome: CorrectionOutcome) {
  const dir = outputDir(methodId, outcome.id), shown = outcome.tested_output;
  rmSync(dir, { recursive: true, force: true }); rmSync(dirname(resultPath(methodId, outcome.id)), { recursive: true, force: true });
  if (outcome.outcome !== 'fixed' || !shown) return;
  if (shown.result !== undefined && shown.result !== null && valueText(shown.result).length > CLIP) {
    try { mkdirSync(dirname(resultPath(methodId, outcome.id)), { recursive: true, mode: 0o700 }); writeFileSync(resultPath(methodId, outcome.id), JSON.stringify(shown.result, null, 2) + '\n', { mode: 0o600 }); } catch { /* the lines show the cut text */ }
  }
  for (const [name, text] of Object.entries(shown.files ?? {})) {
    const path = resolve(dir, name), inside = relative(dir, path);
    if (!inside || inside.startsWith('..') || resolve(dir, inside) !== path) continue;
    try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, text, { mode: 0o600 }); } catch { /* the lines show the text without its path */ }
  }
}
/** The kept file of a record's tested output, or undefined. */
function keptPath(record: StoredOutcome, name: string) {
  const dir = outputDir(record.method_id, record.judgment), path = resolve(dir, name), inside = relative(dir, path);
  return inside && !inside.startsWith('..') && existsSync(path) ? path : undefined;
}
/** Whether a file's text is the result, or one value of the result, as JSON. */
function sameAsResult(text: string, result: unknown) {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return false; }
  if (isDeepStrictEqual(value, result)) return true;
  return !!result && typeof result === 'object' && !Array.isArray(result) && Object.values(result).some(v => v && typeof v === 'object' && isDeepStrictEqual(value, v));
}

export function saveError(methodId: string, file: string, id: string, error: string, log?: string) {
  const before = read(recordPath(methodId, id));
  write({ judgment: id, method_id: methodId, file: resolve(file), status: 'stopped', started_at: before?.started_at ?? new Date().toISOString(), finished_at: new Date().toISOString(), error, ...(log ? { log } : {}), shown: false });
}
/** A line that is not about one correction: a fix that came back. */
export function saveNotice(methodId: string, file: string, kind: 'came_back', line: string) {
  const id = `${kind}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  write({ judgment: id, method_id: methodId, file: resolve(file), status: 'done', kind, line, started_at: new Date().toISOString(), finished_at: new Date().toISOString(), shown: false });
}
export function storedOutcome(methodId: string, id: string) { return read(recordPath(methodId, id)); }

const alive = (pid: number | undefined) => { if (!pid) return true; try { process.kill(pid, 0); return true; } catch (error: any) { return error.code !== 'ESRCH'; } };
/** Every stored record, of one Method or of all; a working record whose process stopped reads as stopped. */
export function storedOutcomes(methodId?: string): StoredOutcome[] {
  const root = join(methodCache(), 'fixes');
  const methods = methodId ? [methodId] : (() => { try { return readdirSync(root); } catch { return []; } })();
  const records: StoredOutcome[] = [];
  for (const id of methods) {
    let names: string[] = [];
    try { names = readdirSync(outcomesDir(id)).filter(name => name.endsWith('.json')); } catch { continue; }
    for (const name of names) {
      const record = read(join(outcomesDir(id), name));
      if (!record) continue;
      records.push(record.status === 'working' && !alive(record.pid) ? { ...record, status: 'stopped' } : record);
    }
  }
  return records.sort((a, b) => a.started_at.localeCompare(b.started_at));
}
export function markShown(record: StoredOutcome) { const now = read(recordPath(record.method_id, record.judgment)); if (now) write({ ...now, shown: true }); }

/** The lines of a record: the person's line, the tested output after a fix, and for a question the agent's next step. */
export function recordLines(record: StoredOutcome, options: { brief?: boolean } = {}): string[] {
  if (record.line) return [record.line];
  if (record.status === 'working') return [workingLine];
  if (record.status === 'stopped') return [record.error ? errorLine(record.error) : stoppedLine];
  const o = record.outcome!, lines = [outcomeLine(o)];
  if (o.outcome === 'question') lines.push(answerNext(record.judgment));
  const shown = o.tested_output;
  if (o.outcome === 'fixed' && shown && !options.brief) {
    // Each part once: a file that holds the result (or one value of it) is named, not shown again. A long part is cut,
    // with the path of its whole text, so the agent copies the file and never searches for it.
    const parts: string[] = [];
    const result = shown.result !== undefined && shown.result !== null ? shown.result : undefined;
    if (result !== undefined) {
      const text = valueText(result), path = resultPath(record.method_id, record.judgment), whole = text.length > CLIP && existsSync(path) ? path : undefined;
      parts.push(whole ? `${clip(text)}\n(cut; the whole result: ${whole})` : clip(text));
    }
    for (const [name, text] of Object.entries(shown.files ?? {})) {
      const path = keptPath(record, name);
      if (result !== undefined && sameAsResult(text, result)) parts.push(`${name}: the same as above${path ? `. Whole file: ${path}` : ''}`);
      else if (text.length > CLIP && path) parts.push(`${name} (cut; whole file: ${path}):\n${clip(text)}`);
      else parts.push(`${name}${path ? ` (${path})` : ''}:\n${clip(text)}`);
    }
    if (parts.length) lines.push(testedOutputHeading, ...parts);
    if (shown.held_back?.length) lines.push(heldBackHeading, ...shown.held_back.map(call => clip(valueText(call.args))));
  }
  return lines;
}
const clip = (text: string, max = CLIP) => text.length > max ? `${text.slice(0, max)}…` : text;

/** The JSON of a record for --json: the outcome as the agent reads it, with the person's line. */
export const recordJson = (record: StoredOutcome) => ({ judgment: record.judgment, status: record.status, ...(record.outcome ? { outcome: record.outcome } : {}), ...(record.error ? { error: record.error } : {}),
  ...(record.kind ? { kind: record.kind } : {}), lines: recordLines(record), ...(record.outcome?.outcome === 'question' ? { next: `method answer ${record.judgment} "THEIR WORDS"` } : {}) });

/** The lines of the outcomes of a Method that nobody has seen yet (without the tested output), marked seen. */
export function unshownLines(methodId: string) {
  const lines: string[] = [];
  for (const record of storedOutcomes(methodId).filter(r => !r.shown && r.status !== 'working')) { lines.push(...recordLines(record, { brief: true })); markShown(record); }
  return lines;
}

/** Starts the fix of these corrections in its own process; tests replace it. */
export const fixStarter = {
  async start(file: string, methodId: string, ids: string[], server: string) {
    const folder = fixFolder(methodId);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const out = openSync(join(folder, 'fix.log'), 'a', 0o600);
    const suffix = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    const entry = fileURLToPath(new URL(`./method${suffix}`, import.meta.url));
    const child = spawn(process.execPath, [...process.execArgv, entry, '__fix', resolve(file), '--server', server, ...ids.flatMap(id => ['--judgment', id])],
      { detached: true, stdio: ['ignore', out, out], cwd: process.cwd(), env: { ...process.env, METHOD_RUN_WORKER: '' } });
    closeSync(out);
    await new Promise<void>((yes, no) => { child.once('spawn', yes); child.once('error', no); });
    if (child.pid) setWorker(methodId, ids, child.pid);
    child.unref();
  },
  /** Judges the run's output against the corrections that recent fixes answered, in its own process. */
  watch(file: string, runDir: string, server: string) {
    try {
      const suffix = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
      const entry = fileURLToPath(new URL(`./method${suffix}`, import.meta.url));
      const child = spawn(process.execPath, [...process.execArgv, entry, '__watch', resolve(file), resolve(runDir), '--server', server], { detached: true, stdio: 'ignore', cwd: process.cwd(), env: { ...process.env, METHOD_RUN_WORKER: '' } });
      child.on('error', () => {}); child.unref();
    } catch { /* watching never delays or fails a run */ }
  },
};

/**
 * `method wait [JUDGMENT_ID] [--timeout SECONDS] [--json]`: wait until the fix of a correction (or of every correction
 * that is being fixed on this computer) has an outcome, and print what it did. While it waits it prints one line a
 * minute. With --timeout, a wait that ends before the fix says so in one line; the fix goes on, and method wait can run
 * again.
 */
export async function waitCommand(args: string[], options: { pollMs?: number; minuteMs?: number } = {}) {
  const { parseArgs } = await import('node:util');
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { timeout: { type: 'string' }, json: { type: 'boolean' } } });
  const id = positionals[0];
  const timeout = values.timeout !== undefined ? Number(values.timeout) : Infinity;
  if (Number.isNaN(timeout) || timeout < 0) throw Error('Use method wait [JUDGMENT_ID] [--timeout SECONDS].');
  const started = Date.now(), deadline = started + timeout * 1000, minute = options.minuteMs ?? 60_000;
  const chosen = () => storedOutcomes().filter(r => id ? r.judgment === id : !r.shown);
  let records = chosen(), told = 0;
  if (id && !records.length) throw Error(`This computer is not fixing ${id} now. ${waitsForComputerLine} Its outcome will be on the run's page on the dashboard.`);
  while (records.some(r => r.status === 'working') && Date.now() < deadline) {
    await new Promise(done => setTimeout(done, options.pollMs ?? 500));
    records = chosen();
    const minutes = Math.floor((Date.now() - started) / minute);
    if (minutes > told && records.some(r => r.status === 'working')) { told = minutes; process.stderr.write(workingForLine(minutes) + '\n'); }
  }
  const finished = records.filter(r => r.status !== 'working'), working = records.filter(r => r.status === 'working');
  for (const record of finished) markShown(record);
  if (values.json) { process.stdout.write(JSON.stringify({ outcomes: records.map(recordJson) }, null, 2) + '\n'); return; }
  const lines = finished.flatMap(record => recordLines(record));
  if (working.length) lines.push((await import('./fix-lines.js')).stillWorkingLine);
  if (!records.length) lines.push((await import('./fix-lines.js')).nothingWaitingLine);
  process.stdout.write(lines.join('\n') + '\n');
}

// The global pointer to the Method file of the last change on this computer, for method undo with no file.
const lastChangeFile = () => join(methodCache(), 'fixes', 'last-change.json');
export function recordLastChange(file: string) { mkdirSync(join(methodCache(), 'fixes'), { recursive: true, mode: 0o700 }); writePrivateJson(lastChangeFile(), { file: resolve(file) }); }
export function lastChangedFile(): string | undefined { try { const file = JSON.parse(readFileSync(lastChangeFile(), 'utf8')).file; return existsSync(file) ? file : undefined; } catch { return undefined; } }

export function forgetOutcome(methodId: string, id: string) { rmSync(recordPath(methodId, id), { force: true }); rmSync(outputDir(methodId, id), { recursive: true, force: true }); rmSync(dirname(resultPath(methodId, id)), { recursive: true, force: true }); }
