/**
 * Parent and child Methods. A child file names its parent with `extends: PATH`; the CLI resolves the chain into one
 * ordinary, self-contained Method document before any command reads it, so validate, run, test, diff and publish see
 * the same flat document that a saved version holds. The hosted server and the production worker never see `extends`.
 *
 * The rule, in one paragraph: maps merge key by key and the child wins; a list replaces the parent's list unless the
 * child writes `{append: [...]}`; `null` removes a key. A child step entry names a parent step and patches it (or
 * replaces it with `replace: true`); a new step needs `insert_after:` or `insert_before:`; `remove_steps:` removes parent
 * steps. A parent declares `params:` and uses them as `{{params.NAME}}`; a child fills them under `params:`. A child
 * that names a parent step or param that does not exist, or leaves a param without a value, is an error.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parseDocumentValue, serializeWorkflow } from '../../workflow-language/src/validate.js';
import { packagePath } from '../../contracts/src/method-package.js';

/** Keys that only a parent or child file has. A file without any of them is an ordinary Method and is never resolved. */
export const inheritanceKeys = ['extends', 'params', 'abstract', 'remove_steps'] as const;
const stepKeys = ['insert_after', 'insert_before', 'replace', 'prompt'] as const;
const paramTypes = ['text', 'number', 'boolean', 'list', 'record'] as const;
const marker = 'resolved.json';
const lockFiles = [['package.json', 'package-lock.json'], ['pyproject.toml', 'uv.lock']];

type Param = { type: (typeof paramTypes)[number]; description?: string; default?: unknown; declared_in: string };
type Level = { file: string; folder: string; raw: any; sha256: string };
export type Resolved = {
  /** The flat Method document: the same schema as any Method file. */
  document: any;
  /** The files of the chain, the child first and the top parent last. */
  chain: Level[];
  /** The value of each param after filling, by name. */
  params: Record<string, unknown>;
  /** True when the child file itself says abstract: true (a template that cannot run or be published by itself). */
  abstract: boolean;
};

const plain = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = <T>(v: T): T => v === undefined ? v : structuredClone(v);
const shown = (file: string) => { const rel = relative(process.cwd(), file); return rel && !rel.startsWith('..') ? rel : file; };

/** True when the parsed document is a parent or child file (it has extends, params, abstract or remove_steps). */
export function isInheriting(document: unknown): boolean {
  return plain(document) && inheritanceKeys.some(key => Object.hasOwn(document, key));
}
/** The parsed file, or undefined when it cannot be read or parsed (the command then reports the file's own error). */
function parsed(file: string): any {
  try { return parseDocumentValue(readFileSync(file, 'utf8')); } catch { return undefined; }
}
/** True when FILE is a parent or child Method file. */
export function inheritingFile(file: string): boolean {
  return /\.method$/i.test(file) && existsSync(file) && statSync(file).isFile() && isInheriting(parsed(resolve(file)));
}

function readLevel(file: string): Level {
  const text = readFileSync(file, 'utf8');
  let raw: any;
  try { raw = parseDocumentValue(text); } catch (error) { throw Error(`${shown(file)} is not readable YAML or JSON: ${(error as Error).message}`); }
  if (!plain(raw)) throw Error(`${shown(file)} must hold a Method document (a map of fields).`);
  if (raw.extends !== undefined && (typeof raw.extends !== 'string' || !raw.extends.trim()))
    throw Error(`${shown(file)}: extends must be the path of the parent .method file, relative to this file, for example extends: ../shared/invoice-coding.method.`);
  if (typeof raw.extends === 'string' && !/\.method$/i.test(raw.extends))
    throw Error(`${shown(file)}: extends: ${raw.extends} is not a .method file. Name the parent by its file path (a Method ID or version is not supported).`);
  if (raw.abstract !== undefined && typeof raw.abstract !== 'boolean') throw Error(`${shown(file)}: abstract must be true or false.`);
  if (raw.params !== undefined && !plain(raw.params)) throw Error(`${shown(file)}: params must be a map of names.`);
  if (raw.remove_steps !== undefined && (!Array.isArray(raw.remove_steps) || raw.remove_steps.some((s: unknown) => typeof s !== 'string')))
    throw Error(`${shown(file)}: remove_steps must be a list of step IDs, for example remove_steps: [notify].`);
  if (raw.remove_steps !== undefined && raw.extends === undefined) throw Error(`${shown(file)}: remove_steps needs extends: it removes steps of the parent.`);
  return { file, folder: dirname(file), raw, sha256: createHash('sha256').update(text).digest('hex') };
}

