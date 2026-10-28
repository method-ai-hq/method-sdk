import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
};
type Person = keyof typeof people;

/** A fake Method server: who each credential belongs to, which Methods each workspace owns, and every request. */
function fakeServer() {
  const holders = new Map<string, Person>(), revoked = new Set<string>(), calls: Array<{ path: string; method: string; person: Person | undefined }> = [];
  const owned: Record<string, Person> = {};
  let approver: Person = 'ryan', pending = '';
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const path = url.slice(server.length), method = init.method ?? 'GET';
    const token = String((init.headers as any)?.authorization ?? '').replace(/^Bearer /, '');
    const person = token && !revoked.has(sha256(token)) ? holders.get(sha256(token)) : undefined;
    calls.push({ path, method, person });
    if (path === '/auth/cli/start') { pending = JSON.parse(String(init.body)).token_hash; return json({ poll_secret: 'p', code: 'ABCDEF123456', expires_at: Date.now() + 60_000, verification_url: `${server}/auth/cli/authorize?code=ABCDEF123456` }); }
    if (path === '/auth/cli/poll') { holders.set(pending, approver); return json({ status: 'approved' }); }
    if (!person) return json({ error: 'unauthorized' }, 401);
    if (path === '/api/cli/me') { const p = people[person]; return json({ user: { id: p.id, name: p.name, email: p.email, organization_id: p.organization_id }, organization: { name: p.workspace, keep_run_content_on_devices: false } }); }
    if (path === '/api/cli/logout') { revoked.add(sha256(token)); return json({ ok: true }); }
    const id = /^\/api\/cli\/methods\/([^/?]+)/.exec(path)?.[1];
    if (id && method === 'GET') return owned[id] === person ? json({ workflow_id: id, version_id: 'v1', version_number: 1, workflow: {} }) : json({ message: 'Not found.' }, 404);
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
  expect(s.saved().accounts.map((a: any) => a.key)).toEqual(['user_shared', 'user_ryan']);
  expect(s.said()).toContain('The current account is Ryan (ryan+shared@example.test), workspace Shared with Ada. Also signed in: Ryan (ryan@example.test), workspace Main.');
  // The main account again: its credential is replaced (the old one no longer works), its Methods stay its own.
  const before = s.saved().accounts[1];
  s.client('user_ryan').remember('wf_' + '1'.repeat(32));
  s.fake.approve('ryan');
  await s.client().login(noBrowser);
  const [main, shared] = s.saved().accounts;
  expect([main.key, shared.key]).toEqual(['user_ryan', 'user_shared']);
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
  expect(s.saved().accounts.find((a: any) => a.key === 'user_ryan').ids).toEqual([mine]);
  // Remembered: the next command asks nobody first, and uses the main account.
  delete process.env.METHOD_ACCOUNT; s.fake.calls.length = 0;
  await methodMain(['get', mine], () => s.client());
  expect(s.fake.calls.map(c => c.person)).toEqual(['ryan']);
  // A Method file with an id: line uses its owner too; a file with a new ID uses the current account.
  const folder = mkdtempSync(join(tmpdir(), 'method-accounts-file-')); dirs.push(folder);
  writeFileSync(join(folder, 'theirs.method'), `id: ${theirs}\nname: Theirs\n`);
  expect(process.env.METHOD_ACCOUNT).toBe('user_ryan');
  await methodMain(['steps', join(folder, 'theirs.method')], () => s.client()).catch(() => {});
  expect(process.env.METHOD_ACCOUNT).toBe('user_shared');
  expect(s.client().token()).toBe(s.saved().accounts[0].token);
  delete process.env.METHOD_ACCOUNT;
  await s.client().route('wf_' + 'c'.repeat(32));
  expect(process.env.METHOD_ACCOUNT).toBeUndefined();
  expect(s.client().account()?.key).toBe('user_shared');
  // While a command of the main account runs, every client of this process (and of the processes it starts) uses it.
  await s.client().route(mine);
  expect(process.env.METHOD_ACCOUNT).toBe('user_ryan');
  expect(s.client().account()?.key).toBe('user_ryan');
  expect(s.client().owner(theirs).account()?.key).toBe('user_shared');
}, 30_000);

it('what waits to be saved goes with the account that saved it, whichever account is current later', async () => {
  const s = setup();
  await s.client().login(noBrowser);
  s.fake.approve('shared');
  await s.client().login(noBrowser);
  const outbox = (key: string) => new Outbox(s.client(key), { write: () => {} });
  outbox('user_ryan').add({ kind: 'run', server, run_dir: join(s.root, 'run-main'), version_id: 'v1', pid: 1 });
  outbox('user_shared').add({ kind: 'run', server, run_dir: join(s.root, 'run-shared'), version_id: 'v2', pid: 1 });
  expect(outbox('user_ryan').items().map(i => i.kind === 'run' && i.run_dir)).toEqual([join(s.root, 'run-main')]);
  expect(outbox('user_shared').items().map(i => i.kind === 'run' && i.run_dir)).toEqual([join(s.root, 'run-shared')]);
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
  expect(s.saved().accounts.map((a: any) => a.key)).toEqual(['user_ryan']);
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
  const client = clientOf({ server, config_dir: s.root, account: 'user_ryan', cache_dir: s.root, comparison_id: 'cmp_' + 'd'.repeat(32), version_number: 1, stage: 'draft', url: '', spec_digest: '' });
  expect(client.account()?.key).toBe('user_ryan');
  // The processes it starts inherit the account.
  expect(process.env.METHOD_ACCOUNT).toBe('user_ryan');
  expect(new MethodClient(server, s.fake.fetcher, s.root).account()?.key).toBe('user_ryan');
}, 30_000);
