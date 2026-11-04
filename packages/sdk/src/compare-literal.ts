/**
 * What a comparison does, literally: the record that the comparison page shows first. Method makes it from the
 * comparison's own files and run records, with rules in code that are the same for every comparison, so a smart reader
 * can check each sentence against a real thing from the run:
 *
 * - steps: nine numbered steps in a fixed order (start, task, right answers, correction, learning, between, measure,
 *   score, decide), each one plain sentence with the counts and the literal things beside it (a file, a message, a real
 *   correction, a command, a diff, a table). A step that the comparison does not use says so.
 * - one_event: one teaching input followed through both arms and on to the measured result: the input whose item had
 *   the largest rise in errors on new inputs between two checkpoints.
 * - concerns: where the result could be wrong, each a sentence with its evidence, found from the files and records.
 * - per_item: when the main measure prints items ({items: [{question | id, expected, given, right}]}), the errors on
 *   each item on new inputs per arm and checkpoint, and the corrections that each arm received on it.
 * - baselines: shortcut scores that read no input, from the hidden answers of the teaching inputs.
 * - usage: tokens per correction for each arm, with the events that report them.
 *
 * Before the trial the literal things are samples (the exhibits); after a run they are the run's own.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import type { Exhibits } from './compare-exhibits.js';

/** One literal thing: a text verbatim, or a table. arm: the agent it belongs to. */
export type Artifact = { name: string; arm?: string; text?: string; table?: { columns: string[]; rows: string[][] } };
export type Step = { n: number; title: string; sentence: string; used: boolean; artifacts: Artifact[] };
export type Concern = { kind: string; text: string; evidence: Artifact[] };
export type OneEvent = { title: string; sentence: string; parts: Array<{ label: string; artifacts: Artifact[] }> };
export type PerItem = {
  measure: string; noun: string; checkpoints: number[];
  items: Array<{ id: string; words: string | null; corrections: Record<string, number>; wrong: Record<string, Array<{ checkpoint: number; wrong: number; of: number }>> }>;
};
export type Literal = {
  from: 'design' | 'run'; paragraph: string; steps: Step[]; one_event: OneEvent | null; concerns: Concern[]; per_item: PerItem | null;
  counted: Record<string, Array<{ checkpoint: number | null; right: number; of: number }>>;
  baselines: Array<{ name: string; value: number }>;
  usage: Record<string, { tokens: number | null; with_tokens: number; events: number }>;
  /** The parts of the page that do not apply to this comparison, each with why, in one sentence. */
  not_shown: string[];
  /** The model review: claims of the file that the facts above contradict (reviewLiteral), or null when it has not run. */
  review: Review | null;
};
/** One model review of a record: each claim of the file that a fact of the record contradicts, both quoted word for word. */
export type Review = { model: string; findings: Array<{ claim: string; fact: string; why: string }> };
/** The records of a run: what each arm received (treated), each run cell, and each grade cell. */
export type RunRecords = { treated: any[] | null; runs: any[]; grades: any[] };

const TEXT_CHARS = 12_000;
const cut = (text: string, max = TEXT_CHARS) => text.length > max ? `${text.slice(0, max)}\n[... ${text.length - max} more characters]` : text;
const one = (text: string, max = 300) => { const t = text.replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max).replace(/\s+\S*$/, '')} …` : t; };
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const list = (words: string[]) => words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const fixed2 = (n: number) => n.toFixed(2);
const json = (text: string) => { try { return JSON.parse(text); } catch { return null; } };

// ---------------------------------------------------------------------------------------------------------------
// Diffs

/** Files that are Method's own bookkeeping, not the change: its private folder, saved checks and their recordings, snapshots. */
const BOOKKEEPING = [/^\.method\//, /^cases\//, /(^|\/)recording\.json$/, /(^|\/)snapshot\//, /^\.fix\//];
/**
 * The paths that the comparison itself puts in an arm's folder for each input, not the arm's learning: the folders of
 * the inputs' own folders (inputs/ID/NAME/ is placed as NAME/) and the handed-in file (deliverable).
 */
export function placedPaths(doc: { inputs: string[]; teaching?: string[]; deliverable?: string }, room: (id: string) => string | null): string[] {
  const out = new Set<string>();
  for (const id of [...doc.inputs, ...(doc.teaching ?? [])]) {
    const dir = room(id);
    if (!dir) continue;
    try { for (const entry of readdirSync(dir)) out.add(entry); } catch { /* none */ }
  }
  if (doc.deliverable && !/\{\{/.test(doc.deliverable)) out.add(doc.deliverable.replace(/^\.\//, ''));
  return [...out];
}
const isPlaced = (placed: string[], rel: string) => placed.some(p => rel === p || rel.startsWith(`${p.replace(/\/$/, '')}/`));
/** A line as its value: without spaces, quote marks, YAML block marks and trailing commas, so a reformatted line equals its old self. */
const valueOf = (line: string) => line.replace(/^\s*-\s+/, '').replace(/^\s*"?[\w.-]+"?:\s*/, '').replace(/^[|>]-?\s*$/, '').replace(/[\s"'`,]+/g, '').replace(/\\n/g, '');
/**
 * A unified diff without Method's bookkeeping files and without pure reformatting: a removed line whose value an added
 * line of the same file has again (and the reverse) is left out, and a file with nothing left is left out.
 */
