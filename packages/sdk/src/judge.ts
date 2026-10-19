import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_SERVER, type MethodClient } from './method-client.js';
import { deviceRun, findRunFolder, methodFileOfRun, saveLocalJudgment } from './local-judgments.js';
import { fixCorrection, waitingLine, type RunFile } from './improve.js';
import { catchUp, readHome } from './home.js';

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
 * own Claude Code or Codex, and applies it only when it fixes the run and breaks no earlier correction. When a fix of
 * the same Method already runs on this computer, the correction joins it: that fix takes it in one more pass, and this
 * command waits for it. It prints one line: what changed, or why nothing did.
 */
export async function judgeCommand(args: string[], clientFactory: (server: string) => MethodClient, options: { run?: RunFile } = {}) {
  // The output stream at the start: a fix that runs in this process sends its run's own output to a log meanwhile.
  const print = process.stdout.write.bind(process.stdout);
  const usage = 'Use method judge RUN_ID right|wrong [--step STEP_ID] [--note TEXT] [--corrected FILE], or method judge RUN_ID keep JUDGMENT_ID.';
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    step: { type: 'string' }, note: { type: 'string' }, corrected: { type: 'string' }, json: { type: 'boolean' }, server: { type: 'string' } } });
  const [runId, verdict] = positionals;
  if (runId && verdict === 'keep' && positionals.length === 3) return keepCommand(runId, positionals[2]!, values, clientFactory, options);
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
  const response = await client.request<{ judgment: Judgment; held?: boolean }>(`/api/cli/runs/${encodeURIComponent(runId)}/judgments`, 'POST', body);
  if (device && runFile) saveLocalJudgment(runFile, {
    id: response.judgment.id, run_id: runId, account_run_id: response.judgment.run_id ?? null, run_dir: runDir!, method_id: response.judgment.method_id ?? null,
    file: basename(runFile), step_id: step ?? null, verdict, note: note ?? null, ...(corrected !== undefined ? { corrected } : {}), created_at: response.judgment.created_at,
  });
  const recorded = judgmentLine(response.judgment);
  // A judgment that contradicts another person's judgment of the same step is held: show both, with the two choices.
  const pairs = response.held ? await heldPairs(client, response.judgment.method_id, response.judgment.id) : [];
  if (verdict === 'right' || response.held) { print(values.json ? JSON.stringify({ judgment: response.judgment, ...(pairs.length ? { held: pairs } : {}) }, null, 2) + '\n' : [recorded, ...pairs.map(heldLine)].join('\n') + '\n'); return; }
  return fixAfter(client, response.judgment, recorded, runFile, values, options, pairs, print);
}

/** The run's Method file fixes the correction: the file that ran the run, else the Method's home file on this computer. */
async function fixAfter(client: MethodClient, judgment: Pick<Judgment, 'id' | 'method_id'>, recorded: string, runFile: string | undefined, values: { json?: boolean }, options: { run?: RunFile }, pairs: HeldPair[],
  print: (text: string) => boolean = process.stdout.write.bind(process.stdout)) {
  const home = judgment.method_id ? readHome(client.server, judgment.method_id)?.path : undefined;
  const file = runFile ?? (home && existsSync(home) ? home : undefined);
  const held = pairs.map(heldLine), extra = pairs.length ? { held: pairs } : {};
  if (!file) {
    const line = `${recorded} The Method file is not on this computer, so the next method run of it on a computer fixes it.`;
    print(values.json ? JSON.stringify({ judgment, fix: null, ...extra }, null, 2) + '\n' : [line, ...held].join('\n') + '\n');
    return;
  }
  // The fix starts from the newest version; a teammate's change of the same step stops it until the person combines them.
  const caught = await catchUp(client, file, 'fixing');
  if (caught.status === 'conflict') {
    print(values.json ? JSON.stringify({ judgment, fix: null, stopped: caught.result, ...extra }, null, 2) + '\n' : [`${recorded} ${caught.result.failure.headline}`, ...held].join('\n') + '\n');
    process.exitCode = 2; return;
  }
  if ('line' in caught) process.stderr.write(caught.line + '\n');
  const fix = await fixCorrection(client, file, judgment.id, options);
  if (values.json) { print(JSON.stringify({ judgment, fix: fix ?? null, ...extra }, null, 2) + '\n'); return; }
  const line = !fix ? `${recorded} Another loop is fixing it.` : fix.corrections > 1 ? `${recorded} ${waitingLine(fix)}` : `${recorded} ${fix.line}`;
  print([line, ...held].join('\n') + '\n');
}

