import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { authoringPath } from './authoring.js';
import { DEFAULT_SERVER, type MethodClient } from './method-client.js';
import { recordChange, saveVersion, snapshot } from './undo.js';
import { removedRuleLine } from './fix-lines.js';

// Learned rules: the rules that the fix loop added from corrections, in learned.json beside the Method file (runtime
// 0.16.0 adds the active rules of a step to its prompt when they apply, and records learned.applied events).

export type LearnedRule = {
  id: string; when: string | null; then: string; by: string | null; from: { judgment?: string; case?: string } | null;
  status: 'active' | 'retired'; created: string; retired_at: string | null; retired_reason: string | null;
  /** What the fix loop keeps about a rule: base_failures, base_runs, dormant, merged_from. */
  meta?: { base_failures?: number; base_runs?: number; dormant?: boolean; merged_from?: string[] };
};
export type Learned = { format: 'method-learned/1'; steps: Record<string, LearnedRule[]> };

export const learnedFile = (file: string) => join(dirname(file), 'learned.json');
export function readLearned(file: string): Learned {
  const path = learnedFile(file);
  if (!existsSync(path)) return { format: 'method-learned/1', steps: {} };
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value?.format !== 'method-learned/1' || typeof value.steps !== 'object') throw Error(`${basename(path)} is not a learned rules file.`);
  return value;
}
/** The active rules of a Method in a stable order: by step, then by date. */
export function activeRules(learned: Learned) {
  return Object.entries(learned.steps).flatMap(([step, rules]) => rules.filter(r => r.status === 'active').map(rule => ({ step, rule })))
    .sort((a, b) => a.rule.created.localeCompare(b.rule.created));
}

/** How often each rule applied, from the learned.applied events of this Method's runs on this computer. */
export async function appliedCounts(file: string) {
  const { localRuns } = await import('./proposals.js');
  const counts = new Map<string, number>();
  for (const run of await localRuns(file)) {
    let text = '';
    try { text = readFileSync(join(run.dir, 'events.jsonl'), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('learned.applied')) continue;
      try { const event = JSON.parse(line); if (event.event === 'learned.applied') for (const id of event.applied ?? []) counts.set(id, (counts.get(id) ?? 0) + 1); } catch { /* a partial line */ }
    }
  }
  return counts;
}

const day = (iso: string) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }); };
/** A rule in plain words: "When the client is Acme, accept five years." */
export const ruleText = (rule: Pick<LearnedRule, 'when' | 'then'>) => {
  const then = rule.then.trim().replace(/[.\s]+$/, '');
  // A condition reads as part of the sentence: "The email is in German." becomes "When the email is in German, ...".
  const when = rule.when?.trim().replace(/^when\s+/i, '').replace(/[.,\s]+$/, '').replace(/^[A-Z](?=[a-z])/, c => c.toLowerCase());
  return when ? `When ${when}, ${then.charAt(0).toLowerCase()}${then.slice(1)}.` : `${then}.`;
};
const usedText = (n: number) => n === 0 ? 'not used yet' : n === 1 ? 'used once' : `used ${n} times`;

/**
 * `method learned FILE [--remove NUMBER|ID] [--json]`: the rules the agent learned from corrections, in plain words,
 * with who taught each one and how often it applied. --remove retires one rule (by its number in the list or its ID);
 * the change is saved as a new version, and method undo brings it back.
 */
export async function learnedCommand(args: string[], clientFactory: (server: string) => MethodClient) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { remove: { type: 'string' }, json: { type: 'boolean' }, server: { type: 'string' } } });
  if (positionals.length !== 1) throw Error('Use method learned FILE [--remove NUMBER].');
  const file = authoringPath(positionals[0]!);
  const learned = readLearned(file), rules = activeRules(learned);
  if (values.remove !== undefined) {
    const wanted = values.remove.trim(), index = /^\d+$/.test(wanted) ? Number(wanted) - 1 : rules.findIndex(r => r.rule.id === wanted);
    const chosen = rules[index];
    if (!chosen) throw Error(`There is no learned rule ${wanted}. List them with method learned ${basename(file)}.`);
    const client = clientFactory(values.server ?? DEFAULT_SERVER);
    const { signedInName } = await import('./quality.js');
    const name = await signedInName(client);
    const before = snapshot(file, ['learned.json']);
    Object.assign(chosen.rule, { status: 'retired', retired_at: new Date().toISOString(), retired_reason: `Removed by ${name ?? 'the person'}.` });
    writeFileSync(learnedFile(file), JSON.stringify(learned, null, 2) + '\n');
    const text = ruleText(chosen.rule);
    recordChange(file, 'learned', `Removed the learned rule "${text}"`, `the rule "${text}" is back`, before);
    await saveVersion(client, file, `Removed a learned rule: ${text}`.slice(0, 500));
    process.stdout.write(values.json ? JSON.stringify({ removed: chosen.rule }, null, 2) + '\n' : removedRuleLine(text) + '\n');
    return;
  }
  const counts = await appliedCounts(file);
  if (values.json) { process.stdout.write(JSON.stringify({ rules: rules.map(({ step, rule }) => ({ ...rule, step, applied: counts.get(rule.id) ?? 0, text: ruleText(rule) })) }, null, 2) + '\n'); return; }
  if (!rules.length) { process.stdout.write('This agent has not learned any rules from corrections yet.\n'); return; }
  const lines = rules.map(({ rule }, i) => `${i + 1}. ${ruleText(rule)} (${[rule.by, day(rule.created)].filter(Boolean).join(', ')}${rule.by || day(rule.created) ? '; ' : ''}${usedText(counts.get(rule.id) ?? 0)})`);
  process.stdout.write(['What this agent learned from corrections:', ...lines, `Remove one: method learned ${basename(file)} --remove NUMBER`].join('\n') + '\n');
}
