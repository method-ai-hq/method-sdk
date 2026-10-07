// Accept a repair only if the cases are untouched, the change is small and general, the new case
// passes, and no earlier case regresses. Runs outside the repair agent.
import { writeFileSync } from 'node:fs';
import { input, output, runtime, prepared, hashes, changed, lineDiff, text, join, dirname, existsSync } from './lib.mjs';
const { inputs, outputs: { repair: outputs } } = input();
const { workspace, method_file, method_copy, case_id, cases_copy, cases_digest, prepared_file, note, snapshot } = inputs;
const { casesDigest, listCases, testSuite } = await runtime();
const report = { checks: [] };
const finish = (status, reason) => {
  writeFileSync(join(dirname(workspace), 'gate-report.json'), JSON.stringify({ status, reason, ...report }, null, 2));
  output({ status, reason, evidence: ['gate-report.json'] });
  process.exit(0);
};
// 1. The agent cannot change a case, old or new.
const digest = (await casesDigest(cases_copy)).sha256;
report.checks.push({ check: 'cases unchanged', pass: digest === cases_digest });
if (digest !== cases_digest) finish('fail', 'The cases changed during the repair. A repair may change only the Method copy.');
if (outputs.result === 'spec_conflict') {
  const active = new Set((await listCases(method_file, cases_copy)).filter(c => c.status === 'active').map(c => c.id));
  const unknown = outputs.conflicting_cases.filter(id => !active.has(id) || id === case_id);
  if (!outputs.conflicting_cases.length || unknown.length) finish('fail', `A spec conflict must name earlier active cases. Not active or unknown: ${unknown.join(', ') || 'none named'}.`);
  finish('pass', `The agent reports a conflict with ${outputs.conflicting_cases.join(', ')}. A person decides.`);
}
if (outputs.result !== 'repaired') finish('fail', 'The repair result must be repaired or spec_conflict.');
// 2. A small, local change. Deleting behavior or copying the note's values into code are known ways to pass a weak test.
const before = JSON.parse(snapshot), after = hashes(workspace, []);
const files = changed(before, after);
if (!files.length) finish('fail', 'The repair changed no file.');
const folder = dirname(method_file);
let added = [], removed = [];
for (const file of files) {
  const diff = lineDiff(text(join(folder, file)) ?? '', text(join(workspace, file)) ?? '');
  added.push(...diff.added); removed.push(...diff.removed);
}
const size = added.length + removed.length;
report.checks.push({ check: 'diff size', lines: size, limit: 80, files });
if (size > 80) finish('fail', `The repair changes ${size} lines; the limit is 80. Make a smaller, local change.`);
const literals = [...note.matchAll(/"([^"]{6,})"|'([^']{6,})'|\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b|\b(\d{5,})\b/g)].map(m => m[1] ?? m[2] ?? m[3] ?? m[4]);
const copied = literals.filter(value => added.some(line => line.includes(value)) && !removed.some(line => line.includes(value)));
report.checks.push({ check: 'no values copied from the note', copied });
if (copied.length) finish('fail', `The repair copies values from the note into the Method (${copied.join(', ')}). Fix the rule, not the example.`);
if (!existsSync(method_copy)) finish('fail', 'The repair removed the Method file.');
// 3. The new case turns green, and every earlier case still passes or was already failing.
const { config, runOptions } = prepared(prepared_file);
const suite = await testSuite(method_copy, config, { casesDir: cases_copy, baseline: method_file, newIds: [case_id], runOptions });
report.suite = { counts: suite.counts, cases: suite.cases.map(c => ({ id: c.id, verdict: c.verdict, reasons: c.candidate.attempts.map(a => a.results?.map(r => r.reason) ?? a.reason) })) };
if (!suite.passed) finish('fail', `The cases do not accept this repair: ${suite.cases.filter(c => !['pass', 'fixed', 'already_failing'].includes(c.verdict)).map(c => `${c.id} ${c.verdict}`).join(', ')}.`);
finish('pass', `Case ${case_id} is fixed; ${suite.counts.pass} earlier cases pass; ${suite.counts.already_failing} were already failing.`);
