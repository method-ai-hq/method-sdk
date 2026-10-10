/**
 * The issues of a local Method: the runtime's methodIssues (format and code checks, with this computer's secret
 * values and the files that will be uploaded), the model privacy check, and the model checks. Only errors block.
 */
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { methodIssues } from '@withmethod/runtime/document.js';
import { isModelId } from '@withmethod/runtime/semantics.js';
import { parseDocumentValue } from '../../workflow-language/src/validate.js';
import { authoringPath } from './authoring.js';
import { changedSteps, checkTargets, checks, checksDir, evaluateTarget, modelIssues, runChecks, shownChecks, type Issue, type Target } from './model-checks.js';
import { packageFileNames } from './method-files.js';
import { MethodClient } from './method-client.js';

/** A .env file holds secret values: issue checks never read it. */
export const refused = (path: string) => /^\.env(\.|$)/.test(basename(path));
/** A file of the Method folder as text; undefined when it is missing, outside the folder, or not allowed. */
export function folderReader(file: string) {
  const root = realpathSync(dirname(resolve(file)));
  return (path: string) => {
    try {
      const target = realpathSync(resolve(root, path));
      if (!target.startsWith(root + sep) || refused(target)) return undefined;
      return readFileSync(target, 'utf8');
    } catch { return undefined; }
  };
}
function folderBytes(file: string, names: string[]) {
  const root = realpathSync(dirname(resolve(file))), files: Record<string, Uint8Array> = {};
  for (const name of names) {
    try {
      const target = realpathSync(resolve(root, name));
      if (target.startsWith(root + sep) && !refused(target)) files[name] = readFileSync(target);
    } catch { /* A missing file is reported by preflight. */ }
  }
  return files;
}

/** The hosted model ID that each call or agent step (or agent check) names, with the field. */
export function hostedModelUses(method: any) {
  const uses: { step: string; field: string; model: string; name?: string }[] = [];
  for (const [id, step] of Object.entries<any>(method.steps ?? {})) for (const [field, exec] of [['do.model', step.do], ['check.model', step.check]] as const) {
    if (!exec || !['call', 'agent'].includes(exec.kind) || typeof exec.model !== 'string') continue;
    const named = method.models?.[exec.model];
    // A local-agent entry ({agent: codex | claude}) is not a hosted model.
    if (named?.agent) continue;
    const model = typeof named === 'string' ? named : typeof named?.model === 'string' ? named.model : isModelId(exec.model) ? exec.model : undefined;
    if (model) uses.push({ step: id, field, model, ...(named ? { name: exec.model } : {}) });
  }
  return uses;
}
/** model_not_private: a step names a hosted model that has no private endpoint. Deterministic from the saved list. */
export function privacyIssues(method: any, privateIds: Set<string>): Issue[] {
  return hostedModelUses(method).filter(use => !privateIds.has(use.model)).map(use => ({
    code: 'model_not_private', level: 'warning' as const, step: use.step, field: use.field,
    message: `${use.step} uses ${use.model}${use.name ? ` (models.${use.name})` : ''}, which no provider serves with the private options (no training, zero data retention), so hosted runs refuse it.`,
    fix: 'Choose a model from method models.',
  }));
}

/**
 * legacy_runtime_json and legacy_sidecar: an old runtime.json or FILE.method.json is next to the Method. Method files
 * no longer read them, so a run would lose their settings. The fix says what to move where; nothing is changed here.
 */
