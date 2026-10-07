/** Effect observation, recorded cases, library observers, and method learn. */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { observeRun, pendingRuns } from "@withmethod/runtime/observe.js";
import { createCase, retireCase, listCases, testSuite, defaultCasesDir } from "@withmethod/runtime/cases.js";
import { authoringPath, editDocument, readDocument } from "./authoring.js";
import { localSetup } from "./local-setup.js";
import { resolveAgentProfiles, checkAgents } from "./capabilities.js";
import { prepareRuntime, methodCache } from "./prepare.js";
import { writePrivateJson } from "./files.js";

const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
const json = (path: string | undefined) => path ? JSON.parse(readFileSync(authoringPath(path), "utf8")) : undefined;

/** The same runtime preparation as method run, without starting a run. */
export async function preparedConfig(file: string, flags: { config?: string; workspace?: string; agent?: string }) {
  const setup = await localSetup(file, flags);
  const method = readDocument(file);
  const config = setup.config;
  config.models = await resolveAgentProfiles(method, config, flags.agent);
  await checkAgents(config.models);
  const prepared = await prepareRuntime(setup.sourceRoot, config, method);
  return { config: prepared.config, sourceRoot: setup.sourceRoot, processPath: prepared.processPath, prepareBundle: prepared.prepareBundle };
}

/** Run directories that this computer's Method runs use by default. */
export const defaultRunRoots = () => [resolve(".method-runs"), join(methodCache(), "runs")];

export async function observeCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { pending: { type: "string", multiple: true }, config: { type: "string" }, sync: { type: "boolean" } } });
  const dirs = positionals.map(dir => authoringPath(dir));
  if (!dirs.length) for (const root of values.pending ?? defaultRunRoots()) dirs.push(...await pendingRuns(authoringPath(root)));
  const config = values.config ? readDocument(values.config) : undefined;
  const runs = [];
  for (const dir of dirs) {
    try {
      const result = await observeRun(dir, { config });
      let dashboard: string | undefined;
      // A late observation can change a synced run; upload the new record so the dashboard shows it.
      if (result.changed && existsSync(join(dir, "method-sync.json")) && values.sync !== false) {
        try { const { MethodSync } = await import("./method-sync.js"); await MethodSync.retry(dir); dashboard = "saved"; }
        catch (error: any) { dashboard = `not saved: ${error.message}. Retry with method sync ${dir}`; }
      }
      runs.push({ run_dir: dir, status: result.status, changed: result.changed, observed: result.observed.map((e: any) => ({ effect: e.effect, verdict: e.verdict, reason: e.reason })),
        next_observation_at: result.effects?.next_observation_at ?? null, ...(dashboard ? { dashboard } : {}) });
    } catch (error: any) { runs.push({ run_dir: dir, error: error.message, code: error.code ?? "observe_failed" }); }
  }
  print({ runs, note: dirs.length ? undefined : "No run has open effects." });
  if (runs.some(run => "error" in run)) process.exitCode = 1;
}

export async function testCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { case: { type: "string", multiple: true }, new: { type: "string", multiple: true }, baseline: { type: "string" }, cases: { type: "string" }, config: { type: "string" }, workspace: { type: "string" }, agent: { type: "string" } } });
  const file = positionals[0];
  if (!file || positionals.length !== 1) throw Error("Use method test FILE [--case ID]... [--baseline OLD_FILE --new ID]...");
  const prepared = await preparedConfig(authoringPath(file), values);
  const report = await testSuite(authoringPath(file), prepared.config, {
    casesDir: values.cases ? authoringPath(values.cases) : undefined, ids: values.case, baseline: values.baseline ? authoringPath(values.baseline) : undefined, newIds: values.new ?? [],
    runOptions: { processPath: prepared.processPath, prepareBundle: prepared.prepareBundle, ...(values.agent ? { agent: values.agent } : {}) },
  });
  print(report);
  process.exitCode = report.passed ? 0 : 1;
}