function declaration(name: string, value: unknown, file: string): Param {
  if (!plain(value) || typeof value.type !== 'string') throw Error(`${shown(file)}: params.${name} is not declared by a parent. To declare it, write params.${name}: {type: text, description: "..."}; to fill a parent's param, check the name.`);
  const extra = Object.keys(value).filter(key => !['type', 'description', 'default'].includes(key));
  if (extra.length) throw Error(`${shown(file)}: params.${name} has unknown field ${extra.join(', ')}. A param declaration has type, description and default.`);
  if (!(paramTypes as readonly string[]).includes(value.type)) throw Error(`${shown(file)}: params.${name}.type must be one of ${paramTypes.join(', ')}.`);
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw Error(`${shown(file)}: params.${name}: a param name is lowercase letters, digits and _, starting with a letter.`);
  const param: Param = { type: value.type as Param["type"], ...(typeof value.description === 'string' ? { description: value.description } : {}), declared_in: file };
  if (Object.hasOwn(value, 'default')) param.default = paramValue(param, value.default, file, `params.${name}.default`);
  return param;
}
/** A value for a param: checked against its type. A text value may be {file: PATH}, the text of a file beside FILE. */
function paramValue(param: Param, value: unknown, file: string, where: string): unknown {
  if (param.type === 'text' && plain(value) && Object.keys(value).length === 1 && typeof value.file === 'string') {
    const path = resolve(dirname(file), value.file);
    if (!existsSync(path)) throw Error(`${shown(file)}: ${where} reads ${value.file}, which does not exist (looked for ${path}).`);
    return readFileSync(path, 'utf8');
  }
  const ok = param.type === 'text' ? typeof value === 'string' : param.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : param.type === 'boolean' ? typeof value === 'boolean' : param.type === 'list' ? Array.isArray(value) : plain(value);
  if (!ok) throw Error(`${shown(file)}: ${where} must be ${param.type === 'text' ? 'text (or {file: PATH})' : `a ${param.type}`}${param.description ? ` (${param.description})` : ''}.`);
  return clone(value);
}

/**
 * JSON merge patch with one addition: maps merge key by key and the patch wins; null removes a key; a list replaces,
 * except {append: [...]}, which adds to the list below it.
 */
