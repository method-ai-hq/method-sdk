import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../../contracts/src/identity.js';
import { writePrivateJson } from './files.js';
import { fileHash } from './method-files.js';
import { methodCache } from './prepare.js';
import type { MethodClient } from './method-client.js';

/**
 * The outbox on this computer holds what must reach the account: package file uploads, version saves, and run records.
 * It sends them in parallel (6 at a time), retries with backoff, and stops only when no bytes moved for 60 s or the
 * server cannot be reached. What is left stays here; any later method command sends it.
 *
 * Order: a version is sent after its files; a run record after its version. Every request is idempotent, so two
 * processes that send the same item do no harm.
 */
export type FileItem = { kind: 'file'; server: string; sha256: string; size: number };
export type VersionItem = { kind: 'version'; server: string; method_id: string; version_id: string; file?: string;
  body: { workflow: unknown; package: { files: Array<{ sha256: string }>; digest: string }; parent_version_id?: string; reason: string } };
export type RunItem = { kind: 'run'; server: string; run_dir: string; version_id: string; pid: number };
export type Item = FileItem | VersionItem | RunItem;
type Saved = { method_id: string; version_number: number };

export const outboxDir = () => join(methodCache(), 'outbox');
const blobPath = (hash: string) => join(outboxDir(), 'blobs', hash);
const itemKey = (item: Item) => sha256([item.server, item.kind, item.kind === 'file' ? item.sha256 : item.kind === 'version' ? item.version_id : item.run_dir].join('\n')).slice(0, 32);
const savedFile = (server: string) => join(methodCache(), 'versions', `${sha256(server).slice(0, 24)}.json`);
const methodFile = (server: string, methodId: string) => join(methodCache(), 'versions', `${sha256(`${server}\n${methodId}`).slice(0, 24)}.json`);
const read = (path: string) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; } };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Versions this computer knows the server has: version_id -> {method_id, version_number}. */
export function savedVersions(server: string): Record<string, Saved> { return read(savedFile(server)) ?? {}; }
/** The last version this computer saved of a Method, for the parent and the change reason of the next one. */
export function lastSaved(server: string, methodId: string): { version_id: string; version_number?: number; workflow: any } | undefined { return read(methodFile(server, methodId)); }

/** Note a version that the server is known to have (a saved Method run by ID). */
export function recordKnownVersion(server: string, methodId: string, versionId: string, versionNumber: number) {
  if (!savedVersions(server)[versionId]) writePrivateJson(savedFile(server), { ...savedVersions(server), [versionId]: { method_id: methodId, version_number: versionNumber } });
}
/** A checkout of a saved version: the next save of this Method on this computer has it as its parent. */
export function recordCheckout(server: string, methodId: string, versionId: string, versionNumber: number, workflow: unknown) {
  recordKnownVersion(server, methodId, versionId, versionNumber);
  writePrivateJson(methodFile(server, methodId), { version_id: versionId, version_number: versionNumber, workflow });
}
function recordSaved(item: VersionItem, versionNumber: number) {
  writePrivateJson(savedFile(item.server), { ...savedVersions(item.server), [item.version_id]: { method_id: item.method_id, version_number: versionNumber } });
  writePrivateJson(methodFile(item.server, item.method_id), { version_id: item.version_id, version_number: versionNumber, workflow: item.body.workflow });
}

/** Errors that a retry can fix: no response, a stalled transfer, a server error, or too many requests. */
export function retryable(error: any) {
  const status = error?.status ?? Number(/^(\d{3}):/.exec(String(error?.message))?.[1]);
  return !status || status >= 500 || status === 429 || status === 408;
}
const networkError = (error: any) => !(error?.status ?? /^\d{3}:/.test(String(error?.message))) && error?.code !== 'stalled';

export class Outbox {
  private running: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private lastProgress = Date.now();
  private networkFailures = 0;
  private stopped = false;
  private retryAt = new Map<string, { at: number; attempt: number }>();
  private waiters = new Map<string, Array<(saved: boolean) => void>>();
  private failures = new Map<string, string>();
  private owned = new Set<string>();
  private activated = false;
  private signInNoted = false;
  constructor(readonly client: MethodClient, readonly options: { stallMs?: number; concurrency?: number; send?: (item: RunItem) => Promise<void>; write?: (line: string) => void } = {}) {}

