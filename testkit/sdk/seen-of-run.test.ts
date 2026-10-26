import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seenOfRun } from '../../packages/sdk/src/improve.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('what a person saw of a run leaves out the runtime\'s own records of each agent attempt', () => {
  const artifacts = mkdtempSync(join(tmpdir(), 'method-seen-'));
  roots.push(artifacts);
  const write = (path: string, text: string) => { mkdirSync(join(artifacts, path, '..'), { recursive: true }); writeFileSync(join(artifacts, path), text); };
  write('memo.md', 'The memo');
  for (const record of ['prompt.md', 'events.jsonl', 'transcript.jsonl', 'stderr.log']) write(`claude/attempt-a/${record}`, 'record');
  write('session/attempt-b/transcript.jsonl', 'record');
  write('session/attempt-b/last-message.txt', 'record');
  write('session/attempt-b/room/notes.md', 'Notes the session wrote');
  const refs = seenOfRun({ result: 'Done', artifacts }).map(seen => seen.ref);
  expect(refs.sort()).toEqual(['file:memo.md', 'file:session/attempt-b/room/notes.md', 'result']);
});