export function mergePatch(base: unknown, patch: unknown): unknown {
  if (plain(patch) && Object.keys(patch).length === 1 && Array.isArray(patch.append) && (base === undefined || Array.isArray(base)))
    return [...((base as unknown[]) ?? []), ...clone(patch.append)];
  if (!plain(patch)) return clone(patch);
  const out: Record<string, unknown> = plain(base) ? clone(base) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else Object.defineProperty(out, key, { value: mergePatch(out[key], value), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function applySteps(base: Record<string, any>, patch: unknown, level: Level, parentFile: string): Record<string, any> {
  if (!plain(patch)) throw Error(`${shown(level.file)}: steps must be a map of step IDs.`);
  const entries: Array<[string, any]> = Object.entries(base);
  const at = (id: string) => entries.findIndex(([key]) => key === id);
  const parentIds = () => entries.map(([key]) => key).join(', ');
  for (const [id, entry] of Object.entries(patch)) {
    if (entry === null) throw Error(`${shown(level.file)}: steps.${id} is empty. To remove a parent step, list it under remove_steps: [${id}].`);
    if (!plain(entry)) throw Error(`${shown(level.file)}: steps.${id} must be a map of step fields.`);
    const { insert_after, insert_before, replace, prompt, ...fields } = entry;
    if (insert_after !== undefined && insert_before !== undefined) throw Error(`${shown(level.file)}: steps.${id} has both insert_after and insert_before. Keep one.`);
    if (replace !== undefined && typeof replace !== 'boolean') throw Error(`${shown(level.file)}: steps.${id}.replace must be true or false.`);
    if (prompt !== undefined && typeof prompt !== 'string') throw Error(`${shown(level.file)}: steps.${id}.prompt must be text: it replaces the prompt of the step's do.`);
    const index = at(id);
    let step: any;
    if (index < 0) {
      if (insert_after === undefined && insert_before === undefined)
        throw Error(`${shown(level.file)}: steps.${id} names a step that ${shown(parentFile)} does not have (its steps: ${parentIds()}). To change a parent step, use its ID. To add a new step, give it insert_after: STEP_ID or insert_before: STEP_ID.`);
      if (replace) throw Error(`${shown(level.file)}: steps.${id} says replace: true, but ${shown(parentFile)} has no step ${id} to replace. Remove replace to add it as a new step.`);
      step = clone(fields);
    } else {
      step = replace ? clone(fields) : mergePatch(entries[index]![1], fields);
      entries.splice(index, 1);
    }
    if (prompt !== undefined) {
      if (!plain(step.do) || !['call', 'agent', 'session'].includes(step.do.kind) && step.do.prompt === undefined)
        throw Error(`${shown(level.file)}: steps.${id}.prompt changes the prompt of the step's do, but that step's do has no prompt (kind ${step.do?.kind ?? 'none'}). Patch do instead.`);
      step.do = { ...step.do, prompt };
    }
    const target = insert_after ?? insert_before;
    if (target !== undefined) {
      if (typeof target !== 'string' || at(target) < 0) throw Error(`${shown(level.file)}: steps.${id}.${insert_after !== undefined ? 'insert_after' : 'insert_before'}: ${String(target)} is not a step of the resolved Method (its steps: ${parentIds()}).`);
      entries.splice(at(target) + (insert_after !== undefined ? 1 : 0), 0, [id, step]);
    } else entries.splice(index < 0 ? entries.length : index, 0, [id, step]);
  }
  return Object.fromEntries(entries);
}

type Merged = { document: any; declared: Record<string, Param>; values: Record<string, { value: unknown; from: string }>; chain: Level[] };
function merge(file: string, seen: string[], from?: string): Merged {
  if (!existsSync(file)) throw Error(`${shown(from!)} extends ${relative(dirname(from!), file) || file}, which does not exist (looked for ${file}). Fix the extends: path in ${shown(from!)}.`);
  if (seen.includes(file)) throw Error(`The extends: lines make a cycle: ${[...seen.slice(seen.indexOf(file)), file].map(shown).join(' extends ')}. A Method cannot extend itself; remove one extends: line.`);
  const level = readLevel(file), raw = level.raw;
  const own = Object.fromEntries(Object.entries(raw).filter(([key]) => !(inheritanceKeys as readonly string[]).includes(key)));
  if (raw.extends === undefined) {
    for (const [id, step] of Object.entries(plain(raw.steps) ? raw.steps : {}))
      for (const key of stepKeys) if (plain(step) && Object.hasOwn(step, key))
        throw Error(`${shown(file)}: steps.${id}.${key} is only for a child file (one with extends:). This file has no parent.`);
    const declared = Object.fromEntries(Object.entries(raw.params ?? {}).map(([name, value]) => [name, declaration(name, value, file)]));
    return { document: own, declared, values: {}, chain: [level] };
  }
  const parentFile = resolve(level.folder, raw.extends);
  const base = merge(parentFile, [...seen, file], file);
  const declared = { ...base.declared }, values = { ...base.values };
  for (const [name, value] of Object.entries(raw.params ?? {})) {
    if (declared[name] && declared[name]!.declared_in !== file) values[name] = { value: paramValue(declared[name]!, value, file, `params.${name}`), from: file };
    else if (plain(value) && typeof value.type === 'string' && !declared[name]) declared[name] = declaration(name, value, file);
    else throw Error(`${shown(file)}: params.${name} is not a param of ${shown(parentFile)}${Object.keys(declared).length ? ` (its params: ${Object.keys(declared).join(', ')})` : ' (it declares none)'}. Check the spelling, or declare it with params.${name}: {type: text, description: "..."}.`);
  }
  const document: any = clone(base.document);
  // Each child is its own Method: the parent's id is never inherited.
  delete document.id;
  if (Array.isArray(raw.remove_steps)) for (const id of raw.remove_steps) {
    if (!plain(document.steps) || !Object.hasOwn(document.steps, id)) throw Error(`${shown(file)}: remove_steps names ${id}, which ${shown(parentFile)} does not have (its steps: ${Object.keys(document.steps ?? {}).join(', ')}).`);
    if (plain(raw.steps) && Object.hasOwn(raw.steps, id)) throw Error(`${shown(file)}: ${id} is both in remove_steps and under steps. Keep one.`);
    delete document.steps[id];
  }
  for (const [key, value] of Object.entries(own)) {
    if (key === 'steps') document.steps = applySteps(plain(document.steps) ? document.steps : {}, value, level, parentFile);
    else if (key === 'id') document.id = value;
    else if (value === null) delete document[key];
    else document[key] = mergePatch(document[key], value);
  }
  return { document, declared, values, chain: [level, ...base.chain] };
}

const whole = /^\{\{\s*params\.([a-z][a-z0-9_]*)\s*\}\}$/, anywhere = /\{\{\s*params\.([a-z][a-z0-9_]*)\s*\}\}/g;
function fill(value: unknown, params: Record<string, unknown>, path: string, file: string): unknown {
  if (typeof value === 'string') {
    const unknown = [...value.matchAll(anywhere)].map(m => m[1]!).filter(name => !Object.hasOwn(params, name));
    if (unknown.length) throw Error(`${shown(file)}: ${path} uses {{params.${unknown[0]}}}, but no file in the chain declares params.${unknown[0]}${Object.keys(params).length ? ` (declared: ${Object.keys(params).join(', ')})` : ''}. Declare it in the parent's params:, or fix the name.`);
    const one = whole.exec(value);
    if (one) return clone(params[one[1]!]);
    return value.replace(anywhere, (_, name: string) => { const v = params[name]; return typeof v === 'string' ? v : JSON.stringify(v); });
  }
  if (Array.isArray(value)) return value.map((item, i) => fill(item, params, `${path}[${i}]`, file));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, params, path ? `${path}.${key}` : key, file)]));
  return value;
}

