import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addedLines, checkCopies, checkInputs, inputLookups, lookupFailure, plainText } from '../../packages/sdk/src/generalize.js';

// What makes a fix general, in code: a check tests what its correction says, and a change takes nothing from one input.

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

const NDA_147 = 'In the event that the Vendor requires the assistance of any third party other than employees of the Vendor, the Vendor shall first seek ISCA’s written approval of such third party. This Agreement is governed by the laws of Singapore and each party submits to the courts there.';
const NDA_183 = 'The Recipient may disclose Confidential Information to its advisers who need to know it. This Agreement is governed by the laws of Singapore and each party submits to the courts there.';

/** A cases folder with one check for each input: the NDA as a file in the case's snapshot of the matter folder. */
function cases(inputs: Record<string, [string, string]>) {
  const root = mkdtempSync(join(tmpdir(), 'method-generalize-')); roots.push(root);
  for (const [id, [name, text]] of Object.entries(inputs)) {
    mkdirSync(join(root, id, 'snapshot', 'env', 'matter'), { recursive: true });
    writeFileSync(join(root, id, 'snapshot', 'env', 'matter', name), text);
    writeFileSync(join(root, id, 'recording.json'), JSON.stringify({ inputs: {} }));
    writeFileSync(join(root, id, 'case.json'), JSON.stringify({ id, expect: [] }));
  }
  return root;
}

it('compares letters and digits only, so JSON escapes, quotes and line breaks do not hide copied text', () => {
  expect(plainText('ISCA’s “written\\napproval”,  of\nsuch')).toBe('isca s written approval of such');
});

it('finds a rule that copies the text or names the file of one input, and allows text that several inputs share', () => {
  const dir = cases({ 'correction-147': ['NDA_147.txt', NDA_147], 'correction-183': ['NDA_183.txt', NDA_183] });
  const inputs = checkInputs(dir);
  expect(inputs.map(i => [i.id, i.names])).toEqual([['correction-147', ['NDA_147.txt']], ['correction-183', ['NDA_183.txt']]]);
  // A rule of the old learner: the exact clause of NDA 147 with its label, as JSON.
  const rule = JSON.stringify({ question: 6, answer: 'no', evidence: NDA_147.slice(0, 190) });
  expect(inputLookups(rule, inputs)).toEqual([{ check: 'correction-147', kind: 'text', text: expect.stringContaining('vendor requires the assistance of any third party') }]);
  // A table of answers by file name, and the stem of a name with a number.
  expect(inputLookups('| NDA_183.txt | 6 | yes |', inputs)).toEqual([{ check: 'correction-183', kind: 'name', text: 'NDA_183.txt' }]);
  expect(inputLookups('if doc == "NDA 147": answer = "no"', inputs).map(l => l.kind)).toEqual(['name']);
  // The general rule names no input; the governing-law sentence is in both NDAs, so it is a general phrase.
  expect(inputLookups('When the NDA lets the receiver share with a third party only after written approval, question 6 is no.', inputs)).toEqual([]);
  expect(inputLookups('This Agreement is governed by the laws of Singapore and each party submits to the courts there.', inputs)).toEqual([]);
  // Less than 80 letters and digits of one input is not a copy.
  expect(inputLookups('the Vendor shall first seek ISCA’s written approval', inputs)).toEqual([]);
  expect(lookupFailure([{ path: 'rules.json', lookup: inputLookups(rule, inputs)[0]! }])).toMatch(/^rules\.json copies text of the input of the check correction-147 \(".+"\)\. A rule that applies to one input only is refused/);
});

it('a check that requires a copy of a whole result, or compares copied quotes, is refused; a parts check of labels is not', () => {
  const dir = cases({ 'correction-147': ['NDA_147.txt', NDA_147] });
  const inputs = checkInputs(dir), check = join(dir, 'correction-147');
  const write = (expect: unknown[]) => writeFileSync(join(check, 'case.json'), JSON.stringify({ id: 'correction-147', expect }));
  write([{ kind: 'equals', ref: 'outputs.checked', value: { answers: [{ question: 6, answer: 'no', quote: NDA_147 }] } }]);
  expect(checkCopies(check, inputs)).toEqual([expect.stringMatching(/^The check correction-147 requires outputs\.checked to equal a copy of a whole result\. Check what the correction says instead: a parts check/),
    expect.stringMatching(/compares text copied from the input/)]);
  write([{ kind: 'parts', ref: 'outputs.checked.answers', key: 'question', corrected: { 6: { answer: 'no' } }, kept: { 1: { answer: 'yes' } } }, { kind: 'equals', ref: 'outputs.route', value: 'legal' }]);
  expect(checkCopies(check, inputs)).toEqual([]);
});

it('the added text of a change is the lines that the file did not have', () => {
  expect(addedLines('a\nb\nc', 'a\nB\nc\nd')).toBe('B\nd');
});

it('reads only the Method\'s own files: a result that a chat saved in the folder is not a rule', async () => {
  const { changeLookups, methodPaths } = await import('../../packages/sdk/src/learner.js');
  const dir = cases({ 'correction-147': ['NDA_147.txt', NDA_147], 'correction-183': ['NDA_183.txt', NDA_183] });
  const inputs = checkInputs(dir);
  const base = mkdtempSync(join(tmpdir(), 'method-base-')), room = mkdtempSync(join(tmpdir(), 'method-room-')); roots.push(base, room);
  const copied = JSON.stringify({ answers: [{ question: 6, answer: 'no', quote: NDA_147.slice(0, 190) }] });
  for (const path of ['answers.json', 'rules/one.md', 'learned.json']) { mkdirSync(join(room, path, '..'), { recursive: true }); writeFileSync(join(room, path), copied); }
  const document = { files: ['rules/', 'check.py'] };
  const paths = (found: { path: string }[]) => [...new Set(found.map(f => f.path))].sort();
  // The handed-in answers.json is not a file of the Method; a listed folder and learned.json are.
  expect(paths(changeLookups(base, room, ['answers.json', 'rules/one.md', 'learned.json'], inputs, document))).toEqual(['learned.json', 'rules/one.md']);
  expect(methodPaths(document)('nda.method')).toBe(true);
  expect(methodPaths(document)('memo.md')).toBe(false);
  // Without the Method's document, every changed file is read, as before.
  expect(paths(changeLookups(base, room, ['answers.json'], inputs))).toEqual(['answers.json']);
});
