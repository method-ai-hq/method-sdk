/**
 * Exhibits: the literal things of a comparison, which the page shows verbatim before any explanation. Method makes them
 * itself from the comparison's own files and code, with the same functions that the run uses, so the writer cannot
 * paraphrase them:
 *
 * - what each arm receives for one teaching input and one checking input (the session prompt, the Method's step prompts
 *   with the input's values, or the project chat's messages), and each file in its folder for that input;
 * - one correction as an arm gets it: the study's own feedback writer run on a sample output made by code (samples), and
 *   how each arm gets those words;
 * - the hidden answer of one checking input, and each measure's scoring of the sample: what its code reads and prints;
 * - the handed-in output's form, from the sample.
 *
 * After the trial, trialExamples gives the same from each arm's real trial: the words it received, what it handed in,
 * and how one of its runs was scored. labels maps each word that the page uses as a label to the exhibit that shows it.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  PLAIN_PROMPT, RIGHT_WORDS, builderPrompt, cellFolders, checkedAll, deliverableOf, expectedValue, feedbackWriting, inputRoom, inputValue,
  measureStdin, outputText, projectMessage, runScript, shuffled, taskPrompt, type Comparison,
} from './compare.js';
import { RIGHT_MESSAGE, copyTree, placeInput } from './compare-project.js';
import { readDocument } from './authoring.js';

/** One verbatim text of an exhibit: a file by its path, a prompt, a message, or what a script printed. anchor: a label can link to it. */
export type Block = { name: string; text: string; anchor?: string };
/** replaces: the exhibit of the comparison that a trial example shows from a real run (correction, output). */
export type Exhibit = { id: string; title: string; caption: string; arm?: string; blocks: Block[]; replaces?: string };
/** see: what the agents see; scored: how a run is scored; labels: each label word, by the exhibit (or block anchor) that shows it. */
export type Exhibits = { see: Exhibit[]; scored: Exhibit[]; labels: Record<string, string> };
/**
 * An arm as its exhibits need it: its folders by files connection (a Method arm's bound folders; a plain arm's are the
 * Method arms'), and its prompt: a Method file, a plain agent's instructions, or a project's messages and start folder.
 */
export type ArmSource = { name: string; label: string; folders: Record<string, string>; file?: string;
  plain?: { agent: 'claude' | 'codex'; instructions: string }; project?: { message: string; first_message: string | null; start: string } };

/** The most of one text that an exhibit keeps; the contract takes the same. */
export const BLOCK_CHARS = 100_000;
const cut = (text: string) => text.length > BLOCK_CHARS ? `${text.slice(0, BLOCK_CHARS)}\n[... ${text.length - BLOCK_CHARS} more characters]` : text;
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'x';
const nameOf = (doc: Comparison, id: string) => doc.about_inputs?.names?.[id] ?? id.replace(/^.*[/\\]/, '').replace(/\.[a-z0-9]+$/i, '');
const list = (words: string[]) => words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;

