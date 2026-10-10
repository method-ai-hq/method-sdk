import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadWorkflow } from '../../workflow-language/src/validate.js';
import { authoringPath, readDocument } from './authoring.js';
import { writePrivateJson } from './files.js';
import { managedModels } from './hosted-models.js';
import { contained, fileHash } from './method-files.js';
import type { MethodClient } from './method-client.js';
import { methodCache } from './prepare.js';
import { scriptLanguage, staticEffects, type Language, type ScriptEffects, type ScriptFacts, type Source } from './explain-effects.js';

/** The contract shared with the server and the dashboard (docs/design/step-cards-and-jev.md, section 3). */
export type ScriptCard = {
  schema: 'method-script-card/1'; step_id: string; entrypoint: string; script_sha256: string;
  summary: string; changes: 'nothing' | 'data'; effects: ScriptEffects;
  steps: { text: string; lines: [number, number] }[]; not_done: string[];
  checks: { entities: 'passed' | 'failed'; entity_problems: string[]; round_trip: 'passed' | 'failed' | 'not_run'; round_trip_inputs: number };
  generated_at: string; model: string;
};
type Draft = { summary: string; changes: 'nothing' | 'data'; steps: { text: string; lines: number[] }[]; not_done: string[] };
/** The hosted-model client: managedModels in production, a fake in tests. */
export type Models = { model(): Promise<string>; request(body: Record<string, any>, signal: AbortSignal): Promise<any> };
type Method = { files?: string[]; secrets?: Record<string, unknown>; steps: Record<string, any> };

const runEntrypoints = (method: Method) => new Set(Object.values(method.steps).flatMap(step => [step?.do, step?.check])
  .filter(action => action?.kind === 'run').map(action => action.entrypoint as string));
/** The script steps of a Method: steps whose action is a script. */
export const scriptSteps = (method: Method) => Object.entries(method.steps).filter(([, step]) => step?.do?.kind === 'run').map(([id]) => id);

/**
 * The files a script step's card describes: its entrypoint and every declared Method file that is not another step's
 * entrypoint (the step cache counts the same helper files, because the runtime does not trace imports).
 */
export function scriptFiles(method: Method, id: string) {
  const entrypoints = runEntrypoints(method), entrypoint = method.steps[id]!.do.entrypoint as string;
  return [...new Set([entrypoint, ...(method.files ?? []).filter(path => !entrypoints.has(path))])].sort();
}
/** sha256 over "<file sha256>  <path>\n" lines, sorted by path. The server computes the same value from the package. */
export function scriptSha256(method: Method, id: string, hashes: Map<string, string> | Record<string, string>) {
  const get = (path: string) => hashes instanceof Map ? hashes.get(path) : hashes[path];
  const paths = scriptFiles(method, id);
  if (paths.some(path => !get(path))) return undefined;
  return createHash('sha256').update(paths.map(path => `${get(path)}  ${path}\n`).join('')).digest('hex');
}

const numbered = (text: string) => text.split('\n').map((line, index) => `${String(index + 1).padStart(4)}| ${line}`).join('\n');
const declaration = (method: Method, id: string) => {
  const step = method.steps[id]!;
  return { id, name: step.name, purpose: step.purpose, in: step.in ?? {}, out: step.out ?? {}, secrets: Object.keys(method.secrets ?? {}), changes: step.changes, effects: step.effects };
};

// ---------- Entity check ----------

/**
 * Every number, quoted or backticked name, and host in the card's text must appear in the code or in the step's
 * declaration. A percentage may appear as a fraction (50% as 0.5).
 */
