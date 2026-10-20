import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { methodMain } from '../../packages/sdk/src/method.js';
import { recordChange, snapshot } from '../../packages/sdk/src/undo.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const METHOD_ID = 'wf_' + '2'.repeat(32);

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'method-learned-'))); roots.push(root);
  vi.stubEnv('METHOD_CACHE_DIR', join(root, 'cache')); vi.stubEnv('METHOD_CONFIG_DIR', join(root, 'config'));
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const folder = join(root, 'project'); mkdirSync(folder);
  const file = join(folder, 'nda.method');
  writeFileSync(join(folder, 'write.mjs'), 'console.log(JSON.stringify({reply: "ok"}));\n');
  writeFileSync(file, JSON.stringify({ format: 'method/3.4', id: METHOD_ID, name: 'NDA', goal: 'Review an NDA.',
    steps: { review: { name: 'Review', purpose: 'Reviews.', do: { kind: 'run', runtime: 'node', entrypoint: 'write.mjs' }, out: { reply: { type: 'text', description: 'The reply.' } } } }, result: 'reply' }, null, 2) + '\n');
  const printed = () => stdout.mock.calls.map(c => String(c[0])).join('');
  return { root, folder, file, stdout, printed };
}
const rule = (id: string, when: string | null, then: string, by: string | null, created: string) => ({ id, when, then, by, from: { judgment: `jdg_${id.slice(3)}`, case: `correction-${id.slice(3)}` }, status: 'active', created, retired_at: null, retired_reason: null });
/** A signed-in fake account that saves versions. */
const fakeClient = () => {
  let number = 3;
  return { server: 'https://example.test', token: () => 'method_x', calls: [] as any[],
    async request(path: string, verb = 'GET', body?: any) {
      this.calls.push({ path, verb, body });
      if (path === '/api/me') return { user: { name: 'Ryan' } };
      if (verb === 'POST' && path === '/api/cli/files/check') return { present: body.hashes };
      const saved = /^\/api\/cli\/methods\/[^/]+\/versions\/([^/]+)$/.exec(path);
      if (verb === 'PUT' && saved) return { version_id: saved[1], version_number: ++number };
      throw Object.assign(Error(`404: ${verb} ${path}`), { status: 404 });
    }, async transfer() { return Buffer.alloc(0); }, async login() {} } as any;
};

it('method learned lists the learned rules in plain words, who taught each, and how often it applied; --remove retires one and method undo brings it back', async () => {
  const s = setup(), client = fakeClient();
  writeFileSync(join(s.folder, 'learned.json'), JSON.stringify({ format: 'method-learned/1', steps: { review: [
    rule('lr_aaaaaaaaaaaa', 'the client is Acme', 'Accept five years.', 'Gráinne', '2026-10-12T09:00:00Z'),
    rule('lr_bbbbbbbbbbbb', null, 'Always attach the redlined NDA.', 'Ryan', '2026-10-14T09:00:00Z'),
    { ...rule('lr_cccccccccccc', null, 'Use British spelling.', null, '2026-10-01T09:00:00Z'), status: 'retired' },
  ] } }, null, 2));
  // Two runs of this Method on this computer applied the first rule; one applied the second too.
  for (const [n, applied] of [[1, ['lr_aaaaaaaaaaaa']], [2, ['lr_aaaaaaaaaaaa', 'lr_bbbbbbbbbbbb']]] as const) {
    const dir = join(s.root, 'cache', 'runs', `run-${n}`); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'checkpoint.json'), '{}'); writeFileSync(join(dir, 'method.json'), JSON.stringify({ id: METHOD_ID, name: 'NDA' }));
    writeFileSync(join(dir, 'events.jsonl'), [JSON.stringify({ event: 'run.started' }), JSON.stringify({ event: 'learned.applied', step: 'review', iteration: 0, considered: ['lr_aaaaaaaaaaaa', 'lr_bbbbbbbbbbbb'], applied })].join('\n') + '\n');
  }
  await methodMain(['learned', s.file], () => client);
  expect(s.printed()).toBe([
    'What this agent learned from corrections:',
    '1. When the client is Acme, accept five years. (Gráinne, 12 Oct; used 2 times)',
    '2. Always attach the redlined NDA. (Ryan, 14 Oct; used once)',
    'Remove one: method learned nda.method --remove NUMBER', ''].join('\n'));
  s.stdout.mockClear();
  await methodMain(['learned', s.file, '--remove', '2'], () => client);
  expect(s.printed()).toBe('Removed: "Always attach the redlined NDA". Undo: method undo.\n');
  const after = JSON.parse(readFileSync(join(s.folder, 'learned.json'), 'utf8')).steps.review[1];
  expect(after).toMatchObject({ id: 'lr_bbbbbbbbbbbb', status: 'retired', retired_reason: 'Removed by Ryan.' });
  expect(client.calls.filter((c: any) => c.verb === 'PUT').map((c: any) => c.body.reason)).toEqual(['Removed a learned rule: Always attach the redlined NDA.']);
  await expect(methodMain(['learned', s.file, '--remove', '7'], () => client)).rejects.toThrow('There is no learned rule 7');
  // Undo brings the rule back and saves that as a new version.
  s.stdout.mockClear();
  await methodMain(['undo', s.file], () => client);
  expect(s.printed()).toBe('Undone: the rule "Always attach the redlined NDA." is back. The agent works as it did before.\n');
  expect(JSON.parse(readFileSync(join(s.folder, 'learned.json'), 'utf8')).steps.review[1].status).toBe('active');
  expect(client.calls.filter((c: any) => c.verb === 'PUT')).toHaveLength(2);
  s.stdout.mockClear();
  await methodMain(['learned', s.file, '--json'], () => client);
  expect(JSON.parse(s.printed()).rules.map((r: any) => [r.id, r.step, r.applied])).toEqual([['lr_aaaaaaaaaaaa', 'review', 2], ['lr_bbbbbbbbbbbb', 'review', 1]]);
});

