import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { writePrivateJson } from './files.js';
import { openUrl } from './method-client.js';

/**
 * Secret values stay on this computer, in one private file next to the Method sign-in.
 * Method servers never receive them. A value exported in the shell takes precedence.
 */
const storeFile = () => join(homedir(), '.config', 'method', 'secrets.json');
const name = /^[A-Z][A-Z0-9_]*$/;
function readStore(): Record<string, string> {
  const file = storeFile();
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}
function save(values: Record<string, string>) {
  writePrivateJson(storeFile(), { ...readStore(), ...values });
}

/** Values for the declared names that have one. */
export function resolveSecrets(names: string[]): Record<string, string> {
  const store = readStore();
  return Object.fromEntries(names.flatMap(key => {
    const value = process.env[key] || store[key];
    return value ? [[key, value]] : [];
  }));
}

/** Read KEY=VALUE lines without executing the file. Quotes and a leading export are removed. */
function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    let value = match[2]!;
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    values[match[1]!] = value;
  }
  return values;
}

export function importSecrets(file: string, names: string[]) {
  if (!names.length) throw Error('Name the secrets to copy: method secret import FILE NAME...');
  for (const key of names) if (!name.test(key)) throw Error(`Use a capitalized secret name: ${key}`);
  const values = parseEnv(readFileSync(resolve(file), 'utf8'));
  const missing = names.filter(key => !values[key]);
  if (missing.length) throw Error(`Not found in ${file}: ${missing.join(', ')}. No secret was copied.`);
  save(Object.fromEntries(names.map(key => [key, values[key]!])));
  return { saved: names, store: storeFile() };
}

export function listSecrets(names?: string[]) {
  const store = readStore();
  const keys = names?.length ? names : Object.keys(store).sort();
  return keys.map(key => ({ name: key, source: process.env[key] ? 'shell' : store[key] ? 'this computer' : 'missing' }));
}

/** Ask for one value in a private browser form on this computer. The value never passes through chat or a terminal. */
export async function setSecret(key: string, open: (url: string) => void = openUrl, timeoutMs = 10 * 60_000) {
  if (!name.test(key)) throw Error(`Use a capitalized secret name: ${key}`);
  const token = randomBytes(24).toString('base64url');
  const page = (body: string) => `<!doctype html><meta charset="utf-8"><title>Method secret</title><body style="font:16px system-ui;max-width:32rem;margin:4rem auto">${body}</body>`;
  return new Promise<{ saved: string[]; store: string }>((done, fail) => {
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const supplied = Buffer.from(url.pathname.slice(1)), expected = Buffer.from(token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || request.headers.host !== `127.0.0.1:${(server.address() as any).port}`) { response.writeHead(404).end(); return; }
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
        response.end(page(`<h1>${key}</h1><p>Paste the value. It is saved only on this computer, in ${storeFile()}.</p><form method="post"><input name="value" type="password" autofocus required style="width:100%;font:inherit;padding:.5rem"><p><button style="font:inherit">Save</button></p></form>`));
        return;
      }
      let body = '';
      for await (const chunk of request) { body += chunk; if (body.length > 100_000) { response.writeHead(413).end(); return; } }
      // A pasted value often carries a line break or space at its ends.
      const value = (new URLSearchParams(body).get('value') ?? '').trim();
      if (!value) { response.writeHead(400).end(page('<p>Enter a value.</p>')); return; }
      save({ [key]: value });
      response.writeHead(200, { 'content-type': 'text/html' }).end(page(`<p>Saved ${key}. You can close this tab.</p>`));
      clearTimeout(timer); server.close();
      done({ saved: [key], store: storeFile() });
    });
    const timer = setTimeout(() => { server.close(); fail(Error(`No value was entered for ${key}. Run method secret set ${key} again.`)); }, timeoutMs);
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${(server.address() as any).port}/${token}`;
      process.stderr.write(`Enter ${key} in your browser: ${url}\n`);
      open(url);
    });
  });
}

export async function secretCommand(args: string[]) {
  const [action, ...rest] = args;
  const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  if (action === 'import' && rest[0]) return print(importSecrets(rest[0], rest.slice(1)));
  if (action === 'set' && rest.length === 1) return print(await setSecret(rest[0]!));
  if (action === 'list') return print({ secrets: listSecrets(rest) });
  throw Error('Use method secret import FILE NAME..., method secret set NAME, or method secret list.');
}
