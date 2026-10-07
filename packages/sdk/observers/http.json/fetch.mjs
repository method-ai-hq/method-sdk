// Read one record back from an HTTP JSON API. GET only.
import { readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
const connections = JSON.parse(process.env.METHOD_ENVIRONMENT ?? '{}');
const base = connections[option('--connection')];
if (!base) throw Error(`Observer connection ${option('--connection')} is not configured`);
const path = option('--path').replace(/\{(token|inputs\.[a-z0-9_.]+)\}/g, (_, key) => {
  const value = key === 'token' ? input.token : key.split('.').slice(1).reduce((v, k) => v?.[k], input.inputs);
  if (value === undefined || value === null || typeof value === 'object') throw Error(`No scalar value for {${key}}`);
  return encodeURIComponent(String(value));
});
const url = new URL(path, base.endsWith('/') ? base : base + '/');
const headers = { accept: 'application/json', ...(process.env.HTTP_OBSERVER_TOKEN ? { authorization: `Bearer ${process.env.HTTP_OBSERVER_TOKEN}` } : {}) };
const response = await fetch(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(20_000) });
const text = await response.text();
let body = null;
try { body = JSON.parse(text); } catch { /* A non-JSON body is reported by status only. */ }
console.log(JSON.stringify({ observations: [{ source: 'http', ref: `GET ${url.pathname}${url.search}`, observed_at: new Date().toISOString(), data: { status: response.status, body } }] }));
