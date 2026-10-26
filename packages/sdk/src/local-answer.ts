/**
 * Answers for the ask steps of runs on this computer. A local run that reaches an ask step stops and says its run ID;
 * `method answer RUN_ID --answer JSON` keeps the person's answer in the run folder (answers.json) and continues the run
 * in the background, as method run does, so an agent can pass on what the person said. A run finds its answers there
 * when it continues. Each run on this computer is listed by its ID, so the answer finds the run folder.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { methodCache } from './prepare.js';
import { writePrivateJson } from './files.js';

const index = () => join(methodCache(), 'run-ids');
const readJson = (path: string) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; } };

/** The run's ID on this computer (also its ID in the account): the one the worker gave it, else a new one. */
export function localRunId(runDir: string): string {
  const dir = resolve(runDir), saved = readJson(join(dir, 'method-sync.json'))?.id ?? readJson(join(dir, 'run-id.json'))?.id;
  const id = typeof saved === 'string' ? saved : crypto.randomUUID();
  if (!existsSync(join(dir, 'run-id.json'))) writePrivateJson(join(dir, 'run-id.json'), { id });
  mkdirSync(index(), { recursive: true, mode: 0o700 });
  writePrivateJson(join(index(), `${id}.json`), { run_dir: dir });
  return id;
}
/** The folder of a run on this computer, by its ID. */
export function localRunFolder(runId: string) {
  if (!/^[0-9a-f-]{36}$/.test(runId)) return undefined;
  const dir = readJson(join(index(), `${runId}.json`))?.run_dir;
  return typeof dir === 'string' && existsSync(dir) ? dir : undefined;
}

/** The answers that the person gave to a run's ask steps, in the runtime's form {steps: {"STEP:ITERATION": {outputs}}}. */
export const answersFile = (runDir: string) => join(runDir, 'answers.json');
export const readAnswers = (runDir: string) => readJson(answersFile(runDir));
export function saveAnswer(runDir: string, step: string, outputs: unknown) {
  const saved = readAnswers(runDir) ?? { steps: {} };
  writePrivateJson(answersFile(runDir), { steps: { ...saved.steps, [step]: { outputs } } });
}

/** Whether an answer has the fields and types of the question's form. Returns the first problem, or undefined. */
function formProblem(form: any, answer: unknown): string | undefined {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return 'The answer must be a JSON object with the fields of the form.';
  const properties = form?.properties ?? {};
  for (const name of form?.required ?? Object.keys(properties)) if (!(name in (answer as object))) return `The answer has no ${name}.`;
  for (const name of Object.keys(answer as object)) if (!(name in properties)) return `The form has no field ${name}.`;
  const kind = (value: unknown) => Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  for (const [name, definition] of Object.entries(properties) as Array<[string, any]>) {
    const value = (answer as any)[name], type = definition?.type;
    if (type && !(kind(value) === type || (type === 'object' && kind(value) === 'object'))) return `${name} must be a ${type === 'string' ? 'text' : type === 'array' ? 'list' : type}.`;
  }
  return undefined;
}

/**
 * `method answer RUN_ID [--answer JSON]` for a run on this computer. Without --answer: the question, its form and the
 * command that answers it. With --answer: the answer is checked against the form and kept, and the run continues.
 */
export async function answerLocalRun(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { answer: { type: 'string' }, server: { type: 'string' } } });
  const runId = positionals[0]!, dir = localRunFolder(runId)!;
  const { lastQuestion } = await import('./worker.js');
  const summary = readJson(join(dir, 'summary.json'));
  const question = summary?.status === 'needs_input' ? lastQuestion(dir) : null;
  const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  if (!question) { print({ run_id: runId, status: summary?.status ?? 'unknown', message: 'This run has no question to answer.' }); return; }
  const fields = Object.keys((question.form as any)?.properties ?? {});
  if (values.answer === undefined) {
    print({ run_id: runId, step: question.step, question: question.question, form: question.form,
      next: `method answer ${runId} --answer '${JSON.stringify(Object.fromEntries(fields.map(name => [name, '…'])))}'` });
    return;
  }
  let answer: unknown;
  try { answer = JSON.parse(values.answer); } catch { throw Error('The answer is not JSON. Give it as --answer \'{"FIELD": VALUE}\'.'); }
  const problem = formProblem(question.form, answer);
  if (problem) throw Error(`${problem} The form: ${JSON.stringify(question.form)}`);
  saveAnswer(dir, question.step, answer);
  const file = readJson(join(dir, 'method-file.json'))?.path;
  if (typeof file !== 'string' || !existsSync(file)) throw Error(`The Method file of this run is not on this computer any more. Its run folder: ${dir}`);
  const server = readJson(join(dir, 'worker-request.json'))?.args?.find((_: string, i: number, all: string[]) => all[i - 1] === '--server') ?? values.server;
  const { startRunWorker } = await import('./run-worker.js');
  await startRunWorker(['run', file, '--run-dir', dir, '--resume', ...(server ? ['--server', server] : [])], dir);
}
