/**
 * A Claude Code project arm of a comparison: Claude Code used the way a person uses the desktop app. The arm's state is
 * one project folder. Each piece of work is a new chat in that folder: the first message is the task, the agent works,
 * and a second message in the same chat may correct it. When the chat ends, only the project folder carries over.
 *
 * Every chat runs in a clean room: a fresh HOME with only the Claude Code sign-in, the same model, effort and tools for
 * every arm, and no web unless the comparison tests the tools. A project with the Method plugin also gets the plugin
 * (loaded with --plugin-dir, as Claude Code loads a plugin for one session) and the method CLI on PATH, signed in to the
 * comparison's Method account. A project without it has no plugin and no method command on PATH.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { textDiff } from './text-diff.js';

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
 * How a project chat runs. plugins: the project's plugins. method: for the Method plugin, the folder that holds the
 * method CLI, the Method config folder (its sign-in), the learner's Method cache, and the account and server the
 * comparison uses.
 */
export type ChatSettings = { plugins: ProjectPlugin[]; model: string | null; effort: string | null; web: boolean;
  method?: { cli: string; config: string; cache: string; account?: string | null; server?: string | null } };
/** One message of a chat and what came back: the agent's last words, its transcript entries, and the tokens it reported. */
export type Turn = { message: string; reply: string; model: string | null; entries: any[]; tokens: number | null; attempt: string };

/**
 * Open one chat in a project folder. Each send is one message of the same chat (the first starts it, the next resume
 * it). close() waits for every Method fix that the chat started to end, then removes the room. artifacts: where each
 * message keeps its prompt, events and transcript (session/attempt-N), as a Method session step keeps them.
 */