  /** Add an item. A file item copies the bytes now, so later edits to the file cannot change what is uploaded. */
  add(item: Item, source?: string) {
    mkdirSync(join(outboxDir(), 'blobs'), { recursive: true, mode: 0o700 });
    if (item.kind === 'file' && !existsSync(blobPath(item.sha256))) {
      const temporary = `${blobPath(item.sha256)}.${process.pid}.tmp`;
      copyFileSync(source!, temporary);
      if (fileHash(readFileSync(temporary)) !== item.sha256) { rmSync(temporary, { force: true }); throw Error(`A file changed while it was being saved: ${source}`); }
      renameSync(temporary, blobPath(item.sha256));
    }
    if (item.kind === 'run') this.owned.add(itemKey(item));
    writePrivateJson(join(outboxDir(), `${itemKey(item)}.json`), item);
    if (this.activated) this.start();
    this.wake?.();
  }
  /** Remove a run item that this process sent itself. */
  remove(item: Item) { this.owned.delete(itemKey(item)); rmSync(join(outboxDir(), `${itemKey(item)}.json`), { force: true }); }
  release(item: RunItem) { this.owned.delete(itemKey(item)); }
  items(): Item[] {
    let names: string[] = [];
    try { names = readdirSync(outboxDir()).filter(name => /^[a-f0-9]{32}\.json$/.test(name)); } catch { return []; }
    return names.map(name => read(join(outboxDir(), name))).filter((item): item is Item => !!item && item.server === this.client.server);
  }
  pending() { return this.items().length; }
  /**
   * Resolves true when the version is on the server (or this computer has no record of it: the server decides), and
   * false when it cannot be saved now: it is still in the outbox after sending stopped, or the server refused it.
   */
  whenSaved(versionId: string): Promise<boolean> {
    if (savedVersions(this.client.server)[versionId]) return Promise.resolve(true);
    if (this.failures.has(versionId)) return Promise.resolve(false);
    if (!this.items().some(item => item.kind === 'version' && item.version_id === versionId)) return Promise.resolve(true);
    this.start();
    if (!this.running) return Promise.resolve(false);
    return new Promise(resolve => this.waiters.set(versionId, [...this.waiters.get(versionId) ?? [], resolve]));
  }
  failure(versionId: string) { return this.failures.get(versionId); }

  /** Start sending in the background. Never throws. */
  start() {
    this.activated = true;
    try { if (this.running || !this.client.token()) return; } catch { return; }
    this.stopped = false;
    this.running = this.loop().catch(() => {}).finally(() => { this.running = undefined; this.settleWaiters(); });
  }
  /** Send what is left. Resolves when the outbox is empty, no bytes moved for stallMs, or the server is unreachable. */
  async drain() {
    this.lastProgress = Date.now();
    this.networkFailures = 0;
    this.start();
    await this.running;
    return { pending: this.items().filter(item => !(item.kind === 'run' && this.owned.has(itemKey(item)))).length };
  }
  stop() { this.stopped = true; this.wake?.(); }