export function cleanDiff(diff: string, placed: string[] = []): string {
  const files = diff.split(/^(?=--- )/m).filter(part => part.startsWith('--- '));
  const out: string[] = [];
  for (const file of files) {
    const name = /^\+\+\+ (.+)$/m.exec(file)?.[1]?.trim() ?? /^--- (.+)$/m.exec(file)![1]!.trim();
    if (BOOKKEEPING.some(rule => rule.test(name)) || isPlaced(placed, name)) continue;
    const lines = file.split('\n');
    const removed = new Map<string, number>(), added = new Map<string, number>();
    const count = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
    for (const line of lines) {
      if (line.startsWith('---') || line.startsWith('+++')) continue;
      if (line.startsWith('-')) count(removed, valueOf(line.slice(1)));
      if (line.startsWith('+')) count(added, valueOf(line.slice(1)));
    }
    const kept: string[] = [], left = { removed: new Map(removed), added: new Map(added) };
    const take = (map: Map<string, number>, key: string) => { const n = map.get(key) ?? 0; if (n > 0) { map.set(key, n - 1); return true; } return false; };
    for (const line of lines) {
      if (line.startsWith('---') || line.startsWith('+++')) continue;
      if (line.startsWith('-')) { const v = valueOf(line.slice(1)); if (!v || take(left.added, v)) continue; kept.push(line); }
      else if (line.startsWith('+')) { const v = valueOf(line.slice(1)); if (!v || take(left.removed, v)) continue; kept.push(line); }
    }
    if (kept.length) out.push(`--- ${name}`, ...kept);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Code

/**
 * The code that does the work of a script: the script, and for a Python script that calls a function of a module beside
 * it (nli.correction(...)), that function's own lines. Comments of a docstring stay.
 */
export function coreCode(path: string): Artifact[] {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  const out: Artifact[] = [{ name: basename(path), text: cut(text, 6000) }];
  if (extname(path) !== '.py') return out;
  const seen = new Set<string>();
  for (const call of text.matchAll(/\b([a-z_][\w]*)\.([a-z_]\w*)\(/g)) {
    const [, module, fn] = call;
    const file = join(dirname(path), `${module}.py`);
    if (seen.has(`${module}.${fn}`) || !existsSync(file)) continue;
    seen.add(`${module}.${fn}`);
    const source = readFileSync(file, 'utf8').split('\n');
    const start = source.findIndex(line => new RegExp(`^def ${fn}\\(`).test(line));
    if (start < 0) continue;
    let end = start + 1;
    while (end < source.length && (source[end]!.trim() === '' || /^\s/.test(source[end]!))) end++;
    out.push({ name: `${basename(file)}: ${fn}()`, text: source.slice(start, end).join('\n').trimEnd() });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Inputs, labels and items

/** An input's text: its value and every file of its own folder, as one text with spaces made single. */
function inputText(root: string, id: string, read: { value: (id: string) => unknown; room: (id: string) => string | null }) {
  const parts: string[] = [];
  const value = read.value(id);
  parts.push(typeof value === 'string' ? value : JSON.stringify(value));
  const room = read.room(id);
  if (room) for (const file of filesUnder(room)) parts.push(readFileSync(file, 'utf8'));
  return parts.join('\n');
}
/** Every text file under a folder, leaving out Method's private folders and run records. */
function filesUnder(dir: string, skip: (rel: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const walk = (sub: string) => {
    let entries: import('node:fs').Dirent[] = [];
    try { entries = readdirSync(join(dir, sub), { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (['.method-runs', 'node_modules', '.git', '__pycache__'].includes(entry.name) || skip(rel)) continue;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) {
        try { if (statSync(join(dir, rel)).size > 2_000_000) continue; const bytes = readFileSync(join(dir, rel)); if (!bytes.includes(0)) out.push(join(dir, rel)); } catch { /* gone */ }
      }
    }
  };
  walk('');
  return out;
}
const squash = (text: string) => text.replace(/\s+/g, ' ');
/** The text of a file as the agent's code reads it: a JSON file's strings joined (so escaped quotes read as quotes). */
function readable(path: string) {
  const text = readFileSync(path, 'utf8');
  if (!/\.json$/i.test(path)) return text;
  const value = json(text);
  if (value === null) return text;
  const strings: string[] = [];
  const walk = (v: unknown) => { if (typeof v === 'string') strings.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(value);
  return strings.join('\n');
}

/** A hidden answer as a table of labels: {labels: {ITEM: LABEL}, evidence?: {ITEM: [TEXT]}}, or null for another form. */
export function labelTable(expected: unknown): Map<string, { label: string; evidence: string[] }> | null {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return null;
  const labels = (expected as any).labels, evidence = (expected as any).evidence ?? {};
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return null;
  const out = new Map<string, { label: string; evidence: string[] }>();
  for (const [id, label] of Object.entries(labels)) out.set(id, { label: String(label), evidence: Array.isArray(evidence[id]) ? evidence[id].map(String) : [] });
  return out;
}
/** The words of each numbered item in a message: "1. All Confidential Information shall be…" by "1". */
export function itemWords(message: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of message.matchAll(/^\s*(\d+)\.\s+(.+)$/gm)) if (!out.has(m[1]!)) out.set(m[1]!, m[2]!.trim());
  return out;
}
/** What a measure printed, read as {score, items}. An item's ID is its id, item or question. */
function printedItems(printed: string | undefined): { score: number | null; items: Array<{ id: string; expected: string | null; given: string | null; right: boolean; unsure: boolean }> | null; key: string | null } {
  const value = printed ? json(printed) : null;
  if (!value || typeof value !== 'object') return { score: null, items: null, key: null };
  const score = typeof value.score === 'number' ? value.score : null;
  if (!Array.isArray(value.items)) return { score, items: null, key: null };
  const key = ['id', 'item', 'question'].find(k => value.items.some((item: any) => item && item[k] !== undefined)) ?? null;
  if (!key) return { score, items: null, key: null };
  return { score, key, items: value.items.map((item: any) => ({ id: String(item[key]), expected: item.expected ?? null, given: item.given ?? null, right: item.right === true, unsure: item.unsure === true })) };
}
/** Whether a line of a correction is about an item: it starts with the item's noun and number ("Question 11 …"). */
const aboutItem = (noun: string, id: string) => new RegExp(`^\\s*(?:${noun === 'id' ? '' : `${noun}\\s+`})${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'im');
const linesAbout = (text: string, noun: string, id: string) => text.split('\n').filter(line => aboutItem(noun, id).test(line));

// ---------------------------------------------------------------------------------------------------------------
// Records on this computer

/** One learner's records (treatment.jsonl): the last record of each event, the redesigns, and how often each event ran. */
function learnerRecords(folder: string) {
  const byKey = new Map<string, any>(), runs = new Map<number, number>();
  try {
    for (const line of readFileSync(join(folder, 'treatment.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      byKey.set(record.key, record);
      if (typeof record.index === 'number') runs.set(record.index, (runs.get(record.index) ?? 0) + 1);
    }
  } catch { /* none yet */ }
  const all = [...byKey.values()];
  return {
    events: all.filter(r => r.kind !== 'redesign').sort((a, b) => a.index - b.index),
    redesigns: all.filter(r => r.kind === 'redesign').map(r => ({ at_event: r.at_event, received: r.received, line: r.line, tokens: r.tokens ?? null })),
    runs,
  };
}
/** The records of a comparison on this computer: each learner's treatment, each run cell and each grade of the current grader. */
export async function recordsOnDisk(plan: any): Promise<RunRecords> {
  const { learnerFolder, graderVersion } = await import('./compare.js');
  const treated = plan.arms.map((arm: any) => ({
    arm: arm.name, planned: plan.events.length,
    learners: Array.from({ length: plan.learners }, (_, learner) => {
      const own = learnerRecords(learnerFolder(plan, arm, learner));
      return { learner, events: own.events, redesigns: own.redesigns, missing: [], snapshots: {} };
    }),
  }));
  const runs: any[] = [], grades: any[] = [], grader = graderVersion(plan);
  let names: string[] = [];
  try { names = readdirSync(join(plan.folder, 'cells')).filter(n => /^[a-f0-9]{64}\.json$/.test(n)); } catch { /* none */ }
  for (const name of names) {
    const record = json(readFileSync(join(plan.folder, 'cells', name), 'utf8'));
    if (!record) continue;
    if (record.scores) { if (record.grader_version === grader) grades.push(record); } else if (record.arm) runs.push(record);
  }
  return { treated: treated.some((t: any) => t.learners.some((l: any) => l.events.length)) ? treated : null, runs, grades };
}
/** How many times each event of each arm's first learner ran (a stopped event that ran again counts twice). */
async function reruns(plan: any) {
  const { learnerFolder } = await import('./compare.js');
  return Object.fromEntries(plan.arms.map((arm: any) => [arm.name, learnerRecords(learnerFolder(plan, arm, 0)).runs]));
}

// ---------------------------------------------------------------------------------------------------------------
// The record

type Context = {
  doc: any; root: string; plan: any; exhibits: Exhibits | null; records: RunRecords | null;
  noun: string; nouns: string; label: (arm: string) => string; name: (id: string) => string;
  agent: (arm: any) => string;
  /** The paths that the comparison places in an arm's folder for each input (placedPaths). */
  placed: string[];
};

/**
 * The literal record of a comparison: design (before any run: samples from the exhibits) or run (from the run records).
 * doc: the .compare file; root: its folder; plan: the compiled plan; exhibits: the comparison's exhibits.
 */
export async function comparisonLiteral(doc: any, root: string, plan: any, exhibits: Exhibits | null, records: RunRecords | null): Promise<Literal> {
  await loadLiteralModules();
  const { agentName } = await import('./compare-project.js');
  const nounOne = doc.about_inputs?.noun ?? 'input';
  const ctx: Context = {
    doc, root, plan, exhibits, records: records && (records.treated || records.grades.length) ? records : null,
    noun: nounOne, nouns: nounOne.endsWith('s') ? nounOne : `${nounOne}s`,
    label: arm => plan.arms.find((a: any) => a.name === arm)?.label ?? arm,
    name: id => plan.names?.[id] ?? id.replace(/^.*[/\\]/, '').replace(/\.[a-z0-9]+$/i, ''),
    placed: placedPaths(doc, id => compareModule.inputRoom(root, id)),
    agent: arm => arm.project ? agentName(arm.project.agent) : arm.plain ? (arm.plain.agent === 'codex' ? 'Codex' : 'Claude Code') : 'Method',
  };
  const perItem = itemTable(ctx);
  const counted = countedAnswers(ctx, perItem);
  const usage = usageOf(ctx);
  const baselines = baselinesOf(ctx, perItem);
  const event = oneEvent(ctx, perItem);
  const steps = await stepsOf(ctx, perItem, counted, event);
  const concerns = await concernsOf(ctx, perItem, counted, baselines, usage, event);
  return { from: ctx.records ? 'run' : 'design', paragraph: paragraphOf(ctx), steps, one_event: event?.view ?? null, concerns, per_item: perItem, counted, baselines, usage, not_shown: notShown(ctx, perItem, baselines, event), review: null };
}

/** Why a part of the page is empty, in plain words: the run has not happened, or the comparison's files have another form. */
function notShown(ctx: Context, perItem: PerItem | null, baselines: Literal['baselines'], event: ReturnType<typeof oneEvent>): string[] {
  const out: string[] = [], main = mainMeasure(ctx);
  if (!ctx.records) return ['Results per item, shortcut scores and the end-to-end example come from the run\'s records. This comparison has not run yet.'];
  if (!perItem) out.push(`Errors per item, counted answers${ctx.plan.events.length ? ' and the end-to-end example' : ''} are not shown: the main measure “${main.name}” does not print its items as {"items": [{"id": …, "expected": …, "given": …, "right": true or false}]}.`);
  if (perItem && !baselines.length) out.push('Shortcut scores are not shown: they need the main measure\'s items on the first checkpoint.');
  if (perItem && ctx.plan.events.length && !teachingLabels(ctx).size) out.push(`The right answers of the teaching ${ctx.nouns} are not shown as a table, and shortcut scores from them are not made: their hidden answers are not in the form {"labels": {ITEM: ANSWER}, "evidence": {ITEM: [TEXT]}}.`);
  if (perItem && !event && ctx.plan.events.length && perItem.checkpoints.length > 1) out.push(`No end-to-end example: no ${perItem.noun}'s errors on new ${ctx.nouns} rose between two checkpoints after a correction on it.`);
  if (!ctx.records.treated && ctx.plan.events.length) out.push('What each arm received is not on this computer, so the corrections, their diffs and the usage are not shown.');
  return out;
}

const kindOf = (ctx: Context) => {
  const arms = ctx.plan.arms;
  if (arms.every((a: any) => a.project)) return { unit: 'chat', units: 'chats', what: 'project' };
  if (arms.every((a: any) => a.plain)) return { unit: 'session', units: 'sessions', what: 'agent' };
  return { unit: 'run', units: 'runs', what: 'agent' };
};
const teachingIds = (ctx: Context) => [...new Set<string>(ctx.plan.events.map((e: any) => e.input.id))];
/** The measured inputs that are new: the inputs whose text no teaching input has. */
function inputTexts(ctx: Context) {
  const read = { value: (id: string) => { const { inputValue } = requireCompare(); return inputValue(ctx.root, id); }, room: (id: string) => { const { inputRoom } = requireCompare(); return inputRoom(ctx.root, id); } };
  const text = new Map<string, string>();
  for (const id of [...ctx.doc.inputs, ...teachingIds(ctx)]) { try { text.set(id, inputText(ctx.root, id, read)); } catch { text.set(id, id); } }
  return text;
}
let compareModule: any = null;
const requireCompare = () => compareModule;
/** Every measured input that has the same text as a teaching input, with that teaching input. */
function overlaps(ctx: Context, texts: Map<string, string>) {
  const teaching = teachingIds(ctx);
  return ctx.doc.inputs.flatMap((id: string) => {
    const same = teaching.find(t => texts.get(t) === texts.get(id));
    return same ? [{ measured: id, teaching: same }] : [];
  }) as Array<{ measured: string; teaching: string }>;
}

function paragraphOf(ctx: Context) {
  const { plan, doc } = ctx, kind = kindOf(ctx), events = plan.events.length, inputs = doc.inputs.length;
  const arms = plan.arms.map((a: any) => ctx.label(a.name));
  const agents = [...new Set(plan.arms.map((a: any) => ctx.agent(a)))];
  const model = plan.arms[0]?.project?.model ?? plan.arms[0]?.plain?.model ?? plan.model?.model ?? null;
  const start = `${capital(list(arms))} ${arms.length === 2 ? 'both' : 'all'} work on the same ${ctx.nouns}${agents.length === 1 && agents[0] !== 'Method' ? `, as ${agents[0]} ${kind.what}s${model ? ` on ${model}` : ''}` : ''}.`;
  const teach = events ? ` Each gets ${plural(events, `teaching ${ctx.noun}`, `teaching ${ctx.nouns}`)}, one ${kind.unit} each, and after each one the words of a correction.` : '';
  const points = plan.checkpoints ?? [];
  const measure = ` ${points.length ? `At ${points.length === 1 ? 'checkpoint' : 'checkpoints'} ${list(points.map(String))}, a` : 'A'} copy of each answers ${plural(inputs, `measured ${ctx.noun}`, `measured ${ctx.nouns}`)}, and code or a judge scores the answers against the hidden answers.`;
  return `${start}${teach}${measure}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Per item, counts, baselines, usage

/** One grade for each arm, input, checkpoint and copy of the decision (a run that the trial and the full run share is graded twice). */
function gradesOf(ctx: Context) {
  const out = new Map<string, any>();
  for (const g of ctx.records?.grades ?? []) if (g.repeat < learnersOf(ctx)) out.set(`${g.arm}\n${g.input}\n${g.checkpoint ?? ''}\n${g.repeat}`, g);
  return [...out.values()];
}
function mainMeasure(ctx: Context) { return ctx.plan.measures.find((m: any) => m.main); }
const learnersOf = (ctx: Context) => ctx.plan.learners as number;

function itemTable(ctx: Context): PerItem | null {
  if (!ctx.records) return null;
  const main = mainMeasure(ctx);
  const grades = gradesOf(ctx);
  let key: string | null = null;
  const byArm = new Map<string, Map<number, Map<string, { wrong: number; of: number }>>>();
  const ids: string[] = [];
  for (const g of grades) {
    const read = printedItems(g.printed?.[main.name]);
    if (read.score === null || !read.items) continue;
    key ??= read.key;
    const at = g.checkpoint ?? 0;
    const arm = byArm.get(g.arm) ?? new Map(); byArm.set(g.arm, arm);
    const point = arm.get(at) ?? new Map(); arm.set(at, point);
    for (const item of read.items) {
      if (!ids.includes(item.id)) ids.push(item.id);
      const cell = point.get(item.id) ?? { wrong: 0, of: 0 };
      cell.of++; if (!item.right) cell.wrong++;
      point.set(item.id, cell);
    }
  }
  if (!key || !ids.length) return null;
  const noun = key === 'id' || key === 'item' ? 'item' : key;
  const checkpoints = [...new Set(grades.map(g => g.checkpoint ?? 0))].sort((a, b) => a - b);
  const words = itemWords(ctx.plan.arms.find((a: any) => a.project)?.project?.message ?? '');
  const corrections = (arm: string, id: string) => (ctx.records!.treated?.find(t => t.arm === arm)?.learners ?? [])
    .flatMap((l: any) => l.events.filter((e: any) => e.kind === 'correction' && e.received && typeof e.text === 'string' && linesAbout(e.text, noun, id).length)).length;
  ids.sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  return {
    measure: main.name, noun, checkpoints,
    items: ids.map(id => ({ id, words: words.get(id) ?? null,
      corrections: Object.fromEntries(ctx.plan.arms.map((a: any) => [a.name, corrections(a.name, id)])),
      wrong: Object.fromEntries(ctx.plan.arms.map((a: any) => [a.name, checkpoints.map(c => ({ checkpoint: c, ...(byArm.get(a.name)?.get(c)?.get(id) ?? { wrong: 0, of: 0 }) }))])) })),
  };
}
function countedAnswers(ctx: Context, perItem: PerItem | null): Literal['counted'] {
  if (!perItem) return {};
  return Object.fromEntries(ctx.plan.arms.map((a: any) => [a.name, perItem.checkpoints.map(c => {
    const cells = perItem.items.map(item => item.wrong[a.name]!.find(x => x.checkpoint === c)!);
    const of = cells.reduce((n, x) => n + x.of, 0), wrong = cells.reduce((n, x) => n + x.wrong, 0);
    return { checkpoint: c, right: of - wrong, of };
  })]));
}
function usageOf(ctx: Context): Literal['usage'] {
  if (!ctx.records?.treated) return {};
  return Object.fromEntries(ctx.records.treated.map((t: any) => {
    const events = t.learners.flatMap((l: any) => l.events.filter((e: any) => e.kind === 'correction' && e.received));
    const counted = events.filter((e: any) => typeof e.tokens === 'number');
    return [t.arm, { tokens: counted.length ? Math.round(counted.reduce((s: number, e: any) => s + e.tokens, 0) / counted.length) : null, with_tokens: counted.length, events: events.length }];
  }));
}
/** The hidden answers of the teaching inputs, as label tables, by input. */
function teachingLabels(ctx: Context) {
  const out = new Map<string, Map<string, { label: string; evidence: string[] }>>();
  for (const e of ctx.plan.events) {
    const table = labelTable(e.feedback?.expected ?? (ctx.doc.expected?.[e.input.id] ? safeExpected(ctx, ctx.doc.expected[e.input.id]) : null));
    if (table) out.set(e.input.id, table);
  }
  // A table of items has the same items in every hidden answer; one with other keys per input is another form.
  const keys = [...out.values()].map(t => [...t.keys()].sort().join('\n'));
  if (new Set(keys).size > 1) return new Map<string, Map<string, { label: string; evidence: string[] }>>();
  return out;
}
const safeExpected = (ctx: Context, path: string) => { try { return JSON.parse(readFileSync(resolve(ctx.root, path), 'utf8')); } catch { return null; } };
/** Shortcuts that read no input: the most common label of each item in the teaching inputs, and one label for every item. */
function baselinesOf(ctx: Context, perItem: PerItem | null): Literal['baselines'] {
  if (!perItem || !ctx.records) return [];
  const teaching = [...teachingLabels(ctx).values()];
  const main = mainMeasure(ctx), first = ctx.plan.arms[0].name;
  const measured = gradesOf(ctx).filter(g => g.arm === first && g.repeat === 0 && (g.checkpoint ?? 0) === perItem.checkpoints[0]).map(g => printedItems(g.printed?.[main.name])).filter(r => r.score !== null && r.items);
  const answers = measured.flatMap(r => r.items!.map(i => ({ id: i.id, expected: i.expected })));
  if (!answers.length) return [];
  const out: Literal['baselines'] = [];
  if (teaching.length) {
    const mode = new Map<string, string>();
    for (const item of perItem.items) {
      const counts = new Map<string, number>();
      for (const t of teaching) { const l = t.get(item.id)?.label; if (l) counts.set(l, (counts.get(l) ?? 0) + 1); }
      const best = [...counts].sort((a, b) => b[1] - a[1])[0];
      if (best) mode.set(item.id, best[0]);
    }
    out.push({ name: `For each ${perItem.noun}, the most common right answer in the ${plural(teaching.length, `teaching ${ctx.noun}`, `teaching ${ctx.nouns}`)}`, value: answers.filter(a => mode.get(a.id) === a.expected).length / answers.length });
  }
  const all = new Map<string, number>();
  for (const a of answers) if (a.expected) all.set(a.expected, (all.get(a.expected) ?? 0) + 1);
  for (const [label, n] of [...all].sort((a, b) => b[1] - a[1]).slice(0, 1)) out.push({ name: `Every answer “${label}”`, value: n / answers.length });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// One event, end to end

function eventsOf(ctx: Context, arm: string) {
  return (ctx.records?.treated?.find(t => t.arm === arm)?.learners?.[0]?.events ?? []) as any[];
}
/** The item whose errors on new inputs rose most between two checkpoints for an arm, with that arm and those checkpoints. */
function worstRise(perItem: PerItem | null) {
  let best: { id: string; arm: string; from: number; to: number; before: number; after: number } | null = null;
  for (const item of perItem?.items ?? []) for (const [arm, points] of Object.entries(item.wrong)) for (let i = 1; i < points.length; i++) {
    const rise = points[i]!.wrong - points[i - 1]!.wrong;
    if (rise > 0 && (!best || rise > best.after - best.before)) best = { id: item.id, arm, from: points[i - 1]!.checkpoint, to: points[i]!.checkpoint, before: points[i - 1]!.wrong, after: points[i]!.wrong };
  }
  return best;
}
function oneEvent(ctx: Context, perItem: PerItem | null): { view: OneEvent; item: string; arm: string; index: number } | null {
  const rise = worstRise(perItem);
  if (!ctx.records?.treated || !perItem || !rise) return null;
  const noun = perItem.noun, Noun = capital(noun);
  const corrected = eventsOf(ctx, rise.arm).filter(e => e.index > rise.from && e.index <= rise.to && e.received && typeof e.text === 'string' && linesAbout(e.text, noun, rise.id).length);
  const event = corrected[0];
  if (!event) return null;
  const labels = teachingLabels(ctx), table = labels.get(event.input)?.get(rise.id);
  const name = ctx.name(event.input), words = perItem.items.find(i => i.id === rise.id)?.words;
  const parts: OneEvent['parts'] = [];
  parts.push({ label: `The ${noun} and its right answer on ${name}`, artifacts: [{ name: `${Noun} ${rise.id}`, text: words ?? `${Noun} ${rise.id}` },
    ...(table ? [{ name: 'The right answer in the hidden answer', text: `${table.label}${table.evidence.length ? `\n\nEvidence:\n${table.evidence.map(e => `“${one(e, 400)}”`).join('\n')}` : '\n\nNo evidence sentence: the hidden answer marks no words of the input for it.'}` }] : [])] });
  parts.push({ label: `What each arm was told about ${noun} ${rise.id} after event ${event.index}`, artifacts: ctx.plan.arms.map((a: any) => {
    const own = eventsOf(ctx, a.name).find(e => e.index === event.index);
    const lines = typeof own?.text === 'string' ? linesAbout(own.text, noun, rise.id) : [];
    return { name: ctx.label(a.name), arm: a.name, text: lines.length ? lines.join('\n') : own ? `No line about ${noun} ${rise.id}: its answer was right.` : 'Not received.' };
  }) });
  parts.push({ label: `What each arm changed about ${noun} ${rise.id}`, artifacts: ctx.plan.arms.map((a: any) => {
    const own = eventsOf(ctx, a.name).find(e => e.index === event.index);
    const diff = own?.change?.diff ? cleanDiff(own.change.diff, ctx.placed) : '';
    const pattern = new RegExp(`\\b(?:${noun}\\s*|q)${rise.id}\\b|\\[[^\\]]*\\b${rise.id}\\b[^\\]]*\\]`, 'i');
    const lines = diff.split('\n').filter(line => /^[+-]/.test(line) && pattern.test(line)).map(line => one(line, 600));
    return { name: ctx.label(a.name), arm: a.name, text: lines.length ? lines.join('\n') : `No changed line names ${noun} ${rise.id}.` };
  }) });
  // Later corrections on the same item that ask for another answer.
  const later = eventsOf(ctx, rise.arm).filter(e => e.index > event.index && e.received && typeof e.text === 'string' && linesAbout(e.text, noun, rise.id).length);
  if (later.length && table) parts.push({ label: `Later corrections on ${noun} ${rise.id}`, artifacts: later.map(e => {
    const other = labels.get(e.input)?.get(rise.id);
    return { name: `Event ${e.index}, ${ctx.name(e.input)}: right answer “${other?.label ?? '?'}”${other && other.label !== table.label ? ` (event ${event.index} taught “${table.label}”)` : ''}`, text: linesAbout(e.text, noun, rise.id).join('\n') };
  }) });
  parts.push({ label: `Errors on ${noun} ${rise.id} on the new ${ctx.nouns}`, artifacts: [{ name: `${Noun} ${rise.id} wrong, of the new ${ctx.nouns} at each checkpoint`, table: {
    columns: ['Arm', ...perItem.checkpoints.map(c => `Checkpoint ${c}`)],
    rows: ctx.plan.arms.map((a: any) => [ctx.label(a.name), ...perItem.items.find(i => i.id === rise.id)!.wrong[a.name]!.map(x => `${x.wrong} of ${x.of}`)]) } }] });
  return {
    item: rise.id, arm: rise.arm, index: event.index,
    view: { title: `${name} and ${noun} ${rise.id}`, parts,
      sentence: `${capital(ctx.label(rise.arm))} got ${noun} ${rise.id} wrong on ${rise.before} new ${rise.before === 1 ? ctx.noun : ctx.nouns} at checkpoint ${rise.from} and on ${rise.after} at checkpoint ${rise.to}: the largest rise of any ${noun}. The first correction on it in between was event ${event.index}, ${name}.` },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The steps

async function stepsOf(ctx: Context, perItem: PerItem | null, counted: Literal['counted'], event: ReturnType<typeof oneEvent>): Promise<Step[]> {
  const c = compareModule;
  const { plan, doc, root } = ctx, kind = kindOf(ctx);
  const teaching = teachingIds(ctx), points: number[] = plan.checkpoints ?? [];
  const steps: Step[] = [];
  const step = (title: string, sentence: string, artifacts: Artifact[], used = true) => steps.push({ n: steps.length + 1, title, sentence, used, artifacts });
  const firstEvent = plan.events[0];
  const main = mainMeasure(ctx), rule = plan.rule;
  const texts = inputTexts(ctx), again = overlaps(ctx, texts), fresh = doc.inputs.length - again.length;
  const arms = plan.arms as any[];
  const learnsFirst = (a: any) => (a.project ? a.project.plugins?.includes('method') : !a.plain) ? 0 : 1;
  const [armA, armB] = [...arms].sort((a, b) => learnsFirst(a) - learnsFirst(b));
  const project = arms.find(a => a.project)?.project, plainArm = arms.find(a => a.plain);
  const learnsOf = (arm: any) => arm.project ? !!arm.project.plugins?.includes('method') : !arm.plain;
  const writerName = firstEvent?.feedback?.name, writer = writerName ? doc.treatment?.feedback_writers?.[writerName] : undefined;
  const corrections = plan.events.filter((e: any) => e.kind === 'correction').length;

  // 1. The question.
  {
    const guard = rule.guard ? `, without being more than ${rule.guard.max_drop} behind on “${rule.guard.measure}”` : '';
    const after = corrections ? `After ${plural(corrections, `corrected ${ctx.noun}`, `corrected ${ctx.nouns}`)}, ` : '';
    const on = teaching.length ? plural(fresh, `new ${ctx.noun}`, `new ${ctx.nouns}`) : `the same ${plural(doc.inputs.length, ctx.noun, ctx.nouns)}`;
    // An arm is named first only when it alone learns with Method; otherwise the question names no favourite.
    const leader = arms.filter(a => learnsOf(a)).length === 1 && arms.length === 2;
    const who = leader ? `is ${ctx.label(armA.name)} ahead of ${ctx.label(armB.name)}` : `which of ${arms.length === 2 ? 'the two arms' : `the ${arms.length} arms`} (${list(arms.map(a => ctx.label(a.name)))}) is ahead`;
    step('The question', `${capital(`${after}${who}`)} on “${main.name}” on ${on}${rule.at !== undefined && points.length ? ` at checkpoint ${rule.at}` : ''}${guard}?`,
      [{ name: 'The question in the file, word for word', text: doc.question }]);
  }

  // 2. The two arms: what both get, then what only each gets, quoted, and the treatment points.
  {
    const agents = [...new Set(arms.map(a => ctx.agent(a)))] as string[];
    const model = project?.model ?? plainArm?.plain?.model ?? plan.model?.model ?? null;
    const both = [`${arms.every(a => a.project) ? `a ${agents.length === 1 ? `${agents[0]} ` : ''}project` : arms.every(a => a.file) ? 'a Method' : 'an agent'}${model ? ` on ${model}` : ''}`,
      plan.web ? 'the same tools, with the web' : 'the same tools, no web',
      ...(project ? [`the same ${project.first_message ? 'first message, the same ' : ''}message for each ${ctx.noun}`] : []),
      ...(writer ? [`the same correction code`] : [])];
    const own: string[] = [], artifacts: Artifact[] = [];
    for (const arm of arms) {
      const label = capital(ctx.label(arm.name));
      if (arm.project) {
        const files = filesUnder(arm.project.start).map(f => relative(arm.project.start, f));
        const instructions = files.find(f => /^(AGENTS|CLAUDE)\.md$/.test(f));
        const line = instructions ? readFileSync(join(arm.project.start, instructions), 'utf8').trim() : '';
        const methods = files.filter(f => f.endsWith('.method'));
        own.push(`${label}: ${arm.project.plugins?.includes('method') ? 'the Method plugin and the method command; ' : ''}${instructions ? `${instructions} with ${line.split('\n').length === 1 ? 'the line' : 'the text'} “${one(line, 400).replace(/\.$/, '')}”` : 'no instructions file'}${methods.length ? `; and ${list(methods)} with ${plural(files.length - 1 - methods.length, 'other file')}` : files.length > 1 ? `; and ${plural(files.length - 1, 'other file')}` : ''}.`);
        for (const f of methods) artifacts.push({ name: `${ctx.label(arm.name)}: the steps of ${f}`, arm: arm.name, text: methodSteps(join(arm.project.start, f)) });
        if (files.length > 1) artifacts.push({ name: `${ctx.label(arm.name)}: its starting files`, arm: arm.name, text: files.join('\n') });
      } else if (arm.plain) {
        own.push(`${label}: a plain ${ctx.agent(arm)} session with these instructions: “${one(arm.plain.instructions, 400)}”.`);
      } else if (arm.file) {
        const shared = arms.filter(a => a.file === arm.file).length > 1;
        own.push(`${label}: ${shared ? `its own ${arm.file} (the arms' files have the same name; their steps are below)` : `the Method ${arm.file}`}.`);
        artifacts.push({ name: `${ctx.label(arm.name)}: the steps of ${arm.file}`, arm: arm.name, text: methodSteps(join(arm.dir, arm.file)) });
      }
    }
    const at = plan.redesign ?? [];
    const between = at.length ? ` ${arms.map(a => `${capital(ctx.label(a.name))} only: ${learnsOf(a) ? 'method redesign' : 'one chat that asks it to rewrite its notes from every correction so far'}`).join('. ')}, after ${at.length === 1 ? 'event' : 'events'} ${list(at.map(String))}.` : '';
    const read = startReads(ctx);
    if (read.length) artifacts.push({ name: 'Teaching inputs that the starting files name', text: read.map(r => `${r.name}: named in ${list(r.files)}`).join('\n') });
    for (const arm of arms) {
      const record = ctx.records?.treated?.find(t => t.arm === arm.name)?.learners?.[0]?.redesigns?.[0];
      if (record) artifacts.push({ name: `${ctx.label(arm.name)}: ${learnsOf(arm) ? 'the redesign' : 'the notes rewrite'} after event ${record.at_event}`, arm: arm.name, text: `${learnsOf(arm) ? '' : `Message: ${c.NOTES_MESSAGE}\n\n`}Result: ${record.line}` });
    }
    step('The two arms', `Both: ${list(both)}. ${own.join(' ')}${between}`, artifacts);
  }

  // 3. One event, step by step.
  {
    const id = firstEvent?.input.id ?? doc.inputs[0];
    const value = c.inputValue(root, id), deliverable = doc.deliverable ? c.deliverableOf(doc.deliverable, value) : null;
    const room = c.inputRoom(root, id);
    const out = deliverable ? deliverable.split('/')[0] : null;
    const folders = room ? readdirSync(room, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== out).map(d => `${d.name}/`) : [];
    const handed = deliverable ? basename(deliverable) : 'its output';
    const lines: string[] = [];
    const letter = (text: string) => lines.push(`${String.fromCharCode(97 + lines.length)}. ${text}`);
    letter(`A new ${kind.unit}${project ? ' in the project' : ''}${folders.length ? `; the ${ctx.noun} is in ${list(folders)}` : ''}.`);
    if (project) letter(`Message 1: ${project.first_message ? 'the first message (first chat only), then ' : ''}the daily message with the ${ctx.noun}'s values filled in.`);
    else letter(plainArm ? `The task: the ${ctx.noun} and the file to hand in.` : `The Method runs on the ${ctx.noun}'s values.`);
    letter(arms.every(a => a.file) ? `The Method hands in ${deliverable ? handed : 'its result'}.` : `The agent saves ${handed}.`);
    if (!corrections) letter(`${main.code ? `Code (${main.code.path ? relative(root, main.code.path) : 'the measure'})` : main.rubric || main.checklist ? 'One judge' : 'A person'} scores ${deliverable ? handed : 'the result'} against the hidden answer${doc.expected ? '' : ' (this file has none)'}. Nothing goes back to the arm.`);
    if (writer?.code) letter(`Code (${writer.code}) reads ${handed} and the hidden answer, and writes the correction. No model.`);
    else if (writer?.judge) letter(`One ${plan.judge?.agent === 'codex' ? 'Codex' : 'Claude Code'} judge reads ${handed} and the hidden answer, and writes the correction.`);
    else if (corrections) letter('The correction is the text that the file gives for this event.');
    if (corrections) letter(`${project ? 'Message 2, in the same chat' : 'The arm gets'}: the correction. The hidden answer file itself is never sent.`);
    const what = arms.map(a => `${capital(ctx.label(a.name))}: ${a.project ? (learnsOf(a) ? 'the same chat may send it through method judge; a separate learner session then changes the Method, and Method keeps the change only if it passes the gate (below); the fix ends before the next event' : 'the same chat does what it wants with it (notes, memory); no other program runs')
      : a.plain ? 'a separate session edits the agent\'s instructions' : 'method judge starts the learner, which changes the Method behind the gate'}.`);
    if (corrections) letter(what.join(' '));
    if (project) letter('The chat ends.');
    const artifacts: Artifact[] = [];
    if (project) artifacts.push({ name: `Message 1 of the chat on ${ctx.name(id)}, word for word`, text: cut(c.projectMessage(project, value, true)) });
    else if (plainArm) artifacts.push({ name: `The task on ${ctx.name(id)}`, text: cut(c.taskPrompt(value, deliverable)) });
    if (writer?.code) artifacts.push(...coreCode(resolve(root, writer.code)));
    else if (writer?.judge) artifacts.push({ name: 'The judge\'s instruction', text: writer.judge });
    if (ctx.records) for (const arm of arms) {
      const first = eventsOf(ctx, arm.name).find(e => e.kind === 'correction' && typeof e.text === 'string');
      if (first) artifacts.push({ name: `${ctx.label(arm.name)}: message 2 of event ${first.index} (${ctx.name(first.input)}), word for word`, arm: arm.name, text: cut(first.text) });
    } else {
      const sample = ctx.exhibits?.see.find(e => e.id === 'correction');
      for (const block of sample?.blocks.filter(b => !/sample output|printed|prompt of the session/i.test(b.name)) ?? []) artifacts.push({ name: `${block.name} (on a sample output made by code)`, text: cut(block.text) });
    }
    if (corrections) for (const arm of arms) {
      const events = eventsOf(ctx, arm.name).filter(e => e.kind === 'correction' && e.received);
      const first = events.find(e => e.change?.diff) ?? events[0];
      if (learnsOf(arm) && arm.project !== undefined || (!arm.plain && !arm.project)) {
        if (first) { const commands = chatCommands(ctx, arm, first.index); if (commands) artifacts.push({ name: `${ctx.label(arm.name)}: the commands of event ${first.index}'s chat after the correction`, arm: arm.name, text: commands }); }
        const check = first ? savedCheck(ctx, arm, first) : null;
        const prompt = check?.prompt ?? await learnerPromptText(arm);
        artifacts.push({ name: `${ctx.label(arm.name)}: the learner's prompt${check?.prompt ? ', as it ran' : ''}`, arm: arm.name, text: cut(prompt, 8000) });
        artifacts.push({ name: `${ctx.label(arm.name)}: the gate that keeps a change, from that prompt`, arm: arm.name, text: gateOf(prompt) });
        if (check?.text) artifacts.push({ name: `${ctx.label(arm.name)}: the check that the learner saved for event ${first.index} (${check.id})`, arm: arm.name, text: check.text });
      } else if (arm.plain) artifacts.push({ name: `${ctx.label(arm.name)}: the prompt of the session that edits the instructions`, arm: arm.name, text: c.builderPrompt });
      if (first?.change?.diff) artifacts.push({ name: `${ctx.label(arm.name)}: what event ${first.index} changed, without Method's bookkeeping files`, arm: arm.name, text: cut(cleanDiff(first.change.diff, ctx.placed) || '(no change)', 8000) });
    }
    step(corrections ? 'One event, step by step' : 'One run, step by step', lines.join('\n'), artifacts, true);
  }

  // 4. The corrections, in counts and kinds.
  {
    const parts: string[] = [], artifacts: Artifact[] = [];
    if (ctx.records?.treated) for (const arm of arms) {
      const events = eventsOf(ctx, arm.name).filter(e => e.kind === 'correction' && e.received);
      const right = events.filter(e => e.outcome === 'was_right' || e.outcome === 'no_feedback').length;
      const lines = events.flatMap(e => typeof e.text === 'string' && e.outcome !== 'was_right' ? e.text.split('\n').filter((l: string) => l.trim()) : []).length;
      const changed = events.filter(e => e.outcome === 'edited' || e.outcome === 'fixed').length;
      const most = perItem ? [...perItem.items].sort((a, b) => b.corrections[arm.name]! - a.corrections[arm.name]!)[0] : null;
      parts.push(`${capital(ctx.label(arm.name))}: ${plural(events.length, 'correction')}, ${events.length - right} with wrong answers (${plural(lines, 'line')} in all) and ${right} “right”; it changed itself after ${changed}${most && most.corrections[arm.name] ? `; most corrected: ${perItem!.noun} ${most.id} (${most.corrections[arm.name]} times)` : ''}.`);
    }
    const labels = teachingLabels(ctx);
    if (labels.size) {
      const all = [...labels.values()].flatMap(t => [...t.values()]);
      const counts = new Map<string, number>(); for (const l of all) counts.set(l.label, (counts.get(l.label) ?? 0) + 1);
      const silent = all.filter(l => !l.evidence.length).length;
      parts.push(`The hidden answers of the ${plural(labels.size, `teaching ${ctx.noun}`, `teaching ${ctx.nouns}`)} hold ${all.length} right answers: ${list([...counts].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${n} “${l}”`))}; ${silent} have no evidence sentence.`);
    }
    artifacts.push({ name: 'The order', table: { columns: ['Event', capital(ctx.noun), ...(ctx.records ? arms.map(a => `${ctx.label(a.name)}: lines`) : [])],
      rows: plan.events.map((e: any) => [String(e.index), ctx.name(e.input.id), ...(ctx.records ? arms.map(a => { const r = eventsOf(ctx, a.name).find(x => x.index === e.index); return r ? (r.outcome === 'was_right' ? 'right' : String(typeof r.text === 'string' ? r.text.split('\n').filter((l: string) => l.trim()).length : 0)) : '–'; }) : [])]) } });
    if (plan.events.length) step('The corrections', `${plural(plan.events.length, 'event')}, in one order, the same for every arm. ${parts.join(' ')}`.trim(), artifacts);
    else step('The corrections', 'None: the arms get nothing between runs. Each arm is measured as it starts.', [], false);
  }

  // 5. What is measured, on which inputs, when.
  {
    const sameName = again.filter(o => JSON.stringify(c.inputValue(root, o.measured)) === JSON.stringify(c.inputValue(root, o.teaching)));
    const rows: string[][] = [];
    const redesign = new Set(plan.redesign ?? []);
    const at = (n: number) => points.includes(n) ? [[`Checkpoint ${n}`, `A fresh copy of each arm answers ${plural(doc.inputs.length, ctx.noun, ctx.nouns)}, one new ${kind.unit} each, and is thrown away.`]] : [];
    if (redesign.has(0)) rows.push(['Before event 1', 'One redesign session for each arm.']);
    rows.push(...at(0));
    let run: any[] = [];
    const flush = () => { if (!run.length) return; rows.push([run.length === 1 ? `Event ${run[0].index}` : `Events ${run[0].index}–${run.at(-1).index}`, `${run.map((e: any) => ctx.name(e.input.id)).join(', ')}: one ${kind.unit} each, then its correction.`]); run = []; };
    for (const e of plan.events) {
      run.push(e);
      if (points.includes(e.index) || redesign.has(e.index)) { flush(); if (redesign.has(e.index)) rows.push([`After event ${e.index}`, 'One more session for each arm (redesign or notes rewrite).']); rows.push(...at(e.index)); }
    }
    flush();
    const artifacts: Artifact[] = points.length ? [{ name: 'The timeline', table: { columns: ['When', 'What happens'], rows } }] : [];
    if (again.length) artifacts.push({ name: `Measured ${ctx.nouns} that are teaching ${ctx.nouns} again`, table: { columns: ['Measured', 'Teaching', 'Same text', 'Same file name'],
      rows: again.map(o => [ctx.name(o.measured), ctx.name(o.teaching), 'yes', sameName.includes(o) ? 'yes' : 'no']) } });
    step('What is measured', `${teaching.length ? `New ${ctx.nouns}` : capital(ctx.nouns)}: ${fresh}${teaching.length ? ', none of them a teaching input' : ''}. ${again.length ? `Also ${plural(again.length, `teaching ${ctx.noun}`, `teaching ${ctx.nouns}`)} asked again (same text${sameName.length === again.length ? ', same file name' : ''}): a lookup check only. ` : ''}${points.length ? `Checkpoints: ${list(points.map(String))}; the decision is at ${rule.at ?? points.at(-1)}. ` : ''}${plural(plan.learners, 'copy', 'copies')} of each arm. Nothing from a measuring ${kind.unit} reaches the ${kind.what}.`, artifacts);
  }

  // 6. The measures, numbered, each with its code.
  {
    const lookups = new Set<string>();
    if (ctx.records && again.length) for (const m of plan.measures) {
      const scored = ctx.records.grades.filter(g => printedItems(g.printed?.[m.name]).score !== null).map(g => g.input);
      if (scored.length && scored.every(i => again.some(o => o.measured === i))) lookups.add(m.name);
    }
    const measures = [doc.measure, ...(doc.other_measures ?? [])];
    const lines = measures.map((m: any, i: number) => `(${String.fromCharCode(97 + i)}) ${m.name}${i === 0 ? ' (main)' : ''}${lookups.has(m.name) ? ', a lookup check only' : ''}: ${m.description ? one(m.description.split(/(?<=\.)\s/)[0]!, 260).replace(/\.$/, '') : 'no description'}; ${m.code ? m.code : m.rubric ? 'a judge with a rubric' : m.checklist ? 'a judge with each input\'s checklist' : 'a person'}${m.checklist || m.compares_with === 'labels' ? '; it compares each answer with the right answers' : m.compares_with === 'nothing' ? '; it reads the output only' : ''}.`);
    if (corrections) lines.push(`(${String.fromCharCode(97 + measures.length)}) usage per correction, both arms; Method counts it.`);
    const artifacts: Artifact[] = [];
    if (main.code) artifacts.push(...coreCode(main.code.path));
    const scored = scoredExample(ctx, perItem);
    if (scored) artifacts.push(scored);
    else { const sample = ctx.exhibits?.scored.find(e => e.id.startsWith('scoring-')); for (const b of sample?.blocks.filter(b => /printed/i.test(b.name)) ?? []) artifacts.push({ name: `${b.name}, on a sample output made by code`, text: cut(b.text, 4000) }); }
    step('Measures', lines.join('\n'), artifacts);
  }

  // 7. The decision rule, fixed before the run.
  {
    const at = rule.at ?? null;
    const of = at !== null ? counted[armA.name]?.find(x => x.checkpoint === at)?.of : undefined;
    const answers = of ? ` (about ${Math.round(rule.margin * of)} of ${of} answers)` : '';
    const least = Math.max(2, rule.min_runs);
    const guard = rule.guard ? `, and it is no more than ${rule.guard.max_drop} behind on “${rule.guard.measure}”` : '';
    const artifacts: Artifact[] = [];
    if (Object.keys(counted).length) artifacts.push({ name: `“${main.name}”: right answers on the new ${ctx.nouns}`, table: { columns: ['Arm', ...(perItem?.checkpoints ?? []).map(x => `Checkpoint ${x}`)],
      rows: arms.map(a => [ctx.label(a.name), ...(counted[a.name] ?? []).map(x => `${x.right} of ${x.of} (${fixed2(x.right / Math.max(x.of, 1))})`)]) } });
    step('The decision rule', `Fixed before any run: ${at !== null ? `at checkpoint ${at}, ` : ''}an arm is better when its “${main.name}” is at least ${rule.margin} above the other's${answers}, the lead is larger than the difference between two copies of one arm${guard}, with at least ${least} copies of each arm. Otherwise: can't tell yet.`, artifacts);
  }

  // 8. Cost and copies.
  {
    const parts: string[] = [];
    if (ctx.records?.treated) for (const arm of arms) {
      const events = eventsOf(ctx, arm.name).filter(e => e.kind === 'correction' && e.received);
      const minutes = events.length ? events.reduce((s, e) => s + (e.duration_ms ?? 0), 0) / events.length / 60_000 : null;
      const tokens = events.filter(e => typeof e.tokens === 'number');
      parts.push(`${capital(ctx.label(arm.name))}: ${minutes === null ? 'no time known' : `about ${plural(Math.round(minutes * 10) / 10, 'minute')}`} per correction${tokens.length ? `, ${(tokens.reduce((s, e) => s + e.tokens, 0) / tokens.length / 1e6).toFixed(2)} million tokens per correction (${tokens.length} of ${events.length} corrections report tokens)` : ', no token count'}.`);
    }
    if (ctx.records?.runs.length) for (const arm of arms) {
      const runs = ctx.records.runs.filter(r => r.arm === arm.name && typeof r.duration_ms === 'number');
      if (!runs.length) continue;
      const usd = runs.every(r => typeof r.cost_usd === 'number') ? runs.reduce((a, r) => a + r.cost_usd, 0) / runs.length : null;
      parts.push(`${capital(ctx.label(arm.name))}: about ${plural(Math.round(runs.reduce((a, r) => a + r.duration_ms, 0) / runs.length / 6000) / 10, 'minute')} per measured ${ctx.noun}${usd !== null ? `, $${usd.toFixed(3)} at API prices` : ''} (${plural(runs.length, 'run')}).`);
    }
    const least = Math.max(2, rule.min_runs);
    const copies = plan.learners < least ? `${plural(plan.learners, 'copy', 'copies')} of each arm: the rule needs ${least}, so this run cannot answer, and how much two copies of one arm differ is not known.` : `${plural(plan.learners, 'copy', 'copies')} of each arm.`;
    step('Cost and copies', `${parts.join(' ')} ${copies}`.trim(), []);
  }
  return steps;
}

/** The gate that keeps a learner's change, as the learner's prompt states it: its lines after "Method checks your work". */
function gateOf(prompt: string) {
  const at = prompt.indexOf('When you finish, Method checks your work');
  if (at < 0) return 'The learner\'s prompt does not state the gate.';
  return prompt.slice(at).split('\n').filter((line, i) => i === 0 || line.startsWith('- ')).map(line => line.length > 400 ? `${line.slice(0, 400)} …` : line).join('\n');
}

/** The steps of a Method file in plain words: each step's name, kind and the start of its prompt or its script. */
export function methodSteps(file: string): string {
  let document: any;
  try { const { readDocument } = requireAuthoring(); document = readDocument(file); } catch { try { return cut(readFileSync(file, 'utf8'), 4000); } catch { return ''; } }
  return Object.entries(document.steps ?? {}).map(([id, step]: [string, any], i) => {
    const d = step.do ?? {};
    const what = d.prompt ? `${d.kind ?? 'model'} step: “${one(String(d.prompt), 200)}”` : d.entrypoint ? `code (${d.entrypoint}${Array.isArray(d.args) && d.args.length ? ` ${d.args.join(' ')}` : ''})` : d.kind ?? 'step';
    return `${i + 1}. ${step.name ?? id}: ${what}${step.each ? ' (once for each item)' : ''}${step.check ? '; then a check' : ''}`;
  }).join('\n');
}
let authoringModule: any = null;
const requireAuthoring = () => authoringModule;

/** The commands that an arm's chat ran after the correction of an event (message 2), each with the first line of what it printed. */
function chatCommands(ctx: Context, arm: any, index: number): string | null {
  const { learnerFolder } = compareModule;
  const dir = join(learnerFolder(ctx.plan, arm, 0), 'events', String(index), 'artifacts', 'session');
  let attempts: string[] = [];
  try { attempts = readdirSync(dir).filter(n => n.startsWith('attempt-')).sort(); } catch { return null; }
  const last = attempts.at(-1);
  if (!last || attempts.length < 2) return null;
  let lines: any[] = [];
  try { lines = readFileSync(join(dir, last, 'transcript.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return null; }
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const e = lines[i];
    if (e.role !== 'assistant' || e.kind !== 'command') continue;
    const m = /(?:^|[\s'"/])(method (?:judge|wait|run|redesign|undo|answer)\b[\s\S]*)/.exec(String(e.text));
    if (!m) continue;
    const command = m[1]!.replace(/'\s*$/, '');
    const result = lines.slice(i + 1).find(x => x.role === 'tool');
    out.push(`$ ${one(command, 260)}`, ...(result ? [`→ ${one(String(result.text).split('\n').find((l: string) => l.trim()) ?? '', 300)}`] : []));
  }
  return out.length ? out.join('\n') : null;
}
/** The check that the learner saved for an event (a file cases/ID/case.json that the event added), and the learner's prompt as it ran. */
function savedCheck(ctx: Context, arm: any, event: any): { id: string; text: string | null; prompt: string | null } | null {
  const added: string[] = event.did?.added ?? [];
  const casePath = added.find(p => /^cases\/[^/]+\/case\.json$/.test(p));
  const { learnerFolder } = compareModule;
  const base = learnerFolder(ctx.plan, arm, 0);
  const id = casePath ? casePath.split('/')[1]! : null;
  let text: string | null = null;
  if (casePath) {
    for (const where of [join(base, 'project', casePath), ...(ctx.plan.checkpoints ?? []).map((c: number) => join(base, `after-${c}`, 'project', casePath))]) {
      const value = existsSync(where) ? json(readFileSync(where, 'utf8')) : null;
      if (!value) continue;
      const expect = Array.isArray(value.expect) ? value.expect : [];
      const lines = expect.map((e: any) => e.kind === 'equals' ? `${e.ref} must equal this value exactly:\n${cut(JSON.stringify(e.value, null, 2), 3000)}` : `${e.kind}${e.ref ? ` on ${e.ref}` : ''}${e.text ? `: ${e.text}` : ''}`);
      const rubric = Array.isArray(value.rubric) ? value.rubric.map((r: any) => `- ${typeof r === 'string' ? r : r.text ?? JSON.stringify(r)}`) : [];
      text = [...lines, ...rubric].join('\n') || cut(JSON.stringify(value, null, 2), 3000);
      break;
    }
  }
  // The learner's prompt for that judgment, as the fix ran it: cache/fixes/METHOD/learn/jdg_ID…/tries/N/run/artifacts/session/attempt-*/prompt.md.
  let prompt: string | null = null;
  const fixes = join(base, 'cache', 'fixes');
  const short = id?.replace(/^correction-/, '');
  try {
    const found: string[] = [];
    for (const method of readdirSync(fixes)) {
      let judgments: string[] = [];
      try { judgments = readdirSync(join(fixes, method, 'learn')); } catch { continue; }
      for (const j of judgments.sort((a, b) => Number(!!short && b.startsWith(`jdg_${short}`)) - Number(!!short && a.startsWith(`jdg_${short}`)))) {
        const tries = join(fixes, method, 'learn', j, 'tries');
        try {
          for (const t of readdirSync(tries).sort()) {
            const session = join(tries, t, 'run', 'artifacts', 'session');
            for (const a of readdirSync(session)) if (existsSync(join(session, a, 'prompt.md'))) found.push(join(session, a, 'prompt.md'));
          }
        } catch { /* none */ }
        if (found.length) break;
      }
      if (found.length) break;
    }
    if (found[0]) prompt = readFileSync(found[0], 'utf8');
  } catch { /* no fixes */ }
  return id || prompt ? { id: id ?? 'no check', text, prompt } : null;
}
async function learnerPromptText(arm: any) {
  const { learnerPrompt } = await import('./learner.js');
  const file = arm.project ? (filesUnder(arm.project.start).map(f => relative(arm.project.start, f)).find(f => f.endsWith('.method')) ?? 'NAME.method') : arm.file ?? 'NAME.method';
  return learnerPrompt(file, ['CHECK-ID']);
}
/** One measured input at the deciding checkpoint as a table: each item that some arm got wrong, with each arm's answer, and the score. */
function scoredExample(ctx: Context, perItem: PerItem | null): Artifact | null {
  if (!ctx.records || !perItem) return null;
  const main = mainMeasure(ctx), at = ctx.plan.checkpoints ? (ctx.plan.rule.at ?? perItem.checkpoints.at(-1) ?? null) : null;
  for (const input of ctx.doc.inputs as string[]) {
    const read = ctx.plan.arms.map((a: any) => printedItems(ctx.records!.grades.find(g => g.arm === a.name && g.repeat === 0 && g.input === input && (g.checkpoint ?? 0) === (at ?? 0))?.printed?.[main.name]));
    if (read.some((r: any) => r.score === null || !r.items)) continue;
    const ids = read[0].items!.map((i: any) => i.id).filter((id: string) => read.some((r: any) => !r.items.find((i: any) => i.id === id)?.right));
    const words = perItem.items;
    const rows = ids.map((id: string) => {
      const expected = read[0].items!.find((i: any) => i.id === id)!.expected ?? '';
      const w = words.find(x => x.id === id)?.words;
      return [`${id}${w ? ` ${one(w, 80)}` : ''}`, expected, ...read.map((r: any) => { const i = r.items.find((x: any) => x.id === id); return i?.right ? 'right' : `${i?.given ?? 'no answer'}${i?.unsure ? ' (unsure)' : ''}`; })];
    });
    rows.push(['Score', '', ...read.map((r: any) => { const right = r.items.filter((i: any) => i.right).length; return `${right}/${r.items.length} = ${fixed2(r.score)}`; })]);
    return { name: `${ctx.name(input)}${at !== null ? ` at checkpoint ${at}` : ''}: each ${perItem.noun} that an arm got wrong`, table: { columns: [capital(perItem.noun), 'Right answer', ...ctx.plan.arms.map((a: any) => `${ctx.label(a.name)} gave`)], rows } };
  }
  return null;
}
/** The teaching inputs that the arms' starting files name: by a string value of the input (a file name, with or without its extension). */
function startReads(ctx: Context): Array<{ name: string; files: string[] }> {
  const { inputValue } = compareModule;
  const starts = ctx.plan.arms.flatMap((a: any) => a.project ? [a.project.start] : a.dir ? [a.dir] : []) as string[];
  const files = starts.flatMap(dir => filesUnder(dir).map(f => ({ rel: relative(dir, f), text: readFileSync(f, 'utf8') })));
  const userFiles = new Set((ctx.plan.user_files ?? []) as string[]);
  const out: Array<{ name: string; files: string[] }> = [];
  for (const id of teachingIds(ctx)) {
    const value = inputValue(ctx.root, id);
    const words = new Set<string>();
    const walk = (v: unknown) => { if (typeof v === 'string' && v.length >= 5 && v.length <= 200) { words.add(v); words.add(v.replace(/\.[a-z0-9]+$/i, '')); } else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
    walk(value);
    const hits = [...new Set(files.filter(f => !userFiles.has(f.rel) && [...words].some(w => w.length >= 5 && new RegExp(`(?<![\\w])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`).test(f.text))).map(f => f.rel))];
    if (hits.length) out.push({ name: ctx.name(id), files: hits });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Where this could be wrong

/** The longest runs of text (at least min characters, spaces made single) that a learned file shares with the teaching inputs. */
export function copiedPassages(learned: string, sources: string[], min = 200): string[] {
  const text = squash(learned), probe = 64;
  const index = new Map<string, number[]>();
  const joined = sources.map(squash);
  joined.forEach((s, si) => { for (let i = 0; i + probe <= s.length; i += 16) { const k = s.slice(i, i + probe); const at = index.get(k); if (at) at.push(si); else index.set(k, [si]); } });
  const out: string[] = [];
  let i = 0;
  while (i + probe <= text.length) {
    const hit = index.get(text.slice(i, i + probe));
    if (!hit) { i++; continue; }
    // The longest stretch of the learned text from i back and forward that one source holds.
    let best = '';
    for (const si of new Set(hit)) {
      const source = joined[si]!;
      let from = i, to = i + probe;
      while (from > 0 && source.includes(text.slice(from - 1, to))) from--;
      let step = 256;
      while (step >= 1) { if (to + step <= text.length && source.includes(text.slice(from, to + step))) to += step; else step = Math.floor(step / 2); }
      if (to - from > best.length) best = text.slice(from, to);
    }
    if (best.length >= min) { out.push(best); i = text.indexOf(best, Math.max(0, i - best.length)) + best.length; } else i++;
  }
  return out;
}

async function concernsOf(ctx: Context, perItem: PerItem | null, counted: Literal['counted'], baselines: Literal['baselines'], usage: Literal['usage'], event: ReturnType<typeof oneEvent>): Promise<Concern[]> {
  const c = compareModule ?? await import('./compare.js');
  compareModule = c;
  const { plan, doc, root } = ctx, out: Concern[] = [];
  const add = (kind: string, text: string, evidence: Artifact[] = []) => out.push({ kind, text, evidence });
  const teaching = teachingIds(ctx);

  // Sources that the treatment contradicts: a feedback event's source names another writer than the one that writes it.
  const writers = doc.treatment?.feedback_writers ?? {};
  const mismatches = new Map<string, { said: string; writer: string; real: string; events: number[] }>();
  (doc.treatment?.events ?? []).forEach((e: any, i: number) => {
    const writer = e.feedback ? writers[e.feedback] : undefined;
    if (!writer || !e.source) return;
    const agrees = writer.code ? e.source.kind === 'code' && resolve(root, e.source.file) === resolve(root, writer.code)
      : e.source.kind === 'model' && e.source.prompt === writer.judge;
    if (agrees) return;
    const said = c.sourceWords(e.source), real = writer.code ? `code (${writer.code})` : `a model judge with the instruction “${one(writer.judge, 300)}”`;
    const found = mismatches.get(`${e.feedback}\n${said}`) ?? { said, writer: e.feedback, real, events: [] as number[] };
    found.events.push(i + 1);
    mismatches.set(`${e.feedback}\n${said}`, found);
  });
  for (const m of mismatches.values())
    add('claim', `The file says who writes the words of ${m.events.length === 1 ? 'event' : 'events'} ${list(m.events.map(String))}: “${one(m.said, 300)}” But the feedback writer ${m.writer} writes them, and it is ${m.real}.`);
  // Who made the labels, and whether the main measure compares with them, as the file states both.
  if (doc.expected) {
    const by = doc.about_inputs?.labels_by as string | undefined;
    const main = doc.measure, compares = main.checklist ? 'labels' : main.compares_with;
    const parts = [by ? `Who made the right answers, in the file's words: “${one(by, 1000)}”` : 'The file does not say who made the right answers.'];
    if (compares === 'labels') parts.push(`The main measure, “${main.name}”, compares each answer with them.`);
    else if (compares === 'nothing') parts.push(`The main measure, “${main.name}”, reads the output only, not them.`);
    else parts.push(`The file does not say whether the main measure, “${main.name}”, compares with them.`);
    if (Object.keys(writers).length) parts.push('The feedback writers read them to write the corrections.');
    add('labels_by', parts.join(' '));
  }
  // Who writes the corrections.
  const writerName = plan.events.find((e: any) => e.feedback)?.feedback?.name, writer = writerName ? writers[writerName] : undefined;
  const labels = teachingLabels(ctx);
  if (writer?.code) {
    let silent = 0, lines = 0;
    for (const t of ctx.records?.treated ?? []) for (const e of t.learners[0]?.events ?? []) {
      if (typeof e.text !== 'string' || !perItem) continue;
      for (const item of perItem.items) if (linesAbout(e.text, perItem.noun, item.id).length) { lines++; if (!labels.get(e.input)?.get(item.id)?.evidence.length) silent++; }
    }
    add('corrections_by_code', `The corrections are written by code (${basename(writer.code)}), not by a person or a model.${lines ? ` ${silent} of the ${lines} corrected answers had no evidence sentence in the hidden answer, so their correction gives the right answer with no reason from the ${ctx.noun}.` : ''}`, coreCode(resolve(root, writer.code)).slice(-1));
  } else if (writer?.judge) add('corrections_by_judge', `The corrections are written by a model judge from the hidden answer, not by a person.`, [{ name: 'Its instruction', text: writer.judge }]);
  // Different corrections per arm.
  if (ctx.records?.treated && writer && plan.arms.length > 1) {
    const [a, b] = plan.arms;
    const ea = eventsOf(ctx, a.name), eb = eventsOf(ctx, b.name);
    const both = ea.filter(e => typeof e.text === 'string' && eb.some(x => x.index === e.index && typeof x.text === 'string'));
    const differ = both.filter(e => eb.find(x => x.index === e.index)!.text !== e.text);
    if (differ.length) add('different_corrections', `The arms got different words on ${differ.length} of ${plural(both.length, 'event')}: each is corrected on its own answers.`,
      [{ name: `Event ${differ[0].index}, ${ctx.name(differ[0].input)}`, table: { columns: plan.arms.map((x: any) => ctx.label(x.name)), rows: [[one(differ[0].text, 1200), one(eb.find(x => x.index === differ[0].index)!.text, 1200)]] } }]);
  }
  // Teaching and measured inputs overlap.
  const texts = inputTexts(ctx), again = overlaps(ctx, texts);
  if (again.length) {
    const measures = plan.measures.filter((m: any) => ctx.records?.grades.some(g => again.some(o => o.measured === g.input) && printedItems(g.printed?.[m.name]).score !== null)).map((m: any) => m.name);
    add('overlap', `${plural(again.length, `measured ${ctx.noun}`, `measured ${ctx.nouns}`)} ${again.length === 1 ? 'is a teaching input' : `are teaching ${ctx.nouns}`} again, with the same text and the same values. An arm can answer ${again.length === 1 ? 'it' : 'them'} by looking up what it was told${measures.length ? `; ${list(measures.map((m: string) => `“${m}”`))} ${measures.length === 1 ? 'scores' : 'score'} ${again.length === 1 ? 'it' : 'them'}` : ''}.`,
      [{ name: 'The pairs', text: again.map(o => `${ctx.name(o.measured)} = ${ctx.name(o.teaching)}`).join('\n') }]);
  }
  // Learned text that matches only teaching inputs.
  if (ctx.records?.treated) {
    const { learnerFolder } = c;
    const sources = teaching.map(id => texts.get(id) ?? '');
    const fresh = (doc.inputs as string[]).filter(id => !again.some(o => o.measured === id)).map(id => squash(texts.get(id) ?? ''));
    for (const arm of plan.arms) {
      const base = learnerFolder(plan, arm, 0);
      const dir = arm.project ? join(base, 'project') : join(base, 'method');
      const skip = (rel: string) => BOOKKEEPING.some(rule => rule.test(rel)) || isPlaced(ctx.placed, rel);
      const found: Array<{ file: string; text: string }> = [];
      for (const file of filesUnder(dir, skip)) for (const text of copiedPassages(readable(file), sources)) found.push({ file: relative(dir, file), text });
      for (const file of filesUnder(join(base, 'memory'))) for (const text of copiedPassages(readable(file), sources)) found.push({ file: `memory/${relative(join(base, 'memory'), file)}`, text });
      const distinct = [...new Map(found.map(f => [f.text, f])).values()];
      found.splice(0, found.length, ...distinct);
      if (!found.length) continue;
      const onNew = found.filter(f => fresh.some(t => t.includes(f.text))).length;
      const files = [...new Set(found.map(f => f.file))];
      add('copied_text', `${capital(ctx.label(arm.name))}'s ${arm.project ? 'project' : 'Method'} holds ${plural(found.length, 'passage')} of 200 or more characters copied word for word from the teaching ${ctx.nouns} (in ${list(files)}). ${onNew === 0 ? `None of them is in any of the ${plural(fresh.length, `new ${ctx.noun}`, `new ${ctx.nouns}`)}, so a rule that fires on that text can only fire on a teaching ${ctx.noun} or its copy.` : `${onNew} of them ${onNew === 1 ? 'is' : 'are'} also in a new ${ctx.noun}.`}`,
        [{ name: `The first passage (${found[0]!.file})`, text: one(found[0]!.text, 1200) }]);
    }
    // Steps fixed to item numbers.
    if (perItem) {
      const max = Math.max(...perItem.items.map(i => Number(i.id)).filter(Number.isFinite));
      for (const arm of plan.arms) {
        const base = learnerFolder(plan, arm, 0), dir = arm.project ? join(base, 'project') : join(base, 'method');
        const start = arm.project ? arm.project.start : arm.dir;
        const before = new Set<string>();
        if (start) for (const f of filesUnder(start)) for (const m of readFileSync(f, 'utf8').matchAll(/\[\s*\d+(?:\s*,\s*\d+)+\s*\]/g)) before.add(m[0].replace(/\s+/g, ''));
        const hits: string[] = [];
        for (const f of filesUnder(dir, rel => BOOKKEEPING.some(rule => rule.test(rel)) || isPlaced(ctx.placed, rel)).filter(f => /\.(py|mjs|js|ts|method|ya?ml)$/.test(f))) {
          for (const m of readFileSync(f, 'utf8').matchAll(/\[\s*\d+(?:\s*,\s*\d+)+\s*\]/g)) {
            const numbers = m[0].match(/\d+/g)!.map(Number), key = m[0].replace(/\s+/g, '');
            if (numbers.every(n => n >= 1 && n <= max) && !before.has(key)) hits.push(`${m[0].replace(/\s+/g, ' ')} (${relative(dir, f)})`);
          }
        }
        const unique = [...new Set(hits)];
        if (unique.length) add('fixed_items', `${capital(ctx.label(arm.name))}'s changed code holds lists of ${perItem.noun} numbers, so some steps run only for those ${perItem.noun}s on every ${ctx.noun}: ${list(unique.slice(0, 4))}${unique.length > 4 ? ` and ${unique.length - 4} more` : ''}.`);
      }
    }
  }
  // No change on new inputs after some events.
  for (const arm of plan.arms) {
    const points = counted[arm.name] ?? [];
    for (let i = 1; i < points.length; i++) if (points[i]!.right === points[i - 1]!.right && points[i]!.of === points[i - 1]!.of) {
      const n = eventsOf(ctx, arm.name).filter(e => e.kind === 'correction' && e.received && e.index > (points[i - 1]!.checkpoint ?? 0) && e.index <= (points[i]!.checkpoint ?? 0)).length;
      if (n) add('no_change', `${capital(ctx.label(arm.name))} had ${points[i]!.right} of ${points[i]!.of} right on the new ${ctx.nouns} at checkpoint ${points[i - 1]!.checkpoint} and at checkpoint ${points[i]!.checkpoint}, after ${plural(n, 'more correction')}.`);
    }
  }
  // A question that got worse, with the corrections on it before.
  if (perItem) for (const item of perItem.items) for (const arm of plan.arms) {
    const points = item.wrong[arm.name] ?? [];
    for (let i = 1; i < points.length; i++) {
      if (points[i]!.wrong - points[i - 1]!.wrong < 3) continue;
      const before = eventsOf(ctx, arm.name).filter(e => e.received && e.index <= points[i]!.checkpoint && typeof e.text === 'string' && linesAbout(e.text, perItem.noun, item.id).length);
      const asked = before.map(e => { const l = labels.get(e.input)?.get(item.id); return `event ${e.index} (${ctx.name(e.input)}) “${l?.label ?? '?'}”${l && !l.evidence.length ? ' with no evidence' : ''}`; });
      const differ = new Set(before.map(e => labels.get(e.input)?.get(item.id)?.label).filter(Boolean)).size > 1;
      add('worse_item', `${capital(ctx.label(arm.name))} got ${perItem.noun} ${item.id} wrong on ${points[i - 1]!.wrong} of ${points[i - 1]!.of} new ${ctx.nouns} at checkpoint ${points[i - 1]!.checkpoint} and on ${points[i]!.wrong} at checkpoint ${points[i]!.checkpoint}.${asked.length ? ` The corrections on it before: ${list(asked)}.` : ''}${differ ? ` These corrections ask for different answers.` : ''}`,
        before.slice(0, 3).map(e => ({ name: `Event ${e.index}, ${ctx.name(e.input)}`, text: linesAbout(e.text, perItem.noun, item.id).join('\n') })));
    }
  }
  // The start read teaching inputs.
  const read = startReads(ctx);
  if (read.length) add('start_read', `The starting files name ${plural(read.length, `teaching ${ctx.noun}`, `teaching ${ctx.nouns}`)}: ${list(read.map(r => `${r.name} (in ${list(r.files)})`))}. The arm that starts with them was built after reading ${read.length === 1 ? 'it' : 'them'}.`);
  // Copies below the rule.
  if (plan.learners < Math.max(2, plan.rule.min_runs)) {
    const at = plan.rule.at ?? null, [a, b] = plan.arms;
    const x = counted[a?.name]?.find(p => p.checkpoint === at), y = counted[b?.name]?.find(p => p.checkpoint === at);
    add('copies', `${plural(plan.learners, 'copy', 'copies')} per arm; the rule needs ${Math.max(2, plan.rule.min_runs)}, so it cannot decide, and how much two copies of one arm differ is not known.${x && y ? ` At checkpoint ${at} the arms differ by ${Math.abs(x.right - y.right)} of ${x.of} answers.` : ''}`);
  }
  // Little room.
  const start = plan.arms.map((a: any) => counted[a.name]?.[0]).filter(Boolean) as Array<{ right: number; of: number }>;
  const strongest = baselines[0];
  if (strongest && start.length) {
    const low = Math.min(...start.map(s => s.right / s.of));
    if (low - strongest.value <= 0.15) add('little_room', `A shortcut that reads no ${ctx.noun} already scores ${fixed2(strongest.value)} on the new ${ctx.nouns}; the arms start at ${list(start.map(s => fixed2(s.right / s.of)))}. The shortcut: ${strongest.name}.`);
  }
  // Restarts.
  const again2 = ctx.records?.treated ? await reruns(plan) : {};
  for (const arm of plan.arms) {
    const runs = [...((again2 as any)[arm.name] as Map<number, number> ?? new Map())].filter(([, n]) => n > 1);
    if (runs.length) add('restart', `${capital(ctx.label(arm.name))}: ${list(runs.map(([index, n]) => `event ${index} ran ${n} times`))}; the record keeps the last.`);
  }
  // Usage in mixed units.
  const missing = Object.entries(usage).filter(([, u]) => u.with_tokens < u.events);
  if (missing.length && Object.values(usage).some(u => u.tokens !== null)) {
    const parts = plan.arms.map((a: any) => { const u = usage[a.name]; return u ? `${ctx.label(a.name)} ${u.tokens === null ? 'not known' : `${(u.tokens / 1e6).toFixed(2)} million tokens`} (${u.with_tokens} of ${plural(u.events, 'correction')})` : null; }).filter(Boolean);
    const ratio = plan.arms.length === 2 && usage[plan.arms[0].name]?.tokens && usage[plan.arms[1].name]?.tokens ? Math.max(usage[plan.arms[0].name]!.tokens!, usage[plan.arms[1].name]!.tokens!) / Math.min(usage[plan.arms[0].name]!.tokens!, usage[plan.arms[1].name]!.tokens!) : null;
    add('usage', `Usage per correction is shown in minutes, because ${list(missing.map(([arm, u]) => `${u.events - u.with_tokens} of ${ctx.label(arm)}'s corrections`))} report no tokens. In tokens, for the corrections that report them: ${list(parts as string[])}${ratio ? `, about ${Math.round(ratio)} times apart` : ''}.`);
  }
  return out;
}

/** Load the modules that the steps use once, before a record is made. */
export async function loadLiteralModules() {
  compareModule ??= await import('./compare.js');
  authoringModule ??= await import('./authoring.js');
}

// ---------------------------------------------------------------------------------------------------------------
// The model review

/** The hosted-model client (managedModels in production, a fake in tests). */
export type ReviewModels = { model(): Promise<string>; request(body: Record<string, any>, signal: AbortSignal): Promise<any> };
/** Change it when the prompt or the facts change, so that a cached review is made again. */
const REVIEW_VERSION = 1;
const REVIEW_PROMPT = `You review a comparison file before people read its result. You get the file's text and the facts that Method computed from the file, its other files and its run records.
List each claim of the file that a fact contradicts. A claim is any words of the file: the question, a measure's name or description, a description of the inputs, a source, a note or an assumption. Contradicts means that the claim and the fact cannot both be true. Examples: a measure named for one kind of person ("replies the doctors approve") while the facts say that other people made the answers it compares with; inputs called new while the facts say that some of them are teaching inputs again; words said to be a person's while the facts say that code writes them.
Do not list a claim that the facts only fail to support, a point of style, or a weakness that the facts already state openly.
For each one: claim, the words of the file, copied exactly and as short as possible while they still show the contradiction; fact, the words of the facts, copied exactly in the same way; why, one plain sentence.
Return {"findings": []} when no fact contradicts a claim.`;
const REVIEW_SCHEMA = { type: 'object', additionalProperties: false, required: ['findings'], properties: { findings: { type: 'array', items: {
  type: 'object', additionalProperties: false, required: ['claim', 'fact', 'why'], properties: { claim: { type: 'string' }, fact: { type: 'string' }, why: { type: 'string' } } } } } };

/** The facts of a record that the review reads: the paragraph, each part's sentence, each finding and each part not shown. */
export function literalFacts(literal: Literal): string {
  return [literal.paragraph, ...literal.steps.map(step => `${step.n}. ${step.title}: ${step.sentence}`), ...literal.concerns.map(c => `- ${c.text}`), ...literal.not_shown.map(text => `- ${text}`)].join('\n');
}
const quoteFree = (text: string) => squash(text).replace(/^[\s"'“”]+|[\s"'“”]+$/g, '').trim();
/**
 * One model review of a record: one request to the hosted model with the file's text and the record's facts, cached
 * by their hash. A finding is kept only when its claim is in the file and its fact is in the facts, word for word.
 */
export async function reviewLiteral(literal: Literal, fileText: string, models: ReviewModels, cacheDir: string): Promise<Review> {
  const { createHash } = await import('node:crypto');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const facts = literalFacts(literal);
  const key = createHash('sha256').update(JSON.stringify([REVIEW_VERSION, fileText, facts])).digest('hex');
  const cached = join(cacheDir, `${key}.json`);
  if (existsSync(cached)) { const saved = json(readFileSync(cached, 'utf8')); if (saved) return saved as Review; }
  const model = await models.model();
  const data = await models.request({
    model, max_tokens: 8000, reasoning: { effort: 'low' }, provider: { require_parameters: true },
    messages: [{ role: 'system', content: REVIEW_PROMPT }, { role: 'user', content: `The file:\n\n${fileText}\n\nThe facts:\n\n${facts}` }],
    response_format: { type: 'json_schema', json_schema: { name: 'comparison_review', strict: true, schema: REVIEW_SCHEMA } },
  }, AbortSignal.timeout(180_000));
  const content = data?.choices?.[0]?.message?.content;
  const value = typeof content === 'string' ? json(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) : null;
  if (!value || !Array.isArray(value.findings)) throw Error(`the hosted model returned no review (finish reason: ${data?.choices?.[0]?.finish_reason ?? 'unknown'})`);
  const file = squash(fileText), known = squash(facts);
  const findings = value.findings.filter((f: any) => typeof f?.claim === 'string' && typeof f?.fact === 'string' && quoteFree(f.claim) && quoteFree(f.fact)
    && file.includes(quoteFree(f.claim)) && known.includes(quoteFree(f.fact)))
    .map((f: any) => ({ claim: quoteFree(f.claim), fact: quoteFree(f.fact), why: typeof f.why === 'string' ? one(f.why, 600) : '' }));
  const review: Review = { model: typeof data?.model === 'string' ? data.model : model, findings };
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  writeFileSync(cached, JSON.stringify(review), { mode: 0o600 });
  return review;
}
