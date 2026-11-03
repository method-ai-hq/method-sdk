import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../../packages/contracts/src/identity.js';
import { MethodClient } from '../../packages/sdk/src/method-client.js';
import { methodMain } from '../../packages/sdk/src/method.js';
import { Outbox } from '../../packages/sdk/src/outbox.js';

// Several Method accounts on one computer: login adds or refreshes one and makes it current, status names them,
// commands use the account that owns their Method, and logout signs out of the current account only.
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); delete process.env.METHOD_ACCOUNT; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const server = 'https://example.test';
const people = {
  ryan: { id: 'user_ryan', name: 'Ryan', email: 'ryan@example.test', organization_id: 'org_main', workspace: 'Main' },
  shared: { id: 'user_shared', name: 'Ryan', email: 'ryan+shared@example.test', organization_id: 'org_shared', workspace: 'Shared with Ada' },
  // The same person as ryan, signed in to a second workspace of theirs.
  ryanLdgr: { id: 'user_ryan', name: 'Ryan', email: 'ryan@example.test', organization_id: 'org_ldgr', workspace: 'LDGR Systems' },
};
type Person = keyof typeof people;

/** A fake Method server: who each credential belongs to, which Methods each workspace owns, and every request. */
function fakeServer(server = 'https://example.test', onRequest: (path: string, method: string) => void = () => {}) {
  const holders = new Map<string, Person>(), revoked = new Set<string>(), calls: Array<{ path: string; method: string; person: Person | undefined }> = [];
  const owned: Record<string, Person> = {};
  let approver: Person = 'ryan', pending = '';
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const path = url.slice(server.length), method = init.method ?? 'GET';
    const token = String((init.headers as any)?.authorization ?? '').replace(/^Bearer /, '');
    const person = token && !revoked.has(sha256(token)) ? holders.get(sha256(token)) : undefined;
    calls.push({ path, method, person });
    onRequest(path, method);
    if (path === '/auth/cli/start') { pending = JSON.parse(String(init.body)).token_hash; return json({ poll_secret: 'p', code: 'ABCDEF123456', expires_at: Date.now() + 60_000, verification_url: `${server}/auth/cli/authorize?code=ABCDEF123456` }); }
    if (path === '/auth/cli/poll') { holders.set(pending, approver); return json({ status: 'approved' }); }
    if (!person) return json({ error: 'unauthorized' }, 401);
    if (path === '/api/cli/me') { const p = people[person]; return json({ user: { id: p.id, name: p.name, email: p.email, organization_id: p.organization_id }, organization: { name: p.workspace, keep_run_content_on_devices: false } }); }
    if (path === '/api/cli/logout') { revoked.add(sha256(token)); return json({ ok: true }); }
    if (/^\/api\/cli\/comparisons\/cmp_[a-f0-9]{32}\/versions\/1\/plan$/.test(path)) return json({ missing: JSON.parse(String(init.body)).cells.map((c: any) => c.key) });
    if (path === '/api/cli/files/check') return json({ present: JSON.parse(String(init.body)).hashes });
    // A Method ID belongs to the workspace that first saves a version of it.
    const version = /^\/api\/cli\/methods\/(wf_[a-f0-9]{32})\/versions\/(v_[a-f0-9]{32})$/.exec(path);
    if (version && method === 'PUT') {
      owned[version[1]!] ??= person;
      return owned[version[1]!] === person ? json({ version_id: version[2], version_number: 1, newest: true })
        : json({ message: 'This Method ID belongs to another account. Run method new-id FILE to save this file as a new Method.' }, 409);
    }
    const id = /^\/api\/cli\/methods\/([^/?]+)/.exec(path)?.[1];
    if (id && method === 'GET') return owned[id] === person ? json({ workflow_id: id, version_id: 'v1', version_number: 1, workflow: {} }) : json({ message: 'Not found.' }, 404);
    // A comparison is saved in the workspace of the account that first saves it; any other workspace does not find it.
    const comparison = /^\/api\/cli\/comparisons\/(cmp_[a-f0-9]{32})$/.exec(path)?.[1];
    if (comparison && method === 'PUT') {
      owned[comparison] ??= person;
      return owned[comparison] === person ? json({ comparison_id: comparison, version_number: 1, stage: 'draft', url: `${server}/comparisons/${comparison}?version=1` }) : json({ message: 'Comparison not found.' }, 404);
    }
    return json({ message: 'Not found.' }, 404);
  }) as unknown as typeof fetch;
  return { fetcher, calls, owned, holders, revoked, approve: (who: Person) => { approver = who; } };
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'method-accounts-')); dirs.push(root);
  const fake = fakeServer();
  const client = (key?: string) => new MethodClient(server, fake.fetcher, root, key);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const printed = () => stdout.mock.calls.map(c => String(c[0])).join('');
  const said = () => stderr.mock.calls.map(c => String(c[0])).join('');
  return { root, fake, client, printed, said, stdout, stderr, saved: () => JSON.parse(readFileSync(client().credentialFile, 'utf8')) };
}
const noBrowser = () => {};
const token = (letter: string) => 'method_' + letter.repeat(43);