/**
 * Resolve a parent or child file into one flat Method document. Errors name the file, the key and what to do. An
 * abstract file (a template) resolves with its params left as {{params.NAME}} where they have no value.
 */
export function resolveMethod(file: string): Resolved {
  const path = resolve(file);
  const merged = merge(path, []);
  const leaf = merged.chain[0]!, abstract = leaf.raw.abstract === true;
  const params: Record<string, unknown> = {}, missing: string[] = [];
  for (const [name, param] of Object.entries(merged.declared)) {
    if (merged.values[name]) params[name] = merged.values[name]!.value;
    else if (Object.hasOwn(param, 'default')) params[name] = param.default;
    else missing.push(name);
  }
  if (abstract) {
    // A template keeps its unfilled params as they are written.
    for (const name of missing) params[name] = `{{params.${name}}}`;
    return { document: fill(merged.document, params, '', path), chain: merged.chain, params, abstract };
  }
  if (missing.length) {
    const name = missing[0]!, param = merged.declared[name]!;
    throw Error(`${shown(path)} leaves params.${name} without a value${param.description ? ` (${param.description})` : ''}; ${shown(param.declared_in)} declares it with no default. Add it under params: in ${shown(path)}${missing.length > 1 ? ` (also missing: ${missing.slice(1).join(', ')})` : ''}, or mark ${shown(path)} abstract: true if it is a template.`);
  }
  const document = fill(merged.document, params, '', path) as any;
  // The id: line comes first after format:, as in any Method file.
  const { format, id, ...rest } = document;
  return { document: { ...(format !== undefined ? { format } : {}), ...(id !== undefined ? { id } : {}), ...rest }, chain: merged.chain, params, abstract };
}

export function abstractError(file: string) {
  return Error(`${shown(resolve(file))} is a template (abstract: true): it cannot run, be tested or be published by itself. Run, test or publish a child that extends it; method children ${shown(resolve(file))} lists them, and method test ${shown(resolve(file))} --children tests each child's cases.`);
}

/** One line for a version's record: which files the resolved Method came from. */
export function provenanceLine(source: { source: string; chain: Array<{ file: string; sha256: string }> }) {
  const [child, ...parents] = source.chain;
  return `Resolved from ${basename(child!.file)}${parents.map(p => ` extends ${basename(p.file)} (sha256 ${p.sha256.slice(0, 12)})`).join('')}.`;
}