export function legacyIssues(file: string): Issue[] {
  const path = authoringPath(file), folder = dirname(path), issues: Issue[] = [];
  if (existsSync(join(folder, 'runtime.json'))) issues.push({ code: 'legacy_runtime_json', level: 'error',
    message: `runtime.json is next to ${basename(path)}. Methods no longer read runtime.json, so its settings would be lost.`,
    fix: 'Move each part into the Method, then delete runtime.json. models -> top-level models: (NAME: provider/model, or {model, max_output_tokens, reasoning_effort}); a profile with backend codex or claude -> NAME: {agent: codex|claude, model, reasoning_effort} (keep its model and reasoning_effort). limits -> top-level limits:. step_defaults -> limits.step. tools -> top-level tools:. environment paths -> method bind ID NAME --file FOLDER (a folder beside the Method with the connection name needs nothing). classification.api_key_env -> method config model-key. runtimes and allow_local_processes need nothing. Set format: method/3.4 and remove runtime.json from files:.' });
  if (existsSync(`${path}.method.json`)) issues.push({ code: 'legacy_sidecar', level: 'error',
    message: `${basename(path)}.method.json is next to ${basename(path)}. Methods keep their ID in the file now.`,
    fix: `Put its workflow_id as the line id: wf_... directly after format: method/3.4 in ${basename(path)}, then delete ${basename(path)}.method.json.` });
  return issues;
}

export type IssueReport = { issues: Issue[]; changed?: Set<string>; pending: number; notChecked: string[]; invalid?: boolean };
/**
 * All issues of a Method file. With changed, model checks run for the steps whose text changed since the last
 * validate (in parallel, waitMs in all; the rest finish in the background). Without it, only cached answers are used.
 */
export async function collectIssues(file: string, options: { phase?: 'validate' | 'publish'; waitMs?: number; client?: MethodClient; background?: boolean } = {}): Promise<IssueReport> {
  const path = authoringPath(file), text = readFileSync(path, 'utf8');
  const legacy = legacyIssues(path), first = [...legacy, ...methodIssues(text)];
  if (first.some(issue => issue.level === 'error')) return { issues: first, pending: 0, notChecked: [], invalid: true };
  const method = parseDocumentValue(text), read = folderReader(path);
  const { deviceSecretValues, resolveSecrets } = await import('./secrets.js');
  const declared = Object.keys(method.secrets ?? {});
  const client = options.client ?? new MethodClient();
  const signedIn = (() => { try { return !!client.token(); } catch { return false; } })();

  const changed = options.phase === 'publish' ? undefined : changedSteps(path, method, read);
  const targets = checkTargets(method, read);
  const provider = signedIn ? (await import('./classification-client.js')).managedClassification(client) : undefined;
  const run = changed ? targets.filter(target => changed.has(target.step)) : [];
  const [{ done, pending }, list] = await Promise.all([
    runChecks(provider, run, options.waitMs ?? 3000),
    signedIn ? (await import('./hosted-models.js')).privateModels(client, { waitMs: options.waitMs ?? 3000 }).catch(() => undefined) : Promise.resolve(undefined),
  ]);
  // Unchanged steps use the answers saved earlier; a missing one is not computed now.
  const { cached } = await import('./model-checks.js');
  const results = [...done, ...targets.filter(target => !run.includes(target)).flatMap(target => { const hit = cached(target.key); return hit ? [hit] : []; })];
  if (pending.length && provider && options.background !== false) finishInBackground(pending);
  const computed = new Set(results.map(result => `${result.check} ${result.step}`));
  // Shadow checks and checks without an answer give no accept_unused note.
  const notChecked = [...Object.keys(checks).filter(code => !shownChecks.includes(code) || targets.some(target => target.check === code && !computed.has(`${code} ${target.step}`))),
    ...(list ? [] : ['model_not_private'])];
  const issues = methodIssues(text, {
    secretValues: deviceSecretValues(declared), availableSecrets: Object.keys(resolveSecrets(declared)), phase: 'validate',
    files: folderBytes(path, packageFileNames(dirname(path), method)),
    issues: [...modelIssues(results), ...(list ? privacyIssues(method, new Set(list.models.map(model => model.id))) : [])],
    notChecked,
  } as any) as Issue[];
  return { issues, ...(changed ? { changed } : {}), pending: provider ? pending.length : 0, notChecked };
}