it('keeps the single sign-in of an earlier CLI as the first account, with no action by the person', async () => {
  const s = setup();
  s.fake.holders.set(sha256(token('a')), 'ryan');
  writeFileSync(s.client().credentialFile, JSON.stringify({ server, token: token('a') }));
  expect(s.client().token()).toBe(token('a'));
  expect(s.saved()).toEqual({ server, accounts: [{ key: `t_${sha256(token('a')).slice(0, 16)}`, token: token('a'), ids: [], added_at: 0 }] });
  // status names it, and keeps the name for later.
  await methodMain(['status'], () => s.client());
  expect(JSON.parse(s.printed())).toEqual({ installed: true, server, signed_in: true, account: { person: 'Ryan', email: 'ryan@example.test', workspace: 'Main' } });
  expect(s.saved().accounts[0]).toMatchObject({ person: { id: 'user_ryan' }, workspace: { id: 'org_main', name: 'Main' } });
});

it('login always asks the browser: another account is added and becomes current, a known one is refreshed', async () => {
  const s = setup();
  await s.client().login(noBrowser);
  expect(s.said()).toContain('The current account is Ryan (ryan@example.test), workspace Main.');
  // Signed in already: login still opens the approval. The shared account is added and becomes current.
  s.fake.approve('shared');
  await s.client().login(noBrowser);
  expect(s.saved().accounts.map((a: any) => a.key)).toEqual(['user_shared:org_shared', 'user_ryan:org_main']);
  expect(s.said()).toContain('The current account is Ryan (ryan+shared@example.test), workspace Shared with Ada. Also signed in: Ryan (ryan@example.test), workspace Main.');
  // The main account again: its credential is replaced (the old one no longer works), its Methods stay its own.
  const before = s.saved().accounts[1];
  s.client('user_ryan:org_main').remember('wf_' + '1'.repeat(32));
  s.fake.approve('ryan');
  await s.client().login(noBrowser);
  const [main, shared] = s.saved().accounts;
  expect([main.key, shared.key]).toEqual(['user_ryan:org_main', 'user_shared:org_shared']);
  expect(main.token).not.toBe(before.token);
  expect(main.ids).toEqual(['wf_' + '1'.repeat(32)]);
  expect(s.fake.revoked.has(sha256(before.token))).toBe(true);

  // status: the current account by person and workspace, and the other one.
  s.stdout.mockClear();
  await methodMain(['status'], () => s.client());
  expect(JSON.parse(s.printed())).toEqual({ installed: true, server, signed_in: true, account: { person: 'Ryan', email: 'ryan@example.test', workspace: 'Main' },
    other_accounts: [{ person: 'Ryan', email: 'ryan+shared@example.test', workspace: 'Shared with Ada' }] });
}, 30_000);

