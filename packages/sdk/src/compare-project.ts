/**
 * A project arm of a comparison: Claude Code or Codex used the way a person uses it. The arm's state is one project
 * folder and the agent's own memory. Each piece of work is a new chat in that folder: the first message is the task, the
 * agent works, and a second message in the same chat (resumed) may correct it. When the chat ends, only the project
 * folder and the agent's memory carry over: Claude Code's auto-memory for the folder, or what Codex keeps in its home
 * (its AGENTS.md and its memories folder); the project's own AGENTS.md or CLAUDE.md is in the folder.
 *
 * Every chat runs in a clean room: a fresh HOME with only the agent's sign-in and the learner's memory, the same model, effort and tools for
 * every arm, and no web unless the comparison tests the tools. The chat works in a copy of the project in a folder of
 * its own outside every repository and the comparison's folder, as a person's own project is: the agent reads no
 * instructions of the folders around the comparison (CLAUDE.md, AGENTS.md), and finds no hidden answers beside it. The
 * Method cache of a project with the Method plugin is copied beside it.
 * Other chats cannot be found from it: the folder that holds every project's folder, and each room, cannot be listed.
 * The account's cloud plugins, skills and connectors are not synced into the room. A project with the Method plugin also
 * gets the plugin (Claude Code loads it with --plugin-dir; Codex installs it from a local marketplace, as the Method
 * installer adds it, and runs its hooks as a person who trusted them) and the method CLI on PATH, signed in to the
 * comparison's Method account. A Method fix that a Codex chat starts runs on Codex, the agent that started it. A project
 * without the plugin has no plugin and no method command on PATH.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { removeTree } from './files.js';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { textDiff } from './text-diff.js';
import { readDocument } from './authoring.js';
import { methodIdPattern, newMethodId, writeMethodId } from './versions.js';

/** The agents that a project arm can be: Claude Code (as in the desktop app) or Codex (as in the Codex app). */
export const projectAgents = ['claude', 'codex'] as const;
export type ProjectAgent = (typeof projectAgents)[number];
/** An agent's name as people say it. */
export const agentName = (agent: ProjectAgent) => agent === 'claude' ? 'Claude Code' : 'Codex';
/** Where an agent's memory is, in the words of the page: "Claude memory", "Codex memory". */
export const memoryName = (agent: ProjectAgent) => agent === 'claude' ? 'Claude memory' : 'Codex memory';
/** The plugins that a project arm can have. method: Method's own plugin (its skill and hooks, and the method CLI). */
export const projectPlugins = ['method'] as const;
export type ProjectPlugin = (typeof projectPlugins)[number];
/** What a project arm gets when the feedback writer finds nothing wrong: the person says so, as people do. */
export const RIGHT_MESSAGE = 'That\'s right, thanks.';
/** The tools of every project chat: Claude Code's own tools, as the desktop app has them, without the web unless tested. */
const projectTools = ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'NotebookEdit', 'TodoWrite', 'Task', 'Skill'];
const webTools = ['WebSearch', 'WebFetch'];
/** The longest that one message of a chat, or the Method fixes that a chat started, may take. */
const MESSAGE_LIMIT_MS = 2 * 3_600_000;

/** The folder of Method's Claude Code plugin: beside the built package (dist/packages/sdk/plugins/method), or in the repository. */
export function methodPluginFolder() {
  for (const url of ['../plugins/method/', '../../../plugins/method/']) {
    const path = fileURLToPath(new URL(url, import.meta.url));
    if (existsSync(join(path, '.claude-plugin', 'plugin.json'))) return path;
  }
  throw Error('Method\'s Claude Code plugin is not in this installation of the method CLI, so a project arm cannot have it. Update the method CLI.');
}

/**
 * The Method plugin that a comparison's project arms have: a copy in the comparison's folder (method-plugin), made from
 * this installation's plugin. An update of the method CLI that changes only the plugin's version number keeps the copy,
 * so the arm stays the same arm and nothing that it received or ran is done again. Before the trial starts, a plugin
 * whose skills or hooks changed is a new arm. After the trial starts (trial-approval.json), the copy stays: a new copy
 * would be a new arm, and every treatment event and run of the arm would be done again.
 */
export function comparisonPlugin(folder: string) {
  const copy = join(folder, 'method-plugin'), installed = methodPluginFolder();
  const started = existsSync(join(folder, 'trial-approval.json'));
  if (!existsSync(copy) || (!started && pluginContent(copy) !== pluginContent(installed))) { removeTree(copy); cpSync(installed, copy, { recursive: true }); }
  return copy;
}
/** A plugin's files without the version number in its plugin.json. */
function pluginContent(dir: string) {
  const files = projectFiles(dir), manifest = '.claude-plugin/plugin.json';
  const { version: _version, ...rest } = JSON.parse(readFileSync(join(dir, manifest), 'utf8'));
  return JSON.stringify(Object.entries({ ...files, [manifest]: rest }).sort(([a], [b]) => a.localeCompare(b)));
}