  private settleWaiters() {
    const saved = savedVersions(this.client.server);
    for (const [id, waiters] of this.waiters) {
      const waiting = this.items().some(item => item.kind === 'version' && item.version_id === id);
      if (saved[id] || this.failures.has(id) || !waiting || !this.running) {
        waiters.forEach(resolve => resolve(!!saved[id] || (!waiting && !this.failures.has(id)))); this.waiters.delete(id);
      }
    }
  }
  private ready(item: Item, all: Item[]) {
    if (item.kind === 'version') return !all.some(other => other.kind === 'file' && item.body.package.files.some(f => f.sha256 === other.sha256));
    if (item.kind === 'run') return !this.owned.has(itemKey(item)) && !(item.pid !== process.pid && alive(item.pid))
      && !all.some(other => other.kind === 'version' && other.version_id === item.version_id) && !this.failures.has(item.version_id);
    return true;
  }
  private async loop() {
    const limit = this.options.concurrency ?? 6, stallMs = this.options.stallMs ?? Number(process.env.METHOD_OUTBOX_STALL_MS || 60_000);
    const active = new Map<string, Promise<void>>();
    let checked = false;
    for (;;) {
      const all = this.items();
      const waiting = all.filter(item => !(item.kind === 'run' && this.owned.has(itemKey(item))));
      if (!waiting.length || this.stopped) break;
      if (Date.now() - this.lastProgress > stallMs) break;
      // The server is unreachable: stop now and keep the items for a later command.
      if (this.networkFailures >= 3 && !active.size) break;
      if (!checked) { checked = true; await this.skipPresent(all.filter((item): item is FileItem => item.kind === 'file')); continue; }
      const now = Date.now();
      const next = waiting.filter(item => !active.has(itemKey(item)) && this.ready(item, all) && (this.retryAt.get(itemKey(item))?.at ?? 0) <= now);
      for (const item of next.slice(0, Math.max(0, limit - active.size))) {
        const key = itemKey(item);
        active.set(key, this.send(item).then(() => {
          rmSync(join(outboxDir(), `${key}.json`), { force: true });
          if (item.kind === 'file') rmSync(blobPath(item.sha256), { force: true });
          this.retryAt.delete(key); this.networkFailures = 0; this.lastProgress = Date.now();
        }, (error: any) => {
          const status = error?.status ?? Number(/^(\d{3}):/.exec(String(error?.message))?.[1]);
          if (status === 401) {
            // The sign-in expired: keep everything for the next signed-in command.
            this.stopped = true;
            if (!this.signInNoted) (this.options.write ?? (line => process.stderr.write(line + '\n')))('Will save when signed in: run method login.');
            this.signInNoted = true;
            return;
          }
          if (!retryable(error)) {
            // A request the server refuses will be refused again: keep it out of the outbox, and say why once.
            mkdirSync(join(outboxDir(), 'failed'), { recursive: true, mode: 0o700 });
            writePrivateJson(join(outboxDir(), 'failed', `${key}.json`), { item, error: String(error.message ?? error) });
            rmSync(join(outboxDir(), `${key}.json`), { force: true });
            if (item.kind === 'version') this.failures.set(item.version_id, String(error.message ?? error));
            (this.options.write ?? (line => process.stderr.write(line + '\n')))(`Not saved to your Method account: ${String(error.message ?? error)}`);
            return;
          }
          if (networkError(error)) this.networkFailures++;
          const attempt = (this.retryAt.get(key)?.attempt ?? 0) + 1;
          this.retryAt.set(key, { at: Date.now() + Math.min(30_000, 500 * 2 ** (attempt - 1)), attempt });
        }).finally(() => { active.delete(key); this.settleWaiters(); this.wake?.(); }));
      }
      // Wait for a send to finish, a new item, or the next retry time.
      const due = Math.min(1000, ...[...this.retryAt.values()].map(r => Math.max(10, r.at - Date.now())));
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, due); timer.unref?.();
        this.wake = () => { clearTimeout(timer); resolve(); };
        Promise.race(active.size ? [...active.values()] : [new Promise(() => {})]).then(() => { clearTimeout(timer); resolve(); });
      });
      this.wake = undefined;
    }
    await Promise.allSettled(active.values());
  }
  private async skipPresent(files: FileItem[]) {
    if (!files.length) return;
    try {
      for (let offset = 0; offset < files.length; offset += 10_000) {
        const found = await this.client.request<{ present: string[] }>('/api/cli/files/check', 'POST', { hashes: files.slice(offset, offset + 10_000).map(f => f.sha256) }, true, { stallMs: this.options.stallMs ?? 60_000 });
        for (const hash of found.present ?? []) {
          const item = files.find(f => f.sha256 === hash)!;
          rmSync(join(outboxDir(), `${itemKey(item)}.json`), { force: true }); rmSync(blobPath(hash), { force: true });
        }
      }
      this.lastProgress = Date.now();
    } catch (error) { if (networkError(error)) this.networkFailures++; }
  }
  private async send(item: Item) {
    const stallMs = this.options.stallMs ?? Number(process.env.METHOD_OUTBOX_STALL_MS || 60_000);
    const onProgress = () => { this.lastProgress = Date.now(); };
    if (item.kind === 'file') {
      if (!existsSync(blobPath(item.sha256))) return;
      await this.client.transfer(`/api/cli/files/${item.sha256}`, readFileSync(blobPath(item.sha256)), { stallMs, onProgress, attempts: 1 });
      return;
    }
    if (item.kind === 'version') {
      const saved = await this.client.request<{ version_id: string; version_number: number }>(
        `/api/cli/methods/${encodeURIComponent(item.method_id)}/versions/${encodeURIComponent(item.version_id)}`, 'PUT', item.body, true, { stallMs, onProgress });
      if (saved.version_id !== item.version_id) throw Object.assign(Error('The server saved another version ID than this content has.'), { status: 409 });
      recordSaved(item, saved.version_number);
      return;
    }
    if (!existsSync(join(item.run_dir, 'method-sync.json'))) return;
    if (!this.options.send) { const { MethodSync } = await import('./method-sync.js'); await MethodSync.retry(item.run_dir, this.client); }
    else await this.options.send(item);
  }
}

/** Send what earlier commands left in the outbox, in the background. Never throws and never delays the command. */
export function sendLeftovers(client: MethodClient) {
  try { const outbox = new Outbox(client, { write: () => {} }); if (outbox.pending()) outbox.start(); } catch { /* sent by a later command */ }
}
