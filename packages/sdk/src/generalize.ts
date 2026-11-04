import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

// What makes a fix general. A person corrected one input; the fix must work on the next input, not only on this one.
// Two tests here are in code and cost no model run:
// - A saved check tests what the correction says (checkCopies): not an exact copy of a whole result, and no quote
//   copied from the input. A parts check compares the corrected parts and the parts the person left, as labels.
// - A change does not look up one input (inputLookups): no added line holds 80 or more characters (letters and digits)
//   that are in the input of only one saved check, or the file name of a saved check's input. Text that is in the
//   inputs of two or more saved checks is a general phrase, not one input.
// The third test runs in the learner's gate (learner.ts): a rule for every input of the new check is judged on the
// inputs of earlier checks, which the change was not taught on.

/** The length of copied input text that a change may not hold, in letters and digits with single spaces. */
export const COPIED_CHARS = 80;
/** The longest text value that a check compares exactly; longer text is judged by a rubric. */
export const CHECK_TEXT_CHARS = 200;
const WINDOW = 60, STRIDE = COPIED_CHARS - WINDOW;
const MAX_FILE_BYTES = 2_000_000;

/** Text as the input test compares it: letters and digits, in lower case, with one space between words. */
export const plainText = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\\[nrt]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The input of one saved check: the text it read, and the file names of its input files. */
export type CheckInput = { id: string; texts: string[]; names: string[] };

/** The text files of a folder, at most 200, each at most MAX_FILE_BYTES. */
function textFiles(dir: string, found: string[] = []) {
  let entries: import('node:fs').Dirent[] = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (found.length >= 200) break;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) textFiles(path, found);
    else if (entry.isFile()) found.push(path);
  }
  return found;
}
const readText = (path: string) => {
  try {
    if (lstatSync(path).size > MAX_FILE_BYTES) return null;
    const bytes = readFileSync(path);
    return bytes.subarray(0, 8192).includes(0) ? null : bytes.toString('utf8');
  } catch { return null; }
};
const strings = (value: unknown, found: string[] = []): string[] => {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) value.forEach(v => strings(v, found));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => strings(v, found));
  return found;
};

/**
 * The inputs of the saved checks in a cases folder: the run's input values and the files it read from outside the run
 * (the case's snapshot/env and snapshot/ext copies). Not what the run wrote.
 */