/** Two judgments of the same run and step by two people with opposite verdicts: neither is fixed until one is kept. */
export type HeldPair = { run_id: string; step_id: string | null; judgments: Array<{ id: string; verdict: string; noted_by: string | null; note: string | null }> };
/** The held pairs of a Method, from its judgments in the account. Nothing when they cannot be read. */
async function heldPairs(client: MethodClient, methodId: string | undefined, mine?: string): Promise<HeldPair[]> {
  if (!methodId) return [];
  let judgments: any[];
  try { judgments = (await client.request<{ judgments: any[] }>(`/api/cli/methods/${encodeURIComponent(methodId)}/judgments`)).judgments ?? []; } catch { return []; }
  const byId = new Map(judgments.map(j => [j.id, j])), pairs: HeldPair[] = [], seen = new Set<string>();
  for (const j of judgments) {
    const other = j.outcome === 'held' && j.held_with ? byId.get(j.held_with) : undefined;
    if (!other || seen.has(j.id) || seen.has(other.id)) continue;
    seen.add(j.id); seen.add(other.id);
    const [first, second] = mine === other.id ? [other, j] : [j, other];
    pairs.push({ run_id: j.run_id, step_id: j.step_id ?? null, judgments: [first, second].map(x => ({ id: x.id, verdict: x.verdict, noted_by: x.noted_by ?? null, note: x.note ?? null })) });
  }
  return pairs;
}
const heldLine = (pair: HeldPair) => {
  const said = (j: HeldPair['judgments'][number]) => `${j.noted_by ?? 'Someone'} says it is ${j.verdict}${j.note ? ` ("${j.note.slice(0, 200)}")` : ''}`;
  return `Held: ${pair.step_id ? `step ${pair.step_id} of run ${pair.run_id}` : `run ${pair.run_id}`}. ${pair.judgments.map(said).join('; ')}. Nothing is fixed until one is kept: ${pair.judgments.map(j => `method judge ${pair.run_id} keep ${j.id} (${j.noted_by ?? 'this one'}'s)`).join(' or ')}.`;
};

/** `method judge RUN keep JUDGMENT_ID`: keep this judgment of a held pair; the other one is set aside. A kept wrong judgment is fixed. */
async function keepCommand(runId: string, judgmentId: string, values: { json?: boolean; server?: string }, clientFactory: (server: string) => MethodClient, options: { run?: RunFile }) {
  const client = clientFactory(values.server ?? DEFAULT_SERVER);
  const response = await client.request<{ judgment?: Judgment & { noted_by?: string | null } }>(`/api/judgments/${encodeURIComponent(judgmentId)}/settle`, 'POST', { keep: true });
  const kept = response.judgment;
  const recorded = `Kept ${kept?.noted_by ? `${kept.noted_by}'s judgment` : 'this judgment'}${kept?.verdict ? ` (${kept.verdict})` : ''}; the other one is set aside.`;
  if (kept?.verdict !== 'wrong' || !kept.method_id) { process.stdout.write(values.json ? JSON.stringify({ judgment: kept ?? { id: judgmentId } }, null, 2) + '\n' : recorded + '\n'); return; }
  const runDir = findRunFolder(runId);
  return fixAfter(client, kept, recorded, runDir ? methodFileOfRun(runDir) : undefined, values, options, []);
}
