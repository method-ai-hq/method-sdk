import { spawnSync } from 'node:child_process';

/** What code analysis finds in a script. A model never adds to it. */
export type ScriptEffects = {
  network: string[]; secrets: string[]; env: string[]; reads: string[]; writes: string[]; runs: string[];
  input_fields: string[]; output_fields: string[];
};
/** Facts that the card does not show but that the prompt and the entity check use. */
export type ScriptFacts = { stdin_keys: string[]; output_keys: string[] };
export type Source = { path: string; text: string };
export type Language = 'python' | 'node';

export function scriptLanguage(entrypoint: string): Language | undefined {
  if (/\.py$/i.test(entrypoint)) return 'python';
  if (/\.(?:js|mjs|cjs|ts|mts|cts)$/i.test(entrypoint)) return 'node';
  return undefined;
}

const sorted = (values: Iterable<string>) => [...new Set([...values].filter(Boolean))].sort();
export function hostOf(url: string) {
  try { return new URL(url).hostname.toLowerCase() || undefined; } catch { return /^https?:\/\/([^/:?#\s'"`]+)/i.exec(url)?.[1]?.toLowerCase(); }
}

// The Python analysis uses the ast module of the local python3. The script reads [{path, text}] on stdin.
const pythonAnalysis = String.raw`
import ast, json, re, sys
from urllib.parse import urlparse
sources = json.load(sys.stdin)
found = {k: set() for k in ("hosts", "env", "reads", "writes", "runs", "stdin_keys", "output_keys")}
errors = []
URL = re.compile(r"https?://[^\s'\"<>{}]+")
HTTP = {"get", "post", "put", "patch", "delete", "head", "request", "stream", "urlopen", "Request", "Client", "AsyncClient"}
RUNS = {"run", "call", "check_call", "check_output", "Popen", "system", "popen"}
def text(node, names):
    if isinstance(node, ast.Constant) and isinstance(node.value, str): return node.value
    if isinstance(node, ast.JoinedStr):
        out = ""
        for value in node.values:
            if isinstance(value, ast.Constant) and isinstance(value.value, str): out += value.value
            else: return out if out.startswith("http") else None
        return out
    if isinstance(node, ast.Name) and node.id in names: return names[node.id]
    if isinstance(node, ast.Call) and dotted(node.func) in ("Path", "pathlib.Path") and node.args: return text(node.args[0], names)
    return None
def dotted(node):
    if isinstance(node, ast.Name): return node.id
    if isinstance(node, ast.Attribute):
        base = dotted(node.value)
        return base + "." + node.attr if base else node.attr
    if isinstance(node, ast.Call): return dotted(node.func) + "()"
    return ""
def host(url):
    try: return (urlparse(url).hostname or "").lower()
    except Exception: return ""
def is_stdin_load(node):
    if not isinstance(node, ast.Call): return False
    name = dotted(node.func)
    if name == "json.load" and node.args and dotted(node.args[0]) == "sys.stdin": return True
    if name == "json.loads" and node.args and dotted(node.args[0]) in ("sys.stdin.read()", "input()", "sys.stdin.buffer.read()"): return True
    return False
def dict_keys(node):
    return [k.value for k in node.keys if isinstance(k, ast.Constant) and isinstance(k.value, str)] if isinstance(node, ast.Dict) else []
for source in sources:
    try: tree = ast.parse(source["text"], filename=source["path"])
    except SyntaxError as error:
        errors.append(f"{source['path']}: {error.msg} (line {error.lineno})"); continue
    names, inputs, dicts, printed = {}, set(), {}, set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            target = node.targets[0].id
            value = text(node.value, {})
            if value is not None: names[target] = value
            if is_stdin_load(node.value): inputs.add(target)
            if isinstance(node.value, ast.Dict): dicts.setdefault(target, set()).update(dict_keys(node.value))
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            for url in URL.findall(node.value):
                if host(url): found["hosts"].add(host(url))
        if isinstance(node, ast.JoinedStr):
            value = text(node, {})
            if value and host(value): found["hosts"].add(host(value))
        if isinstance(node, ast.Subscript):
            base = dotted(node.value)
            key = node.slice.value if isinstance(node.slice, ast.Constant) and isinstance(node.slice.value, str) else None
            if key is None: continue
            if base in ("os.environ", "environ"): found["env"].add(key)
            if isinstance(node.value, ast.Name) and node.value.id in inputs and isinstance(node.ctx, ast.Load): found["stdin_keys"].add(key)
            if isinstance(node.value, ast.Name) and isinstance(node.ctx, ast.Store): dicts.setdefault(node.value.id, set()).add(key)
            if is_stdin_load(node.value): found["stdin_keys"].add(key)
        if not isinstance(node, ast.Call): continue
        name = dotted(node.func)
        last = name.split(".")[-1]
        first = text(node.args[0], names) if node.args else None
        if name in ("os.getenv", "os.environ.get", "environ.get", "getenv", "os.environ.setdefault") and first: found["env"].add(first)
        if last == "get" and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) and node.func.value.id in inputs and first: found["stdin_keys"].add(first)
        if name in ("open", "io.open", "builtins.open") and first is not None:
            mode = text(node.args[1], {}) if len(node.args) > 1 else next((text(k.value, {}) for k in node.keywords if k.arg == "mode"), "r") or "r"
            if any(c in mode for c in "wax"): found["writes"].add(first)
            else: found["reads"].add(first)
            if "+" in mode: found["reads"].add(first)
        if isinstance(node.func, ast.Attribute) and last in ("read_text", "read_bytes", "write_text", "write_bytes", "open", "unlink", "mkdir", "touch"):
            path = text(node.func.value, names)
            if path is not None and not name.startswith(("os.", "io.", "sys.", "builtins.")):
                (found["reads"] if last in ("read_text", "read_bytes", "open") else found["writes"]).add(path)
        if (name.startswith(("requests.", "httpx.", "urllib.request.", "aiohttp.")) or name in ("urlopen", "Request")) and last in HTTP and first and host(first):
            found["hosts"].add(host(first))
        if last in ("HTTPSConnection", "HTTPConnection") and first: found["hosts"].add(first.lower())
        if (name.startswith("subprocess.") or name.startswith("os.") or name in ("Popen", "check_output")) and last in RUNS and node.args:
            arg = node.args[0]
            if isinstance(arg, (ast.List, ast.Tuple)):
                parts = [text(e, names) for e in arg.elts]
                if parts and parts[0]: found["runs"].add(" ".join(p if p is not None else "…" for p in parts))
            elif first: found["runs"].add(first)
        dumped = None
        if name == "print" and node.args and isinstance(node.args[0], ast.Call) and dotted(node.args[0].func) == "json.dumps" and node.args[0].args: dumped = node.args[0].args[0]
        if name == "sys.stdout.write" and node.args and isinstance(node.args[0], ast.Call) and dotted(node.args[0].func) == "json.dumps" and node.args[0].args: dumped = node.args[0].args[0]
        if name == "json.dump" and len(node.args) > 1 and dotted(node.args[1]) == "sys.stdout": dumped = node.args[0]
        if dumped is not None:
            printed.update(dict_keys(dumped))
            if isinstance(dumped, ast.Name): printed.update(dicts.get(dumped.id, set()))
    found["output_keys"].update(printed)
print(json.dumps({**{k: sorted(v) for k, v in found.items()}, "errors": errors}))
`;

function pythonFacts(sources: Source[]) {
  const result = spawnSync('python3', ['-I', '-c', pythonAnalysis], { input: JSON.stringify(sources), encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(`Python analysis failed: ${(result.error?.message ?? result.stderr).trim().split('\n').at(-1)}`);
  return JSON.parse(result.stdout) as Record<'hosts' | 'env' | 'reads' | 'writes' | 'runs' | 'stdin_keys' | 'output_keys' | 'errors', string[]>;
}

/** A light token scan for JavaScript and TypeScript. It finds literal values only. */
function nodeFacts(sources: Source[]) {
  const found = { hosts: new Set<string>(), env: new Set<string>(), reads: new Set<string>(), writes: new Set<string>(), runs: new Set<string>(), stdin_keys: new Set<string>(), output_keys: new Set<string>() };
  // A string literal after one capture group: the quote is group 2 and the text group 3.
  const literal = String.raw`(['"\x60])([^'"\x60$\n]+)\2`;
  for (const { text: raw } of sources) {
    const text = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\x60\\])\/\/[^\n]*/g, '$1');
    for (const match of text.matchAll(/https?:\/\/[^\s'"\x60<>{}$]+/g)) { const host = hostOf(match[0]); if (host) found.hosts.add(host); }
    for (const match of text.matchAll(/\bhost(?:name)?\s*:\s*['"]([a-z0-9.-]+\.[a-z]{2,})['"]/gi)) found.hosts.add(match[1]!.toLowerCase());
    for (const match of text.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)|process\.env\[\s*['"]([^'"]+)['"]\s*\]/g)) found.env.add(match[1] ?? match[2]!);
    for (const match of text.matchAll(/\{([^{}]+)\}\s*=\s*process\.env\b/g))
      for (const name of match[1]!.split(',')) { const id = name.split(/[:=]/)[0]!.trim(); if (/^[A-Za-z_]\w*$/.test(id)) found.env.add(id); }
    for (const match of text.matchAll(new RegExp(String.raw`\b(readFileSync|readFile|createReadStream|readdirSync|readdir|existsSync|statSync|stat|access)\(\s*` + literal, 'g'))) found.reads.add(match[3]!);
    for (const match of text.matchAll(new RegExp(String.raw`\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|mkdirSync|mkdir|rmSync|rm|unlinkSync|unlink|renameSync|rename|copyFileSync|copyFile)\(\s*` + literal, 'g'))) found.writes.add(match[3]!);
    for (const match of text.matchAll(new RegExp(String.raw`\b(execSync|execFileSync|execFile|spawnSync|spawn|exec)\(\s*` + literal + String.raw`(?:\s*,\s*\[([^\]]*)\])?`, 'g'))) {
      const args = (match[4] ?? '').split(',').map(arg => arg.trim()).filter(Boolean).map(arg => /^(['"\x60])(.*)\1$/.exec(arg)?.[2] ?? '…');
      found.runs.add([match[3]!, ...args].join(' '));
    }
    const inputs = new Set<string>();
    for (const match of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?JSON\.parse\(/g)) inputs.add(match[1]!);
    for (const match of text.matchAll(/(?:const|let|var)\s+\{([^{}]+)\}\s*=\s*(?:await\s+)?JSON\.parse\(/g))
      for (const name of match[1]!.split(',')) { const id = name.split(/[:=]/)[0]!.trim(); if (/^[A-Za-z_$][\w$]*$/.test(id)) found.stdin_keys.add(id); }
    for (const name of inputs) for (const match of text.matchAll(new RegExp(String.raw`\b${name.replace(/\$/g, '\\$')}(?:\.([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])`, 'g'))) found.stdin_keys.add(match[1] ?? match[2]!);
    for (const match of text.matchAll(/JSON\.stringify\(\s*\{([^{}]*)\}/g))
      for (const part of match[1]!.split(',')) { const key = /^\s*(?:['"]([^'"]+)['"]|([A-Za-z_$][\w$]*))\s*(?::|$)/.exec(part); if (key) found.output_keys.add(key[1] ?? key[2]!); }
  }
  return { ...Object.fromEntries(Object.entries(found).map(([key, value]) => [key, sorted(value)])), errors: [] as string[] } as Record<keyof typeof found | 'errors', string[]>;
}

/**
 * Effects of a `run` step's entrypoint and declared helper files. Input and output fields come from the step's
 * declaration; secrets are the declared secrets whose names appear in the code.
 */
export function staticEffects(language: Language, sources: Source[], step: any, secrets: string[] = []): { effects: ScriptEffects; facts: ScriptFacts; errors: string[] } {
  const found = language === 'python' ? pythonFacts(sources) : nodeFacts(sources);
  const code = sources.map(source => source.text).join('\n');
  const used = sorted(secrets.filter(name => new RegExp(String.raw`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`).test(code)));
  return {
    effects: {
      network: sorted(found.hosts), secrets: used, env: sorted(found.env.filter(name => !used.includes(name))),
      reads: sorted(found.reads), writes: sorted(found.writes), runs: sorted(found.runs),
      input_fields: Object.keys(step?.in ?? {}).sort(), output_fields: Object.keys(step?.out ?? {}).sort(),
    },
    facts: { stdin_keys: sorted(found.stdin_keys), output_keys: sorted(found.output_keys) },
    errors: found.errors,
  };
}
