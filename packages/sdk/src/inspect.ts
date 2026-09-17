import { attachResultFiles } from "./result-files.js";
import { inspectCurrentRun } from "./current-inspection.js";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { semanticDigest } from "../../contracts/src/identity.js";
import { loadWorkflow } from "../../workflow-language/src/validate.js";
import { InspectionSchema, type RunInspection } from "../../workflow-language/src/inspection.js";

/** Export known run records. File previews are opt-in and must match saved hashes. */
export function inspectRun(directory: string, options: { includeFiles?: boolean; /** Internal: only called synchronously by the owning SDK process. */ activeSnapshot?: boolean } = {}): RunInspection {
  const requested = resolve(directory);
  if (requested.split(sep).includes("sensitive")) throw Error("INSPECT_PATH: choose a run outside sensitive/.");
  const root = realpathSync(requested);
  if (root.split(sep).includes("sensitive")) throw Error("INSPECT_PATH: choose a run outside sensitive/.");
  if (existsSync(join(root, "method.json"))) return inspectCurrentRun(root, options.activeSnapshot, options.includeFiles);
  const active = existsSync(join(root, "run.lock"));
  if (active && (!options.activeSnapshot || readFileSync(join(root, "run.lock"), "utf8") !== String(process.pid))) throw Error("RUN_ACTIVE: finish the run before exporting its records.");
  const read = (name: string, optional = false): any => {
    const path = join(root, name);
    if (optional && !existsSync(path)) return undefined;
    const actual = realpathSync(path);
    if (!actual.startsWith(root + sep) || actual.split(sep).includes("sensitive")) throw Error("INSPECT_PATH: a saved record points outside the run.");
    return JSON.parse(readFileSync(actual, "utf8"));
  };
  const workflow = loadWorkflow(read(existsSync(join(root, "method.method")) ? "method.method" : "workflow.workflow"));
  const inputs = read("inputs.json"), resources = read("resources.json"), manifest = read("run.json"), journal = read("journal.json"), result = active ? undefined : read("result.json", true);
  if (manifest.workflow_sha256 !== semanticDigest(workflow) || manifest.inputs_sha256 !== semanticDigest(inputs) || manifest.resources_sha256 !== semanticDigest(resources)
    || journal.fingerprint !== manifest.fingerprint || journal.run_id !== manifest.run_id || result && result.run_id !== manifest.run_id) throw Error("RUN_CHANGED: saved run identities do not match.");
  const eventsPath = join(root, "events.jsonl");
  const events = existsSync(eventsPath) ? (() => {
    const actual = realpathSync(eventsPath);
    if (!actual.startsWith(root + sep) || actual.split(sep).includes("sensitive")) throw Error("INSPECT_PATH: events point outside the run.");
    return readFileSync(actual, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  })() : [];
  const invocations: RunInspection["invocations"] = {};
  for (const id of new Set([...Object.keys(journal.entries), ...Object.keys(result?.steps ?? {})])) {
    const stepId = id.split("/")[0]!, step = workflow.steps[stepId];
    if (!step || id !== stepId && !step.each) throw Error("INSPECT_STEP: unrecognized step in saved records.");
    const entry = journal.entries[id], row = result?.steps[id] ?? entry?.row;
    if (entry && (!Number.isInteger(entry.attempt) || entry.attempt < 1)) throw Error("INSPECT_ATTEMPT: invalid saved attempt.");
    const candidate = entry?.candidate;
    invocations[id] = { step_id: stepId, status: row?.status ?? entry?.phase ?? "unknown", verification: row?.verification ?? (step.check ? "checked" : "unchecked"),
      ...(entry?.inputs ? { inputs: entry.inputs } : {}), ...(row?.outputs ?? candidate?.outputs ? { outputs: row?.outputs ?? candidate.outputs } : {}), ...(row?.failure ? { failure: row.failure, error: row.failure.observed } : {}),
      checks: row?.checks ?? [], changes: entry?.change_records ?? {},
      events: events.filter((event: any) => event.step === id).map(({ at, type, detail }: any) => ({ at, type, ...(detail ? { detail } : {}) })),
    };
  }
  const files = options.includeFiles ? attachResultFiles(workflow, invocations, [root, ...Object.values(resources).flatMap((value: any) => typeof value?.path === "string" ? [value.path] : [])]) : undefined;
  const environment = Object.fromEntries(Object.keys(workflow.environment ?? {}).flatMap(id => { const record = read(`environment/${id}.json`, true); return record ? [[id, record]] : []; }));
  return InspectionSchema.parse({ environment, state: journal.initial_state, ...(options.includeFiles ? { files } : {}), schema: "workflow-inspection/2", workflow, run_id: manifest.run_id, local_run_directory: root, status: active ? "running" : result?.status ?? "incomplete", ...(result?.error ? { error: result.error, failure: result.failure } : {}), inputs, resources, invocations });
}
