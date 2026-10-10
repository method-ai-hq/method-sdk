/**
 * Model checks: yes/no questions to Jev through the Method account, for steps whose text changed. Each check starts
 * in shadow mode: it is computed and recorded under ~/.cache/method/checks/, never shown. A check is shown only after
 * its precision on the frozen labeled set (testkit/checks) meets its level: warning >= 0.90, note >= 0.75.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClassificationProvider } from '@withmethod/runtime';
import { serializeWorkflow } from '../../workflow-language/src/validate.js';
import { methodCache } from './prepare.js';

export type Level = 'error' | 'warning' | 'note';
export type Issue = { code: string; level: Level; step?: string; field?: string; file?: string; line?: number; message: string; fix: string;
  evidence?: { probability?: number; check?: string; run_id?: string }; accepted?: string };
type Step = any;
type Check = {
  /** Change the version when the question or the inputs change; old cached answers then no longer apply. */
  version: number; level: Exclude<Level, 'error'>; question: string;
  /** Which part of the step the check reads; undefined when the check does not apply to the step. */
  script?: (step: Step) => string | undefined;
  applies: (step: Step) => boolean;
  field: string; message: (id: string) => string; fix: string;
};

const promptKinds = ['call', 'agent'];
export const checks: Record<string, Check> = {
  script_calls_model: {
    version: 1, level: 'warning', field: 'do',
    question: 'Does this script send text to a language model, an AI model, or an AI classifier (directly or through a helper library or company gateway), and use the model\'s answer? Fetching data, managing API keys, or counting records is not a model call.',
    applies: step => step.do?.kind === 'run', script: step => step.do?.entrypoint,
    message: id => `The script of ${id} appears to call a model.`,
    fix: 'Move each model request into its own call, agent, or classify step with its prompt in the Method, and keep the fixed logic in the script.',
  },
  prompt_multiple_tasks: {
    version: 1, level: 'note', field: 'do.prompt',
    question: 'Does this step\'s prompt ask the model to do two or more separate tasks that could each be their own step with their own output, for example research and then write, or classify and then draft a reply? Several requirements for one output are one task.',
    applies: step => promptKinds.includes(step.do?.kind),
    message: id => `The prompt of ${id} appears to ask for more than one task.`,
    fix: 'Give each task its own step, so that each prompt can be changed and compared alone.',
  },
  check_enforces_wording: {
    version: 1, level: 'note', field: 'check',
    question: 'Does this step\'s check fail an output because it does not use particular words, phrases, or a fixed wording, instead of checking facts, structure, or whether the output meets its goal? Requiring a field, a format such as a date or a link, or a value from the input is not enforcing wording.',
    applies: step => !!step.check?.kind, script: step => step.check?.kind === 'run' ? step.check.entrypoint : undefined,
    message: id => `The check of ${id} appears to require exact wording.`,
    fix: 'Check what the output must contain or achieve, not the words it uses.',
  },
  classify_needs_math: {
    version: 1, level: 'warning', field: 'do.question',
    question: 'Does answering this classification step\'s question need arithmetic, counting, comparing numbers or dates, or another exact calculation that a script does reliably?',
    applies: step => step.do?.kind === 'classify',
    message: id => `The question of ${id} appears to need a calculation.`,
    fix: 'Calculate the value in a run step, and classify only what needs judgment.',
  },
  classify_no_unclear: {
    version: 1, level: 'note', field: 'do.options',
    question: 'Can some inputs of this classification step fit none of its options, or be impossible to decide, while no option covers unclear, other, or none?',
    applies: step => step.do?.kind === 'classify' && !!step.do.options,
    message: id => `The options of ${id} have no choice for an unclear input.`,
    fix: 'Add an option for unclear or other inputs, and decide what a later step does with it.',
  },
  prompt_no_missing_input: {
    version: 1, level: 'warning', field: 'do.prompt',
    question: 'Does this step\'s prompt refer to information, files, or data that are neither written in the prompt nor supplied by the step\'s in: values, so that the model must guess them? Tools, a browser, or a connection named in the step that can get the information count as supplied.',
    applies: step => promptKinds.includes(step.do?.kind),
    message: id => `The prompt of ${id} appears to need information that the step does not give it.`,
    fix: 'Add the missing value to in: from an input or an earlier step, or write it in the prompt.',
  },
};

/**
 * Checks shown to the user. A check moves here from shadow mode only with a results.json that shows its precision
 * on the frozen held-out set meets its level (warning >= 0.90, note >= 0.75). Run npm run eval:checks first.
 */
// Promoted by testkit/checks/results.json: held-out precision 1.00, recall 0.97, with real positives. The other checks stay in shadow mode until real positives clear their bar.
export const shownChecks: string[] = ["script_calls_model"];
export const precisionBar = { warning: 0.9, note: 0.75 } as const;
/** An answer with a probability of yes at or above this is a finding. */
export const findingThreshold = 0.5;