export function entityProblems(draft: Pick<Draft, 'summary' | 'steps' | 'not_done'>, code: string, step: unknown) {
  const haystack = `${code}\n${JSON.stringify(step)}`;
  const words = new Set(haystack.match(/[A-Za-z0-9_.$-]+/g) ?? []);
  const numbers = new Set((haystack.match(/\d+(?:_\d+)*(?:\.\d+)?(?:e-?\d+)?/gi) ?? []).map(value => Number(value.replace(/_/g, ''))));
  const problems = new Set<string>();
  const texts = [draft.summary, ...draft.steps.map(step => step.text), ...draft.not_done];
  for (const text of texts) {
    const names = [...text.matchAll(/`([^`]+)`|"([^"]+)"|'([^'\s][^']*)'(?![a-z])/g)].map(match => (match[1] ?? match[2] ?? match[3])!);
    for (const name of names) if (!haystack.includes(name)) problems.add(`"${name}" does not appear in the code.`);
    const plain = text.replace(/`[^`]*`/g, ' ');
    for (const match of plain.matchAll(/\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|dev|app|co|gov|edu|us|uk|de|so|me|cloud)\b/gi))
      if (!words.has(match[0]) && !haystack.toLowerCase().includes(match[0].toLowerCase())) problems.add(`Host ${match[0]} does not appear in the code.`);
    for (const match of plain.matchAll(/(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(\s*%)?(?![\w])/g)) {
      const value = Number(match[1]!.replace(/,/g, ''));
      if (numbers.has(value) || (match[2] && numbers.has(value / 100))) continue;
      problems.add(`The number ${match[1]}${match[2] ? '%' : ''} does not appear in the code.`);
    }
  }
  return [...problems];
}

// ---------- Hosted model ----------

const draftSchema = {
  type: 'object', additionalProperties: false, required: ['summary', 'changes', 'steps', 'not_done'],
  properties: {
    summary: { type: 'string' }, changes: { type: 'string', enum: ['nothing', 'data'] },
    steps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'lines'], properties: { text: { type: 'string' }, lines: { type: 'array', items: { type: 'integer' } } } } },
    not_done: { type: 'array', items: { type: 'string' } },
  },
};
const programSchema = { type: 'object', additionalProperties: false, required: ['code'], properties: { code: { type: 'string' } } };
const explainRules = `You explain one script of a Method to the person who owns it. Return JSON {summary, changes, steps, not_done}.
Rules:
- summary: one sentence in command form (for example "Score each lead and keep those above 50."). changes: "data" when the script writes files, sends data, or changes another system; otherwise "nothing".
- steps: 3 to 8 numbered plain-English steps in the order the code runs them. Each step has lines [first, last] from the numbered code.
- Write for a reader who does not read code. Say what happens, not how the code does it: no function calls, expressions, or variable names of the code's internals. Example: write "Keep the links to x.com and twitter.com as handles", not "append urlsplit(url).path to handles".
- State thresholds, limits, time windows, sort orders, hosts, and file names exactly as the code has them. Name the step's input and output fields in backticks.
- Add one step that begins with "If" for each branch and each failure path (for example "If \`leads\` is empty, print an empty list."). Join small branches that lead to the same result into one step.
- not_done: up to 4 edge cases that matter to the result and that the code ignores (for example duplicates, missing fields, time zones). Use an empty list if there are none.
- Make no claim that is not in the code. Do not describe the effects list again; it is shown separately.`;

async function ask(models: Models, model: string, system: string, user: string, schema: object, name: string, reasoning: object = { effort: 'low' }) {
  // A reasoning model can spend the whole token budget before it answers a long script, so reasoning is kept low
  // and an empty answer gets one more attempt.
  let data: any, content: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    data = await models.request({
      model, max_tokens: 16000, reasoning, provider: { require_parameters: true },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
    }, AbortSignal.timeout(180_000));
    content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) break;
  }
  if (typeof content !== 'string' || !content.trim())
    throw Error(`The hosted model returned no answer (finish reason: ${data?.choices?.[0]?.finish_reason ?? 'unknown'}).`);
  const json = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  return { value: JSON.parse(json), model: typeof data.model === 'string' ? data.model : model };
}

function cleanDraft(value: any, lineCount: number): Draft {
  const clamp = (n: unknown) => Math.min(Math.max(1, Math.trunc(Number(n) || 1)), Math.max(1, lineCount));
  const steps = (Array.isArray(value?.steps) ? value.steps : []).filter((step: any) => typeof step?.text === 'string' && step.text.trim()).slice(0, 8).map((step: any) => {
    const [a, b] = [clamp(step.lines?.[0]), clamp(step.lines?.[1] ?? step.lines?.[0])];
    return { text: step.text.trim().slice(0, 2000), lines: [Math.min(a, b), Math.max(a, b)] as [number, number] };
  });
  if (typeof value?.summary !== 'string' || !value.summary.trim() || !steps.length) throw Error('The hosted model returned an incomplete explanation.');
  return {
    summary: value.summary.trim().slice(0, 2000), changes: value.changes === 'data' ? 'data' : 'nothing', steps,
    not_done: (Array.isArray(value.not_done) ? value.not_done : []).filter((item: any) => typeof item === 'string' && item.trim()).slice(0, 20).map((item: string) => item.trim().slice(0, 2000)),
  };
}

