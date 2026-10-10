import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { checks, precisionBar, shownChecks } from '../../packages/sdk/src/model-checks.js';

const root = 'testkit/checks';
const read = (split: string, check: string) => { const file = join(root, split, `${check}.jsonl`); return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; };
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

it('each labeled item has a label, a reason, its inputs, and the split that its id gives', () => {
  for (const check of Object.keys(checks)) {
    const ids = new Set<string>();
    for (const split of ['heldout', 'open']) for (const item of read(split, check)) {
      expect(Object.keys(item)).toEqual(['id', 'check', 'label', 'reason', 'source', 'synthetic', 'inputs']);
      expect(item.check).toBe(check); expect(typeof item.label).toBe('boolean'); expect(item.reason.length).toBeGreaterThan(10);
      expect(typeof item.inputs.step).toBe('string'); expect(item.synthetic === (item.source === 'synthetic')).toBe(true);
      expect(ids.has(item.id)).toBe(false); ids.add(item.id);
      expect(parseInt(sha(item.id)[0]!, 16) < 8 ? 'heldout' : 'open').toBe(split);
    }
  }
});
it('the held-out split is frozen', () => {
  const frozen = JSON.parse(readFileSync(join(root, 'frozen.json'), 'utf8'));
  for (const check of Object.keys(checks)) expect(sha(readFileSync(join(root, 'heldout', `${check}.jsonl`)))).toBe(frozen[check]);
});
it('a check is shown only when results.json shows it meets its precision bar on the frozen held-out split', () => {
  const results = JSON.parse(readFileSync(join(root, 'results.json'), 'utf8')), frozen = JSON.parse(readFileSync(join(root, 'frozen.json'), 'utf8'));
  for (const name of shownChecks) {
    const result = results.checks[name], check = checks[name]!;
    expect(result.version).toBe(check.version); expect(result.heldout_sha256).toBe(frozen[name]);
    expect(result.errors).toBe(0); expect(result.precision).toBeGreaterThanOrEqual(precisionBar[check.level]);
  }
});
