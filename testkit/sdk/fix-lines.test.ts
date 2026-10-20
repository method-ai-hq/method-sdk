import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as lines from '../../packages/sdk/src/fix-lines.js';
import type { CorrectionOutcome, OutcomeKind } from '../../packages/sdk/src/fix-lines.js';

// Every line that a fix shows to the person is about their work: no case, step, criterion, judge, version, IDs,
// paths or run counts.
const forbidden: [string, RegExp][] = [
  ['an internal word', /\b(cases?|steps?|criteri(on|a)|rubrics?|judge[sd]?|judging|versions?|replays?|candidates?|ids?)\b/i],
  ['an ID', /\b(jdg|wf|run|v|lr|lp|un)_[a-z0-9]/i],
  ['a path', /(^|[\s"(])(~|\.{1,2})?\/[\w.-]+\/|[\w-]+\/[\w-]+\.(method|json|mjs|js|py)\b/],
  ['a run count', /\b\d+\s+(runs?|replays?|attempts?|votes?)\b/i],
];
const check = (line: string) => { for (const [what, pattern] of forbidden) expect(line, `"${line}" has ${what}`).not.toMatch(pattern); };

const kinds: OutcomeKind[] = ['fixed', 'no_fix_found', 'could_not_test', 'question', 'held', 'not_reproduced', 'not_fixable_here', 'already_changed', 'retry', 'elsewhere'];
const samples: CorrectionOutcome[] = kinds.flatMap(outcome => [
  { id: 'jdg_1', outcome },
  { id: 'jdg_1', outcome, summary: 'replies now include the redline', tested: { times: 3, earlier: 2 }, subject: 'NDA', tried: 3, question: 'Should every NDA come back redlined?', by: 'Gráinne', detail: 'Two years, not five.', rule_added: true, sends: 'email', path: '/Users/x/room/pages.json' },
  ...(outcome === 'could_not_test' ? (['missing_file', 'can_send', 'too_large', 'no_live_step'] as const).flatMap(reason => [{ id: 'jdg_1', outcome, reason }, { id: 'jdg_1', outcome, reason, rule_added: true, sends: 'email', subject: 'NDA' }]) : []),
]);

it('the line of every outcome has no internal words, IDs, paths or run counts', () => {
  for (const o of samples) check(lines.outcomeLine(o));
  expect(lines.outcomeLine({ id: 'jdg_1', outcome: 'fixed', summary: 'replies now include the redline', tested: { times: 3, earlier: 2 }, subject: 'NDA' }))
    .toBe('Fixed: replies now include the redline. Tested 3 times on this NDA and on 2 earlier ones. Undo: method undo.');
  expect(lines.outcomeLine({ id: 'jdg_1', outcome: 'no_fix_found', tried: 3, subject: 'NDA' })).toBe("No fix found yet: I tried 3 changes; none fixed this NDA reliably. I'll keep your note.");
  expect(lines.outcomeLine({ id: 'jdg_1', outcome: 'could_not_test', reason: 'can_send', sends: 'email', rule_added: true }))
    .toBe('Could not test a fix safely: this agent can send email. I added your note as a rule and will check it on the next runs.');
});

it('every other line for the person has none either', () => {
  for (const [name, value] of Object.entries(lines)) {
    // The agent's next step after a question names the command with the correction's ID; it is not for the person.
    if (name === 'answerNext' || name === 'outcomeLine') continue;
    if (typeof value === 'string') check(value);
    if (typeof value === 'function') {
      const made = name === 'heldPairLine' ? (value as any)([{ verdict: 'wrong', noted_by: 'Ryan', note: 'Too short.' }, { verdict: 'right', noted_by: null, note: null }])
        : name === 'correctionName' ? (value as any)({ author: 'Gráinne', note: 'Two years.' })
        : name === 'uncheckedLine' ? (value as any)(2, ['Gráinne\'s correction ("Two years")'], 'method test nda.method')
        : name === 'prunedLine' ? (value as any)('Removed 2 rules that no longer changed any result.')
        : (value as any)(name === 'waitingLine' ? 2 : 'the fix for "it is not redlined"');
      check(made);
    }
  }
  expect(lines.prunedLine('Removed 2 rules that no longer changed any result.')).toBe('Removed 2 rules that no longer changed any result. Undo: method undo.');
});

it('the source of the lines has no internal words in any quoted text', () => {
  const source = readFileSync(new URL('../../packages/sdk/src/fix-lines.ts', import.meta.url), 'utf8').split('\n').filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.includes('export type') && !line.includes('answerNext'));
  const quoted = source.join('\n').match(/(['`])(?:\\.|(?!\1).)*\1/g) ?? [];
  // Keys of the outcome kinds and reasons are code, not text.
  for (const text of quoted.filter(q => /\s/.test(q))) check(text.slice(1, -1).replace(/\$\{[^}]*\}/g, ''));
});