/** The record beside a resolved Method file, or undefined for any other file. */
export function resolvedSource(file: string): { format: 'method-resolved/1'; source: string; chain: Array<{ file: string; sha256: string }>; params: Record<string, unknown>; files: Record<string, string> } | undefined {
  try {
    const record = JSON.parse(readFileSync(join(dirname(resolve(file)), marker), 'utf8'));
    return record?.format === 'method-resolved/1' && basename(record.source) === basename(file) ? record : undefined;
  } catch { return undefined; }
}

/** The files that a resolved Method needs in its folder: declared files, run entrypoints, effect fixtures. */
function neededFiles(document: any): string[] {
  const steps = Object.values(plain(document.steps) ? document.steps : {}) as any[];
  const executions = [...steps.flatMap(s => [s?.do, s?.check, ...Object.values(s?.effects ?? {}).flatMap((e: any) => [e?.observe, e?.judge])]),
    ...Object.values(document.tools ?? {}).map((t: any) => t?.run)].filter(Boolean);
  const fixtures = steps.flatMap(s => Object.values(s?.effects ?? {}).map((e: any) => e?.fixtures)).filter((f): f is string => typeof f === 'string');
  return [...new Set<string>([...(Array.isArray(document.files) ? document.files : []), ...executions.filter((e: any) => e.kind === 'run' && typeof e.entrypoint === 'string').map((e: any) => e.entrypoint), ...fixtures])];
}

const cacheRoot = () => process.env.METHOD_CACHE_DIR ?? join(process.env.HOME ?? '', '.cache', 'method');
/** The folder that holds the resolved Method of a child file: the same folder each time for the same file. */
export function resolvedFolder(file: string) {
  return join(cacheRoot(), 'resolved', createHash('sha256').update(resolve(file)).digest('hex').slice(0, 24));
}
function writeIfChanged(path: string, bytes: Buffer | string) {
  const data = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
  try { if (lstatSync(path).isFile() && readFileSync(path).equals(data)) return; } catch { /* new file */ }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try { if (lstatSync(path).isSymbolicLink() || lstatSync(path).isDirectory()) rmSync(path, { recursive: true, force: true }); } catch { /* none */ }
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, data, { mode: 0o600 }); renameSync(temporary, path);
}
function linkTo(path: string, target: string) {
  try { if (lstatSync(path).isSymbolicLink() && readlinkSync(path) === target) return; rmSync(path, { recursive: true, force: true }); } catch { /* none */ }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  symlinkSync(target, path, 'dir');
}

/**
 * Write the resolved Method of a child file, and the files it needs, to its own folder in Method's cache. Each file
 * comes from the nearest folder in the chain that has it: the child's folder first, then each parent's. The child's
 * cases/ folder, learned.json and files-connection folders are reached from there as well, so a run, a test, a new
 * case and a publish of the resolved Method use the child's own. Returns the path of the resolved Method file, which
 * has the child file's name.
 */
