import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanDiff, comparisonLiteral, copiedPassages, coreCode, itemWords, labelTable, placedPaths } from '../../packages/sdk/src/compare-literal.js';
import { comparisonGaps } from '../../packages/sdk/src/compare.js';

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'literal-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const write = (root: string, path: string, value: unknown) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value)); };

it('leaves Method\'s bookkeeping, the placed input folders, the deliverable and pure reformatting out of a diff', () => {
  const diff = [
    '--- .method/written.json', '+++ .method/written.json', '@@ -1 +1 @@', '-{}', '+{"a": 1}',
    '--- cases/correction-1/case.json', '+++ cases/correction-1/case.json', '@@ -0,0 +1 @@', '+{}',
    '--- docs/a.txt', '+++ docs/a.txt', '@@ -0,0 +1 @@', '+the input',
    '--- out.json', '+++ out.json', '@@ -0,0 +1 @@', '+{"answers": []}',
    '--- flow.method', '+++ flow.method', '@@ -1,3 +1,4 @@', '-  prompt: "Answer the question."', '+  prompt: |', '+    Answer the question.', '+  check: rule-7',
  ].join('\n');
  expect(cleanDiff(diff, ['docs', 'out.json'])).toBe(['--- flow.method', '+  check: rule-7'].join('\n'));
});

it('finds passages copied from teaching inputs, and none from text that is not in them', () => {
  const clause = 'The Recipient may disclose information that it lawfully obtained from a third party without any duty of confidentiality, provided that the third party had the right to disclose it and the Recipient keeps a written record of how it obtained it.';
  const learned = JSON.stringify({ rules: [{ text: clause, answer: 'yes' }, { text: 'a short rule', answer: 'no' }] });
  expect(copiedPassages(learned, [`Intro. ${clause} End.`])).toEqual([clause]);
  expect(copiedPassages('Answer yes when a clause lets the recipient get similar information from someone else.', [`Intro. ${clause} End.`])).toEqual([]);
});

it('reads a label table, the numbered items of a message, and the function a Python script calls', () => {
  expect(labelTable({ labels: { 1: 'yes', 2: 'no' }, evidence: { 1: ['It says so.'] } })).toEqual(new Map([['1', { label: 'yes', evidence: ['It says so.'] }], ['2', { label: 'no', evidence: [] }]]));
  expect(labelTable(['- an item'])).toBeNull();
  expect(itemWords('Questions:\n1. Is it signed?\n2. Is it dated?')).toEqual(new Map([['1', 'Is it signed?'], ['2', 'Is it dated?']]));
  const root = temp();
  write(root, 'writer.py', 'import helper\nprint(helper.write(1))\n');
  write(root, 'helper.py', 'X = 1\n\ndef write(n):\n    return n + 1\n\ndef other():\n    pass\n');
  expect(coreCode(join(root, 'writer.py')).map(a => a.name)).toEqual(['writer.py', 'helper.py: write()']);
  expect(coreCode(join(root, 'writer.py'))[1]!.text).toBe('def write(n):\n    return n + 1');
});

it('takes the placed paths from the comparison: each input folder\'s entries and the deliverable', () => {
  const root = temp();
  write(root, 'inputs/a/papers/x.txt', 'x');
  write(root, 'inputs/a.json', {});
  expect(placedPaths({ inputs: ['inputs/a.json'], deliverable: 'reply.md' }, id => id === 'inputs/a.json' ? join(root, 'inputs/a') : null).sort()).toEqual(['papers', 'reply.md']);
});

it('asks the file for who made the expected answers and where a written correction comes from', () => {
  const base: any = { question: 'q', arms: {}, difference: 'd', inputs: ['a'], measure: { name: 'm' }, rule: { margin: 0.1, min_runs: 1 }, runs: 1 };
  expect(comparisonGaps(base)).toEqual([]);
  expect(comparisonGaps({ ...base, expected: { a: 'e.json' } })[0]).toMatch(/labels_by/);
  expect(comparisonGaps({ ...base, expected: { a: 'e.json' }, about_inputs: { labels_by: 'Two clerks.' }, treatment: { events: [{ correction: 'Fix it.', input: 'a' }], checkpoints: [0, 1] } })[0]).toMatch(/correction 1 come from in source/);
});

/**
 * A small comparison with records: two project arms, two teaching inputs whose labels for item 2 differ, three new
 * inputs and one teaching input measured again. The plain arm gets item 2 wrong on more new inputs after its
 * corrections: that event is the one followed end to end, and the rise is a concern.
 */
