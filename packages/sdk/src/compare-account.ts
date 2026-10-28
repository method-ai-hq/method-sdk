/**
 * A comparison in the Method account. `method run NAME.compare` saves the file as a version of its comparison
 * (PUT /api/cli/comparisons/:id; `method publish NAME.compare` saves it the same way as a draft for review, and runs
 * nothing), and each stage of the generated Method reports to it: the cells that a version needs
 * (plan, which answers with the ones not finished yet), each finished cell (cells: a run cell with its synced run, a
 * grade cell with its numbers and verdicts), and each stage (trial, running, done). The result page on the dashboard
 * reads them. When run content stays on this computer, only run IDs and numbers go to the account.
 *
 * The account record (account.json in the comparison folder) keeps the server, the sign-in folder, the signed-in account,
 * the comparison ID and the version, so the stages, which run as separate processes, report to the same comparison with
 * the same account, whichever account is current. It is not part of the
 * generated Method's inputs, so a new version reuses every finished cell. Nothing here stops a comparison: a failed
 * report prints one line, and the comparison runs on.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { canonicalJson } from '../../contracts/src/identity.js';
import { writePrivateJson } from './files.js';
import { DEFAULT_SERVER, MethodClient } from './method-client.js';
import { configRoot } from './computer-settings.js';
import { methodCache } from './prepare.js';

/** cache_dir: the Method cache of this computer, where the local Method server finds the runs it may show. */
export type Account = { server: string; config_dir: string; account?: string | undefined; cache_dir: string; comparison_id: string; version_number: number; stage: string; url: string; spec_digest: string };
const accountFile = (folder: string) => join(folder, 'account.json');
export const readAccount = (folder: string): Account | null => { try { return JSON.parse(readFileSync(accountFile(folder), 'utf8')); } catch { return null; } };
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** One line on stderr, once per process and problem, when the account could not take a report. */
const said = new Set<string>();
function warn(error: unknown) {
  const message = `The comparison page did not get everything: ${(error as Error).message.replace(/\s+/g, ' ').slice(0, 300)}. The comparison runs on; run it again later to send the rest.`;
  if (!said.has(message)) { said.add(message); process.stderr.write(message + '\n'); }
}

/**
 * The client of the comparison's account, with the sign-in that saved it. The processes that this one starts (the arms,
 * their runs and fixes) use the same account.
 */
export function clientOf(account: Account) {
  process.env.METHOD_CONFIG_DIR ??= account.config_dir;
  if (account.account) process.env.METHOD_ACCOUNT = account.account;
  const client = new MethodClient(account.server);
  return account.account ? client.as(account.account) : client;
}

/**
 * Save the comparison file as the newest version of its comparison. Signed out: nothing is saved and the comparison
 * runs on this computer. Returns the account record, or null. strict (method publish, which only saves): signed out or a
 * failed save is an error.
 */
export async function saveComparison(folder: string, id: string, name: string, spec: unknown, options: { strict?: boolean } = {}): Promise<Account | null> {
  let client: MethodClient;
  try { client = new MethodClient(DEFAULT_SERVER); } catch (error) { if (options.strict) throw error; return null; }
  if (!client.token()) {
    if (options.strict) throw Error('Sign in to publish this comparison: method login');
    process.stderr.write('Sign in to see this comparison on the dashboard: method login\n'); return null;
  }
  try {
    const saved = await client.request<{ comparison_id: string; version_number: number; stage: string; url: string }>(`/api/cli/comparisons/${id}`, 'PUT', { name, spec });
    client.remember(id);
    const account: Account = { server: client.server, config_dir: configRoot(), account: client.account()?.key, cache_dir: methodCache(), comparison_id: saved.comparison_id, version_number: saved.version_number, stage: saved.stage,
      url: saved.url, spec_digest: digest(spec) };
    writePrivateJson(accountFile(folder), account);
    return account;
  } catch (error) {
    if (options.strict) throw Error(`The comparison was not published: ${(error as Error).message.replace(/\s+/g, ' ').slice(0, 300)}`);
    warn(error);
    return null;
  }
}