export function materialize(file: string, { refuseAbstract = true }: { refuseAbstract?: boolean } = {}): { file: string; resolved: Resolved } {
  const source = resolve(file), resolved = resolveMethod(source);
  if (resolved.abstract && refuseAbstract) throw abstractError(source);
  const folder = resolvedFolder(source), leaf = resolved.chain[0]!;
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  let previous: string[] = [];
  try { previous = Object.keys(JSON.parse(readFileSync(join(folder, marker), 'utf8')).files ?? {}); } catch { /* first time */ }
  const files: Record<string, string> = {};
  const copy = (name: string, from: string) => {
    const path = join(from, name);
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path, { recursive: true, withFileTypes: true }) as any[]) if (entry.isFile()) {
        const rel = relative(from, join(entry.parentPath ?? entry.path, entry.name)).split(sep).join('/');
        files[rel] = from; writeIfChanged(join(folder, rel), readFileSync(join(from, rel)));
      }
    } else { files[name] = from; writeIfChanged(join(folder, name), readFileSync(path)); }
  };
  for (const name of neededFiles(resolved.document)) {
    try { packagePath(name); } catch { throw Error(`${shown(source)}: the resolved Method names the file ${name}, which is not a path inside the Method's folder. Use a relative path without .. .`); }
    const owner = resolved.chain.find(level => existsSync(join(level.folder, name)));
    if (!owner) throw Error(`${shown(source)}: the resolved Method needs the file ${name}, and none of these folders has it: ${resolved.chain.map(l => shown(l.folder) || '.').join(', ')}. A parent's file is found beside the parent file; a child's beside the child file.`);
    copy(name, owner.folder);
  }
  for (const pair of lockFiles) {
    const owner = resolved.chain.find(level => existsSync(join(level.folder, pair[0]!)));
    if (owner) for (const name of pair) if (existsSync(join(owner.folder, name))) copy(name, owner.folder);
  }
  // Rules learned from corrections belong to the child's own Method.
  if (existsSync(join(leaf.folder, 'learned.json'))) copy('learned.json', leaf.folder);
  for (const stale of previous) if (!files[stale]) try { unlinkSync(join(folder, stale)); } catch { /* gone */ }
  // Cases and files connections stay in the child's folder; the resolved folder links to them.
  const links = ['cases', ...Object.entries(resolved.document.environment ?? {}).filter(([, d]: [string, any]) => d?.type === 'files').map(([name]) => name)];
  for (const name of links) {
    const owner = name === 'cases' ? (existsSync(join(leaf.folder, 'cases')) ? leaf : undefined) : resolved.chain.find(level => existsSync(join(level.folder, name)) && statSync(join(level.folder, name)).isDirectory());
    if (owner && !files[name]) linkTo(join(folder, name), join(owner.folder, name));
  }
  const header = `# Resolved by method from ${source}.\n# ${resolved.chain.slice(1).map(l => `extends ${l.file}`).join('\n# ')}\n# Do not edit this file: edit the child or the parent, and the next command resolves it again.\n`;
  const target = join(folder, basename(source));
  writeIfChanged(target, header + serializeWorkflow(resolved.document));
  writeIfChanged(join(folder, marker), JSON.stringify({ format: 'method-resolved/1', source, chain: resolved.chain.map(l => ({ file: l.file, sha256: l.sha256 })), params: resolved.params, files }, null, 2) + '\n');
  return { file: target, resolved };
}

/** Write `id: METHOD_ID` into a child file that has none, keeping its text: after format: or extends:. */
export function writeChildId(file: string, id: string) {
  const path = resolve(file), text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  let at = lines.findIndex(line => /^format:/.test(line));
  if (at < 0) at = lines.findIndex(line => /^extends:/.test(line));
  if (at < 0) throw Error(`${shown(path)} has neither a format: nor an extends: line at the top level; add id: ${id} by hand.`);
  lines.splice(at + 1, 0, `id: ${id}`);
  writeIfChanged(path, lines.join('\n'));
}

const skipFolders = new Set(['node_modules', '.git', '.venv', '__pycache__', '.method-runs', 'cases']);
/** Every .method file under ROOT (hidden folders, node_modules and cases left out). */
function methodFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (folder: string, depth: number) => {
    if (depth > 12) return;
    let entries; try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || skipFolders.has(entry.name)) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && /\.method$/i.test(entry.name)) found.push(path);
    }
  };
  walk(resolve(root), 0);
  return found.sort();
}
export type Child = { file: string; extends: string; depth: number; abstract: boolean; id?: string; name?: string };
/** The files under ROOT that extend PARENT, directly (depth 1) or through another child (depth 2 and more). */
export function childrenOf(parent: string, root: string): Child[] {
  const target = resolve(parent), result: Child[] = [];
  for (const file of methodFiles(root)) {
    if (file === target) continue;
    const seen = [file];
    let current = file, depth = 0, raw = parsed(file);
    if (!plain(raw) || typeof raw.extends !== 'string') continue;
    const first = raw;
    while (plain(raw) && typeof raw.extends === 'string' && depth < 20) {
      const next = resolve(dirname(current), raw.extends);
      depth++;
      if (next === target) { result.push({ file, extends: resolve(dirname(file), first.extends), depth, abstract: first.abstract === true, ...(typeof first.id === 'string' ? { id: first.id } : {}), ...(typeof first.name === 'string' ? { name: first.name } : {}) }); break; }
      if (seen.includes(next) || !existsSync(next)) break;
      seen.push(next); current = next; raw = parsed(next);
    }
  }
  return result;
}