it('method undo restores the version before the last fix, file by file, and refuses when the file changed after it', async () => {
  const s = setup(), client = fakeClient();
  const before = readFileSync(s.file, 'utf8');
  writeFileSync(join(s.folder, 'write.mjs'), 'console.log("old");\n');
  // A fix changed the Method, a script, and added learned.json.
  const taken = snapshot(s.file, ['write.mjs', 'learned.json']);
  writeFileSync(s.file, before.replace('Reviews.', 'Reviews and redlines.'));
  writeFileSync(join(s.folder, 'write.mjs'), 'console.log("new");\n');
  writeFileSync(join(s.folder, 'learned.json'), '{"format":"method-learned/1","steps":{}}');
  recordChange(s.file, 'fix', 'The review did not redline.', 'the fix for "it\'s not even redlined"', taken);
  // A second, older change is undone by the next undo.
  await methodMain(['undo'], () => client);
  expect(s.printed()).toBe('Undone: the fix for "it\'s not even redlined". The agent works as it did before.\n');
  expect(readFileSync(s.file, 'utf8')).toBe(before);
  expect(readFileSync(join(s.folder, 'write.mjs'), 'utf8')).toBe('console.log("old");\n');
  expect(existsSync(join(s.folder, 'learned.json'))).toBe(false);
  expect(client.calls.filter((c: any) => c.verb === 'PUT').map((c: any) => c.body.reason)).toEqual(['Undid Method\'s change: The review did not redline.']);
  await expect(methodMain(['undo', s.file], () => client)).rejects.toThrow('nothing to undo');
  // A change after the fix is never overwritten.
  const again = snapshot(s.file, []);
  writeFileSync(s.file, before.replace('Reviews.', 'Reviews twice.'));
  recordChange(s.file, 'prune', 'Removed two rules.', 'the removal of 2 rules', again);
  writeFileSync(s.file, before.replace('Reviews.', 'Reviews by hand.'));
  await expect(methodMain(['undo', s.file], () => client)).rejects.toThrow('changed after Method\'s last change');
  expect(readFileSync(s.file, 'utf8')).toContain('Reviews by hand.');
});

it('a version upload leaves out every case snapshot (copies of what a run read) and keeps learned.json', async () => {
  const s = setup();
  const { buildPackage, caseFileNames } = await import('../../packages/sdk/src/method-files.js');
  const { readDocument } = await import('../../packages/sdk/src/authoring.js');
  const { methodContent } = await import('../../packages/sdk/src/versions.js');
  const caseDir = join(s.folder, 'cases', 'correction-aaaaaaaaaaaa');
  for (const sub of ['snapshot/run/room', 'snapshot/ext/0', 'snapshot/env/inbox', 'artifacts']) mkdirSync(join(caseDir, sub), { recursive: true });
  writeFileSync(join(caseDir, 'case.json'), '{}'); writeFileSync(join(caseDir, 'recording.json'), '{}'); writeFileSync(join(caseDir, 'artifacts', 'reply.md'), 'x');
  for (const name of ['snapshot/run/room/client-nda.docx', 'snapshot/ext/0/playbook.md', 'snapshot/env/inbox/mail.eml']) writeFileSync(join(caseDir, name), 'client document');
  // A folder named snapshot elsewhere is an ordinary file of the case.
  mkdirSync(join(caseDir, 'artifacts', 'snapshot')); writeFileSync(join(caseDir, 'artifacts', 'snapshot', 'a.txt'), 'x');
  writeFileSync(join(s.folder, 'learned.json'), JSON.stringify({ format: 'method-learned/1', steps: {} }));
  const names = caseFileNames(s.folder);
  expect(names.sort()).toEqual(['cases/correction-aaaaaaaaaaaa/artifacts/reply.md', 'cases/correction-aaaaaaaaaaaa/artifacts/snapshot/a.txt', 'cases/correction-aaaaaaaaaaaa/case.json', 'cases/correction-aaaaaaaaaaaa/recording.json']);
  const { pack } = await buildPackage(s.file, methodContent(readDocument(s.file)));
  const paths = pack.files.map(f => f.path);
  expect(paths.some(p => p.includes('/snapshot/run') || p.includes('/snapshot/ext') || p.includes('/snapshot/env'))).toBe(false);
  expect(paths).toContain('learned.json');
});