it('a command uses the account that owns its Method, whichever account is current, and remembers the owner', async () => {
  const s = setup();
  await s.client().login(noBrowser);
  s.fake.approve('shared');
  await s.client().login(noBrowser);
  const mine = 'wf_' + 'a'.repeat(32), theirs = 'wf_' + 'b'.repeat(32);
  s.fake.owned[mine] = 'ryan'; s.fake.owned[theirs] = 'shared';
  // The shared account is current. A Method of the main account, with no record yet: each account asks once.
  s.fake.calls.length = 0;
  await methodMain(['get', mine], () => s.client());
  expect(s.fake.calls.filter(c => c.path === `/api/cli/methods/${mine}`).map(c => c.person).sort()).toEqual(['ryan', 'ryan', 'shared']);
  expect(JSON.parse(s.printed()).workflow_id).toBe(mine);
  expect(s.saved().accounts.find((a: any) => a.key === 'user_ryan:org_main').ids).toEqual([mine]);
  // Remembered: the next command asks nobody first, and uses the main account.
  delete process.env.METHOD_ACCOUNT; s.fake.calls.length = 0;
  await methodMain(['get', mine], () => s.client());
  expect(s.fake.calls.map(c => c.person)).toEqual(['ryan']);
  // A Method file with an id: line uses its owner too; a file with a new ID uses the current account.
  const folder = mkdtempSync(join(tmpdir(), 'method-accounts-file-')); dirs.push(folder);
  writeFileSync(join(folder, 'theirs.method'), `id: ${theirs}\nname: Theirs\n`);
  expect(process.env.METHOD_ACCOUNT).toBe('user_ryan:org_main');
  await methodMain(['steps', join(folder, 'theirs.method')], () => s.client()).catch(() => {});
  expect(process.env.METHOD_ACCOUNT).toBe('user_shared:org_shared');
  expect(s.client().token()).toBe(s.saved().accounts[0].token);
  delete process.env.METHOD_ACCOUNT;
  await s.client().route('wf_' + 'c'.repeat(32));
  expect(process.env.METHOD_ACCOUNT).toBeUndefined();
  expect(s.client().account()?.key).toBe('user_shared:org_shared');
  // While a command of the main account runs, every client of this process (and of the processes it starts) uses it.
  await s.client().route(mine);
  expect(process.env.METHOD_ACCOUNT).toBe('user_ryan:org_main');
  expect(s.client().account()?.key).toBe('user_ryan:org_main');
  expect(s.client().owner(theirs).account()?.key).toBe('user_shared:org_shared');
}, 30_000);

it('what waits to be saved goes with the account that saved it, whichever account is current later', async () => {
  const s = setup();
  await s.client().login(noBrowser);
  s.fake.approve('shared');
  await s.client().login(noBrowser);
  const outbox = (key: string) => new Outbox(s.client(key), { write: () => {} });
  outbox('user_ryan:org_main').add({ kind: 'run', server, run_dir: join(s.root, 'run-main'), version_id: 'v1', pid: 1 });
  outbox('user_shared:org_shared').add({ kind: 'run', server, run_dir: join(s.root, 'run-shared'), version_id: 'v2', pid: 1 });
  expect(outbox('user_ryan:org_main').items().map(i => i.kind === 'run' && i.run_dir)).toEqual([join(s.root, 'run-main')]);
  expect(outbox('user_shared:org_shared').items().map(i => i.kind === 'run' && i.run_dir)).toEqual([join(s.root, 'run-shared')]);
});

it('logout signs out of the current account only and says which account is current now', async () => {
  const s = setup();
  await s.client().login(noBrowser);
  s.fake.approve('shared');
  await s.client().login(noBrowser);
  const sharedToken = s.saved().accounts[0].token;
  await methodMain(['logout'], () => s.client());
  expect(s.printed()).toBe('Signed out of Ryan (ryan+shared@example.test), workspace Shared with Ada. The current account is now Ryan (ryan@example.test), workspace Main.\n');
  expect(s.fake.revoked.has(sha256(sharedToken))).toBe(true);
  expect(s.saved().accounts.map((a: any) => a.key)).toEqual(['user_ryan:org_main']);
  s.stdout.mockClear();
  await methodMain(['logout'], () => s.client());
  expect(s.printed()).toBe('Signed out of Ryan (ryan@example.test), workspace Main. No account is signed in now.\n');
  expect(s.client().token()).toBeNull();
}, 30_000);