const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
/** method children PARENT [--dir ROOT] */
export function childrenCommand(args: string[]) {
  const { file, dir } = parentArgs(args, 'Use method children PARENT.method [--dir ROOT].');
  const children = childrenOf(file, dir);
  print({ parent: file, searched: dir, children: children.map(c => ({ ...c, file: c.file, extends: c.extends })),
    note: children.length ? undefined : `No .method file under ${dir} extends ${basename(file)}. Search another folder with --dir ROOT.` });
}
function parentArgs(args: string[], usage: string) {
  const positionals: string[] = [];
  let dir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--dir') { dir = args[++i]; if (!dir) throw Error(usage); }
    else if (arg.startsWith('--dir=')) dir = arg.slice(6);
    else if (arg === '--children') continue;
    else positionals.push(arg);
  }
  if (positionals.length !== 1) throw Error(usage);
  const file = resolve(positionals[0]!);
  if (!existsSync(file)) throw Error(`${positionals[0]} does not exist.`);
  return { file, dir: resolve(dir ?? process.cwd()), rest: [] as string[] };
}

/**
 * method test PARENT --children [--dir ROOT] [--once]: each child that extends PARENT (and is not itself a template)
 * is resolved against the current parent and its recorded cases run. Fails when a child does not resolve or a case fails.
 */
export async function testChildrenCommand(args: string[]) {
  const once = args.includes('--once');
  const { file, dir } = parentArgs(args.filter(a => a !== '--once'), 'Use method test PARENT.method --children [--dir ROOT] [--once].');
  const children = childrenOf(file, dir).filter(c => !c.abstract);
  const { runCases, printedReport } = await import('./quality.js');
  const { listCases } = await import('@withmethod/runtime/cases.js');
  const rows: any[] = [];
  for (const child of children) {
    let resolvedFile: string;
    try { resolvedFile = materialize(child.file).file; }
    catch (error) { rows.push({ file: child.file, status: 'does_not_resolve', error: (error as Error).message }); continue; }
    const cases = (await listCases(resolvedFile)).filter((c: any) => c.status === 'active');
    if (!cases.length) { rows.push({ file: child.file, status: 'no_cases', note: 'This child has no recorded cases, so nothing checks it. Record one with method case new.' }); continue; }
    process.stderr.write(`Testing ${shown(child.file)} (${cases.length} case${cases.length === 1 ? '' : 's'}).\n`);
    try {
      const report = await runCases(resolvedFile, {}, once ? { once: true } : {});
      rows.push({ file: child.file, status: report.passed ? 'passed' : 'failed', counts: report.counts, ...(report.passed ? {} : { report: printedReport(report) }) });
    } catch (error) { rows.push({ file: child.file, status: 'failed', error: (error as Error).message }); }
  }
  const failed = rows.filter(r => ['failed', 'does_not_resolve'].includes(r.status));
  print({ parent: file, searched: dir, passed: failed.length === 0, children: rows,
    line: !children.length ? `No child under ${dir} extends ${basename(file)}.` : failed.length ? `${failed.length} of ${children.length} children fail with this parent: ${failed.map(r => basename(r.file)).join(', ')}.` : `All ${children.length} children pass their cases with this parent${rows.some(r => r.status === 'no_cases') ? ' (some have no cases)' : ''}.` });
  process.exitCode = failed.length ? 1 : 0;
}

/** method resolve CHILD [--out FILE]: the resolved Method as YAML, on stdout or in a new file. */
function resolveCommand(args: string[]) {
  const usage = 'Use method resolve FILE.method [--out NEW_FILE].';
  let out: string | undefined; const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) { if (args[i] === '--out') { out = args[++i]; if (!out) throw Error(usage); } else if (args[i]!.startsWith('--out=')) out = args[i]!.slice(6); else positionals.push(args[i]!); }
  if (positionals.length !== 1) throw Error(usage);
  const file = resolve(positionals[0]!);
  if (!existsSync(file)) throw Error(`${positionals[0]} does not exist.`);
  const resolved = resolveMethod(file);
  const text = (resolved.abstract ? `# ${shown(file)} is a template (abstract: true); params without a value stay as {{params.NAME}}.\n` : '') + serializeWorkflow(resolved.document);
  if (!out) { process.stdout.write(text); return; }
  if (existsSync(out)) throw Error(`${out} already exists. Choose a new output file.`);
  writeFileSync(out, text, { mode: 0o600, flag: 'wx' });
  print({ file: resolve(out), from: resolved.chain.map(l => l.file) });
}

