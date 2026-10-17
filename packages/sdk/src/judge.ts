import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_SERVER, type MethodClient } from './method-client.js';
import { deviceRun, findRunFolder, methodFileOfRun, saveLocalJudgment } from './local-judgments.js';
import { fixCorrections, waitingLine, type RunFile } from './improve.js';
import { readHome } from './home.js';

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

/** The line that says what was recorded. */
export function judgmentLine(judgment: Pick<Judgment, 'verdict' | 'step_id'>) {
  return `Recorded: ${judgment.verdict}${judgment.step_id ? ` on step ${judgment.step_id}` : ''}.`;
}

/**
 * `method judge RUN_ID right|wrong [--step ID] [--note TEXT] [--corrected FILE] [--json]`: record the person's reaction
 * to a run's result. RUN_ID is the dashboard run ID or this computer's run ID; the server resolves both. When the run's
 * content stays on this computer (run_data: device), the account gets the verdict and step only, and the judgment with
 * its note and corrected result goes in .method/judgments.jsonl next to the Method file. A wrong judgment then fixes the
 * Method here, in the foreground: method judge makes a regression case from the note, finds a change with the user's
 * own Claude Code or Codex, and applies it only when it fixes the run and breaks no earlier correction. It prints one
 * line: what changed, or why nothing did.
 */
export async function judgeCommand(args: string[], clientFactory: (server: string) => MethodClient, options: { run?: RunFile } = {}) {
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
  // The run on this computer, and the Method file that ran it.
  const runDir = findRunFolder(runId), device = !!runDir && deviceRun(runDir);
  const runFile = runDir ? methodFileOfRun(runDir) : undefined;
  if (device && !runFile && (note || corrected !== undefined))
    throw Error(`This run's content stays on this computer, so its note stays next to the Method file. Run method judge in the folder of the Method file.`);
  const content = device ? {} : { ...(note ? { note } : {}), ...(corrected !== undefined ? { corrected } : {}) };
  const body = { verdict, ...(step ? { step_id: step } : {}), ...content };
  const client = clientFactory(values.server ?? DEFAULT_SERVER);
  const response = await client.request<{ judgment: Judgment }>(`/api/cli/runs/${encodeURIComponent(runId)}/judgments`, 'POST', body);
  if (device && runFile) saveLocalJudgment(runFile, {
    id: response.judgment.id, run_id: runId, account_run_id: response.judgment.run_id ?? null, run_dir: runDir!, method_id: response.judgment.method_id ?? null,
    file: basename(runFile), step_id: step ?? null, verdict, note: note ?? null, ...(corrected !== undefined ? { corrected } : {}), created_at: response.judgment.created_at,
  });
  const recorded = judgmentLine(response.judgment);
  if (verdict === 'right') { process.stdout.write(values.json ? JSON.stringify({ judgment: response.judgment }, null, 2) + '\n' : recorded + '\n'); return; }
  // The Method file: the one that ran the run, else the Method's home file on this computer.
  const home = response.judgment.method_id ? readHome(client.server, response.judgment.method_id)?.path : undefined;
  const file = runFile ?? (home && existsSync(home) ? home : undefined);
  if (!file) {
    const line = `${recorded} The Method file is not on this computer, so the next method run of it on a computer fixes it.`;
    process.stdout.write(values.json ? JSON.stringify({ judgment: response.judgment, fix: null }, null, 2) + '\n' : line + '\n');
    return;
  }
  const fix = await fixCorrections(client, file, options);
  if (values.json) { process.stdout.write(JSON.stringify({ judgment: response.judgment, fix: fix ?? null }, null, 2) + '\n'); return; }
  const line = !fix ? `${recorded} Another loop is fixing it.` : fix.corrections > 1 ? `${recorded} ${waitingLine(fix)}` : `${recorded} ${fix.line}`;
  process.stdout.write(line + '\n');
}
