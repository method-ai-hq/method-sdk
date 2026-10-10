/**
 * npm run eval:checks [-- --split open] [-- --check NAME]: ask Jev each model check on the labeled items through this
 * computer's Method sign-in (network), and write precision and recall per check to testkit/checks/results.json.
 * The held-out split is frozen (frozen.json has its hashes); only its results justify moving a check out of shadow
 * mode (shownChecks in packages/sdk/src/model-checks.ts).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { managedClassification } from '../../packages/sdk/src/classification-client.js';
import { MethodClient } from '../../packages/sdk/src/method-client.js';
import { askCheck, checks, findingThreshold, precisionBar } from '../../packages/sdk/src/model-checks.js';

const root = new URL('.', import.meta.url).pathname;
const { values } = parseArgs({ options: { split: { type: 'string', default: 'heldout' }, check: { type: 'string' }, concurrency: { type: 'string', default: '6' } } });
const split = values.split!;
type Item = { id: string; check: string; label: boolean; reason: string; source: string; synthetic: boolean; inputs: Record<string, string> };
export const readSplit = (name: string, check: string): Item[] => {
  const file = join(root, name, `${check}.jsonl`);
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
};
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

const client = new MethodClient();
if (!client.token()) { console.error('Sign in first (method login). The evaluation uses your Method account.'); process.exit(1); }
const provider = managedClassification(client);
const names = values.check ? [values.check] : Object.keys(checks);
const metrics = (rows: { label: boolean; answer: boolean }[]) => {
  const tp = rows.filter(r => r.label && r.answer).length, fp = rows.filter(r => !r.label && r.answer).length;
  const fn = rows.filter(r => r.label && !r.answer).length, tn = rows.filter(r => !r.label && !r.answer).length;
  return { tp, fp, fn, tn, precision: tp + fp ? +(tp / (tp + fp)).toFixed(3) : null, recall: tp + fn ? +(tp / (tp + fn)).toFixed(3) : null };
};
const output: any = { split, generated_at: new Date().toISOString(), server: client.server, threshold: findingThreshold, checks: {} };
let model = '';
for (const name of names) {
  const check = checks[name]!, items = readSplit(split, name);
  if (!items.length) { output.checks[name] = { level: check.level, version: check.version, items: 0 }; continue; }
  const rows: (Item & { answer: boolean; probability: number | null; error?: string })[] = [];
  const queue = [...items];
  await Promise.all(Array.from({ length: Number(values.concurrency) }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      try {
        const answer = await askCheck(provider, check.question, item.inputs, AbortSignal.timeout(120_000));
        model = answer.model;
        rows.push({ ...item, answer: answer.probability >= findingThreshold, probability: answer.probability });
      } catch (error: any) { rows.push({ ...item, answer: false, probability: null, error: error.message }); }
    }
  }));
  const answered = rows.filter(row => row.probability !== null), bar = precisionBar[check.level];
  const all = metrics(answered), real = metrics(answered.filter(row => !row.synthetic));
  output.checks[name] = {
    level: check.level, version: check.version, bar, items: items.length, positives: items.filter(i => i.label).length, negatives: items.filter(i => !i.label).length,
    synthetic: items.filter(i => i.synthetic).length, errors: rows.length - answered.length, ...all, real_only: real,
    meets_bar: all.precision !== null && all.precision >= bar && answered.length === rows.length,
    ...(split === 'heldout' && existsSync(join(root, split, `${name}.jsonl`)) ? { heldout_sha256: sha(join(root, split, `${name}.jsonl`)) } : {}),
    mistakes: rows.filter(row => row.answer !== row.label || row.error).map(row => ({ id: row.id, label: row.label, probability: row.probability, ...(row.error ? { error: row.error } : {}) })),
  };
  console.log(`${name}: precision ${all.precision} recall ${all.recall} (tp ${all.tp} fp ${all.fp} fn ${all.fn} tn ${all.tn}; errors ${rows.length - answered.length}; bar ${bar})`);
}
output.model = model;
const file = join(root, split === 'heldout' ? 'results.json' : `results-${split}.json`);
const previous = existsSync(file) && values.check ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
if (previous) output.checks = { ...previous.checks, ...output.checks };
writeFileSync(file, JSON.stringify(output, null, 2) + '\n');
console.log(`Wrote ${file}`);

