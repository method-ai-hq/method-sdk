/** npm run freeze:checks: record the sha256 of each held-out file in frozen.json. Run it once, when a held-out set is made. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = new URL('.', import.meta.url).pathname;
const files = readdirSync(join(root, 'heldout')).filter(name => name.endsWith('.jsonl')).sort();
writeFileSync(join(root, 'frozen.json'), JSON.stringify(Object.fromEntries(files.map(name =>
  [name.replace(/\.jsonl$/, ''), createHash('sha256').update(readFileSync(join(root, 'heldout', name))).digest('hex')])), null, 2) + '\n');
