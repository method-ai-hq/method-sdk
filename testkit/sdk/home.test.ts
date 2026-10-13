import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimHome, followAccount, homeKey, readHome, recordHome, writtenFiles } from '../../packages/sdk/src/home.js';
import { fileHash } from '../../packages/sdk/src/method-files.js';
import { packageDigest } from '../../packages/contracts/src/method-package.js';
import { readDocument } from '../../packages/sdk/src/authoring.js';

const server = 'https://method.test', id = `wf_${'b'.repeat(32)}`;
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
// Temporary folders never become a home while another one lives, so the "real" folders sit in the repository.
function folders() {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'method-home-'))), real = join(process.cwd(), '.test-homes', temp.split('/').pop()!);
  mkdirSync(real, { recursive: true }); roots.push(temp, real);
  vi.stubEnv('METHOD_CACHE_DIR', join(temp, 'cache'));
  return { temp, real };
}
const methodText = (name: string) => `format: method/3.4\nid: ${id}\nname: ${name}\ngoal: Echo.\nsteps:\n  echo:\n    name: Echo\n    purpose: Echo; changes nothing.\n    do: {kind: run, runtime: node, entrypoint: echo.mjs}\n    out: {text: {type: text, description: The text.}}\nresult: text\n`;
const write = (dir: string, name = 'Echo') => { mkdirSync(dir, { recursive: true }); const file = join(dir, 'echo.method'); writeFileSync(file, methodText(name)); writeFileSync(join(dir, 'echo.mjs'), 'console.log("{}")'); return file; };

it('saves come from one home file; a temporary copy or a second folder is refused while the home lives', () => {
  const { temp, real } = folders();
  const home = write(join(real, 'a')), copy = write(join(temp, 'copy')), other = write(join(real, 'b'));
  claimHome(server, id, home);
  expect(readHome(server, id)?.path).toBe(home);
  expect(() => claimHome(server, id, copy)).toThrow(`This Method is saved from ${home}.`);
  expect(() => claimHome(server, id, other)).toThrow(expect.objectContaining({ code: 'other_home' }));
  // The home moved or was deleted: the next folder takes over.
  rmSync(join(real, 'a'), { recursive: true });
  claimHome(server, id, other);
  expect(readHome(server, id)?.path).toBe(other);
});

it('a home file in JSON keeps its home', () => {
  const { temp, real } = folders();
  const dir = join(real, 'json'); mkdirSync(dir, { recursive: true });
  const home = join(dir, 'echo.method'); writeFileSync(home, JSON.stringify({ format: 'method/3.4', id, name: 'Echo' }));
  claimHome(server, id, home);
  expect(() => claimHome(server, id, write(join(temp, 'copy')))).toThrow(expect.objectContaining({ code: 'other_home' }));
});

it('a temporary home gives way to a real folder', () => {
  const { temp, real } = folders();
  const scratch = write(join(temp, 'scratch')), file = write(join(real, 'kept'));
  claimHome(server, id, scratch);
  claimHome(server, id, file);
  expect(readHome(server, id)?.path).toBe(file);
});

it('every checkout of one Git repository shares the home', () => {
  const { real } = folders();
  mkdirSync(join(real, 'main', '.git', 'worktrees', 'side'), { recursive: true });
  mkdirSync(join(real, 'side'), { recursive: true });
  writeFileSync(join(real, 'side', '.git'), `gitdir: ${join(real, 'main', '.git', 'worktrees', 'side')}\n`);
  const main = write(join(real, 'main', 'methods')), side = write(join(real, 'side', 'methods'));
  expect(homeKey(side)).toBe(homeKey(main));
  claimHome(server, id, main);
  expect(() => claimHome(server, id, side)).not.toThrow();
});

/** A server whose latest version renames the Method and changes its script. */
function account(dir: string) {
  const script = new TextEncoder().encode('console.log("{\\"text\\":\\"new\\"}")');
  const workflow = { ...readDocument(join(dir, 'echo.method')), name: 'Echo again' }; delete workflow.id;
  const files = [{ path: 'echo.mjs', sha256: fileHash(script), size: script.length }];
  const pack = { schema: 'method-package/1', runtime: '0.12.0', files, digest: packageDigest(workflow, { runtime: '0.12.0', files }) };
  return { server, token: () => 'token', request: vi.fn(async () => ({ workflow_id: id, version_id: 'v_new', version_number: 7, workflow, package: pack })), transfer: vi.fn(async () => script) };
}

it('an unchanged home file takes the newer version from the account, with no output', async () => {
  const { real } = folders();
  const file = write(join(real, 'follow'));
  recordHome(server, id, file, { version_id: 'v_old', files: writtenFiles(file, [{ path: 'echo.mjs', sha256: fileHash(readFileSync(join(real, 'follow', 'echo.mjs'))) }]) });
  const client = account(join(real, 'follow'));
  expect(await followAccount(client, file)).toBe(true);
  expect(readDocument(file)).toMatchObject({ id, name: 'Echo again' });
  expect(readFileSync(join(real, 'follow', 'echo.mjs'), 'utf8')).toContain('new');
  expect(readHome(server, id)).toMatchObject({ version_id: 'v_new' });
  expect(await followAccount(client, file)).toBe(false);
});

it('a home file with the user\'s own change keeps it', async () => {
  const { real } = folders();
  const file = write(join(real, 'edited'));
  recordHome(server, id, file, { version_id: 'v_old', files: writtenFiles(file, []) });
  writeFileSync(file, methodText('Edited by the user'));
  const client = account(join(real, 'edited'));
  expect(await followAccount(client, file)).toBe(false);
  expect(client.request).not.toHaveBeenCalled();
  expect(readDocument(file).name).toBe('Edited by the user');
});
