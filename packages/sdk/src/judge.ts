import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_SERVER, type MethodClient } from './method-client.js';
import { deviceRun, findRunFolder, methodFileOfRun, saveLocalJudgment } from './local-judgments.js';

export const maxNoteLength = 4000;
export const maxCorrectedBytes = 1024 * 1024;
export type Judgment = { id: string; run_id: string; method_id: string; verdict: 'right' | 'wrong'; step_id: string | null; created_at: string };

/** The corrected result in a file: its JSON value when it parses as JSON, or else its text. */
export function correctedValue(path: string): unknown {
  let size: number;
  try { size = statSync(path).size; } catch { throw Error(`Cannot read ${path}.`); }
  if (size > maxCorrectedBytes) throw Error(`${path} is larger than 1 MB. Give a shorter corrected result.`);
  const text = readFileSync(path, 'utf8');
  try { return JSON.parse(text); } catch { return text; }
}

/** The one line that says what was recorded. */
export function judgmentLine(judgment: Pick<Judgment, 'verdict' | 'step_id'>, fixing: boolean) {
  return `Recorded: ${judgment.verdict}${judgment.step_id ? ` on step ${judgment.step_id}` : ''}.${fixing ? ' Method is fixing it in the background.' : ''}`;
}

/**
 * `method judge RUN_ID right|wrong [--step ID] [--note TEXT] [--corrected FILE] [--json]`: record the person's reaction
 * to a run's result. RUN_ID is the dashboard run ID or this computer's run ID; the server resolves both. When the run's
 * content stays on this computer (run_data: device), the account gets the verdict and step only, and the judgment with
 * its note and corrected result goes in .method/judgments.jsonl next to the Method file, for method improve.
 */
export async function judgeCommand(args: string[], clientFactory: (server: string) => MethodClient) {
  const usage = 'Use method judge RUN_ID right|wrong [--step STEP_ID] [--note TEXT] [--corrected FILE].';
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    step: { type: 'string' }, note: { type: 'string' }, corrected: { type: 'string' }, json: { type: 'boolean' }, server: { type: 'string' } } });
  const [runId, verdict] = positionals;
  if (!runId || !verdict || positionals.length !== 2) throw Error(usage);
  if (verdict !== 'right' && verdict !== 'wrong') throw Error(`Judge the result right or wrong, not ${verdict}. ${usage}`);
  const note = values.note?.trim();
  if (values.note !== undefined && !note) throw Error('Write the person\'s words after --note.');
  if (note && note.length > maxNoteLength) throw Error(`The note has ${note.length} characters; the most is ${maxNoteLength}.`);
  if (values.step !== undefined && !values.step.trim()) throw Error('Write the step ID after --step.');
  const step = values.step?.trim();
  const corrected = values.corrected !== undefined ? correctedValue(values.corrected) : undefined;
  // A run whose content stays on this computer: its note and corrected result stay here too.
  const runDir = findRunFolder(runId), device = !!runDir && deviceRun(runDir);
  const methodFile = device ? methodFileOfRun(runDir!) : undefined;
  if (device && !methodFile && (note || corrected !== undefined))
    throw Error(`This run's content stays on this computer, so its note stays next to the Method file. Run method judge in the folder of the Method file.`);
  const content = device ? {} : { ...(note ? { note } : {}), ...(corrected !== undefined ? { corrected } : {}) };
  const body = { verdict, ...(step ? { step_id: step } : {}), ...content };
  const client = clientFactory(values.server ?? DEFAULT_SERVER);
  const response = await client.request<{ judgment: Judgment; fixing: boolean }>(`/api/cli/runs/${encodeURIComponent(runId)}/judgments`, 'POST', body);
  const saved = device && methodFile ? saveLocalJudgment(methodFile, {
    id: response.judgment.id, run_id: runId, account_run_id: response.judgment.run_id ?? null, run_dir: runDir!, method_id: response.judgment.method_id ?? null,
    file: basename(methodFile), step_id: step ?? null, verdict, note: note ?? null, ...(corrected !== undefined ? { corrected } : {}), created_at: response.judgment.created_at,
  }) : undefined;
  if (values.json) { process.stdout.write(JSON.stringify({ ...response, ...(saved ? { local_file: saved } : {}) }, null, 2) + '\n'); return; }
  process.stdout.write(judgmentLine(response.judgment, !!response.fixing) + (saved ? ` Its note stays on this computer in ${saved}; method improve ${basename(methodFile!)} uses it.` : '') + '\n');
}