export async function openChat(project: string, settings: ChatSettings, artifacts: string) {
  const { cleanRoomEnv } = await import('@withmethod/runtime/clean-room.js');
  const { claudeTranscript } = await import('@withmethod/runtime/transcript.js');
  const room = await cleanRoomEnv('claude', process.env);
  const claude = findProgram('claude', process.env.PATH ?? '');
  const env: NodeJS.ProcessEnv = { ...room.env, PATH: pathWithoutMethod(process.env.PATH ?? '', room.root),
    // Only the project folder carries over between chats: Claude Code's memory in HOME would not.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  const pluginArgs: string[] = [];
  if (settings.plugins.includes('method')) {
    const m = settings.method;
    if (!m) throw Error('A project with the Method plugin needs the method CLI.');
    const bin = join(env.HOME!, '.local', 'bin');
    mkdirSync(bin, { recursive: true, mode: 0o700 });
    symlinkSync(join(m.cli, 'method'), join(bin, 'method'));
    const plugin = join(room.root, 'plugins', 'method');
    cpSync(methodPluginFolder(), plugin, { recursive: true });
    pluginArgs.push('--plugin-dir', plugin);
    Object.assign(env, { PATH: `${bin}${delimiter}${env.PATH}`, METHOD_CONFIG_DIR: m.config, METHOD_CACHE_DIR: m.cache,
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
    const args = ['--print', '--output-format', 'stream-json', '--verbose', ...(n === 1 ? ['--session-id', session] : ['--resume', session]),
      '--permission-mode', 'dontAsk', '--allowedTools', projectTools.join(','), ...(settings.web ? [] : ['--disallowedTools', webTools.join(',')]),
      ...(settings.model ? ['--model', settings.model] : []), ...(settings.effort ? ['--effort', settings.effort] : []), ...pluginArgs];
    const started = new Date().toISOString();
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>(done => {
      const child = spawn(claude, args, { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
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
    const events = result.stdout.split('\n').flatMap(line => { try { return line ? [JSON.parse(line)] : []; } catch { return []; } });
    const last = events.filter(e => e?.type === 'result').at(-1);
    if (!last || last.is_error || last.subtype !== 'success') {
      const limit = events.some(e => e?.type === 'rate_limit_event' && e.rate_limit_info?.status === 'rejected');
      throw Error(`${limit ? 'Claude Code hit a usage limit' : 'Claude Code did not finish the message'}: ${String(last?.errors?.join('\n') || last?.result || result.stderr.trim().split('\n').at(-1) || `it exited with ${result.code}`).slice(0, 500)}`);
    }
    const usage = last.usage;
    const tokens = usage && typeof usage === 'object' ? ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((s, k) => s + (Number(usage[k]) || 0), 0) : null;
    const model = events.find(e => e?.type === 'system' && e.subtype === 'init')?.model ?? null;
    return { message, reply: typeof last.result === 'string' ? last.result : '', model, entries, tokens, attempt };
  };
  const close = async () => {
    try { if (settings.method) await waitForFixes(settings.method.cache); } finally { await room.remove(); }
  };
  return { send, close };
}

/** Wait until no Method fix in a Method cache still runs (its lock names a live process), for at most MESSAGE_LIMIT_MS. */
export async function waitForFixes(cache: string) {
  const deadline = Date.now() + MESSAGE_LIMIT_MS;
  const running = () => {
    let names: string[];
    try { names = readdirSync(join(cache, 'fixes')); } catch { return false; }
    return names.some(name => { try { process.kill(JSON.parse(readFileSync(join(cache, 'fixes', name, 'lock'), 'utf8')).pid, 0); return true; } catch { return false; } });
  };
  while (running()) {
    if (Date.now() > deadline) throw Error('A Method fix that the chat started did not end within 2 hours.');
    await new Promise(done => setTimeout(done, 2000));
  }
}

/** What a chat did with the project: the files it added, changed or removed, the Methods it built or changed, and its method commands. */
export type Did = { added: string[]; changed: string[]; removed: string[]; methods_built: string[]; methods_changed: string[]; commands: string[]; judged: string[]; skills: string[] };
/** Files that say nothing about what the agent kept: run records and caches. */
const ignored = (path: string) => /(^|\/)(\.method-runs|node_modules|__pycache__|\.git)\//.test(path) || /(^|\/)\.DS_Store$/.test(path);
/** The method commands of a transcript: "method judge", "method run", by their first word after method. */
export function methodCommands(entries: any[]) {
  const commands: string[] = [], judged: string[] = [];
  for (const e of entries) {
    if (e.kind !== 'command' || typeof e.text !== 'string') continue;
    // method as the program of a command: at the start, or after ; & | ( or a shell's then/do, with or without its folder.
    for (const m of e.text.matchAll(/(?:^\s*|[;&|(]\s*|\b(?:then|do)\s+)(?:[^\s;&|(]*\/)?method\s+([a-z][\w-]*)([^\n;&|]*)/g)) {
      commands.push(`method ${m[1]}`);
      if (m[1] === 'judge') judged.push(/\bwrong\b/.test(m[2]!) ? 'wrong' : /\bright\b/.test(m[2]!) ? 'right' : 'other');
    }
  }
  return { commands, judged };
}
export function whatItDid(before: Record<string, string>, after: Record<string, string>, entries: any[], deliverable: string | null): Did {
  const keep = (p: string) => p !== deliverable && !ignored(p);
  const added = Object.keys(after).filter(p => keep(p) && !(p in before)).sort();
  const changed = Object.keys(after).filter(p => keep(p) && p in before && before[p] !== after[p]).sort();
  const removed = Object.keys(before).filter(p => keep(p) && !(p in after)).sort();
  const { commands, judged } = methodCommands(entries);
  const skills = entries.filter(e => e.tool === 'Skill' && e.role === 'assistant').map(e => { try { return String(JSON.parse(e.text).skill ?? JSON.parse(e.text).command ?? ''); } catch { return ''; } }).filter(Boolean);
  return { added, changed, removed, methods_built: added.filter(p => p.endsWith('.method')), methods_changed: changed.filter(p => p.endsWith('.method')),
    commands: [...new Set(commands)], judged, skills: [...new Set(skills)] };
}
const list = (paths: string[]) => paths.length <= 3 ? paths.join(', ') : `${paths.slice(0, 3).join(', ')} and ${paths.length - 3} more`;
/** What a chat did, in short sentences for the page: "Saved notes to CLAUDE.md. Built a Method (nda.method). Ran method judge (wrong)." */
export function didSummary(did: Did) {
  const notes = (paths: string[]) => paths.filter(p => !p.endsWith('.method'));
  const out: string[] = [];
  const claudeMd = [...did.added, ...did.changed].filter(p => /(^|\/)CLAUDE\.md$/.test(p));
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
  if (did.skills.length) out.push(`Used the ${did.skills.join(', ')} skill`);
  return out.length ? `${out.join('. ')}.` : 'Changed nothing in the project.';
}
/** Whether a chat changed what the project keeps: a file other than the handed-in one. */
export const keptSomething = (did: Did) => did.added.length + did.changed.length + did.removed.length > 0;
/** The diff of the text files that a chat added, changed or removed (not the handed-in file), from a copy of the project before it. */
export function projectDiff(beforeDir: string, afterDir: string, did: Did) {
  const read = (dir: string, p: string) => { try { const b = readFileSync(join(dir, p)); return b.includes(0) ? '(a binary file)' : b.toString('utf8'); } catch { return ''; } };
  return [...did.added, ...did.changed, ...did.removed].sort().map(p => textDiff(read(beforeDir, p), read(afterDir, p), p, p)).filter(Boolean).join('\n');
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
/** Remove a file or folder; every folder in it is made writable first, as an agent may make files read-only. */
function removeTree(path: string) {
  const walk = (dir: string) => {
    let entries: import('node:fs').Dirent[];
    try { chmodSync(dir, 0o700); entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink()) walk(join(dir, e.name));
  };
  try { if (statSync(path).isDirectory()) walk(path); } catch { /* not there */ }
  rmSync(path, { recursive: true, force: true });
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
