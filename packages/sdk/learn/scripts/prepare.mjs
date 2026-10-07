// Copy the Method folder to a private workspace and summarize the recorded run for the agents.
import { mkdirSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { input, output, runtime, hashes, copyTree, acceptedSteps, clip, readFileSync, existsSync, join, dirname } from './lib.mjs';
const { method_file, run_dir, cases_dir } = input();
const { parseDocumentValue } = await runtime();
const folder = dirname(method_file), out = process.env.METHOD_OUTPUT_DIR;
const workspace = join(out, 'workspace'), casesCopy = join(out, 'cases');
copyTree(folder, workspace, [cases_dir]);
mkdirSync(casesCopy, { recursive: true });
if (existsSync(cases_dir)) copyTree(cases_dir, casesCopy, []);
const { accepted } = acceptedSteps(run_dir);
const summary = JSON.parse(readFileSync(join(run_dir, 'summary.json'), 'utf8'));
const ledger = existsSync(join(run_dir, 'effects.jsonl')) ? readFileSync(join(run_dir, 'effects.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const lines = [`Run status: ${summary.status}${summary.code ? ` (${summary.code})` : ''}${summary.error ? `: ${summary.error}` : ''}`];
for (const item of accepted) lines.push(`\n## ${item.step} iteration ${item.iteration}\nInputs: ${clip(item.inputs)}\nOutputs: ${clip(item.outputs)}`);
if (ledger.length) lines.push('\n## Effect observations\n' + ledger.map(e => `${e.effect} attempt ${e.attempt}: ${e.verdict} — ${e.reason}`).join('\n'));
const current = readFileSync(method_file, 'utf8');
const recorded = JSON.parse(readFileSync(join(run_dir, 'method.json'), 'utf8'));
output({
  workspace, method_copy: join(workspace, method_file.slice(folder.length + 1)), cases_copy: casesCopy,
  snapshot: JSON.stringify(hashes(folder, [cases_dir])), run_record: lines.join('\n'), method_text: current,
  method_changed: !isDeepStrictEqual(parseDocumentValue(current), recorded),
});