export async function caseCommand(args: string[]) {
  const text = { type: "string" } as const;
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { run: text, id: text, note: text, expect: text, observations: text, redact: text, runs: text, "min-pass": text,
    author: text, reason: text, by: text, cases: text, config: text, workspace: text, "retention-days": text, supersedes: { type: "string", multiple: true } } });
  const [action, file, id] = positionals as string[];
  if (!file || !["new", "retire", "list"].includes(action ?? "")) throw Error("Use method case new|retire|list FILE. See method case --help.");
  const methodFile = authoringPath(file);
  const casesDir = values.cases ? authoringPath(values.cases) : undefined;
  const integer = (value: unknown, name: string) => { if (value === undefined) return undefined; const n = Number(value); if (!Number.isSafeInteger(n)) throw Error(`${name} must be an integer.`); return n; };
  if (action === "list") return print((await listCases(methodFile, casesDir)).map(({ id, status, note, created, superseded_by, retention_until }: any) => ({ id, status, note, created, superseded_by, retention_until })));
  if (action === "retire") { if (!id || !values.reason) throw Error("Supply the case ID and --reason."); await retireCase(methodFile, id, { by: values.by ?? null, reason: values.reason, casesDir }); return print({ retired: id }); }
  if (!values.run || !values.id || !values.note || !values.expect) throw Error("Supply --run, --id, --note, and --expect.");
  const { config } = await localSetup(methodFile, { ...(values.config ? { config: values.config } : {}), ...(values.workspace ? { workspace: values.workspace } : {}) });
  print(await createCase({ methodFile, runDir: authoringPath(values.run), id: values.id, note: values.note, author: values.author ?? null, expect: json(values.expect),
    observations: json(values.observations), redact: json(values.redact), runs: integer(values.runs, "--runs"), minPass: integer(values["min-pass"], "--min-pass"),
    retentionDays: integer(values["retention-days"], "--retention-days"), supersedes: values.supersedes ?? [], casesDir, config }));
}

const library = () => fileURLToPath(new URL("../observers/", import.meta.url));
export function observerLibrary() {
  return readdirSync(library()).filter(name => existsSync(join(library(), name, "observer.json"))).sort()
    .map(name => ({ name, ...JSON.parse(readFileSync(join(library(), name, "observer.json"), "utf8")) }));
}

/** Copy a reviewed observer into the Method folder and declare the effect on a step. */
export async function effectCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { observer: { type: "string" }, connection: { type: "string" }, intent: { type: "string" }, in: { type: "string", multiple: true }, set: { type: "string", multiple: true }, horizon: { type: "string" }, blocking: { type: "boolean" } } });
  const [action, file, stepId, name] = positionals;
  if (action === "list") return print(observerLibrary().map(({ name, description, needs }: any) => ({ name, description, needs })));
  if (action !== "add" || !file || !stepId || !name || !values.observer) throw Error("Use method effect add FILE STEP NAME --observer OBSERVER [--connection NAME] [--in ALIAS=REF]... [--set KEY=VALUE]... or method effect list.");
  const entry = observerLibrary().find(item => item.name === values.observer);
  if (!entry) throw Error(`Unknown observer ${values.observer}. Use method effect list.`);
  const methodFile = authoringPath(file), folder = dirname(methodFile), target = join(folder, "observers", entry.name);
  const connection = values.connection ?? entry.connection.name;
  const bindings = Object.fromEntries((values.in ?? []).map(pair => { const at = pair.indexOf("="); if (at < 1) throw Error("Use --in ALIAS=REFERENCE."); return [pair.slice(0, at), pair.slice(at + 1)]; }));
  for (const required of entry.inputs ?? []) if (!Object.hasOwn(bindings, required.alias)) throw Error(`The ${entry.name} observer needs --in ${required.alias}=REFERENCE: ${required.description}`);
  const settings: Record<string, string> = { connection, ...Object.fromEntries((values.set ?? []).map(pair => { const at = pair.indexOf("="); if (at < 1) throw Error("Use --set KEY=VALUE."); return [pair.slice(0, at), pair.slice(at + 1)]; })) };
  // Fill the observer's own placeholders; {token} and {inputs.NAME} stay for the observer to fill at run time.
  const observerArgs = (entry.effect.args ?? []).map((arg: string) => arg.replace(/\{([a-z_]+)\}/g, (match, key) => {
    if (key === "token") return match;
    if (!Object.hasOwn(settings, key)) throw Error(`The ${entry.name} observer needs --set ${key}=VALUE. ${entry.needs}`);
    return settings[key]!;
  }));
  const result = editDocument(methodFile, doc => {
    const step = doc.steps?.[stepId];
    if (!step) throw Error(`Step not found: ${stepId}.`);
    if (!(step.changes ?? []).some((c: string) => c.startsWith("environment."))) throw Error(`${stepId} changes no environment. Declare the changed connection in changes first.`);
    doc.format = "method/3.3";
    doc.environment ??= {};
    const existing = doc.environment[connection];
    if (existing && existing.role !== "observer") throw Error(`Environment ${connection} exists and is not an observer connection. Choose --connection NAME.`);
    doc.environment[connection] = { type: entry.connection.type, description: entry.connection.description, role: "observer" };
    const path = (file: string) => relative(folder, join(target, file)).split("\\").join("/");
    step.effects = { ...step.effects, [name]: {
      intent: values.intent ?? entry.effect.intent, in: bindings,
      observe: { kind: "run", runtime: entry.effect.observe_runtime ?? "node", entrypoint: path("fetch.mjs"), ...(observerArgs.length ? { args: observerArgs } : {}) },
      judge: { kind: "run", runtime: "node", entrypoint: path("judge.mjs") }, fixtures: path("fixtures"),
      schedule: { ...entry.effect.schedule, ...(values.horizon ? { horizon: values.horizon } : {}) }, confirm: entry.effect.confirm,
      ...(values.blocking ? { blocking: true } : {}),
    } };
    return doc;
  });
  if (!existsSync(target)) { mkdirSync(dirname(target), { recursive: true }); cpSync(join(library(), entry.name), target, { recursive: true }); }
  print({ file: methodFile, step: stepId, effect: name, observer: entry.name, copied_to: target, connection,
    setup: entry.setup, workflow: result });
}

