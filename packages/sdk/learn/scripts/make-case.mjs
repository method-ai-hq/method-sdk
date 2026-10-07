// Save the approved case in the private cases copy and prove that the current version fails it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { input, output, runtime, prepared, join } from './lib.mjs';
const { labels, draft, method_file, run_dir, note, cases_copy, prepared_file, author, locate } = input();
if (!labels.approved) {
  output({ case_id: '', red_report: '', cases_digest: '', state: { approved_case: false, outcome: { status: 'stopped', message: `The case was not approved. ${labels.comment}`.trim() } } });
  process.exit(0);
}
const { createCase, testSuite, casesDigest } = await runtime();
const { config, runOptions } = prepared(prepared_file);
let expect;
try { expect = JSON.parse(draft.expect_json); } catch (error) { throw Error(`The drafted expectation is not JSON: ${error.message}`); }
// A predicate script is written beside a stand-in path with the Method's file name, so the case keeps that name.
const holder = join(process.env.METHOD_OUTPUT_DIR, 'predicate');
mkdirSync(holder, { recursive: true });
for (const item of expect) if (item.kind === 'predicate') {
  if (!draft.predicate_source.trim()) throw Error('The expectation uses a predicate, but the draft has no predicate source.');
  writeFileSync(join(holder, item.entrypoint), draft.predicate_source);
}
const created = await createCase({ methodFile: join(holder, basename(method_file)), runDir: run_dir, id: draft.id, note, author: author || null, expect,
  casesDir: cases_copy, config, locate: { result: locate.result, step: locate.step } });
const red = await testSuite(method_file, config, { casesDir: cases_copy, ids: [created.id], runOptions });
const verdict = red.cases[0].verdict;
if (verdict === 'pass') throw Error('The case passes on the current version, so it does not capture the error. Describe the error more specifically and run method learn again.');
if (verdict === 'unverifiable') throw Error(`The case cannot be replayed on the current version: ${red.cases[0].candidate.attempts[0]?.reason}`);
output({ case_id: created.id, red_report: JSON.stringify(red.cases[0].candidate.attempts.map(a => a.results ?? a.reason)), cases_digest: (await casesDigest(cases_copy)).sha256,
  state: { approved_case: true, outcome: { status: 'in_progress', message: `Case ${created.id} fails on the current version, as it should.` } } });