/** Where a command names its Method file, for the commands that act on the resolved Method. */
function fileIndex(args: string[]): number | undefined {
  const [command, first] = args;
  if (['validate', 'steps', 'prompt', 'run', 'publish', 'explain', 'test'].includes(command ?? '')) return 1;
  if (command === 'check' && !['set', 'remove'].includes(first ?? '')) return 1;
  if (command === 'case' && ['new', 'retire', 'list'].includes(first ?? '')) return 2;
  return undefined;
}

/**
 * Before any command: a parent or child Method file named by the command is resolved. Returns the arguments to run
 * with (the resolved Method file in place of the child file), or undefined when the command was handled here. A
 * command on an ordinary Method file gets its arguments back unchanged.
 */
export async function resolveArgs(args: string[]): Promise<string[] | undefined> {
  const [command] = args;
  if (command === 'children') { childrenCommand(args.slice(1)); return undefined; }
  if (command === 'resolve') { resolveCommand(args.slice(1)); return undefined; }
  if (command === 'test' && args.includes('--children')) { await testChildrenCommand(args.slice(1)); return undefined; }
  if (command === 'show' && args.includes('--resolved')) {
    const rest = args.slice(1).filter(a => a !== '--resolved');
    const file = rest.find(a => !a.startsWith('--') && rest[rest.indexOf(a) - 1] !== '--path');
    if (!file || !existsSync(file)) throw Error('Use method show FILE.method --resolved [--path POINTER].');
    const at = rest.indexOf('--path'), pointer = at >= 0 ? rest[at + 1] ?? '' : '';
    const { at: atPointer } = await import('./authoring.js');
    const document = inheritingFile(file) ? resolveMethod(file).document : parseDocumentValue(readFileSync(file, 'utf8'));
    print(atPointer(document, pointer)); return undefined;
  }
  if (command === 'diff' && args[1] && args[2] && (inheritingFile(args[1]) || inheritingFile(args[2]))) {
    const { differences } = await import('./authoring.js');
    const read = (file: string) => inheritingFile(file) ? resolveMethod(file).document : parseDocumentValue(readFileSync(file, 'utf8'));
    print(differences(read(args[1]), read(args[2]))); return undefined;
  }
  const index = fileIndex(args);
  const file = index !== undefined ? args[index] : undefined;
  if (!file || !inheritingFile(file)) return args;
  const source = resolve(file);
  if (command === 'validate' || command === 'check') {
    try { const { file: target } = materialize(source); return [...args.slice(0, index), target, ...args.slice(index! + 1)]; }
    catch (error) {
      const abstract = /\(abstract: true\)/.test((error as Error).message);
      const issue = { level: 'error', code: abstract ? 'abstract_method' : 'invalid_inheritance', message: (error as Error).message, fix: abstract ? 'Validate a child that extends this template.' : 'Fix what the message names, then validate again.' };
      print({ valid: false, ...(command === 'validate' ? { definition: 'invalid', executed: false } : {}), error: issue.message, issues: [issue], issue_counts: { errors: 1, warnings: 0, notes: 0, accepted: 0 } });
      process.exitCode = 1; return undefined;
    }
  }
  // A version is saved under the child's own Method ID: the child file gets its id: line before it resolves.
  if ((command === 'publish' || command === 'run') && typeof parsed(source)?.id !== 'string' && !resolveMethod(source).abstract) {
    let save = command === 'publish';
    if (!save) try {
      const server = args.find((a, i) => args[i - 1] === '--server');
      const { MethodClient } = await import('./method-client.js');
      save = !!new MethodClient(server).token();
    } catch { /* not signed in */ }
    if (save) writeChildId(source, (await import('./versions.js')).newMethodId());
  }
  if (command === 'case') mkdirSync(join(dirname(source), 'cases'), { recursive: true, mode: 0o700 });
  const { file: target, resolved } = materialize(source);
  process.stderr.write(`${shown(source)} extends ${resolved.chain.slice(1).map(l => shown(l.file)).join(', which extends ')}; using the resolved Method (method resolve ${shown(source)} prints it).\n`);
  return [...args.slice(0, index), target, ...args.slice(index! + 1)];
}