it("a comparison's stages, arms and learners use the account that saved it, whichever account is current", async () => {
  const s = setup();
  await s.client().login(noBrowser);
  s.fake.approve('shared');
  await s.client().login(noBrowser);
  vi.stubEnv('METHOD_CONFIG_DIR', s.root);
  const { clientOf } = await import('../../packages/sdk/src/compare-account.js');
  const client = clientOf({ server, config_dir: s.root, account: 'user_ryan:org_main', cache_dir: s.root, comparison_id: 'cmp_' + 'd'.repeat(32), version_number: 1, stage: 'draft', url: '', spec_digest: '' });
  expect(client.account()?.key).toBe('user_ryan:org_main');
  // The processes it starts inherit the account.
  expect(process.env.METHOD_ACCOUNT).toBe('user_ryan:org_main');
  expect(new MethodClient(server, s.fake.fetcher, s.root).account()?.key).toBe('user_ryan:org_main');
}, 30_000);

it('a comparison saves with the account whose workspace has it and records that account, whichever account is current or becomes current', async () => {
  const root = mkdtempSync(join(tmpdir(), 'method-accounts-')); dirs.push(root);
  vi.stubEnv('METHOD_CONFIG_DIR', root);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const { DEFAULT_SERVER } = await import('../../packages/sdk/src/method-client.js');
  const { clientOf, readAccount, saveComparison } = await import('../../packages/sdk/src/compare-account.js');
  const client = () => new MethodClient(DEFAULT_SERVER, fake.fetcher, root);
  // Another session makes the shared account current while this save is on its way.
  const switchToShared = () => {
    const file = client().credentialFile, saved = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...saved, accounts: [...saved.accounts.filter((a: any) => a.key === 'user_shared:org_shared'), ...saved.accounts.filter((a: any) => a.key !== 'user_shared:org_shared')] }));
  };
  const fake = fakeServer(DEFAULT_SERVER, (path, method) => { if (method === 'PUT' && path.startsWith('/api/cli/comparisons/')) switchToShared(); });
  vi.stubGlobal('fetch', fake.fetcher);
  await client().login(noBrowser);
  fake.approve('shared');
  await client().login(noBrowser);
  const id = 'cmp_' + 'e'.repeat(32), folder = join(root, 'comparison');
  // Saved first while the main account was current; nothing remembers which account has it.
  fake.owned[id] = 'ryan';
  const account = await saveComparison(folder, id, 'Thirty corrections', { question: 'Which agent?' });
  expect(account?.account).toBe('user_ryan:org_main');
  expect(readAccount(folder)?.account).toBe('user_ryan:org_main');
  // The stages, which run as separate processes, report with the account that has the comparison.
  expect(clientOf(readAccount(folder)!).account()?.key).toBe('user_ryan:org_main');
  expect(JSON.parse(readFileSync(client().credentialFile, 'utf8')).accounts.find((a: any) => a.key === 'user_ryan:org_main').ids).toContain(id);
}, 30_000);

it('one person in two workspaces keeps an account for each, and login --workspace switches between them', async () => {
  const s = setup();
  s.fake.approve('ryan');
  await s.client().login(noBrowser);
  const opened: string[] = [];
  s.fake.approve('ryanLdgr');
  await s.client().login(url => opened.push(url), 'LDGR Systems');
  // The approval page opens with the workspace chosen; the first workspace's credential still works.
  expect(new URL(opened[0]!).searchParams.get('workspace')).toBe('LDGR Systems');
  expect(s.saved().accounts.map((a: any) => [a.key, a.workspace.name])).toEqual([['user_ryan:org_ldgr', 'LDGR Systems'], ['user_ryan:org_main', 'Main']]);
  expect(s.fake.calls.some(c => c.path === '/api/cli/logout')).toBe(false);
  // A workspace that this computer is signed in to becomes current with no browser.
  const starts = s.fake.calls.filter(c => c.path === '/auth/cli/start').length;
  await s.client().login(() => { throw Error('The browser must not open.'); }, 'main');
  expect(s.fake.calls.filter(c => c.path === '/auth/cli/start').length).toBe(starts);
  expect(s.client().account()?.key).toBe('user_ryan:org_main');
  expect(s.said()).toContain('The current account is Ryan (ryan@example.test), workspace Main.');
});