// ---------- Round trip ----------

/** Recorded inputs of a step from local runs of the same entrypoint, newest first, without duplicates. */
export function recordedInputs(id: string, entrypoint: string, roots: string[], limit = 3) {
  const runs: [string, number][] = [];
  for (const root of new Set(roots.map(path => resolve(path)))) {
    if (root.split(/[\\/]/).includes('sensitive')) continue;
    let names: string[] = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names) {
      const file = join(root, name, 'events.jsonl');
      try { const stat = statSync(file); if (stat.size < 50_000_000) runs.push([file, stat.mtimeMs]); } catch { /* not a run */ }
    }
  }
  const seen = new Set<string>(), inputs: Record<string, unknown>[] = [];
  for (const [file] of runs.sort((a, b) => b[1] - a[1])) {
    let sameScript = false;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      let event: any; try { event = JSON.parse(line); } catch { continue; }
      if (event.event === 'run.started' || event.event === 'run.resumed') sameScript = event.method?.steps?.[id]?.do?.entrypoint === entrypoint;
      if (!sameScript || event.event !== 'step.started' || event.step !== id || !event.inputs || typeof event.inputs !== 'object') continue;
      const key = canonical(event.inputs);
      if (seen.has(key)) continue;
      seen.add(key); inputs.push(event.inputs);
      if (inputs.length >= limit) return inputs;
    }
  }
  return inputs;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as any)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
/** Two outputs agree when their declared fields are JSON-equal after sorting keys (all fields when none are declared). */
export function sameOutput(a: unknown, b: unknown, fields: string[]) {
  const pick = (value: any) => fields.length && value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(fields.map(field => [field, value[field] ?? null])) : value;
  return canonical(pick(a)) === canonical(pick(b));
}

const pythonGuard = String.raw`import os, runpy, socket, sys
def _blocked(*args, **kwargs): raise OSError("network disabled by method explain")
socket.socket.connect = _blocked; socket.socket.connect_ex = _blocked; socket.create_connection = _blocked; socket.getaddrinfo = _blocked
path = sys.argv[1]; sys.argv = sys.argv[1:]; sys.path.insert(0, os.path.dirname(os.path.abspath(path)))
runpy.run_path(path, run_name="__main__")`;
const nodeGuard = `const blocked = () => { throw new Error('network disabled by method explain'); };
const net = require('node:net'), tls = require('node:tls'), dns = require('node:dns');
net.Socket.prototype.connect = blocked; net.connect = blocked; net.createConnection = blocked; tls.connect = blocked;
dns.lookup = (host, options, callback) => (typeof options === 'function' ? options : callback)(new Error('network disabled by method explain'));
globalThis.fetch = async () => blocked();`;

