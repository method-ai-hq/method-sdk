import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_SERVER, type MethodClient } from './method-client.js';
import { deviceRun, findRunFolder, methodFileOfRun, saveLocalJudgment } from './local-judgments.js';
import { catchUp, readHome } from './home.js';
import { readDocument } from './authoring.js';
import { localJudgments } from './local-judgments.js';
import { fixStarter, markWorking, saveError, storedOutcomes } from './fix-outcomes.js';
import { approvedLine, heldPairLine, notHereLine, workingAnswerLine, workingLine } from './fix-lines.js';

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

/**
 * `method judge RUN_ID right|wrong [--step ID] [--note TEXT] [--corrected FILE] [--json]`: record the person's reaction
 * to a run's result. RUN_ID is the dashboard run ID or this computer's run ID; the server resolves both. When the run's
 * content stays on this computer (run_data: device), the account gets the verdict and step only, and the judgment with
 * its note and corrected result goes in .method/judgments.jsonl next to the Method file. A wrong judgment then starts
 * the fix on this computer in its own process and returns at once with one line; method wait prints what the fix did,
 * and so does the next method run of the Method.
 */
export async function judgeCommand(args: string[], clientFactory: (server: string) => MethodClient) {
  const usage = 'Use method judge RUN_ID right|wrong [--step STEP_ID] [--note TEXT] [--corrected FILE], or method judge RUN_ID keep JUDGMENT_ID.';
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    step: { type: 'string' }, note: { type: 'string' }, corrected: { type: 'string' }, json: { type: 'boolean' }, server: { type: 'string' } } });
  const [runId, verdict] = positionals;
  if (runId && verdict === 'keep' && positionals.length === 3) return keepCommand(runId, positionals[2]!, values, clientFactory);
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
  // A judgment that contradicts another person's judgment of the same step is held: show both, with the two choices.
  const pairs = response.held ? await heldPairs(client, response.judgment.method_id, response.judgment.id) : [];
  if (verdict === 'right' || response.held) {
    print(values.json ? { judgment: response.judgment, ...(pairs.length ? { held: pairs } : {}) } : [verdict === 'right' && !response.held ? approvedLine : 'Noted.', ...pairs.flatMap(heldLines)]);
    return;
  }
  return startFix(client, response.judgment, runFile, values);
}
const print = (value: unknown) => process.stdout.write(Array.isArray(value) ? value.join('\n') + '\n' : JSON.stringify(value, null, 2) + '\n');

/** The run's Method file fixes the correction: the file that ran the run, else the Method's home file on this computer. */
export function fileForJudgment(server: string, judgment: Pick<Judgment, 'method_id'>, runFile: string | undefined) {
  const home = judgment.method_id ? readHome(server, judgment.method_id)?.path : undefined;
  return runFile ?? (home && existsSync(home) ? home : undefined);
}

/** Start the fix of a correction in its own process and return: method wait gives its outcome. */
async function startFix(client: MethodClient, judgment: Pick<Judgment, 'id' | 'method_id'>, runFile: string | undefined, values: { json?: boolean }, line = workingLine) {
  const file = fileForJudgment(client.server, judgment, runFile);
  if (!file || !judgment.method_id) { print(values.json ? { judgment, fix: null } : [notHereLine]); return; }
  // The fix starts from the newest version; a teammate's change of the same step stops it until the person combines them.
  const caught = await catchUp(client, file, 'fixing');
  if (caught.status === 'conflict') { print(values.json ? { judgment, fix: null, stopped: caught.result } : [caught.result.failure.headline]); process.exitCode = 2; return; }
  if ('line' in caught) process.stderr.write(caught.line + '\n');
  markWorking(judgment.method_id, file, [judgment.id]);
  try { await fixStarter.start(file, judgment.method_id, [judgment.id], client.server); }
  catch (error: any) { saveError(judgment.method_id, file, judgment.id, error.message); throw error; }
  print(values.json ? { judgment, fix: { status: 'working', wait: `method wait ${judgment.id}` } } : [line]);
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
/** The person's line of a held pair, then the agent's line with the two commands. */
const heldLines = (pair: HeldPair) => [heldPairLine(pair.judgments),
  `Ask the person which one is right, then keep it: ${pair.judgments.map(j => `method judge ${pair.run_id} keep ${j.id} (${j.noted_by ?? 'this one'}'s)`).join(' or ')}.`];

/** `method judge RUN keep JUDGMENT_ID`: keep this judgment of a held pair; the other one is set aside. A kept wrong judgment is fixed. */
async function keepCommand(runId: string, judgmentId: string, values: { json?: boolean; server?: string }, clientFactory: (server: string) => MethodClient) {
  const client = clientFactory(values.server ?? DEFAULT_SERVER);
  const response = await client.request<{ judgment?: Judgment & { noted_by?: string | null } }>(`/api/judgments/${encodeURIComponent(judgmentId)}/settle`, 'POST', { keep: true });
  const kept = response.judgment;
  const recorded = `Kept ${kept?.noted_by ? `${kept.noted_by}'s view` : 'this view'}: the result is ${kept?.verdict ?? 'as judged'}.`;
  if (kept?.verdict !== 'wrong' || !kept.method_id) { print(values.json ? { judgment: kept ?? { id: judgmentId } } : [recorded]); return; }
  const runDir = findRunFolder(runId);
  return startFix(client, kept, runDir ? methodFileOfRun(runDir) : undefined, values, `${recorded} ${workingLine}`);
}

/**
 * `method answer JUDGMENT_ID "THEIR WORDS"`: send the person's answer to the question that a fix asked, and start the
 * fix again with it. For a Method whose run content stays on this computer, the account keeps no answer, so the words
 * also stay next to the Method file.
 */
export async function answerJudgmentCommand(args: string[], clientFactory: (server: string) => MethodClient) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' }, server: { type: 'string' } } });
  const [id, ...words] = positionals, answer = words.join(' ').trim();
  if (!id || !answer) throw Error('Use method answer JUDGMENT_ID "THE PERSON\'S WORDS".');
  if (answer.length > maxNoteLength) throw Error(`The answer has ${answer.length} characters; the most is ${maxNoteLength}.`);
  const stored = storedOutcomes().find(r => r.judgment === id);
  const file = stored && existsSync(stored.file) ? stored.file : undefined;
  const device = !!file && readDocument(file).run_data === 'device';
  const client = clientFactory(values.server ?? DEFAULT_SERVER);
  // The account keeps no answer for a device Method; the words stay next to the Method file.
  const response = await client.request<{ judgment: Judgment }>(`/api/cli/judgments/${encodeURIComponent(id)}/answer`, 'POST', { answer });
  const judgment = response.judgment ?? { id, method_id: stored?.method_id };
  if (device && file) {
    const before = localJudgments(file).filter(j => j.id === id).at(-1);
    if (before) saveLocalJudgment(file, { ...before, answer });
  }
  return startFix(client, { id, method_id: judgment.method_id ?? stored?.method_id ?? '' }, file, values, workingAnswerLine);
}