it('makes the steps, the end-to-end event and the concerns from the files and records', async () => {
  const root = temp(), folder = join(root, '.compare', 'c');
  const nda = (n: number) => `Agreement ${n}. ${'The parties agree to keep each other\'s information secret and to use it only for the project. '.repeat(3)}`;
  for (const [id, n] of [['teaching/t1.json', 1], ['teaching/t2.json', 2], ['inputs/n1.json', 3], ['inputs/n2.json', 4], ['inputs/n3.json', 5], ['inputs/again.json', 1]] as const) {
    write(root, id, { document: `DOC_${n}.txt` });
    write(root, id.replace(/\.json$/, '/papers/DOC_' + n + '.txt'), nda(n));
  }
  write(root, 'expected/t1.json', { labels: { 1: 'yes', 2: 'not mentioned' }, evidence: { 1: ['keep secret'], 2: [] } });
  write(root, 'expected/t2.json', { labels: { 1: 'yes', 2: 'yes' }, evidence: { 1: ['keep secret'], 2: ['use it only'] } });
  write(root, 'writer.py', 'print("{}")\n');
  write(root, 'plain/AGENTS.md', 'Keep my corrections.');
  write(root, 'method/AGENTS.md', 'Use Method. See DOC_1 for an example.');
  const doc: any = {
    question: 'Does Method help?', arms: { plain: { project: 'codex', files: 'plain' }, method: { project: 'codex', plugins: ['method'], files: 'method' } }, difference: 'Method',
    inputs: ['inputs/n1.json', 'inputs/n2.json', 'inputs/n3.json', 'inputs/again.json'], teaching: ['teaching/t1.json', 'teaching/t2.json'], deliverable: 'answers.json',
    about_inputs: { noun: 'agreement', description: 'Three new agreements that no correction saw.', names: { 'teaching/t1.json': 'Agreement 1', 'teaching/t2.json': 'Agreement 2' } },
    measure: { name: 'answers right', code: 'measure.py' }, rule: { margin: 0.05, min_runs: 2, at: 2 }, runs: 1,
    treatment: { checkpoints: [0, 2], feedback_writers: { review: { code: 'writer.py' } }, events: [{ input: 'teaching/t1.json', feedback: 'review', source: 'From the labels.' }, { input: 'teaching/t2.json', feedback: 'review', source: 'From the labels.' }] },
    expected: { 'teaching/t1.json': 'expected/t1.json', 'teaching/t2.json': 'expected/t2.json' },
  };
  const project = (files: string, plugins: string[]) => ({ agent: 'codex', plugins, model: 'gpt-x', effort: null, web: false, deliverable: 'answers.json', message: 'Answer these about {{document}}:\n1. Is it secret?\n2. May it be shared?', first_message: null, start: join(root, files) });
  const plan: any = {
    file: join(root, 'c.compare'), folder, arms: [{ name: 'plain', label: 'Plain Codex', project: project('plain', []), hash: 'p' }, { name: 'method', label: 'Codex with Method', project: project('method', ['method']), hash: 'm' }],
    inputs: doc.inputs.map((id: string) => ({ id })), events: doc.treatment.events.map((e: any, i: number) => ({ index: i + 1, kind: 'correction', input: { id: e.input }, feedback: { name: 'review', expected: JSON.parse(JSON.stringify(e.input === 'teaching/t1.json' ? { labels: { 1: 'yes', 2: 'not mentioned' }, evidence: { 1: ['keep secret'], 2: [] } } : { labels: { 1: 'yes', 2: 'yes' }, evidence: { 1: ['keep secret'], 2: ['use it only'] } })) } })),
    checkpoints: [0, 2], redesign: null, user_files: [], learners: 1, rule: doc.rule, names: doc.about_inputs.names, feedback_hash: null,
    measures: [{ name: 'answers right', main: true, code: { path: join(root, 'measure.py'), hash: 'h' } }],
  };
  const item = (id: number, expected: string, given: string) => ({ question: id, expected, given, right: expected === given });
  const grade = (arm: string, input: string, checkpoint: number, items: any[]) => ({ arm, input, checkpoint, repeat: 0, printed: { 'answers right': JSON.stringify({ score: items.filter(i => i.right).length / items.length, items }) } });
  const grades = ['inputs/n1.json', 'inputs/n2.json', 'inputs/n3.json'].flatMap(input => [
    grade('plain', input, 0, [item(1, 'yes', 'yes'), item(2, 'yes', 'yes')]), grade('plain', input, 2, [item(1, 'yes', 'yes'), item(2, 'yes', 'not mentioned')]),
    grade('method', input, 0, [item(1, 'yes', 'yes'), item(2, 'yes', 'yes')]), grade('method', input, 2, [item(1, 'yes', 'yes'), item(2, 'yes', 'yes')]),
  ]);
  const event = (index: number, input: string, text: string, diff: string) => ({ index, kind: 'correction', input, received: true, outcome: 'edited', text, tokens: 1000 * index, duration_ms: 60_000, change: { diff } });
  const treated = [
    { arm: 'plain', learners: [{ learner: 0, events: [event(1, 'teaching/t1.json', 'Question 2 (Sharing) needs to be “not mentioned”, not “yes”.', '--- AGENTS.md\n+++ AGENTS.md\n@@ -1 +1,2 @@\n+Question 2: answer not mentioned.'), event(2, 'teaching/t2.json', 'Question 2 (Sharing) needs to be “yes”, not “not mentioned”.', '')] }] },
    { arm: 'method', learners: [{ learner: 0, events: [event(1, 'teaching/t1.json', 'Question 2 (Sharing) needs to be “not mentioned”, not “yes”.\nQuestion 1 needs to be “yes”.', ''), event(2, 'teaching/t2.json', 'That\'s right, thanks.', '')] }] },
  ];
  const literal = await comparisonLiteral(doc, root, plan, null, { treated, runs: [], grades });
  expect(literal.from).toBe('run');
  expect(literal.steps.map(s => s.title)).toEqual(['The question', 'The two arms', 'One event, step by step', 'The corrections', 'What is measured', 'Measures', 'The decision rule', 'Cost and copies']);
  expect(literal.steps[0]!.sentence).toBe('After 2 corrected agreements, is Codex with Method ahead of Plain Codex on “answers right” on 3 new agreements at checkpoint 2?');
  expect(literal.steps[1]!.sentence).toContain('AGENTS.md with the line “Keep my corrections”');
  expect(literal.counted.plain).toEqual([{ checkpoint: 0, right: 6, of: 6 }, { checkpoint: 2, right: 3, of: 6 }]);
  expect(literal.per_item!.items.find(i => i.id === '2')!.wrong.plain!.map(x => x.wrong)).toEqual([0, 3]);
  expect(literal.one_event!.sentence).toContain('Plain Codex got question 2 wrong on 0 new agreements at checkpoint 0 and on 3 at checkpoint 2');
  expect(literal.one_event!.parts.map(p => p.label)).toContain('Later corrections on question 2');
  const kinds = literal.concerns.map(c => c.kind);
  expect(kinds).toEqual(expect.arrayContaining(['claim', 'labels_by', 'corrections_by_code', 'overlap', 'worse_item', 'start_read', 'copies']));
  expect(literal.concerns.find(c => c.kind === 'worse_item')!.text).toContain('These corrections ask for different answers.');
  expect(literal.concerns.find(c => c.kind === 'claim')!.text).toContain('1 measured agreement has the same text as a teaching agreement');
  expect(literal.not_shown).toEqual([]);
});

