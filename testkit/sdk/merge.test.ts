import { expect, it } from 'vitest';
import { changedSteps, mergeFiles, mergeMethod } from '../../packages/sdk/src/merge.js';
import packageInfo from '../../packages/sdk/package.json' with { type: 'json' };

const step = (id: string, purpose: string) => ({ name: 'Echo', purpose, do: { kind: 'run', runtime: 'node', entrypoint: 'echo.mjs' }, out: { [`${id}_text`]: { type: 'text', description: 'The text.' } } });
const method = (steps: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ format: 'method/3.4', name: 'Echo', goal: 'Return a fixed text.', ...extra, steps, result: 'a_text' });

it('is exported as @method-ai-hq/sdk/merge', () => {
  expect((packageInfo.exports as any)['./merge']).toEqual({ types: './dist/packages/sdk/src/merge.d.ts', import: './dist/packages/sdk/src/merge.js', default: './dist/packages/sdk/src/merge.js' });
});

it('merges per step and per top-level key, or lists the conflicts', () => {
  const base = method({ a: step('a', 'A.'), b: step('b', 'B.') });
  // Only theirs changed a step: take it.
  expect(mergeMethod(base, base, method({ a: step('a', 'A2.'), b: step('b', 'B.') }))).toEqual({ clean: true, workflow: method({ a: step('a', 'A2.'), b: step('b', 'B.') }) });
  // Only ours changed: keep ours.
  const ours = method({ a: step('a', 'A.'), b: step('b', 'B ours.') });
  expect(mergeMethod(base, ours, base)).toEqual({ clean: true, workflow: ours });
  // Different steps on each side: both changes, in the order of ours; a new step of theirs goes after its neighbour.
  const theirs = { ...method({ a: step('a', 'A2.'), n: step('n', 'New.'), b: step('b', 'B.') }), goal: 'A better goal.' };
  const merged = mergeMethod(base, ours, theirs) as any;
  expect(merged.clean).toBe(true);
  expect(Object.keys(merged.workflow.steps)).toEqual(['a', 'n', 'b']);
  expect(merged.workflow.steps.a.purpose).toBe('A2.'); expect(merged.workflow.steps.b.purpose).toBe('B ours.');
  expect(merged.workflow.goal).toBe('A better goal.');
  expect(changedSteps(base, merged.workflow)).toEqual(['a', 'b', 'n']);
  // A step removed by theirs and unchanged in ours goes.
  expect((mergeMethod(base, { ...base, name: 'Ours' }, method({ a: step('a', 'A.') })) as any).workflow.steps).toEqual({ a: step('a', 'A.') });
  // The same step and the same top-level key changed in different ways: conflicts.
  const conflict = mergeMethod(base, { ...ours, name: 'Ours' }, { ...method({ a: step('a', 'A.'), b: step('b', 'B theirs.') }), name: 'Theirs' });
  expect(conflict).toMatchObject({ clean: false, conflicts: [
    { path: 'name', base: 'Echo', ours: 'Ours', theirs: 'Theirs' },
    { path: 'steps.b', base: step('b', 'B.'), ours: step('b', 'B ours.'), theirs: step('b', 'B theirs.') },
  ] });
  // The workflow keeps ours at each conflict, for a person who combined the texts after a stop.
  expect((conflict as any).workflow).toMatchObject({ name: 'Ours', steps: { b: step('b', 'B ours.') } });
  // With an empty base, steps on one side only are kept, and one step with two texts is a conflict.
  const fromNothing = mergeMethod({}, method({ a: step('a', 'A.'), o: step('o', 'Ours only.') }), method({ a: step('a', 'A.'), t: step('t', 'Theirs only.') })) as any;
  expect(Object.keys(fromNothing.workflow.steps).sort()).toEqual(['a', 'o', 't']);
  expect(mergeMethod({}, method({ a: step('a', 'A ours.') }), method({ a: step('a', 'A theirs.') }))).toMatchObject({ clean: false, conflicts: [{ path: 'steps.a', base: undefined }] });
});

it('merges package files by path and sha256', () => {
  const f = (path: string, sha256: string, size = 1) => ({ path, sha256, size });
  const base = [f('a.mjs', '1'), f('b.mjs', '2'), f('gone.mjs', '3')];
  // a changed by ours, b changed by theirs, c added by theirs, d added by ours, gone removed by theirs.
  const ours = [f('a.mjs', '1o'), f('b.mjs', '2'), f('d.mjs', '4'), f('gone.mjs', '3')];
  const theirs = [f('a.mjs', '1'), f('b.mjs', '2t', 9), f('c.mjs', '5')];
  expect(mergeFiles(base, ours, theirs)).toEqual({ clean: true, files: [f('a.mjs', '1o'), f('b.mjs', '2t', 9), f('c.mjs', '5'), f('d.mjs', '4')], conflicts: [] });
  // The same change on both sides is no conflict; two different changes of one file are.
  expect(mergeFiles(base, [f('a.mjs', 'x')], [f('a.mjs', 'x')]).files).toEqual([f('a.mjs', 'x')]);
  expect(mergeFiles(base, [f('a.mjs', 'ours')], [f('a.mjs', 'theirs')])).toEqual({ clean: false, files: [f('a.mjs', 'ours')], conflicts: [{ path: 'a.mjs' }] });
  // A file one side changed and the other removed is a conflict; with no base, one file added twice with two texts is too.
  expect(mergeFiles(base, [f('a.mjs', 'ours')], []).conflicts).toEqual([{ path: 'a.mjs' }]);
  expect(mergeFiles([], [f('new.mjs', 'o')], [f('new.mjs', 't')]).conflicts).toEqual([{ path: 'new.mjs' }]);
});