/** Finish the checks that did not answer in time in a detached process, so the next validate has their answers. */
function finishInBackground(targets: Target[]) {
  try {
    if (process.env.METHOD_NO_BACKGROUND_CHECKS === '1') return;
    const dir = join(checksDir(), 'pending'); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${randomUUID()}.json`); writeFileSync(file, JSON.stringify(targets), { mode: 0o600 });
    const suffix = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    const entry = fileURLToPath(new URL(`./method${suffix}`, import.meta.url));
    const log = openSync(join(dir, 'checks.log'), 'a', 0o600);
    const child = spawn(process.execPath, [...process.execArgv, entry, '__checks', file], { detached: true, stdio: ['ignore', log, log], env: { ...process.env, METHOD_RUN_WORKER: '' } });
    closeSync(log); child.on('error', () => {}); child.unref();
  } catch { /* A check never delays or fails validate. */ }
}
/** The background worker: answer each pending target and save it in the cache. */
export async function checksWorker(file: string) {
  const targets: Target[] = JSON.parse(readFileSync(file, 'utf8'));
  const { rmSync } = await import('node:fs');
  rmSync(file, { force: true });
  const provider = (await import('./classification-client.js')).managedClassification(new MethodClient());
  await Promise.allSettled(targets.map(target => evaluateTarget(provider, target, AbortSignal.timeout(120_000))));
}

const where = (issue: Issue) => [issue.file ?? (issue.step ? `steps.${issue.step}${issue.field ? `.${issue.field}` : ''}` : issue.field), issue.line ? `line ${issue.line}` : undefined].filter(Boolean).join(', ');
/** One issue as the coding agent reads it: what is wrong, what to do, and, for a warning on a step, how to accept it. */
export function formatIssue(issue: Issue) {
  return { level: issue.level, code: issue.code, ...(where(issue) ? { at: where(issue) } : {}), message: issue.message, fix: issue.fix,
    ...(issue.level === 'warning' && issue.step ? { accept: `Or, if the user decides to keep it, add accept: {${issue.code}: "<the user's reason>"} to step ${issue.step}.` } : {}) };
}
/**
 * The issues that validate prints: every error; every open warning on a changed step (and those not on a step);
 * notes only when asked. Accepted ones are counted.
 */
export function shownIssues(report: IssueReport, flags: { notes?: boolean; all?: boolean } = {}) {
  const open = report.issues.filter(issue => issue.accepted === undefined);
  const errors = open.filter(issue => issue.level === 'error');
  const warnings = open.filter(issue => issue.level === 'warning');
  const fresh = flags.all || !report.changed ? warnings : warnings.filter(issue => !issue.step || report.changed!.has(issue.step));
  const listed = fresh;
  const notes = open.filter(issue => issue.level === 'note');
  const hidden = warnings.length - listed.length;
  return {
    issues: [...errors, ...listed, ...(flags.notes || flags.all ? notes : [])].map(formatIssue),
    issue_counts: { errors: errors.length, warnings: warnings.length, notes: notes.length, accepted: report.issues.length - open.length },
    ...(hidden ? { more_warnings: `${hidden} more warning${hidden === 1 ? '' : 's'} on unchanged steps. method validate FILE --all lists them.` } : {}),
    ...(report.pending ? { checks: `${report.pending} check${report.pending === 1 ? '' : 's'} pending` } : {}),
  };
}
export const guideLine = 'Fix errors. Fix each warning, or accept it with the user\'s reason. Never add a check only to remove a warning.';

/** The publish gate: errors refuse the publish; every open warning and note is listed. */
export async function publishIssues(client: MethodClient, file: string) {
  const { issues } = await collectIssues(file, { phase: 'publish', client });
  const errors = issues.filter(issue => issue.level === 'error');
  if (errors.length) throw Object.assign(Error(`Nothing was published. Fix ${errors.length === 1 ? 'this error' : 'these errors'}, then publish again: ${errors.map(issue => `${issue.code}${where(issue) ? ` (${where(issue)})` : ''}: ${issue.message} ${issue.fix}`).join(' ')}`), { code: 'method_has_errors', issues: errors.map(formatIssue) });
  const open = issues.filter(issue => issue.accepted === undefined), accepted = issues.length - open.length;
  return { ...(open.length ? { issues: open.map(formatIssue) } : {}), ...(accepted ? { accepted_issues: accepted } : {}) };
}
