/**
 * The local Method server: the one HTTP server that Method keeps on this computer, on 127.0.0.1:47130. For a run whose
 * content stays on this computer (run_data: device, or a workspace that keeps run content on devices), the dashboard
 * reads the run's transcript, the treatment it received and the grader verdicts from here, so that no run content leaves
 * the computer:
 *
 *   GET /runs/{local_run_id}/comparison -> {treatment_note, transcript, grades: {[grade key]: {verdicts, seen}}}
 *
 * It answers only the dashboard of the account that the run is saved in (CORS, with Access-Control-Allow-Private-Network
 * for the browser's private network check), only on its loopback address, and only for runs that a comparison on this
 * computer registered. A comparison run starts it when it is not running; it stops after a day without requests.
 */
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { methodCache } from './prepare.js';
import { writePrivateJson } from './files.js';

export const LOCAL_SERVER_PORT = 47130;
const host = `127.0.0.1:${LOCAL_SERVER_PORT}`;
const idleMs = 24 * 3_600_000;
/** The runs that the server may show, one file each, in the Method cache of the person's computer. */
const registry = (cache = methodCache()) => join(cache, 'local-runs');
const entryFile = (runId: string, cache?: string) => join(registry(cache), `${runId}.json`);

/** What the local server keeps of one run: where its content is on this computer, and the account that may read it. */
export type LocalRun = { server: string; treatment_note: string | null; transcript: string | null; grades: Record<string, { verdicts: unknown[]; seen: string | null }> };
const readEntry = (runId: string, cache?: string): LocalRun | null => { try { return JSON.parse(readFileSync(entryFile(runId, cache), 'utf8')); } catch { return null; } };

/** Register a run in the Method cache `cache`, or add a grade to it. */
export function registerLocalRun(cache: string, runId: string, server: string, change: (entry: LocalRun) => LocalRun) {
  if (!/^[0-9a-f-]{36}$/.test(runId)) return;
  mkdirSync(registry(cache), { recursive: true, mode: 0o700 });
  writePrivateJson(entryFile(runId, cache), change(readEntry(runId, cache) ?? { server, treatment_note: null, transcript: null, grades: {} }));
}

/** The body of GET /runs/{id}/comparison. */
export function localComparisonRun(runId: string) {
  const entry = readEntry(runId);
  if (!entry) return null;
  const text = (path: string | null) => { if (!path) return null; try { return readFileSync(path, 'utf8'); } catch { return null; } };
  const transcript = (text(entry.transcript) ?? '').split('\n').flatMap(line => { try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; } });
  return { server: entry.server, body: { treatment_note: entry.treatment_note, transcript,
    grades: Object.fromEntries(Object.entries(entry.grades).map(([key, grade]) => [key, { verdicts: grade.verdicts, seen: text(grade.seen) }])) } };
}

/** Serve until a day passes without a request. */
export function serveLocal() {
  let timer: ReturnType<typeof setTimeout>;
  const server = createServer((req, res) => {
    clearTimeout(timer); timer = setTimeout(() => server.close(), idleMs);
    // Loopback only: a page that resolves another name to this address (DNS rebinding) is refused.
    if (req.headers.host !== host) { res.writeHead(403).end(); return; }
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"method":true}'); return; }
    const match = /^\/runs\/([0-9a-f-]{36})\/comparison$/.exec(url.pathname);
    const found = match ? localComparisonRun(match[1]!) : null;
    const origin = req.headers.origin;
    // Only the dashboard of the account that saved the run may read it.
    const allowed = !!found && origin === new URL(found.server).origin;
    const cors: Record<string, string> = allowed ? { 'access-control-allow-origin': origin!, vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') {
      if (!allowed) { res.writeHead(403).end(); return; }
      res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET', 'access-control-allow-private-network': 'true', 'access-control-max-age': '600' }).end();
      return;
    }
    if (req.method !== 'GET' || !found) { res.writeHead(404, cors).end(); return; }
    if (!allowed) { res.writeHead(403).end(); return; }
    res.writeHead(200, { ...cors, 'access-control-allow-private-network': 'true', 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(found.body));
  });
  timer = setTimeout(() => server.close(), idleMs);
  return new Promise<typeof server>((done, fail) => {
    server.once('error', fail);
    server.listen(LOCAL_SERVER_PORT, '127.0.0.1', () => done(server));
  });
}

/** Whether the local Method server answers. */
function running() {
  return new Promise<boolean>(done => {
    const req = httpRequest({ host: '127.0.0.1', port: LOCAL_SERVER_PORT, path: '/health', headers: { host }, timeout: 1000 }, res => { res.resume(); done(res.statusCode === 200); });
    req.on('error', () => done(false)); req.on('timeout', () => { req.destroy(); done(false); });
    req.end();
  });
}

/** Start the local Method server for the Method cache `cache` in its own process, when it is not running. */
export async function ensureLocalServer(cache: string) {
  if (await running()) return;
  const suffix = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const entry = fileURLToPath(new URL(`./method${suffix}`, import.meta.url));
  const child = spawn(process.execPath, [...process.execArgv, entry, '__local-server'], { detached: true, stdio: 'ignore', env: { ...process.env, METHOD_CACHE_DIR: cache } });
  child.unref();
  for (let i = 0; i < 40 && !await running(); i++) await new Promise(r => setTimeout(r, 100));
}

/** `method __local-server`: serve; a second server on the same port stops at once. */
export async function localServerCommand() {
  try { await serveLocal(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; }
}
