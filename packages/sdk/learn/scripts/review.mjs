// Show the person the change and its effect on recent recorded runs: old and new versions replay the same runs.
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { input, output, runtime, prepared, hashes, changed, lineDiff, text, readFileSync, existsSync, join, dirname, clip } from './lib.mjs';
const { method_file, method_copy, workspace, snapshot, runs_root, run_dir, prepared_file } = input();
const { recordRun, runMethod } = await runtime();
const { config, runOptions } = prepared(prepared_file);
const folder = dirname(method_file);
const files = changed(JSON.parse(snapshot), hashes(workspace, []));
const sections = ['# Change', ...files.map(file => `## ${file}\n${clip(lineDiff(text(join(folder, file)) ?? '', text(join(workspace, file)) ?? '').text, 6000)}`)];
const name = JSON.parse(readFileSync(join(run_dir, 'method.json'), 'utf8')).name;
const runs = existsSync(runs_root) ? readdirSync(runs_root).map(entry => join(runs_root, entry))
  .filter(dir => existsSync(join(dir, 'events.jsonl')) && existsSync(join(dir, 'method.json')) && JSON.parse(readFileSync(join(dir, 'method.json'), 'utf8')).name === name)
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(0, 10) : [];
const replay = async (file, recording) => {
  const dir = mkdtempSync(join(tmpdir(), 'method-review-'));
  try {
    const result = await runMethod(file, config, { ...runOptions, runDir: join(dir, 'run'), inputs: recording.inputs, state: recording.initial_state, replay: { recording, observations: recording.observations ?? {} } });
    const root = JSON.parse(readFileSync(join(dir, 'run', 'checkpoint.json'), 'utf8')).root;
    const { inputs, state, environment, run, ...outputs } = root;
    return { status: result.status, code: result.code, outputs };
  } catch (error) { return { status: 'unverifiable', error: error.message }; }
  finally { rmSync(dir, { recursive: true, force: true }); }
};
const differences = [];
let compared = 0, unverifiable = 0;
for (const dir of runs) {
  let recording;
  try { recording = await recordRun(dir); } catch { continue; }
  const [before, after] = [await replay(method_file, recording), await replay(method_copy, recording)];
  if ([before.code, after.code].includes('unverifiable') || after.status === 'unverifiable') { unverifiable++; continue; }
  compared++;
  const keys = [...new Set([...Object.keys(before.outputs ?? {}), ...Object.keys(after.outputs ?? {})])];
  const diffs = keys.filter(key => !isDeepStrictEqual(before.outputs?.[key], after.outputs?.[key])).map(key => `  ${key}: ${clip(before.outputs?.[key], 400)} → ${clip(after.outputs?.[key], 400)}`);
  if (before.status !== after.status) diffs.unshift(`  status: ${before.status} → ${after.status}`);
  if (diffs.length) differences.push(`- ${dir}\n${diffs.join('\n')}`);
}
sections.push(`# Recent runs replayed on both versions\n${compared} compared, ${unverifiable} could not be replayed (a changed step that acts on an external system cannot run in a replay).`,
  differences.length ? `Changed results:\n${differences.join('\n')}` : 'No result changed in the compared runs.');
output({ review: sections.join('\n\n'), changed_runs: differences.length });