/** The hash of each file in a folder, by its path in the folder. Links are not followed. */
export function projectFiles(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out[relative(root, path).split(sep).join('/')] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(root);
  return out;
}

/** A project's words: each {{NAME}} replaced by the input's value NAME. what names the file in an error. */
export function fillMessage(template: string, value: unknown, what: string) {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, key: string) => {
    const found = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
    if (typeof found !== 'string' && typeof found !== 'number') throw Error(`${what} names {{${key}}}, which the input does not give as a text or a number.`);
    return String(found);
  });
}

/**
 * A copy of PATH without the method command: each folder that holds a program named method (or method-...) is
 * replaced by a folder of links to its other programs, so every other program stays where the agent finds it.
 */
function pathWithoutMethod(path: string, root: string) {
  return path.split(delimiter).filter(Boolean).map((dir, i) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return dir; }
    if (!names.some(name => name === 'method' || name.startsWith('method-'))) return dir;
    const copy = join(root, 'path', String(i));
    mkdirSync(copy, { recursive: true, mode: 0o700 });
    for (const name of names) if (name !== 'method' && !name.startsWith('method-')) { try { symlinkSync(join(dir, name), join(copy, name)); } catch { /* a name twice */ } }
    return copy;
  }).join(delimiter);
}
function findProgram(name: string, path: string) {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const file = join(dir, name);
    try { if (statSync(file).isFile()) return file; } catch { /* the next folder */ }
  }
  throw Error(`${name} is not on PATH.`);
}

/**
 * How a project chat runs. agent: Codex, or Claude Code when it is not named. plugins: the project's plugins. method: for the Method plugin, the folder that holds the
 * method CLI, the Method config folder (its sign-in), the learner's Method cache, and the account and server the
 * comparison uses.
 */
export type ChatSettings = { agent?: ProjectAgent; plugins: ProjectPlugin[]; model: string | null; effort: string | null; web: boolean;
  method?: { cli: string; config: string; cache: string; plugin: string; account?: string | null; server?: string | null } };
/**
 * The tokens that the model work of a run reported: its Claude Code and Codex sessions and steps, and the requests of
 * its hosted model steps. Null when nothing in it reported a count.
 */
export function tokensOfRun(runDir: string): number | null {
  let total = 0, found = false;
  let lines: string[] = [];
  try { lines = readFileSync(join(runDir, 'events.jsonl'), 'utf8').split('\n'); } catch { return null; }
  for (const line of lines) {
    let e: any; try { e = line ? JSON.parse(line) : null; } catch { continue; }
    if (e?.event === 'agent.completed' && e.usage && typeof e.usage === 'object') {
      found = true;
      for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) total += Number(e.usage[key]) || 0;
    }
    if (e?.event === 'codex.completed' && Array.isArray(e.usage)) for (const u of e.usage) { found = true; total += (Number(u?.input_tokens) || 0) + (Number(u?.output_tokens) || 0); }
    if (e?.event === 'run.completed' && typeof e.usage?.input_tokens === 'number') { found = true; total += e.usage.input_tokens + (Number(e.usage.output_tokens) || 0); }
  }
  return found ? total : null;
}
/** The run folders in a Method cache (CACHE/runs), where each method run that a chat starts keeps its record. */
function cachedRuns(cache: string | null): Set<string> {
  try { return new Set(cache ? readdirSync(join(cache, 'runs')) : []); } catch { return new Set(); }
}
/**
 * The tokens of the Method runs that one message of a chat started: each run folder in the chat's Method cache that
 * was not there before the message. A chat that does its work with method run spends most of its tokens in those runs'
 * steps, which its own count leaves out; a Method fix counts its own sessions and test runs.
 */
function startedRunTokens(cache: string | null, before: Set<string>) {
  let total = 0;
  for (const name of cachedRuns(cache)) if (!before.has(name)) total += tokensOfRun(join(cache!, 'runs', name)) ?? 0;
  return total;
}

/** One message of a chat and what came back: the agent's last words, its transcript entries, and its tokens with those of the Method runs it started. */
export type Turn = { message: string; reply: string; model: string | null; entries: any[]; tokens: number | null; attempt: string };

/** Claude Code's folder for a project in HOME/.claude/projects: the project's path with every other character than a letter or digit as -. */
const projectSlug = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-');
/**
 * Where a project's chats work: a folder of its own under the system's temporary folder, the same for every chat of the
 * project (so paths that the agent writes down still hold), outside every repository and the comparison's folder.
 */
