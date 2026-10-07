// Shared helpers for the learn Method's scripts.
import { readFileSync, readdirSync, statSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const input = () => JSON.parse(readFileSync(0, 'utf8'));
export const output = value => console.log(JSON.stringify(value));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
/** The runtime that the SDK runs, so tests use the same executor as method run. */
export const runtime = () => import(pathToFileURL(process.env.METHOD_LEARN_RUNTIME).href);
/** The configuration that method learn prepared for the target Method. */
export function prepared(file) {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  return { config: value.config, runOptions: { processPath: value.process_path } };
}
const skip = new Set(['.git', 'node_modules', '.method-runs', 'sensitive', '__pycache__', '.venv']);
/** Files of a Method folder, without run records, dependencies, or the cases folder. */
export function files(root, exclude = []) {
  const out = [];
  const excluded = exclude.map(path => resolve(path));
  const visit = dir => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (skip.has(name) || name.endsWith('.lock') || excluded.some(x => path === x || path.startsWith(x + sep))) continue;
      const info = statSync(path);
      if (info.isDirectory()) visit(path);
      else if (info.isFile() && info.size <= 5_000_000) out.push(relative(root, path).split(sep).join('/'));
    }
  };
  visit(root);
  return out;
}
export const hashes = (root, exclude) => Object.fromEntries(files(root, exclude).map(file => [file, sha256(readFileSync(join(root, file)))]));
export function copyTree(from, to, exclude) {
  for (const file of files(from, exclude)) { mkdirSync(dirname(join(to, file)), { recursive: true }); copyFileSync(join(from, file), join(to, file)); }
}
/** Files whose hash differs between two hash maps, including added and removed files. */
export const changed = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter(file => before[file] !== after[file]);
export function text(path) { try { return readFileSync(path, 'utf8'); } catch { return null; } }
/** A plain line diff that is enough for a person to review and for a size limit. */
export function lineDiff(before = '', after = '') {
  const a = before.split('\n'), b = after.split('\n');
  const m = a.length, n = b.length;
  if (m * n > 4_000_000) return { added: b, removed: a, text: `(file too large to compare: ${m} → ${n} lines)` };
  const table = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const lines = [], added = [], removed = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) { i++; j++; }
    else if (j < n && (i >= m || table[i][j + 1] >= table[i + 1][j])) { added.push(b[j]); lines.push('+ ' + b[j++]); }
    else { removed.push(a[i]); lines.push('- ' + a[i++]); }
  }
  return { added, removed, text: lines.join('\n') };
}
/** The accepted iterations of a recorded run, with inputs and outputs. */
export function acceptedSteps(runDir) {
  const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const started = {}, accepted = [];
  for (const event of events) {
    const key = `${event.step}:${event.iteration}`;
    if (event.event === 'step.started') started[key] = event.inputs;
    if (event.event === 'step.accepted') accepted.push({ step: event.step, iteration: event.iteration, inputs: started[key] ?? {}, outputs: event.outputs });
    if (event.event === 'step.imported') for (const [iteration, outputs] of (event.outputs ?? []).entries()) accepted.push({ step: event.step, iteration, inputs: {}, outputs });
  }
  return { events, accepted };
}
export const valueAt = (value, path) => path ? path.split('.').reduce((v, key) => v === null || v === undefined ? undefined : v[key], value) : value;
export const clip = (value, size = 3000) => { const s = typeof value === 'string' ? value : JSON.stringify(value); return s === undefined ? 'undefined' : s.length > size ? s.slice(0, size) + ` …[${s.length - size} more characters]` : s; };
export { existsSync, readFileSync, join, dirname };