const limit = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
/** The step as the check reads it: display text and accepts are left out, because they do not change what it does. */
export function stepText(id: string, step: Step) {
  const { reading: _reading, accept: _accept, ...rest } = step;
  return limit(serializeWorkflow({ [id]: rest }), 16_000);
}
export type Target = { check: string; version: number; step: string; inputs: Record<string, string>; key: string };
/** The checks that apply to each step, with the exact inputs Jev receives. readText returns a file of the Method folder. */
export function checkTargets(method: any, readText: (path: string) => string | undefined, steps?: Set<string>): Target[] {
  const targets: Target[] = [];
  for (const [id, step] of Object.entries<Step>(method.steps ?? {})) {
    if (steps && !steps.has(id)) continue;
    for (const [name, check] of Object.entries(checks)) {
      if (!check.applies(step)) continue;
      const path = check.script?.(step);
      const inputs: Record<string, string> = { step: stepText(id, step) };
      if (path) inputs.script = limit(readText(path) ?? '', 40_000);
      targets.push({ check: name, version: check.version, step: id, inputs, key: checkKey(name, check.version, inputs) });
    }
  }
  return targets;
}
export const checkKey = (check: string, version: number, inputs: Record<string, string>) =>
  createHash('sha256').update(JSON.stringify([check, version, inputs.step, inputs.script ?? ''])).digest('hex');

export type Result = { check: string; version: number; step: string; key: string; answer: boolean; probability: number; model: string; at: string };
export const checksDir = () => join(methodCache(), 'checks');
export function cached(key: string): Result | undefined {
  const file = join(checksDir(), `${key}.json`);
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined; } catch { return undefined; }
}
function store(result: Result) {
  mkdirSync(checksDir(), { recursive: true, mode: 0o700 });
  const file = join(checksDir(), `${result.key}.json`), temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(result), { mode: 0o600 }); renameSync(temporary, file);
}

/**
 * One yes/no question to Jev, as the two options yes and no (the form that every Method server accepts). The
 * probability is that of yes.
 */
export const answerOptions = { yes: 'Yes: the question describes this step.', no: 'No: the question does not describe this step.' };
export async function askCheck(provider: ClassificationProvider, question: string, inputs: Record<string, string>, signal: AbortSignal) {
  const { model } = await provider.resolve(signal);
  const answer = await provider.evaluate({ request_id: randomUUID(), model, question, options: answerOptions, inputs }, signal) as { choice: string; probabilities: Record<string, number> };
  const probability = answer.probabilities.yes ?? 0;
  return { answer: probability >= findingThreshold, probability, model };
}
export async function evaluateTarget(provider: ClassificationProvider, target: Target, signal: AbortSignal): Promise<Result> {
  const answer = await askCheck(provider, checks[target.check]!.question, target.inputs, signal);
  const result = { check: target.check, version: target.version, step: target.step, key: target.key, answer: answer.probability >= findingThreshold,
    probability: answer.probability, model: answer.model, at: new Date().toISOString() };
  store(result);
  return result;
}

/**
 * Run the targets in parallel. Cached answers come at once; new ones get waitMs in all. The others are returned as
 * pending, so the caller can finish them in the background. A failed check is left out and is tried again next time.
 */
export async function runChecks(provider: ClassificationProvider | undefined, targets: Target[], waitMs = 3000) {
  const done: Result[] = [], pending: Target[] = [];
  const open = targets.filter(target => { const hit = cached(target.key); if (hit) done.push(hit); return !hit; });
  if (!open.length) return { done, pending };
  if (!provider) return { done, pending: open };
  const controller = new AbortController();
  const settled = new Set<string>();
  const work = open.map(target => evaluateTarget(provider, target, controller.signal)
    .then(result => { done.push(result); }).catch(() => {}).finally(() => settled.add(target.key)));
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([Promise.all(work), new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]);
  clearTimeout(timer);
  controller.abort();
  pending.push(...open.filter(target => !settled.has(target.key)));
  return { done, pending };
}

/** Findings of shown checks become issues; shadow checks stay in the cache only. */
export function modelIssues(results: Result[], shown = shownChecks): Issue[] {
  return results.filter(result => result.answer && shown.includes(result.check)).map(result => {
    const check = checks[result.check]!;
    return { code: result.check, level: check.level, step: result.step, field: check.field, message: check.message(result.step), fix: check.fix,
      evidence: { probability: result.probability, check: `${result.check}@${result.version}` } };
  });
}

/** Cached shadow results for a set of keys, for audits. */
export function shadowResults(keys?: Set<string>): Result[] {
  if (!existsSync(checksDir())) return [];
  return readdirSync(checksDir()).filter(name => /^[a-f0-9]{64}\.json$/.test(name) && (!keys || keys.has(name.slice(0, 64))))
    .flatMap(name => { const hit = cached(name.slice(0, 64)); return hit ? [hit] : []; });
}

/** The per-Method record of each step's text at the last validate, to show warnings only for changed steps. */
export function changedSteps(file: string, method: any, readText: (path: string) => string | undefined): Set<string> {
  const dir = join(checksDir(), 'validate'), record = join(dir, `${createHash('sha256').update(file).digest('hex').slice(0, 32)}.json`);
  let before: Record<string, string> = {};
  try { before = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')).steps ?? {} : {}; } catch { /* A new record. */ }
  const now: Record<string, string> = {};
  for (const [id, step] of Object.entries<Step>(method.steps ?? {})) {
    const scripts = [step.do?.kind === 'run' ? step.do.entrypoint : undefined, step.check?.kind === 'run' ? step.check.entrypoint : undefined]
      .filter(Boolean).map(path => readText(path!) ?? '');
    now[id] = createHash('sha256').update(JSON.stringify([stepText(id, step), ...scripts])).digest('hex');
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${record}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ file, steps: now }), { mode: 0o600 }); renameSync(temporary, record);
  return new Set(Object.keys(now).filter(id => before[id] !== now[id]));
}
