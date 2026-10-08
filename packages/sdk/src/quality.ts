/** Effect observation, recorded cases, the save gate, and library observers. */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
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

/** A fingerprint of a Method and the files it runs, to tell whether its cases were checked since the last change. */
export function methodFingerprint(file: string) {
  const folder = dirname(file), method = readDocument(file);
  const parts: string[] = [readFileSync(file, "utf8")];
  const paths = new Set<string>(method.files ?? []);
  for (const step of Object.values(method.steps ?? {}) as any[]) {
    for (const exec of [step.do, step.check]) if (exec?.kind === "run") paths.add(exec.entrypoint);
    for (const effect of Object.values(step.effects ?? {}) as any[]) for (const exec of [effect.observe, effect.judge]) if (exec?.kind === "run") paths.add(exec.entrypoint);
  }
  for (const path of [...paths].sort()) { try { parts.push(path, readFileSync(join(folder, path), "utf8")); } catch { parts.push(path, "missing"); } }
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
const checkedFile = (file: string) => join(methodCache(), "checked", createHash("sha256").update(file).digest("hex") + ".json");
function recordChecked(file: string, report: any) {
  mkdirSync(dirname(checkedFile(file)), { recursive: true, mode: 0o700 });
  writePrivateJson(checkedFile(file), { file, fingerprint: methodFingerprint(file), passed: report.passed, cases: report.cases.length, at: new Date().toISOString() });
}
/** One line for method run when the Method changed since its cases last passed. */
export async function casesNotice(file: string) {
  const cases = (await listCases(file)).filter((c: any) => c.status === "active");
  if (!cases.length) return undefined;
  let checked: any;
  try { checked = JSON.parse(readFileSync(checkedFile(file), "utf8")); } catch { /* never checked */ }
  if (checked?.passed && checked.fingerprint === methodFingerprint(file)) return undefined;
  return `${cases.length} case${cases.length === 1 ? "" : "s"} not checked since this Method changed: method test ${file}`;
}

/** Run the cases of a Method with the same preparation as method run. */
export async function runCases(file: string, flags: { config?: string; workspace?: string; agent?: string }, options: { casesDir?: string | undefined; ids?: string[] | undefined; baseline?: string | undefined; newIds?: string[] } = {}) {
  const prepared = await preparedConfig(file, flags);
  const report = await testSuite(file, prepared.config, { ...options,
    runOptions: { processPath: prepared.processPath, prepareBundle: prepared.prepareBundle, ...(flags.agent ? { agent: flags.agent } : {}) } });
  if (!options.ids && !options.casesDir) recordChecked(file, report);
  return report;
}

export async function testCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { case: { type: "string", multiple: true }, new: { type: "string", multiple: true }, baseline: { type: "string" }, cases: { type: "string" }, config: { type: "string" }, workspace: { type: "string" }, agent: { type: "string" } } });
  const file = positionals[0];
  if (!file || positionals.length !== 1) throw Error("Use method test FILE [--case ID]... [--baseline OLD_FILE] [--new ID]...");
  const report = await runCases(authoringPath(file), values, { casesDir: values.cases ? authoringPath(values.cases) : undefined, ids: values.case,
    baseline: values.baseline ? authoringPath(values.baseline) : undefined, newIds: values.new ?? [] });
  print(report);
  process.exitCode = report.passed ? 0 : 1;
}

/**
 * The save gate: a version that breaks an approved case is refused, unless each failing case is accepted with a
 * reason. Returns a line for the version's record.
 */
export async function caseGate(file: string, accept: string[] = [], reason?: string) {
  const cases = (await listCases(file)).filter((c: any) => c.status === "active");
  if (!cases.length) return { line: undefined, report: undefined };
  const report = await runCases(file, {});
  const failing = report.cases.filter((c: any) => !["pass", "fixed"].includes(c.verdict));
  const unaccepted = failing.filter((c: any) => !accept.includes(c.id));
  if (unaccepted.length) throw Object.assign(Error(`This version breaks ${unaccepted.length} approved case${unaccepted.length === 1 ? "" : "s"}: ${unaccepted.map((c: any) => `${c.id} (${c.verdict}: ${c.note})`).join("; ")}. Fix the Method and run method test, or retire a case whose rule no longer applies with method case retire. To save anyway, add --accept-failing-case ${unaccepted.map((c: any) => c.id).join(",")} with --reason.`), { code: "cases_failed" });
  if (failing.length && !reason) throw Error("Give --reason for accepting a failing case.");
  return { report, line: failing.length ? `Cases: ${report.cases.length - failing.length} of ${report.cases.length} passed; accepted failing ${failing.map((c: any) => c.id).join(", ")}.` : `Cases: ${report.cases.length} of ${report.cases.length} passed.` };
}

export async function caseCommand(args: string[]) {
  const text = { type: "string" } as const;
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { run: text, "passing-run": text, id: text, note: text, rubric: { type: "string", multiple: true }, ref: text, context: { type: "string", multiple: true }, expect: text,
    observations: text, redact: text, runs: text, "min-pass": text, author: text, reason: text, by: text, cases: text, config: text, workspace: text, agent: text,
    "retention-days": text, supersedes: { type: "string", multiple: true } } });
  const [action, file, id] = positionals as string[];
  if (!file || !["new", "retire", "list"].includes(action ?? "")) throw Error("Use method case new|retire|list FILE. See method help case new.");
  const methodFile = authoringPath(file);
  const casesDir = values.cases ? authoringPath(values.cases) : undefined;
  const integer = (value: unknown, name: string) => { if (value === undefined) return undefined; const n = Number(value); if (!Number.isSafeInteger(n)) throw Error(`${name} must be an integer.`); return n; };
  if (action === "list") return print((await listCases(methodFile, casesDir)).map(({ id, status, note, created, superseded_by, retention_until }: any) => ({ id, status, note, created, superseded_by, retention_until })));
  if (action === "retire") { if (!id || !values.reason) throw Error("Supply the case ID and --reason."); await retireCase(methodFile, id, { by: values.by ?? null, reason: values.reason, casesDir }); return print({ retired: id }); }
  if (!values.id || !values.note || (!values.run && !values["passing-run"])) throw Error('Supply --id, --note "the person\'s words", and --run (the run that went wrong) or --passing-run (a run that was right).');
  if (!values.rubric?.length && !values.expect) throw Error('Say what must be true with --rubric "plain sentence" (repeatable), or give --expect FILE.');
  const prepared = await preparedConfig(methodFile, { ...(values.config ? { config: values.config } : {}), ...(values.workspace ? { workspace: values.workspace } : {}), ...(values.agent ? { agent: values.agent } : {}) });
  print(await createCase({ methodFile, runDir: values.run ? authoringPath(values.run) : undefined, passingRun: values["passing-run"] ? authoringPath(values["passing-run"]) : undefined,
    id: values.id, note: values.note, author: values.author ?? null, rubric: values.rubric ?? [], ref: values.ref, context: values.context ?? [], expect: json(values.expect) ?? [],
    observations: json(values.observations), redact: json(values.redact), runs: integer(values.runs, "--runs"), minPass: integer(values["min-pass"], "--min-pass"),
    retentionDays: integer(values["retention-days"], "--retention-days"), supersedes: values.supersedes ?? [], casesDir, config: prepared.config,
    options: { runOptions: { processPath: prepared.processPath, ...(values.agent ? { agent: values.agent } : {}) } } }));
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
