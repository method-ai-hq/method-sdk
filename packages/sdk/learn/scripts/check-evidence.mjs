// Every value that the locate agent cites must be in the recorded run, byte for byte.
import { input, output, acceptedSteps, valueAt, clip } from './lib.mjs';
const { run_dir, locate, note } = input();
const { accepted } = acceptedSteps(run_dir);
const problems = [];
for (const item of locate.evidence) {
  const found = accepted.find(a => a.step === item.step && a.iteration === item.iteration);
  if (!found) { problems.push(`${item.step}:${item.iteration} was not accepted in the run.`); continue; }
  const value = valueAt(found.outputs, item.output);
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (value === undefined) problems.push(`${item.step}:${item.iteration} has no output ${item.output}.`);
  else if (!item.quoted || !text.includes(item.quoted)) problems.push(`The quoted text is not in ${item.step}:${item.iteration} ${item.output}: ${clip(item.quoted, 200)}`);
}
if (!locate.evidence.length) problems.push('The agent cited no recorded value.');
const contradicts = locate.result === 'note_wrong';
const verified = !problems.length && !contradicts;
const summary = [
  `Proposed cause: ${locate.result}${locate.step ? ` in step ${locate.step}` : ''}.`, locate.explanation,
  `Cited evidence:\n${locate.evidence.map(e => `- ${e.step}:${e.iteration} ${e.output}: "${clip(e.quoted, 300)}"`).join('\n') || '- none'}`,
  contradicts ? 'The agent found that the recorded evidence contradicts the note. Nothing will change unless you confirm the note.'
    : problems.length ? `Evidence check FAILED:\n${problems.map(p => '- ' + p).join('\n')}` : 'Evidence check: every cited value is in the recorded run.',
].join('\n\n');
output({ evidence_check: { verified, problems }, summary });