export function projectDesk(project: string) {
  const root = join(realpathSync(process.platform === 'win32' ? tmpdir() : '/tmp'), 'method-projects');
  mkdirSync(root, { recursive: true });
  // It can be entered but not listed, so a chat does not find the folders of other chats.
  chmodSync(root, 0o300);
  return join(root, createHash('sha256').update(resolve(project)).digest('hex').slice(0, 16), 'project');
}
/**
 * Put a project in its desk to work on it: the project, and its Method cache beside it (so no path names the
 * comparison's folder). Every Method command of the project runs here (its chats and its redesign), so a Method's
 * home is the desk's file, and a fix writes where keep() copies from. keep() copies the desk back to the project and
 * the cache; remove() removes the desk.
 */
export function openDesk(project: string, cache: string | null) {
  const desk = projectDesk(project);
  const deskCache = cache ? join(dirname(desk), 'cache') : null;
  // A comparison run that stopped (killed, or a usage limit) can leave a Method fix running in the desk: it belongs to
  // no event of this run, so it stops before the desk is filled again. Within a run, a chat ends only after its fixes.
  if (deskCache) stopFixes(deskCache);
  copyTree(project, desk);
  if (cache && deskCache) copyTree(cache, deskCache);
  const keep = () => { copyTree(desk, project); if (cache && deskCache) copyTree(deskCache, cache); };
  return { desk, cache: deskCache, keep, remove: () => removeTree(dirname(desk)) };
}

/**
 * Open one chat in a project folder. Each send is one message of the same chat (the first starts it, the next resume
 * it). close() waits for every Method fix that the chat started to end, puts Claude Code's memory back, and removes the
 * room. artifacts: where each message keeps its prompt, events and transcript (session/attempt-N), as a Method session
 * step keeps them. memory: the folder that keeps the learner's agent memory between chats. Claude Code (auto-memory is
 * on, as in the desktop app) finds it at HOME/.claude/projects/SLUG/memory for the chat's project folder; Codex finds
 * it in its home (HOME/.codex: AGENTS.md and memories/). It is put there before the chat and taken back after it.
 */