/** The dashboard page of the comparison that compiled into this Method file, when it is saved in the account. */
export function comparisonPage(methodFile: string) {
  return /[/\\]\.compare[/\\][^/\\]+[/\\]comparison\.method$/.test(methodFile) && existsSync(accountFile(join(methodFile, '..')))
    ? readAccount(join(methodFile, '..'))?.url : undefined;
}

async function report<T>(folder: string, path: string, body: unknown): Promise<T | null> {
  const account = readAccount(folder);
  if (!account) return null;
  try { return await clientOf(account).request<T>(`/api/cli/comparisons/${account.comparison_id}/versions/${account.version_number}${path}`, 'POST', body); }
  catch (error) { warn(error); return null; }
}

/** A cell that a version needs, as the account plans it. */
export type PlannedCell = { key: string; kind: 'run' | 'grade'; arm: string; input: string; checkpoint: number | null; repeat: number; trial: boolean; target?: string; grader_version?: string };
/** Send the cells that this version needs. Returns the keys that no version has finished, or null without the account. */
export async function sendPlan(folder: string, cells: PlannedCell[]): Promise<Set<string> | null> {
  if (!cells.length) return null;
  const answer = await report<{ missing: string[] }>(folder, '/plan', { cells });
  return answer ? new Set(answer.missing) : null;
}

/** Upload a text as a result file of the account; returns its reference. */
export async function uploadText(folder: string, text: string) {
  const account = readAccount(folder);
  if (!account) return null;
  const bytes = new TextEncoder().encode(text), sha256 = createHash('sha256').update(bytes).digest('hex');
  try { await clientOf(account).transfer(`/api/cli/result-files/${sha256}`, bytes); return { sha256, bytes: bytes.byteLength }; }
  catch (error) { warn(error); return null; }
}

/**
 * Upload a text with this computer's sign-in, before the comparison has an account record (its inputs, which the saved
 * version names). Null when signed out or when the upload failed.
 */
export async function uploadSignedIn(text: string) {
  let client: MethodClient;
  try { client = new MethodClient(DEFAULT_SERVER); if (!client.token()) return null; } catch { return null; }
  const bytes = new TextEncoder().encode(text), sha256 = createHash('sha256').update(bytes).digest('hex');
  try { await client.transfer(`/api/cli/result-files/${sha256}`, bytes); return { sha256, bytes: bytes.byteLength }; }
  catch (error) { warn(error); return null; }
}

/** Link finished cells: a run cell to its synced run, a grade cell with its numbers. */
export async function linkCells(folder: string, cells: Array<Record<string, unknown>>) {
  if (cells.length) await report(folder, '/cells', { cells });
}

/**
 * Report a stage: trial (what each arm received, the trial size and the estimate), running (the person approved; the
 * file is locked), done (the decision). A version that is past the stage keeps its stage.
 */
export async function sendStage(folder: string, update: { stage: 'trial' | 'running' | 'done'; [key: string]: unknown }) {
  const account = readAccount(folder);
  if (!account) return;
  const order = ['draft', 'trial', 'running', 'done'];
  if (order.indexOf(account.stage) > order.indexOf(update.stage)) return;
  const answer = await report<{ stage: string }>(folder, '/stage', update);
  if (answer) writePrivateJson(accountFile(folder), { ...account, stage: answer.stage });
}

/**
 * The answers on the comparison's page for this version (questions for you): what the person or the expert said about
 * the writer's choices, the corrections and the assumptions, each with what the agent does about it (to_do) and whether
 * the run waits for a change of the file (change), and whether the trial and the full run are approved. open: the
 * questions that nobody has answered yet. Null without the account, or when it did not answer.
 */
export type PageAnswers = {
  url: string; open: number; approved: { trial: boolean; full_run: boolean };
  answers: Array<{ kind: string; question: string; choice: string; words: string | null; by: string; at: string; change: boolean; to_do: string }>;
};
export async function readAnswers(account: Account): Promise<PageAnswers | null> {
  try { return await clientOf(account).request<PageAnswers>(`/api/cli/comparisons/${account.comparison_id}/versions/${account.version_number}/answers`); }
  catch (error) { warn(error); return null; }
}
