import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { methodCache } from './prepare.js';
import { writePrivateJson } from './files.js';
import { valueText } from '@withmethod/runtime/rubric.js';
import { type CorrectionOutcome, answerNext, errorLine, heldBackHeading, outcomeLine, stoppedLine, testedOutputHeading, waitsForComputerLine, workingLine } from './fix-lines.js';

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
  write({ judgment: outcome.id, method_id: methodId, file: resolve(file), status: 'done', started_at: before?.started_at ?? new Date().toISOString(), finished_at: new Date().toISOString(), outcome, ...(log ? { log } : {}), shown: false });
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
    const parts = [...(shown.result !== undefined && shown.result !== null ? [clip(valueText(shown.result))] : []), ...Object.entries(shown.files ?? {}).map(([name, text]) => `${name}:\n${clip(text)}`)];
    if (parts.length) lines.push(testedOutputHeading, ...parts);
    if (shown.held_back?.length) lines.push(heldBackHeading, ...shown.held_back.map(call => clip(valueText(call.args))));
  }
  return lines;
}
const clip = (text: string, max = 4000) => text.length > max ? `${text.slice(0, max)}…` : text;

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
 * `method wait [JUDGMENT_ID] [--timeout SECONDS] [--json]`: wait for the fix of a correction (or of every correction
 * that is being fixed on this computer) and print what it did. A wait that ends before the fix says so in one line;
 * the fix goes on, and method wait can run again.
 */
export async function waitCommand(args: string[], options: { pollMs?: number } = {}) {
  const { parseArgs } = await import('node:util');
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { timeout: { type: 'string' }, json: { type: 'boolean' } } });
  const id = positionals[0];
  const timeout = values.timeout !== undefined ? Number(values.timeout) : 100;
  if (!Number.isFinite(timeout) || timeout < 0) throw Error('Use method wait [JUDGMENT_ID] [--timeout SECONDS].');
  const deadline = Date.now() + timeout * 1000;
  const chosen = () => storedOutcomes().filter(r => id ? r.judgment === id : !r.shown);
  let records = chosen();
  if (id && !records.length) throw Error(`This computer is not fixing ${id} now. ${waitsForComputerLine} Its outcome will be on the run's page on the dashboard.`);
  while (records.some(r => r.status === 'working') && Date.now() < deadline) {
    await new Promise(done => setTimeout(done, options.pollMs ?? 500));
    records = chosen();
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

export function forgetOutcome(methodId: string, id: string) { rmSync(recordPath(methodId, id), { force: true }); }