export async function openChat(project: string, settings: ChatSettings, artifacts: string, memory: string | null = null) {
  return settings.agent === 'codex' ? openCodexChat(project, settings, artifacts, memory) : openClaudeChat(project, settings, artifacts, memory);
}
async function openClaudeChat(project: string, settings: ChatSettings, artifacts: string, memory: string | null) {
  const { cleanRoomEnv } = await import('@withmethod/runtime/clean-room.js');
  const { claudeTranscript } = await import('@withmethod/runtime/transcript.js');
  const room = await cleanRoomEnv('claude', process.env);
  // The room can be entered but not listed, so a chat that searches the temporary folder finds no other chat's room.
  chmodSync(room.root, 0o300);
  const claude = findProgram('claude', process.env.PATH ?? '');
  // CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: the account's cloud plugins and skills are not synced into the room.
  const env: NodeJS.ProcessEnv = { ...room.env, PATH: pathWithoutMethod(process.env.PATH ?? '', room.root), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  // The chat works in the project's desk; after each message the desk is copied back to the project.
  const { desk, cache: deskCache, keep, remove } = openDesk(project, settings.method?.cache ?? null);
  // The memory folder of this project (by its path, and by its real path when they differ).
  let real = desk;
  try { real = realpathSync(desk); } catch { /* the path itself */ }
  const memoryFolders = [...new Set([real, desk].map(path => join(env.HOME!, '.claude', 'projects', projectSlug(path), 'memory')))];
  // The memory folder that Claude Code says it uses for this chat (memory_paths.auto of its start event).
  let autoMemory: string | null = null;
  if (memory && existsSync(memory)) for (const folder of memoryFolders) copyTree(memory, folder);
  const pluginArgs: string[] = [];
  if (settings.plugins.includes('method')) {
    const m = settings.method;
    if (!m) throw Error('A project with the Method plugin needs the method CLI.');
    const bin = join(env.HOME!, '.local', 'bin');
    mkdirSync(bin, { recursive: true, mode: 0o700 });
    symlinkSync(join(m.cli, 'method'), join(bin, 'method'));
    const plugin = join(room.root, 'plugins', 'method');
    cpSync(m.plugin, plugin, { recursive: true });
    pluginArgs.push('--plugin-dir', plugin);
    Object.assign(env, { PATH: `${bin}${delimiter}${env.PATH}`, METHOD_CONFIG_DIR: m.config, METHOD_CACHE_DIR: deskCache!,
      // The plugin's start hook installs the method CLI when it finds none; here it is installed, and nothing is downloaded.
      METHOD_INSTALL_URL: 'file:///dev/null',
      ...(settings.web ? {} : { METHOD_WEB: 'off' }), ...(m.account ? { METHOD_ACCOUNT: m.account } : {}), ...(m.server ? { METHOD_SERVER: m.server } : {}) });
  }
  const session = randomUUID();
  let n = 0;
  const send = async (message: string): Promise<Turn> => {
    const attempt = join(artifacts, 'session', `attempt-${++n}`);
    mkdirSync(attempt, { recursive: true, mode: 0o700 });
    writeFileSync(join(attempt, 'prompt.md'), message, { mode: 0o600 });
    const runsBefore = cachedRuns(deskCache);
    const args = ['--print', '--output-format', 'stream-json', '--verbose', ...(n === 1 ? ['--session-id', session] : ['--resume', session]),
      '--permission-mode', 'dontAsk', '--allowedTools', projectTools.join(','), ...(settings.web ? [] : ['--disallowedTools', webTools.join(',')]),
      ...(settings.model ? ['--model', settings.model] : []), ...(settings.effort ? ['--effort', settings.effort] : []), ...pluginArgs];
    const started = new Date().toISOString();
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>(done => {
      const child = spawn(claude, args, { cwd: desk, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), MESSAGE_LIMIT_MS);
      child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
      child.on('error', error => { clearTimeout(timer); done({ code: 1, stdout, stderr: error.message }); });
      child.on('close', code => { clearTimeout(timer); done({ code: code ?? 1, stdout, stderr }); });
      child.stdin.end(message);
    });
    writeFileSync(join(attempt, 'events.jsonl'), result.stdout, { mode: 0o600 });
    writeFileSync(join(attempt, 'stderr.log'), result.stderr, { mode: 0o600 });
    const entries = claudeTranscript(message, result.stdout, { started, times: [] });
    writeFileSync(join(attempt, 'transcript.jsonl'), entries.map((e: any) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
    keep();
    const events = result.stdout.split('\n').flatMap(line => { try { return line ? [JSON.parse(line)] : []; } catch { return []; } });
    const auto = events.find(e => e?.type === 'system' && e.subtype === 'init')?.memory_paths?.auto;
    if (typeof auto === 'string' && auto) autoMemory = auto.replace(/[\\/]+$/, '');
    const last = events.filter(e => e?.type === 'result').at(-1);
    if (!last || last.is_error || last.subtype !== 'success') {
      const limit = events.some(e => e?.type === 'rate_limit_event' && e.rate_limit_info?.status === 'rejected');
      throw Error(`${limit ? 'Claude Code hit a usage limit' : 'Claude Code did not finish the message'}: ${String(last?.errors?.join('\n') || last?.result || result.stderr.trim().split('\n').at(-1) || `it exited with ${result.code}`).slice(0, 500)}`);
    }
    const usage = last.usage;
    const chat = usage && typeof usage === 'object' ? ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((s, k) => s + (Number(usage[k]) || 0), 0) : null;
    const tokens = chat === null ? null : chat + startedRunTokens(deskCache, runsBefore);
    const model = events.find(e => e?.type === 'system' && e.subtype === 'init')?.model ?? null;
    return { message, reply: typeof last.result === 'string' ? last.result : '', model, entries, tokens, attempt };
  };
  const close = async () => {
    try {
      if (deskCache) await waitForFixes(deskCache);
      keep();
      if (memory) {
        // The memory that Claude Code kept for this project: the folder it named, else its folder for the desk (of
        // the two, the one with the latest change).
        const projects = join(env.HOME!, '.claude', 'projects');
        const newest = (dir: string) => Math.max(0, ...Object.keys(projectFiles(dir)).map(p => statSync(join(dir, p)).mtimeMs));
        const own = autoMemory && existsSync(autoMemory) ? autoMemory : memoryFolders.filter(existsSync).sort((a, b) => newest(b) - newest(a))[0];
        if (own) copyTree(own, memory);
        // Memory that Claude Code wrote for any other folder is kept too, so nothing it saved is lost; what the
        // learner's memory has already wins.
        const others = existsSync(projects) ? readdirSync(projects).map(name => join(projects, name, 'memory'))
          .filter(dir => existsSync(dir) && ![own, ...memoryFolders].some(o => o && resolve(o) === resolve(dir)) && Object.keys(projectFiles(dir)).length) : [];
        for (const dir of others) cpSync(dir, memory, { recursive: true, force: false, errorOnExist: false });
      }
    } finally { chmodSync(room.root, 0o700); await room.remove(); remove(); }
  };
  return { send, close };
}

/** What Codex keeps in its home between chats, as a person's Codex does: its own AGENTS.md and its memories folder. */
const codexMemory = ['AGENTS.md', 'memories'];
/** A TOML string. */
const toml = (value: string) => JSON.stringify(value);
/**
 * One Codex chat in a project folder, as a person has it in the Codex app: `codex exec` in the project's desk, and
 * `codex exec resume THREAD` for the next message of the same chat. The room's Codex home holds the sign-in, the
 * learner's Codex memory, and a config with the chat's model and effort (as a person sets them in Codex, so the
 * Method steps and fixes that the chat starts on Codex use them too), web search off unless tested, and no account
 * connectors or remote plugins. Commands run without asking, as Claude Code's project chats do.
 */
async function openCodexChat(project: string, settings: ChatSettings, artifacts: string, memory: string | null) {
  const { cleanRoomEnv } = await import('@withmethod/runtime/clean-room.js');
  const { codexTranscript } = await import('@withmethod/runtime/transcript.js');
  const room = await cleanRoomEnv('codex', process.env);
  chmodSync(room.root, 0o300);
  try {
    // Codex finds its helpers (codex-code-mode-host) beside its real program, which a link on PATH may hide.
    const codex = findProgram('codex', process.env.PATH ?? '');
    const env: NodeJS.ProcessEnv = { ...room.env, PATH: [dirname(realpathSync(codex)), pathWithoutMethod(process.env.PATH ?? '', room.root)].join(delimiter) };
    const home = join(env.HOME!, '.codex');
    writeFileSync(join(home, 'config.toml'), [
      ...(settings.model ? [`model = ${toml(settings.model)}`] : []), ...(settings.effort ? [`model_reasoning_effort = ${toml(settings.effort)}`] : []),
      ...(settings.web ? [] : ['web_search = "disabled"']),
      '', '[features]', 'apps = false', 'remote_plugin = false', 'plugin_discovery_prefetch = false', ''].join('\n'), { mode: 0o600 });
    if (memory && existsSync(memory)) for (const name of codexMemory) if (existsSync(join(memory, name))) cpSync(join(memory, name), join(home, name), { recursive: true });
    const { desk, cache: deskCache, keep, remove } = openDesk(project, settings.method?.cache ?? null);
    const hooks: string[] = [];
    if (settings.plugins.includes('method')) {
      const m = settings.method;
      if (!m) throw Error('A project with the Method plugin needs the method CLI.');
      const bin = join(env.HOME!, '.local', 'bin');
      mkdirSync(bin, { recursive: true, mode: 0o700 });
      symlinkSync(join(m.cli, 'method'), join(bin, 'method'));
      Object.assign(env, { PATH: `${bin}${delimiter}${env.PATH}`, METHOD_CONFIG_DIR: m.config, METHOD_CACHE_DIR: deskCache!, METHOD_INSTALL_URL: 'file:///dev/null',
        ...(settings.web ? {} : { METHOD_WEB: 'off' }), ...(m.account ? { METHOD_ACCOUNT: m.account } : {}), ...(m.server ? { METHOD_SERVER: m.server } : {}) });
      // The plugin is added as the Method installer adds it to Codex: from a marketplace, here a local one that holds the comparison's copy.
      const market = join(room.root, 'marketplace');
      cpSync(m.plugin, join(market, 'plugins', 'method'), { recursive: true });
      mkdirSync(join(market, '.claude-plugin'), { recursive: true, mode: 0o700 });
      writeFileSync(join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'method', owner: { name: 'Method' }, plugins: [{ name: 'method', source: './plugins/method' }] }));
      for (const args of [['plugin', 'marketplace', 'add', market], ['plugin', 'add', 'method@method']]) {
        const done = spawnSync(codex, args, { cwd: room.root, env, encoding: 'utf8', timeout: 120_000 });
        if (done.status !== 0) throw Error(`Codex did not add the Method plugin (codex ${args.join(' ')}): ${String(done.stderr || done.stdout || done.error?.message || '').trim().split('\n').at(-1)}`);
      }
      // A person trusts the plugin's hooks once in Codex; here every chat runs them.
      hooks.push('--dangerously-bypass-hook-trust');
    }
    // Codex reports the tokens of the whole chat so far: a resumed chat's count includes its earlier messages.
    let thread: string | null = null, n = 0, chatTokens = 0;
    const send = async (message: string): Promise<Turn> => {
      const attempt = join(artifacts, 'session', `attempt-${++n}`);
      mkdirSync(attempt, { recursive: true, mode: 0o700 });
      writeFileSync(join(attempt, 'prompt.md'), message, { mode: 0o600 });
      const runsBefore = cachedRuns(deskCache);
      const output = join(attempt, 'last-message.txt');
      const flags = ['--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', ...hooks, '--output-last-message', output];
      const args = thread ? ['exec', 'resume', thread, ...flags, '-'] : ['exec', ...flags, '-C', desk, '-'];
      const started = new Date().toISOString(), times: string[] = [];
      const result = await new Promise<{ code: number; stdout: string; stderr: string }>(done => {
        const child = spawn(codex, args, { cwd: desk, env, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => child.kill('SIGTERM'), MESSAGE_LIMIT_MS);
        // When each line came: Codex gives its events no time.
        child.stdout.on('data', c => { const at = new Date().toISOString(); for (const ch of String(c)) if (ch === '\n') times.push(at); stdout += c; });
        child.stderr.on('data', c => { stderr += c; });
        child.on('error', error => { clearTimeout(timer); done({ code: 1, stdout, stderr: error.message }); });
        child.on('close', code => { clearTimeout(timer); done({ code: code ?? 1, stdout, stderr }); });
        child.stdin.end(message);
      });
      writeFileSync(join(attempt, 'events.jsonl'), result.stdout, { mode: 0o600 });
      writeFileSync(join(attempt, 'stderr.log'), result.stderr, { mode: 0o600 });
      let reply = '';
      try { reply = readFileSync(output, 'utf8'); } catch { /* no last message */ }
      const entries = codexTranscript(message, result.stdout, reply || undefined, 'last-message.txt', { started, times });
      writeFileSync(join(attempt, 'transcript.jsonl'), entries.map((e: any) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
      keep();
      const events = result.stdout.split('\n').flatMap(line => { try { return line ? [JSON.parse(line)] : []; } catch { return []; } });
      thread ??= events.find(e => e?.type === 'thread.started')?.thread_id ?? null;
      const failed = events.find(e => e?.type === 'turn.failed') ?? events.filter(e => e?.type === 'error').at(-1);
      const turns = events.filter(e => e?.type === 'turn.completed');
      if (failed || !turns.length || result.code !== 0) {
        const why = String(failed?.error?.message ?? failed?.message ?? (result.stderr.trim().split('\n').at(-1) || `it exited with ${result.code}`));
        throw Error(`${/\b(hit|reached) your usage limit\b/i.test(why) ? 'Codex hit a usage limit' : 'Codex did not finish the message'}: ${why.slice(0, 500)}`);
      }
      if (!thread) throw Error('Codex did not name its chat, so the chat cannot go on.');
      const total = turns.reduce((sum, e) => sum + (Number(e.usage?.input_tokens) || 0) + (Number(e.usage?.output_tokens) || 0), 0);
      const tokens = Math.max(0, total - chatTokens) + startedRunTokens(deskCache, runsBefore);
      chatTokens = Math.max(chatTokens, total);
      return { message, reply, model: codexModel(home, thread), entries, tokens, attempt };
    };
    const close = async () => {
      try {
        if (deskCache) await waitForFixes(deskCache);
        keep();
        if (memory) for (const name of codexMemory) {
          removeTree(join(memory, name));
          if (existsSync(join(home, name))) cpSync(join(home, name), join(memory, name), { recursive: true });
        }
      } finally { chmodSync(room.root, 0o700); await room.remove(); remove(); }
    };
    return { send, close };
  } catch (error) { chmodSync(room.root, 0o700); await room.remove(); throw error; }
}
/** The model that a Codex chat ran on: the last one that its saved chat (HOME/.codex/sessions/.../rollout-*-THREAD.jsonl) names. */
function codexModel(home: string, thread: string): string | null {
  const find = (dir: string): string | null => {
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { const found = find(path); if (found) return found; }
      else if (entry.name.endsWith(`${thread}.jsonl`)) return path;
    }
    return null;
  };
  const file = find(join(home, 'sessions'));
  if (!file) return null;
  let model: string | null = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    try { const e = JSON.parse(line); if (e?.type === 'turn_context' && typeof e.payload?.model === 'string') model = e.payload.model; } catch { /* not a line of JSON */ }
  }
  return model;
}

/**
 * Give every Method in a copy of a project a new Method ID of its own. A measuring or probe copy then runs each Method
 * as it was at its checkpoint: it does not catch up to newer versions that the learner saved later under the same ID,
 * and nothing that the copy saves reaches the learner's Method.
 */
export function ownMethodIds(project: string) {
  const walk = (dir: string) => {
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !['.method-runs', 'node_modules', '.git'].includes(entry.name)) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.method')) {
        let id: unknown;
        try { id = readDocument(path).id; } catch { continue; }
        if (typeof id === 'string' && methodIdPattern.test(id)) writeMethodId(path, newMethodId());
      }
    }
  };
  walk(project);
}