it("a comparison's Method file saves in the comparison's workspace: an ID that another workspace has becomes the ID this workspace uses for it, the same in every copy", async () => {
  const s = setup();
  vi.stubEnv('METHOD_CACHE_DIR', s.root);
  await s.client().login(noBrowser);
  s.fake.approve('shared');
  await s.client().login(noBrowser);
  const { prepareVersion } = await import('../../packages/sdk/src/versions.js');
  const { accountMethodId, saveInAccount } = await import('../../packages/sdk/src/compare.js');
  const { readDocument } = await import('../../packages/sdk/src/authoring.js');
  const old = 'wf_' + 'f'.repeat(32), main = 'user_ryan:org_main';
  const write = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'answer.mjs'), 'console.log(JSON.stringify({value:1}))');
    writeFileSync(join(dir, 'agent.method'), JSON.stringify({ format: 'method/3.4', id: old, name: 'Agent', goal: 'Answer.', steps: { answer: { do: { kind: 'run', runtime: 'node', entrypoint: 'answer.mjs' }, out: { value: { type: 'number' } } } }, result: 'value' }));
    return join(dir, 'agent.method');
  };
  // Saved last night while the shared account was current: the shared workspace has the Method, and this computer has its version.
  const first = write(join(s.root, 'arm')), shared = s.client('user_shared:org_shared'), outbox = new Outbox(shared, { write: () => {} });
  const saved = await prepareVersion(shared, outbox, first, 'Saved by a comparison.', { home: false });
  expect(await outbox.whenSaved(saved.version_id)).toBe(true);
  expect(s.fake.owned[old]).toBe('shared');
  // The comparison is in the main workspace. The version that the shared account saved is not saved there.
  const mine = await saveInAccount(s.client(main), main, first, false);
  expect(readDocument(first).id).toBe(accountMethodId(old, main));
  expect(mine.version.method_id).toBe(accountMethodId(old, main));
  expect(await mine.outbox.whenSaved(mine.version.version_id)).toBe(true);
  expect(s.fake.owned[accountMethodId(old, main)]).toBe('ryan');
  // A frozen copy of the same file, saved by another process, gets the same ID.
  const copy = write(join(s.root, 'after-8'));
  expect((await saveInAccount(s.client(main), main, copy, false)).version.method_id).toBe(accountMethodId(old, main));
}, 30_000);

it('a comparison report that got no answer is sent again, so the page gets it while the comparison runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'method-accounts-')); dirs.push(root);
  vi.stubEnv('METHOD_CONFIG_DIR', root);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const { DEFAULT_SERVER } = await import('../../packages/sdk/src/method-client.js');
  const { sendPlan } = await import('../../packages/sdk/src/compare-account.js');
  let drops = 2;
  const fake = fakeServer(DEFAULT_SERVER, (path, method) => { if (method === 'POST' && path.endsWith('/plan') && drops-- > 0) throw new TypeError('fetch failed'); });
  vi.stubGlobal('fetch', fake.fetcher);
  await new MethodClient(DEFAULT_SERVER, fake.fetcher, root).login(noBrowser);
  const folder = join(root, 'comparison');
  mkdirSync(folder);
  writeFileSync(join(folder, 'account.json'), JSON.stringify({ server: DEFAULT_SERVER, config_dir: root, account: 'user_ryan:org_main', cache_dir: root, comparison_id: 'cmp_' + 'a'.repeat(32), version_number: 1, stage: 'running', url: '', spec_digest: '' }));
  const missing = await sendPlan(folder, [{ key: 'k1', kind: 'run', arm: 'a', input: 'one', checkpoint: 0, repeat: 0, trial: true }]);
  expect(missing).toEqual(new Set(['k1']));
  expect(fake.calls.filter(c => c.path.endsWith('/plan'))).toHaveLength(3);
  expect(stderr.mock.calls.map(c => String(c[0])).join('')).not.toContain('did not get everything');
}, 30_000);