/** Run the shipped learn Method on one correction. */
export async function learnCommand(args: string[], run: (file: string, flags: any) => Promise<any>) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { run: { type: "string" }, note: { type: "string" }, cases: { type: "string" }, "runs-root": { type: "string" }, author: { type: "string" }, "no-git": { type: "boolean" },
    config: { type: "string" }, workspace: { type: "string" }, agent: { type: "string" }, resume: { type: "boolean" }, "run-dir": { type: "string" }, human: { type: "string" }, retry: { type: "string", multiple: true } } });
  const learnFile = fileURLToPath(new URL("../learn/learn.method", import.meta.url));
  const learnFlags = { config: join(dirname(learnFile), "runtime.json"), workspace: dirname(learnFile), agent: values.agent, "run-dir": values["run-dir"], resume: values.resume, human: values.human, retry: values.retry };
  process.env.METHOD_LEARN_RUNTIME = createRequire(import.meta.url).resolve("@withmethod/runtime");
  if (values.resume) {
    if (!values["run-dir"]) throw Error("Resume needs --run-dir.");
    return run(learnFile, learnFlags);
  }
  const [file] = positionals;
  if (!file || !values.run || !values.note) throw Error('Use method learn FILE --run RUN_DIR --note "What was wrong".');
  const methodFile = authoringPath(file), runDir = authoringPath(values.run);
  if (!existsSync(join(runDir, "events.jsonl"))) throw Error(`No run record in ${runDir}.`);
  // Learn's scripts test the target Method with the same preparation as method run.
  const prepared = await preparedConfig(methodFile, values);
  const work = join(methodCache(), "learn", randomUUID());
  mkdirSync(work, { recursive: true, mode: 0o700 });
  writePrivateJson(join(work, "prepared.json"), { config: prepared.config, process_path: prepared.processPath, source_root: prepared.sourceRoot });
  const inputs = { method_file: methodFile, run_dir: runDir, note: values.note, cases_dir: values.cases ? authoringPath(values.cases) : defaultCasesDir(methodFile),
    runs_root: values["runs-root"] ? authoringPath(values["runs-root"]) : dirname(runDir), prepared_file: join(work, "prepared.json"), author: values.author ?? "", git: !values["no-git"] };
  writePrivateJson(join(work, "inputs.json"), inputs);
  const folder = dirname(methodFile);
  const config = JSON.parse(readFileSync(learnFlags.config, "utf8"));
  config.environment = { ...config.environment, method_folder: folder, method_folder_reader: folder };
  writePrivateJson(join(work, "runtime.json"), config);
  return run(learnFile, { ...learnFlags, config: join(work, "runtime.json"), inputs: join(work, "inputs.json"), "run-dir": values["run-dir"] ?? join(work, "run") });
}