/** Every file of a folder, verbatim, as name PREFIX/PATH. A binary file says its size. */
function filesOf(dir: string, prefix: string): Block[] {
  const out: Block[] = [];
  const walk = (sub: string) => {
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(join(dir, sub), { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (['.method-runs', 'node_modules', '.git'].includes(entry.name)) continue;
      if (entry.isDirectory()) { walk(rel); continue; }
      if (!entry.isFile()) continue;
      const bytes = readFileSync(join(dir, rel));
      out.push({ name: prefix ? `${prefix}/${rel}` : rel, text: bytes.includes(0) ? `(a binary file of ${bytes.length} bytes)` : cut(bytes.toString('utf8')) });
    }
  };
  walk('');
  return out;
}

/** The input that the exhibits show: the first of the list that has a sample output, else the first. */
const shownInput = (ids: string[], samples: Record<string, string>) => ids.find(id => samples[id] !== undefined) ?? ids[0];

/**
 * The exhibits of a comparison, made with the run's own code. arms: each arm's source. Returns the exhibits, the
 * problems that make the comparison show a label without its exhibit (errors), and the label words that the writer's
 * texts use and no exhibit shows (to review).
 */
export async function comparisonExhibits(doc: Comparison, root: string, arms: ArmSource[]): Promise<{ exhibits: Exhibits; errors: string[]; review: string[] }> {
  const samples = doc.samples ?? {}, errors: string[] = [];
  const events = shuffled(doc.treatment?.events ?? [], doc.treatment?.seed);
  const teachingIds = [...new Set(events.flatMap(e => e.input !== undefined ? [e.input] : []))];
  const teaching = teachingIds.length ? shownInput(teachingIds, samples) : undefined;
  const checking = shownInput(doc.inputs, samples)!;
  const input = (id: string) => {
    const value = inputValue(root, id), room = inputRoom(root, id);
    return { id, value, room, deliverable: doc.deliverable ? deliverableOf(doc.deliverable, value) : null };
  };
  const sample = (id: string | undefined) => id !== undefined && samples[id] !== undefined ? readFileSync(resolve(root, samples[id]!), 'utf8') : null;
  const see: Exhibit[] = [], scored: Exhibit[] = [];
  const shown = [...(teaching ? [['teaching', teaching] as const] : []), ['checking', checking] as const];

  // What each arm receives, as the run builds it.
  for (const arm of arms) {
    const blocks: Block[] = [];
    for (const [kind, id] of shown) {
      const one = input(id), name = `${nameOf(doc, id)} (${kind === 'teaching' ? 'a teaching input' : 'a checking input'})`;
      if (arm.plain) {
        const { renderPrompt } = await import('@withmethod/runtime/prompt.js');
        blocks.push({ name: `The session prompt on ${name}`, text: cut(renderPrompt(PLAIN_PROMPT, { instructions: arm.plain.instructions, task: taskPrompt(one.value, one.deliverable) })) });
      } else if (arm.project) {
        // The project's first chat gets the first material: the first event, and each chat at the start.
        const first = kind === 'teaching' ? events.findIndex(e => e.input === id) === 0 : true;
        blocks.push({ name: `Message 1 of the chat on ${name}${kind === 'checking' ? ', at the start' : ''}`, text: cut(projectMessage(arm.project, one.value, first)) });
        if (kind === 'checking' && arm.project.first_message && (doc.treatment?.checkpoints ?? []).some(c => c > 0))
          blocks.push({ name: `Message 1 of the chat on ${name}, at later checkpoints`, text: cut(projectMessage(arm.project, one.value, false)) });
      } else if (arm.file) blocks.push(...await methodPrompts(arm.file, one.value, name));
    }
    const how = arm.plain ? `One ${arm.plain.agent === 'codex' ? 'Codex' : 'Claude Code'} session gets this prompt and nothing else, before any correction edits its instructions.`
      : arm.project ? 'The chat\'s first message, as Claude Code gets it. Nothing else is added.'
        : 'Each model step\'s prompt in the Method at the start, filled with the input\'s values; a value from an earlier step stays as {{name}}.';
    if (blocks.length) see.push({ id: `prompt-${slug(arm.name)}`, title: `What ${arm.label} receives`, caption: how, arm: arm.name, blocks });
  }

  // The files in each arm's folder for an input. Arms with the same files share one exhibit.
  for (const [kind, id] of shown) {
    const groups = new Map<string, { arms: ArmSource[]; blocks: Block[] }>();
    for (const arm of arms) {
      const one = input(id);
      let blocks: Block[];
      if (arm.project) {
        const dir = mkdtempSync(join(tmpdir(), 'method-exhibit-'));
        try { copyTree(arm.project.start, join(dir, 'project')); placeInput(join(dir, 'project'), one, one.deliverable); blocks = filesOf(join(dir, 'project'), ''); }
        finally { rmSync(dir, { recursive: true, force: true }); }
      } else blocks = Object.entries(cellFolders(arm, one)).sort(([a], [b]) => a.localeCompare(b)).flatMap(([envName, dir]) => filesOf(dir, envName));
      const key = JSON.stringify(blocks);
      if (!groups.has(key)) groups.set(key, { arms: [], blocks });
      groups.get(key)!.arms.push(arm);
    }
    for (const group of [...groups.values()].filter(g => g.blocks.length)) {
      const id2 = `files-${kind}${groups.size > 1 ? `-${slug(group.arms[0]!.name)}` : ''}`;
      see.push({ id: id2, title: `The files in the folder, for ${nameOf(doc, id)}`, caption: `Each file that ${list(group.arms.map(a => a.label))} ${group.arms.length === 1 ? 'finds' : 'find'} in ${group.arms.length === 1 ? 'its' : 'their'} folder for this ${kind === 'teaching' ? 'teaching' : 'checking'} input, verbatim.`,
        blocks: group.blocks.map(b => ({ ...b, anchor: `file-${kind === 'teaching' ? 'teaching-' : ''}${slug(b.name)}` })) });
    }
  }

  // One correction as an arm gets it.
  const writerName = events.find(e => e.input === teaching && e.feedback !== undefined)?.feedback;
  const writer = writerName ? doc.treatment?.feedback_writers?.[writerName] : undefined;
  const fixed = events.find(e => e.correction !== undefined);
  const delivery = (words: string | null): Block[] => arms.map(arm => arm.plain
    ? { name: `${arm.label}: correction.md, in the folder of the session that edits its instructions`, text: `${words ?? RIGHT_WORDS}\n` }
    : arm.project ? { name: `${arm.label}: message 2 of the same chat`, text: words ?? RIGHT_MESSAGE }
      : { name: `${arm.label}: the note of method judge RUN ${words === null ? 'right' : 'wrong --note'}`, text: words ?? '(no words: the run is judged right)' });
  const builders = arms.filter(arm => arm.plain).map(arm => ({ name: `${arm.label}: the prompt of the session that edits its instructions`, text: builderPrompt }));
  if (writer?.code && teaching) {
    const own = sample(teaching);
    if (own === null) errors.push(`The correction has no exhibit: Method shows the feedback writer ${writerName}'s words on a sample output. Add samples: {${teaching}: FILE}, an output of ${nameOf(doc, teaching)} made by code.`);
    else {
      const one = input(teaching), outputName = one.deliverable ? basename(one.deliverable) : 'output.md';
      const written = await feedbackWriting.write({ name: writerName!, hash: '', code: resolve(root, writer.code), expected: expectedValue(root, doc.expected![teaching]!), work: tmpdir() },
        { input: { id: teaching, value: one.value }, task: taskPrompt(one.value, one.deliverable), output: own, outputName });
      const words = written.correction === null ? (checkedAll(written) ? null : `No feedback (the writer checked ${written.checked} and found nothing wrong).`) : written.correction;
      see.push({ id: 'correction', title: 'One correction, exactly as each agent gets it', caption: `The feedback writer ${writerName} (${basename(writer.code)}) run on a sample output made by code, not by an agent (${samples[teaching]}), for ${nameOf(doc, teaching)}.`,
        blocks: [{ name: `The sample output (${outputName}), made by code`, text: cut(own) }, { name: `What ${basename(writer.code)} printed`, text: JSON.stringify(written) }, ...delivery(words), ...builders] });
    }
  } else if (writer?.judge) {
    const { feedbackPrompt } = await import('./compare.js');
    see.push({ id: 'correction', title: 'How each correction is written', caption: `One Claude judge writes each correction at run time from the agent's own output; the trial shows the real words each agent received.`,
      blocks: [{ name: 'The judge\'s prompt', text: feedbackPrompt }, { name: 'instruction.md (the writer\'s instruction)', text: writer.judge }, ...builders] });
  } else if (fixed?.correction) {
    see.push({ id: 'correction', title: 'One correction, exactly as each agent gets it', caption: `The words of correction 1 as the file gives them, on ${nameOf(doc, fixed.input!)}.`, blocks: [...delivery(fixed.correction), ...builders] });
  }

  // The handed-in output's form, from the sample.
  const outputSample = sample(checking) ?? sample(teaching);
  const outputFrom = sample(checking) !== null ? checking : teaching;
  if (outputSample !== null && outputFrom) {
    const one = input(outputFrom);
    see.push({ id: 'output', title: `What an agent hands in${one.deliverable ? `: ${basename(one.deliverable)}` : ''}`, caption: `A sample output made by code, not by an agent (${samples[outputFrom]}), for ${nameOf(doc, outputFrom)}. The trial replaces it with each agent's own.`,
      blocks: [{ name: one.deliverable ?? 'output', text: cut(outputSample) }] });
  }

  // How a run is scored: the hidden answer, and each measure on the sample.
  const expectedFile = doc.expected?.[checking];
  if (expectedFile) scored.push({ id: 'hidden-answer', title: `The hidden answer for ${nameOf(doc, checking)}`, caption: `${expectedFile}, verbatim. No agent sees it; the measures${writer ? ' and the feedback writer' : ''} read it.`,
    blocks: [{ name: expectedFile, text: cut(readFileSync(resolve(root, expectedFile), 'utf8')) }] });
  const measures = [doc.measure, ...(doc.other_measures ?? [])];
  for (const m of measures) {
    const id = `scoring-${slug(m.name)}`;
    if (m.code) {
      const own = sample(checking);
      if (own === null) { errors.push(`The measure ${m.name} has no exhibit: Method shows its scoring on a sample output. Add samples: {${checking}: FILE}, an output of ${nameOf(doc, checking)} made by code.`); continue; }
      const stdin = measureStdin({ input: checking, result: own, run_dir: '', artifacts: '', probe: null }, expectedFile ? expectedValue(root, expectedFile) : null);
      const result = await runScript(resolve(root, m.code), stdin);
      scored.push({ id, title: `How “${m.name}” scores one output`, caption: `${basename(m.code)} run on the sample output for ${nameOf(doc, checking)} (made by code, not by an agent): what it reads on stdin (spaces added for reading) and what it printed.`,
        blocks: [{ name: `What ${basename(m.code)} reads`, text: cut(JSON.stringify(stdin, null, 2)) }, { name: `What ${basename(m.code)} printed`, text: cut(result.stdout || result.stderr) }] });
    } else if (m.rubric || m.checklist) {
      const { judgePrompt } = await import('./compare.js');
      const items = m.rubric ? m.rubric.map(line => `- ${line}`).join('\n') : expectedFile ? readFileSync(resolve(root, expectedFile), 'utf8') : '';
      scored.push({ id, title: `How “${m.name}” scores one output`, caption: 'One Claude judge reads this prompt, the handed-in file and every source the agent read, and marks each item met, partly or not met.',
        blocks: [{ name: m.rubric ? 'The rubric' : `checklist.json comes from ${expectedFile}`, text: cut(items) }, { name: 'The judge\'s prompt', text: judgePrompt }] });
    } else if (m.person) scored.push({ id, title: `How “${m.name}” scores one output`, caption: 'A person reads each output, without the agent\'s name, and answers this question with a number.', blocks: [{ name: 'The question', text: m.person }] });
  }

  // The labels: Method's own words, then the writer's.
  const labels: Record<string, string> = {};
  const has = (id: string) => [...see, ...scored].some(e => e.id === id);
  // A file's path names its block in the checking input's folder first, else in the teaching input's.
  const anchors = new Map<string, string>();
  for (const e of [...see.filter(x => x.id.startsWith('files-checking')), ...see, ...scored]) for (const b of e.blocks) if (b.anchor && !anchors.has(b.name)) anchors.set(b.name, b.anchor);
  const builtIn: Array<[string, string]> = [['correction', 'correction'], ['feedback writer', 'correction'], ['hidden answer', 'hidden-answer'], ['expected answer', 'hidden-answer'],
    ...(doc.deliverable ? [[basename(doc.deliverable), 'output'] as [string, string]] : []), ...(doc.about_inputs?.noun ? [[doc.about_inputs.noun, 'files-checking'] as [string, string]] : []),
    ...measures.map(m => [m.name, `scoring-${slug(m.name)}`] as [string, string])];
  for (const [word, id] of builtIn) if (has(id)) labels[word] = id;
  const firstPrompt = see.find(e => e.id.startsWith('prompt-'))?.id;
  const named: Record<string, string | undefined> = { prompt: firstPrompt, files: see.find(e => e.id.startsWith('files-checking'))?.id, correction: has('correction') ? 'correction' : undefined,
    'hidden answer': has('hidden-answer') ? 'hidden-answer' : undefined, output: has('output') ? 'output' : undefined,
    ...Object.fromEntries(measures.map(m => [m.name, has(`scoring-${slug(m.name)}`) ? `scoring-${slug(m.name)}` : undefined])) };
  for (const [word, target] of Object.entries(doc.labels ?? {})) {
    const id = named[target] ?? anchors.get(target);
    if (id) labels[word] = id;
    else errors.push(`labels: “${word}” points to ${target}, which no exhibit shows. Use prompt, files, correction, hidden answer, output, a measure's name, or the path of a file in the files exhibit (${[...anchors.keys()].slice(0, 6).join(', ')}).`);
  }
  return { exhibits: { see, scored, labels }, errors, review: unlabeled(doc, labels) };
}

/** Each step prompt of a Method at the start, filled with the input's values where the step reads them. */
async function methodPrompts(file: string, value: unknown, name: string): Promise<Block[]> {
  const { renderPrompt } = await import('@withmethod/runtime/prompt.js');
  const document: any = readDocument(file), out: Block[] = [];
  for (const [stepId, step] of Object.entries(document.steps ?? {}) as Array<[string, any]>) {
    for (const exec of [step.do, step.check]) {
      if (!exec || typeof exec.prompt !== 'string' || !['session', 'agent', 'call'].includes(exec.kind)) continue;
      const bindings: Record<string, unknown> = {};
      for (const [key, ref] of Object.entries(step.in ?? {})) if (typeof ref === 'string' && ref.startsWith('inputs.') && value && typeof value === 'object') bindings[key] = (value as any)[ref.slice('inputs.'.length)];
      let text: string;
      try { text = renderPrompt(exec.prompt, bindings); } catch { text = exec.prompt; }
      out.push({ name: `Step ${step.name ?? stepId}${exec === step.check ? ' (its check)' : ''}, on ${name}`, text: cut(text) });
    }
  }
  return out;
}

/**
 * The label words that the writer's texts use and no label links: a quoted phrase of up to four words, a word in
 * capitals (NDA), or a file name (decision.json). Simple and the same every time: no model.
 */
export function unlabeled(doc: Comparison, labels: Record<string, string>): string[] {
  const texts = [doc.question, doc.difference, ...(doc.other_differences ?? []), doc.about_inputs?.description, doc.about_inputs?.teaching_description,
    ...[doc.measure, ...(doc.other_measures ?? [])].map(m => m.description),
    ...(doc.assumptions ?? []).flatMap(a => typeof a === 'string' ? [a] : [a.text, a.if_false, a.check]),
    ...Object.values(doc.notes ?? {}).flat()].filter((t): t is string => typeof t === 'string');
  const known = Object.keys(labels).map(word => word.toLowerCase());
  const covered = (word: string) => known.some(k => { const w = word.toLowerCase(); return w === k || w === `${k}s` || `${w}s` === k || w.includes(k); });
  const found = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(/["“]([^"”]{1,60})["”]/g)) if (m[1]!.trim().split(/\s+/).length <= 4) found.add(m[1]!.trim());
    for (const m of text.matchAll(/\b[A-Z]{2,}s?\b(?!\.\w)/g)) found.add(m[0]);
    for (const m of text.matchAll(/\b[\w-]+\.(?:json|md|txt|csv|py|mjs|js|yaml|method)\b/g)) found.add(m[0]);
  }
  return [...found].filter(word => !covered(word)).sort();
}

/**
 * The exhibits from the trial, for each arm: the words that its first copy received for its first correction with
 * what it handed in, and what it handed in on its first checking input with how that run was scored.
 */
export function trialExamples(plan: any, runs: any[], grades: any[], treated: any[] | null): Exhibit[] {
  const out: Exhibit[] = [];
  const name = (id: string) => plan.names?.[id] ?? id.replace(/^.*[/\\]/, '').replace(/\.[a-z0-9]+$/i, '');
  for (const arm of plan.arms) {
    const learner = treated?.find(t => t.arm === arm.name)?.learners?.[0];
    // The words it received: the record's, or a fixed correction's own words.
    const corrections = (learner?.events ?? []).filter((e: any) => e.kind === 'correction' && e.received)
      .map((e: any) => ({ ...e, text: e.text ?? plan.events?.find((x: any) => x.index === e.index)?.text })).filter((e: any) => typeof e.text === 'string');
    const event = corrections.find((e: any) => !['was_right', 'no_feedback'].includes(e.outcome)) ?? corrections[0];
    if (event) {
      const how = arm.project ? 'message 2 of the same chat' : arm.plain ? 'correction.md of the session that edits its instructions' : event.text === 'right' ? 'method judge RUN right' : 'method judge RUN wrong --note';
      out.push({ id: `correction-${slug(arm.name)}`, replaces: 'correction', arm: arm.name, title: `${arm.label}: the correction it received in the trial`,
        caption: `Copy 1, event ${event.index}, on ${name(event.input)}: what it handed in, and the words it got back (${how}).`,
        blocks: [...(typeof event.output === 'string' ? [{ name: `What it handed in${plan.events?.[event.index - 1]?.input?.deliverable ? ` (${basename(plan.events[event.index - 1].input.deliverable)})` : ''}`, text: cut(event.output) }] : []),
          { name: 'The words it received', text: event.text === 'right' ? '(no words: the run is judged right)' : cut(event.text) }] });
    }
    const own = runs.filter(r => r.arm === arm.name && r.repeat === 0);
    const run = own.find(r => r.input === plan.inputs[0]?.id) ?? own[0];
    if (!run) continue;
    out.push({ id: `output-${slug(arm.name)}`, replaces: 'output', arm: arm.name, title: `${arm.label}: what it handed in, in the trial`, caption: `Copy 1 at the start, on ${name(run.input)}.`,
      blocks: [{ name: run.deliverable ?? 'output', text: run.result === null || run.result === undefined ? '(nothing handed in)' : cut(outputText(run.result)) }] });
    const grade = grades.find(g => g.target === run.key) ?? grades.find(g => g.arm === arm.name && g.repeat === 0 && g.input === run.input && g.checkpoint === run.checkpoint);
    if (!grade) continue;
    const blocks: Block[] = plan.measures.flatMap((m: any) => grade.printed?.[m.name] !== undefined ? [{ name: `What ${basename(m.code.path)} printed (${m.name})`, text: cut(grade.printed[m.name]) }]
      : (grade.verdicts ?? []).length && (m.rubric || m.checklist) ? [{ name: `The judge's verdicts (${m.name})`, text: cut(JSON.stringify(grade.verdicts, null, 2)) }] : []);
    if (blocks.length) out.push({ id: `scoring-${slug(arm.name)}`, arm: arm.name, title: `${arm.label}: how that run was scored`, caption: `The measures on the output above, against the hidden answer of ${name(run.input)}.`, blocks });
  }
  return out;
}

/**
 * The arms of a comparison file as their exhibits need them, without copying anything: a Method arm's bound folders on
 * this computer, a plain arm's (the Method arms'), and a project's start folder.
 */
export async function armSources(doc: Comparison, root: string): Promise<ArmSource[]> {
  const { armLabels, armIsMethod, armIsPlain, armIsProject } = await import('./compare.js');
  const { localSetup } = await import('./local-setup.js');
  const { loadWorkflow } = await import('../../workflow-language/src/validate.js');
  const { methodContent } = await import('./versions.js');
  const labels = armLabels(doc, root), out: ArmSource[] = [];
  for (const [armName, arm] of Object.entries(doc.arms)) {
    if (!armIsMethod(arm)) continue;
    const file = resolve(root, arm), workflow: any = loadWorkflow(methodContent(readDocument(file)));
    const environment = (await localSetup(file, {})).config.environment ?? {};
    const folders: Record<string, string> = {};
    for (const [envName, definition] of Object.entries(workflow.environment ?? {}) as Array<[string, any]>) {
      const bound = environment[envName];
      if (definition.type === 'files' && typeof bound === 'string' && existsSync(bound)) folders[envName] = bound;
    }
    out.push({ name: armName, label: labels[armName]!, file, folders });
  }
  const shared = Object.assign({}, ...out.map(a => a.folders));
  for (const [armName, arm] of Object.entries(doc.arms)) {
    if (armIsPlain(arm)) out.push({ name: armName, label: labels[armName]!, folders: shared, plain: { agent: arm.agent, instructions: readFileSync(resolve(root, arm.instructions), 'utf8') } });
    if (armIsProject(arm)) {
      const start = arm.files ? resolve(root, arm.files) : join(tmpdir(), 'method-no-files');
      out.push({ name: armName, label: labels[armName]!, folders: {}, project: { message: readFileSync(resolve(root, doc.message!), 'utf8'), first_message: doc.first_message ? readFileSync(resolve(root, doc.first_message), 'utf8') : null, start } });
    }
  }
  const order = Object.keys(doc.arms);
  return out.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
}