/**
 * Wait until no Method fix in a Method cache still runs, for at most MESSAGE_LIMIT_MS: no lock names a live process, and
 * no correction is still being fixed by a live process (method judge marks it before the fix takes its lock), so the
 * next task runs the fixed Method.
 */
/**
 * Stop every Method fix that still runs with this Method cache: the process (and its process group: its agent session
 * and test runs) that holds a Method's fix lock or a working outcome record. Its record then reads as stopped.
 */
export function stopFixes(cache: string) {
  let names: string[];
  try { names = readdirSync(join(cache, 'fixes')); } catch { return; }
  const stop = (path: string) => {
    let pid: unknown;
    try { const value = JSON.parse(readFileSync(path, 'utf8')); if (value.status !== undefined && value.status !== 'working') return; pid = value.pid; } catch { return; }
    if (typeof pid !== 'number' || pid === process.pid) return;
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* it has ended */ } }
  };
  for (const name of names) {
    stop(join(cache, 'fixes', name, 'lock'));
    rmSync(join(cache, 'fixes', name, 'lock'), { force: true });
    let records: string[] = [];
    try { records = readdirSync(join(cache, 'fixes', name, 'outcomes')).filter(file => file.endsWith('.json')); } catch { /* no outcomes */ }
    for (const file of records) stop(join(cache, 'fixes', name, 'outcomes', file));
  }
}
/** How long a fix that method judge marked as working may take to start its process. */
const FIX_START_MS = 60_000;
export async function waitForFixes(cache: string) {
  const deadline = Date.now() + MESSAGE_LIMIT_MS;
  const alive = (path: string, working = false) => {
    let value: any;
    try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { return false; }
    if (working && value.status !== 'working') return false;
    // method judge marks its correction as working before the fix's process exists: until the process starts (and
    // names itself), the record holds the chat for up to FIX_START_MS.
    if (working && typeof value.pid !== 'number') return Date.now() - Date.parse(value.started_at ?? '') < FIX_START_MS;
    try { process.kill(value.pid, 0); return true; } catch { return false; }
  };
  const running = () => {
    let names: string[];
    try { names = readdirSync(join(cache, 'fixes')); } catch { return false; }
    return names.some(name => {
      if (alive(join(cache, 'fixes', name, 'lock'))) return true;
      let records: string[] = [];
      try { records = readdirSync(join(cache, 'fixes', name, 'outcomes')).filter(file => file.endsWith('.json')); } catch { /* no outcomes */ }
      return records.some(file => alive(join(cache, 'fixes', name, 'outcomes', file), true));
    });
  };
  while (running()) {
    if (Date.now() > deadline) throw Error('A Method fix that the chat started did not end within 2 hours.');
    await new Promise(done => setTimeout(done, 2000));
  }
}