export function checkInputs(casesDir: string): CheckInput[] {
  let ids: string[] = [];
  try { ids = readdirSync(casesDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(); } catch { return []; }
  return ids.flatMap(id => {
    const dir = join(casesDir, id);
    if (!existsSync(join(dir, 'case.json'))) return [];
    const texts: string[] = [], names = new Set<string>();
    try {
      const recording = JSON.parse(readFileSync(join(dir, 'recording.json'), 'utf8'));
      for (const value of strings(recording.inputs ?? {})) {
        if (value.length >= COPIED_CHARS) texts.push(value);
        if (/^\/.+\.[A-Za-z0-9]{1,8}$/.test(value) && !value.includes('\n')) names.add(basename(value));
      }
    } catch { /* a case without a recording has no input values */ }
    for (const folder of ['env', 'ext']) for (const path of textFiles(join(dir, 'snapshot', folder))) {
      names.add(basename(path));
      const text = readText(path);
      if (text !== null) texts.push(text);
    }
    return [{ id, texts: texts.map(plainText).filter(t => t.length >= WINDOW), names: [...names] }];
  });
}

/** A file name as a change could name it: the whole name, and its stem when the stem holds a digit (NDA_147). */
const nameForms = (name: string) => {
  const stem = name.replace(/\.[^.]+$/, '');
  return [...new Set([plainText(name), ...(/\d/.test(stem) && plainText(stem).length >= 3 ? [plainText(stem)] : [])])].filter(Boolean);
};

/** What a change takes from one input: copied text (an example, cut), or a file name. */
export type Lookup = { check: string; kind: 'text' | 'name'; text: string };

/**
 * The places where added text looks up one input: a run of COPIED_CHARS or more letters and digits that is in the
 * input of exactly one saved check, or the file name of a saved check's input. One finding for each check and kind.
 */
export function inputLookups(added: string, inputs: CheckInput[]): Lookup[] {
  const text = plainText(added), padded = ` ${text} `, found = new Map<string, Lookup>();
  for (const input of inputs) for (const name of input.names) {
    if (nameForms(name).some(form => padded.includes(` ${form} `)) && !found.has(`${input.id}:name`)) found.set(`${input.id}:name`, { check: input.id, kind: 'name', text: name });
  }
  // A run of COPIED_CHARS characters holds a whole window that starts at a multiple of STRIDE.
  for (let at = 0; at + WINDOW <= text.length; at += STRIDE) {
    const window = text.slice(at, at + WINDOW);
    const holders = inputs.filter(input => input.texts.some(t => t.includes(window)));
    if (holders.length !== 1) continue;
    const input = holders[0]!, key = `${input.id}:text`;
    if (found.has(key)) continue;
    // The whole run that the input holds, from this window on.
    let end = at + WINDOW;
    while (end < text.length && input.texts.some(t => t.includes(text.slice(at, end + 1)))) end++;
    if (end - at < COPIED_CHARS) continue;
    const from = at && text[at - 1] !== ' ' ? text.indexOf(' ', at) + 1 : at;
    found.set(key, { check: input.id, kind: 'text', text: text.slice(from, Math.min(end, from + 120)) + (end - from > 120 ? '…' : '') });
  }
  return [...found.values()];
}

/** The lines of after that before does not have: the text that a change added to one file. */
export function addedLines(before: string, after: string) {
  const had = new Set(before.split('\n'));
  return after.split('\n').filter(line => !had.has(line)).join('\n');
}

/**
 * What is wrong with a saved check of a correction: it copies a whole result (an equals check of a record, a list or a
 * long text), or a value or script of it holds text of its input. Each problem as a sentence for the learner.
 */
export function checkCopies(caseDir: string, inputs: CheckInput[]): string[] {
  let made: any;
  try { made = JSON.parse(readFileSync(join(caseDir, 'case.json'), 'utf8')); } catch { return []; }
  const id = basename(caseDir), problems: string[] = [];
  for (const item of Array.isArray(made.expect) ? made.expect : []) {
    if (item?.kind === 'equals' && (typeof item.value === 'object' && item.value !== null || typeof item.value === 'string' && item.value.length > CHECK_TEXT_CHARS))
      problems.push(`The check ${id} requires ${item.ref} to equal a copy of a whole result. Check what the correction says instead: a parts check ({"kind": "parts", "ref": ..., "key": ..., "corrected": {...}, "kept": {...}}) with the corrected parts and the parts that the person left, as labels, not quotes; or --rubric sentences.`);
  }
  const own = inputs.filter(input => input.id === id);
  const scripts = (Array.isArray(made.expect) ? made.expect : []).filter((item: any) => item?.kind === 'predicate' && typeof item.entrypoint === 'string').map((item: any) => readText(join(caseDir, item.entrypoint)) ?? '');
  const values = (Array.isArray(made.expect) ? made.expect : []).filter((item: any) => ['equals', 'parts'].includes(item?.kind)).map((item: any) => JSON.stringify(item));
  if (own.length && inputLookups([...scripts, ...values].join('\n'), own).some(l => l.kind === 'text'))
    problems.push(`The check ${id} compares text copied from the input. A later run may quote other words and still be right: compare the answers or labels that the correction gives, not quotes.`);
  return problems;
}

/** The failure for the learner (or a redesign) when a change looks up one input. */
export function lookupFailure(lookups: { path: string; lookup: Lookup }[]) {
  return lookups.slice(0, 6).map(({ path, lookup }) => lookup.kind === 'name'
    ? `${path} names the input file ${lookup.text} of the check ${lookup.check}. A rule that applies to one input only is refused: say what in any input decides the answer, not which input it is.`
    : `${path} copies text of the input of the check ${lookup.check} ("${lookup.text}"). A rule that applies to one input only is refused: write the general rule that the correction's reason gives, which also decides other inputs. Do not store an input's text, file name or answers.`).join('\n');
}