it('says which parts do not apply when the measure prints no items and nothing ran', async () => {
  const root = temp();
  write(root, 'inputs/a.json', { x: 1 });
  write(root, 'start/AGENTS.md', 'Hello.');
  const doc: any = { question: 'q', arms: { a: { project: 'claude', files: 'start' }, b: { project: 'claude', files: 'start' } }, difference: 'd', inputs: ['inputs/a.json'], measure: { name: 'score' }, rule: { margin: 0.1, min_runs: 1 }, runs: 2 };
  const project = { agent: 'claude', plugins: [], model: 'm', effort: null, web: false, deliverable: 'out.md', message: 'Do {{x}}.', first_message: null, start: join(root, 'start') };
  const plan: any = { file: join(root, 'c.compare'), folder: join(root, '.compare/c'), arms: [{ name: 'a', label: 'A', project }, { name: 'b', label: 'B', project }], inputs: [{ id: 'inputs/a.json' }], events: [], checkpoints: null, redesign: null, user_files: [], learners: 2, rule: doc.rule, names: {}, measures: [{ name: 'score', main: true, person: 'Good?' }] };
  const design = await comparisonLiteral(doc, root, plan, null, null);
  expect(design.from).toBe('design');
  expect(design.steps[0]!.sentence).toBe('Which of the two arms (A and B) is ahead on “score” on the same 1 input?');
  expect(design.steps[2]!.title).toBe('One run, step by step');
  expect(design.steps[3]!.used).toBe(false);
  expect(design.not_shown[0]).toMatch(/has not run yet/);
  const ran = await comparisonLiteral(doc, root, plan, null, { treated: null, runs: [], grades: [{ arm: 'a', input: 'inputs/a.json', checkpoint: null, repeat: 0, printed: { score: '{"score": 1}' } }] });
  expect(ran.per_item).toBeNull();
  expect(ran.not_shown[0]).toMatch(/does not print its items/);
});