/** What a chat did with the project: the files it added, changed or removed, the Methods it built or changed, and its method commands. */
export type Did = { added: string[]; changed: string[]; removed: string[]; methods_built: string[]; methods_changed: string[]; commands: string[]; judged: string[]; skills: string[];
  /** The files of Claude Code's memory that the chat added, changed or removed. */
  memory: string[] };
/** Files that say nothing about what the agent kept: run records and caches. */
const ignored = (path: string) => /(^|\/)(\.method-runs|node_modules|__pycache__|\.git)\//.test(path) || /(^|\/)\.DS_Store$/.test(path);
/** The method commands of a transcript: "method judge", "method run", by their first word after method. */
export function methodCommands(entries: any[]) {
  const commands: string[] = [], judged: string[] = [];
  for (const e of entries) {
    if (e.kind !== 'command' || typeof e.text !== 'string') continue;
    // A Codex command comes in its shell's call (/bin/zsh -lc '...'): the commands are inside it.
    const wrapped = /^\S*\/(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(e.text.trim());
    const text = wrapped ? wrapped[2]!.replace(/'\\''/g, "'").replace(/\\"/g, '"') : e.text;
    // method as the program of a command: at the start, or after ; & | ( or a shell's then/do, with or without its folder.
    for (const m of text.matchAll(/(?:^\s*|[;&|(]\s*|\b(?:then|do)\s+)(?:[^\s;&|(]*\/)?method\s+([a-z][\w-]*)([^\n;&|]*)/g)) {
      commands.push(`method ${m[1]}`);
      if (m[1] === 'judge') judged.push(/\bwrong\b/.test(m[2]!) ? 'wrong' : /\bright\b/.test(m[2]!) ? 'right' : 'other');
    }
  }
  return { commands, judged };
}
export function whatItDid(before: Record<string, string>, after: Record<string, string>, entries: any[], deliverable: string | null, memory: { before: Record<string, string>; after: Record<string, string> } = { before: {}, after: {} }): Did {
  const memoryChanged = [...new Set([...Object.keys(memory.before), ...Object.keys(memory.after)])].filter(p => memory.before[p] !== memory.after[p]).sort();
  const keep = (p: string) => p !== deliverable && !ignored(p);
  const added = Object.keys(after).filter(p => keep(p) && !(p in before)).sort();
  const changed = Object.keys(after).filter(p => keep(p) && p in before && before[p] !== after[p]).sort();
  const removed = Object.keys(before).filter(p => keep(p) && !(p in after)).sort();
  const { commands, judged } = methodCommands(entries);
  // A skill: Claude Code's Skill tool, or a SKILL.md that a Codex command read (Codex loads a skill by reading it).
  const skills = [...entries.filter(e => e.tool === 'Skill' && e.role === 'assistant').map(e => { try { return String(JSON.parse(e.text).skill ?? JSON.parse(e.text).command ?? ''); } catch { return ''; } }),
    ...entries.filter(e => e.kind === 'file_read' && e.tool === 'shell' && typeof e.path === 'string').map(e => /(?:^|\/)([^/]+)\/SKILL\.md$/.exec(e.path)?.[1] ?? '')].filter(Boolean);
  return { added, changed, removed, methods_built: added.filter(p => p.endsWith('.method')), methods_changed: changed.filter(p => p.endsWith('.method')),
    commands: [...new Set(commands)], judged, skills: [...new Set(skills)], memory: memoryChanged };
}
const list = (paths: string[]) => paths.length <= 3 ? paths.join(', ') : `${paths.slice(0, 3).join(', ')} and ${paths.length - 3} more`;
/** What a chat did, in short sentences for the page: "Saved notes to CLAUDE.md. Built a Method (nda.method). Ran method judge (wrong)." */
export function didSummary(did: Did, agent: ProjectAgent = 'claude') {
  const notes = (paths: string[]) => paths.filter(p => !p.endsWith('.method'));
  const out: string[] = [];
  const claudeMd = [...did.added, ...did.changed].filter(p => (agent === 'claude' ? /(^|\/)CLAUDE\.md$/ : /(^|\/)AGENTS\.md$/).test(p));
  if (claudeMd.length) out.push(`Saved notes to ${list(claudeMd)}`);
  const added = notes(did.added).filter(p => !claudeMd.includes(p)), changed = notes(did.changed).filter(p => !claudeMd.includes(p));
  if (added.length) out.push(`Wrote ${list(added)}`);
  if (changed.length) out.push(`Changed ${list(changed)}`);
  if (did.removed.length) out.push(`Removed ${list(did.removed)}`);
  if (did.methods_built.length) out.push(`Built a Method (${list(did.methods_built)})`);
  if (did.methods_changed.length) out.push(`Changed a Method (${list(did.methods_changed)})`);
  if (did.judged.length) out.push(`Ran method judge (${did.judged.join(', ')})`);
  const others = did.commands.filter(c => c !== 'method judge');
  if (others.length) out.push(`Ran ${others.join(', ')}`);
  if (did.memory.length) out.push(`Saved to ${memoryName(agent)} (${list(did.memory)})`);
  if (did.skills.length) out.push(`Used the ${did.skills.join(', ')} skill`);
  return out.length ? `${out.join('. ')}.` : 'Changed nothing in the project.';
}
/** Whether a chat changed what the project keeps: a file other than the handed-in one. */
export const keptSomething = (did: Did) => did.added.length + did.changed.length + did.removed.length + (did.memory?.length ?? 0) > 0;
/** The diff of the text files that a chat added, changed or removed (not the handed-in file), from a copy of the project before it. */
export function projectDiff(beforeDir: string, afterDir: string, did: Did, memory?: { before: string; after: string }, agent: ProjectAgent = 'claude') {
  const read = (dir: string, p: string) => { try { const b = readFileSync(join(dir, p)); return b.includes(0) ? '(a binary file)' : b.toString('utf8'); } catch { return ''; } };
  return [...[...did.added, ...did.changed, ...did.removed].sort().map(p => textDiff(read(beforeDir, p), read(afterDir, p), p, p)),
    ...(memory ? did.memory.map(p => textDiff(read(memory.before, p), read(memory.after, p), `${memoryName(agent)}/${p}`, `${memoryName(agent)}/${p}`)) : [])].filter(Boolean).join('\n');
}

/**
 * Put an input's own folders in a project: each folder of the input's folder replaces the project's folder of that
 * name. The handed-in file of an earlier chat is removed, so only this chat's file counts.
 */
export function placeInput(project: string, input: { room: string | null }, deliverable: string | null) {
  if (input.room) for (const entry of readdirSync(input.room, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = join(project, entry.name);
    removeTree(target);
    cpSync(join(input.room, entry.name), target, { recursive: true, verbatimSymlinks: true });
  }
  if (deliverable) removeTree(join(project, deliverable));
}

/** The handed-in file of a chat, or null. */
export function handedIn(project: string, deliverable: string | null) {
  if (!deliverable) return null;
  try { return readFileSync(join(project, deliverable), 'utf8'); } catch { return null; }
}
/** Copy a project folder (and its Method cache) to a new place. */
export function copyTree(from: string, to: string) {
  removeTree(to);
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  if (existsSync(from)) cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  else mkdirSync(to, { recursive: true, mode: 0o700 });
}