type Outcome = { ok: true; output: unknown } | { ok: false; error: string };
/** Run one program on one input with network calls refused. The process gets no secrets and a private temporary folder. */
export function runProgram(language: Language, file: string, cwd: string, input: unknown, scratch: string): Promise<Outcome> {
  const outputDir = mkdtempSync(join(scratch, 'out-'));
  const guard = join(scratch, 'guard.cjs');
  if (language === 'node' && !existsSync(guard)) writeFileSync(guard, nodeGuard, { mode: 0o600 });
  const [command, args] = language === 'python' ? ['python3', ['-c', pythonGuard, file]] as const : [process.execPath, ['--require', guard, file]] as const;
  return new Promise(done => {
    const child = spawn(command, [...args], { cwd, env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', HOME: scratch, METHOD_OUTPUT_DIR: outputDir, METHOD_ENVIRONMENT: '{}' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 8_000_000) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); done({ ok: false, error: error.message }); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return done({ ok: false, error: stderr.trim().split('\n').at(-1) || `exit ${code}` });
      const lines = stdout.trim().split('\n');
      for (const candidate of [stdout, lines.at(-1) ?? '']) { try { return done({ ok: true, output: JSON.parse(candidate) }); } catch { /* next */ } }
      done({ ok: false, error: 'The program did not print one JSON value.' });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

type RoundTrip = { result: 'passed' | 'failed' | 'not_run'; inputs: number; reason?: string };
async function roundTrip(o: { models: Models; model: string; language: Language; entrypoint: string; root: string; draft: Draft; effects: ScriptEffects; inputs: Record<string, unknown>[] }): Promise<RoundTrip> {
  if (o.effects.network.length) return { result: 'not_run', inputs: 0, reason: `the script calls ${o.effects.network.join(', ')}; Method does not call external services twice` };
  if (!o.inputs.length) return { result: 'not_run', inputs: 0, reason: 'no recorded inputs of this step on this computer' };
  if (/\.(?:ts|mts|cts)$/i.test(o.entrypoint)) return { result: 'not_run', inputs: 0, reason: 'TypeScript scripts are not replayed' };
  const language = o.language === 'python' ? 'Python 3 (standard library only)' : 'JavaScript for Node.js (CommonJS, no packages)';
  // The program must follow the text, not the model's own ideas, so it is written without reasoning. A model that
  // cannot write it leaves the card in place with the round trip not run.
  let value: any;
  try {
    ({ value } = await ask(o.models, o.model, `Write one complete program in ${language}. It reads one JSON object from standard input and prints one JSON object to standard output. Follow the description exactly; it is your only source. Return JSON {code}.`,
      JSON.stringify({ summary: o.draft.summary, steps: o.draft.steps.map(step => step.text), effects: o.effects }, null, 2), programSchema, 'method_program', { enabled: false }));
  } catch (error) { return { result: 'not_run', inputs: 0, reason: `no program was written from the steps: ${(error as Error).message}` }; }
  if (typeof value?.code !== 'string' || !value.code.trim()) return { result: 'failed', inputs: 0, reason: 'the model wrote no program' };
  const scratch = mkdtempSync(join(tmpdir(), 'method-explain-'));
  try {
    const generated = join(scratch, o.language === 'python' ? 'generated.py' : 'generated.cjs');
    writeFileSync(generated, value.code, { mode: 0o600 });
    let replayed = 0;
    for (const input of o.inputs) {
      const original = await runProgram(o.language, contained(o.root, o.entrypoint), o.root, input, scratch);
      if (!original.ok) continue;
      replayed++;
      const copy = await runProgram(o.language, generated, mkdtempSync(join(scratch, 'cwd-')), input, scratch);
      if (!copy.ok || !sameOutput(original.output, copy.output, o.effects.output_fields))
        return { result: 'failed', inputs: replayed, reason: copy.ok ? 'a program written from the steps returned another output' : `a program written from the steps failed: ${copy.error}` };
    }
    return replayed ? { result: 'passed', inputs: replayed } : { result: 'not_run', inputs: 0, reason: 'the script failed on every recorded input without network access' };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

// ---------- One card ----------

export type CardContext = { method: Method; id: string; root: string; sources: Source[]; scriptHash: string; models: Models; roundTrip: boolean; runRoots: string[] };
export async function makeCard(c: CardContext): Promise<{ card: ScriptCard; note?: string }> {
  const step = c.method.steps[c.id]!, entrypoint = step.do.entrypoint as string;
  const language = scriptLanguage(entrypoint);
  if (!language) throw Error(`${entrypoint} is not a Python or JavaScript file.`);
  const { effects, facts } = staticEffects(language, c.sources, step, Object.keys(c.method.secrets ?? {}));
  const code = c.sources.map(source => source.text).join('\n');
  const entry = c.sources.find(source => source.path === entrypoint)!;
  const model = await c.models.model();
  const prompt = (problems: string[] = []) => JSON.stringify({
    step: declaration(c.method, c.id), effects, facts: facts as ScriptFacts,
    code: c.sources.map(source => ({ path: source.path, numbered: numbered(source.text) })),
    ...(problems.length ? { fix: `Your last answer named things that are not in the code. Remove or correct them: ${problems.join(' ')}` } : {}),
  }, null, 2);
  let answer = await ask(c.models, model, explainRules, prompt(), draftSchema, 'method_script_card');
  let draft = cleanDraft(answer.value, entry.text.split('\n').length);
  let problems = entityProblems(draft, code, declaration(c.method, c.id));
  if (problems.length) {
    answer = await ask(c.models, model, explainRules, prompt(problems), draftSchema, 'method_script_card');
    draft = cleanDraft(answer.value, entry.text.split('\n').length);
    problems = entityProblems(draft, code, declaration(c.method, c.id));
  }
  const trip = c.roundTrip
    ? await roundTrip({ models: c.models, model, language, entrypoint, root: c.root, draft, effects, inputs: recordedInputs(c.id, entrypoint, c.runRoots) })
    : { result: 'not_run' as const, inputs: 0, reason: '--no-round-trip' };
  const changes = draft.changes === 'data' || effects.writes.length || step.changes?.length || step.effects ? 'data' : 'nothing';
  return {
    card: {
      schema: 'method-script-card/1', step_id: c.id, entrypoint, script_sha256: c.scriptHash,
      summary: draft.summary, changes, effects, steps: draft.steps as ScriptCard['steps'], not_done: draft.not_done,
      checks: { entities: problems.length ? 'failed' : 'passed', entity_problems: problems.slice(0, 100), round_trip: trip.result, round_trip_inputs: trip.inputs },
      generated_at: new Date().toISOString(), model: answer.model,
    },
    ...(trip.reason ? { note: trip.reason } : {}),
  };
}

// ---------- Command ----------

const explainDir = () => join(methodCache(), 'explain');
const cardCache = () => join(methodCache(), 'script-cards');
const draftKey = (file: string) => createHash('sha256').update(resolve(file)).digest('hex').slice(0, 24);
const cacheKey = (method: Method, id: string, hash: string) => createHash('sha256').update(JSON.stringify([hash, declaration(method, id)])).digest('hex');

export type ExplainOptions = { step?: string | undefined; roundTrip?: boolean; models?: Models; runRoots?: string[]; write?: (line: string) => void };
/**
 * Make, check, and upload a card for each script step of the saved version of FILE's current content, when the
 * version has no card for the step's current script. A card made earlier for the same script and step is reused.
 */
export async function explain(client: MethodClient, file: string, options: ExplainOptions = {}) {
  const write = options.write ?? (line => process.stdout.write(line + '\n'));
  if (!client.token()) { write('Script cards skipped: not signed in. Run method login, then method explain FILE.'); return { status: 'skipped' as const, cards: [] }; }
  const path = authoringPath(file), root = dirname(path);
  const current = await (await import('./versions.js')).currentVersion(path);
  if (!current) throw Error('This file has no saved version. Run it or publish it while signed in first.');
  const meta = { workflow_id: current.method_id, base_version: current.version_id };
  const versionPath = `/api/cli/methods/${encodeURIComponent(meta.workflow_id)}/versions/${encodeURIComponent(meta.base_version)}/script-cards`;
  const saved = await client.request<any>(`/api/cli/methods/${encodeURIComponent(meta.workflow_id)}?version=${encodeURIComponent(meta.base_version)}`);
  const method = loadWorkflow(saved.workflow) as unknown as Method;
  const ids = scriptSteps(method).filter(id => !options.step || id === options.step);
  if (options.step && !ids.length) throw Error(`Step ${options.step} is not a script step of this version.`);
  const packaged = new Map<string, string>((saved.package?.files ?? []).map((f: any) => [f.path, f.sha256]));
  const existing = await client.request<{ cards: ScriptCard[] }>(`/api/workspace/methods/${encodeURIComponent(meta.workflow_id)}/versions/${encodeURIComponent(meta.base_version)}/script-cards`);
  const done = new Set(existing.cards.map(card => card.step_id));
  const models = options.models ?? managedModels(client);
  const cards: ScriptCard[] = [], lines: string[] = [];
  for (const id of ids) {
    const hash = scriptSha256(method, id, packaged);
    if (!hash) { lines.push(`${id}: skipped; the saved version lacks its files.`); continue; }
    if (done.has(id)) { lines.push(`${id}: card exists.`); continue; }
    const files = scriptFiles(method, id), sources: Source[] = [];
    for (const name of files) {
      const bytes = readFileSync(contained(root, name));
      if (packaged.get(name) === fileHash(bytes)) sources.push({ path: name, text: bytes.toString('utf8') });
    }
    if (sources.length !== files.length) { lines.push(`${id}: skipped; the local files differ from the saved version. Run method run or method publish to save them.`); continue; }
    const cached = join(cardCache(), `${cacheKey(method, id, hash)}.json`);
    try {
      let card: ScriptCard, note: string | undefined;
      if (existsSync(cached)) card = JSON.parse(readFileSync(cached, 'utf8'));
      else {
        ({ card, note } = await makeCard({ method, id, root, sources, scriptHash: hash, models, roundTrip: options.roundTrip !== false, runRoots: options.runRoots ?? [join(root, '.method-runs'), join(process.cwd(), '.method-runs'), join(methodCache(), 'runs')] }));
        mkdirSync(cardCache(), { recursive: true, mode: 0o700 }); writePrivateJson(cached, card);
      }
      cards.push(card);
      const trip = card.checks.round_trip === 'not_run' ? `round trip not run${note ? ` (${note})` : ''}` : `round trip ${card.checks.round_trip} on ${card.checks.round_trip_inputs} input${card.checks.round_trip_inputs === 1 ? '' : 's'}`;
      lines.push(`${id}: ${card.summary} [entities ${card.checks.entities}${card.checks.entity_problems.length ? `: ${card.checks.entity_problems.join(' ')}` : ''}; ${trip}]`);
    } catch (error) { lines.push(`${id}: no card; ${(error as Error).message}`); }
  }
  if (cards.length) await client.request(versionPath, 'PUT', { cards }, true, { stallMs: 60_000 });
  for (const line of lines) write(line);
  const failed = lines.some(line => / no card;| skipped;/.test(line));
  if (!failed && !options.step) { mkdirSync(explainDir(), { recursive: true, mode: 0o700 }); writePrivateJson(join(explainDir(), `done-${meta.base_version}.json`), { at: new Date().toISOString() }); }
  return { status: 'done' as const, cards };
}

export async function explainCommand(client: MethodClient, args: string[]) {
  const parsed = parseArgs({ args, allowPositionals: true, options: { step: { type: 'string' }, 'no-round-trip': { type: 'boolean' }, server: { type: 'string' } } });
  const [file] = parsed.positionals;
  if (!file || parsed.positionals.length !== 1) throw Error('Use method explain FILE [--step ID] [--no-round-trip].');
  const lock = join(explainDir(), `${draftKey(file)}.json`);
  mkdirSync(explainDir(), { recursive: true, mode: 0o700 });
  if (existsSync(lock) && alive(lock) && JSON.parse(readFileSync(lock, 'utf8')).pid !== process.pid) await waitForExplain(file);
  if (!existsSync(lock) || !alive(lock)) writePrivateJson(lock, { pid: process.pid });
  try { await explain(client, file, { step: parsed.values.step, roundTrip: !parsed.values['no-round-trip'] }); }
  finally { try { if (JSON.parse(readFileSync(lock, 'utf8')).pid === process.pid) rmSync(lock, { force: true }); } catch { /* gone */ } }
}

function alive(lock: string) {
  try { process.kill(JSON.parse(readFileSync(lock, 'utf8')).pid, 0); return true; } catch { return false; }
}

/**
 * After a signed-in run saved a version with script steps, explain them in a detached process. The run neither waits
 * nor fails because of it. Output goes to a log under the Method cache.
 */
export function startBackgroundExplain(file: string, method: Method, versionId: string, server: string) {
  try {
    if (process.env.METHOD_NO_EXPLAIN === '1' || !scriptSteps(method).length) return;
    const dir = explainDir(), lock = join(dir, `${draftKey(file)}.json`);
    if (existsSync(join(dir, `done-${versionId}.json`)) || (existsSync(lock) && alive(lock))) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const log = join(dir, `${draftKey(file)}.log`), out = openSync(log, 'a', 0o600);
    const suffix = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    const entry = fileURLToPath(new URL(`./method${suffix}`, import.meta.url));
    const child = spawn(process.execPath, [...process.execArgv, entry, 'explain', resolve(file), '--server', server], { detached: true, stdio: ['ignore', out, out], cwd: process.cwd(), env: { ...process.env, METHOD_RUN_WORKER: '' } });
    closeSync(out);
    child.on('error', () => {});
    if (child.pid) writePrivateJson(lock, { pid: child.pid, version_id: versionId, log });
    child.unref();
  } catch { /* Script cards never delay or fail a run. */ }
}

/** Wait for a background explain of this draft to finish. */
export async function waitForExplain(file: string, timeoutMs = 15 * 60_000) {
  const lock = join(explainDir(), `${draftKey(file)}.json`), deadline = Date.now() + timeoutMs;
  while (existsSync(lock) && alive(lock) && Date.now() < deadline) await new Promise(r => setTimeout(r, 500));
}

/** Used by tests: python3 is required for Python analysis and replay. */
export const hasPython = () => spawnSync('python3', ['--version']).status === 0;
