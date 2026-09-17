import { isCurrentWorkflow } from "../../workflow-language/src/schema.js";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { semanticDigest } from "../../contracts/src/identity.js";
import { type Workflow, type Json, type Shape, type LegacyStep as Step } from "../../workflow-language/src/schema.js";
import { loadWorkflow, stepDependencies, shapeErrors, shapeObject } from "../../workflow-language/src/validate.js";
import { DecisionSchema, StepResultSchema, type Connections, type Executor, type Verifier, type StepRequest, type StepResult, type RunResult, type Event, type Failure } from "./contracts.js";
import { readValue, renderInstructions, equal } from "./values.js";
import { assertValue } from "./checks.js";
import { fileArtifacts, checkedFile, writePrivateJson } from "./files.js";
import { environmentResources, safePath, readState } from "./environment.js";

export type RunOptions = {
  workflow: Workflow; inputs: Record<string, Json>; directory: string; workspace: string;
  resources?: Connections; state_directory?: string | undefined; executor: Executor; verifier?: Verifier;
  resume?: boolean; runtime_revision: string; concurrency?: number | undefined; timeout_ms?: number | undefined;
  human?: { execute?: (request: StepRequest) => Promise<StepResult | undefined> };
  retry_invocations?: string[]; recoveries?: Record<string, StepResult>;
  onEvent?: (event: Event) => void; onStart?: () => Promise<void>;
};
type Entry = { step_id: string; inputs: Record<string, Json>; attempt: number; phase: "started" | "returned" | "passed" | "failed"; candidate?: StepResult; row?: RunResult["steps"][string]; change_records?: Record<string, any> };
type Journal = { schema: "workflow-journal/2"; fingerprint: string; run_id: string; started_at: string; initial_state: Record<string, Json>; current_state: Record<string, Json>; entries: Record<string, Entry> };
class Stop extends Error { constructor(readonly failure: Failure, readonly attention = false) { super(failure.observed); } }
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
function stop(phase: Failure["phase"], expected: string, observed: string, evidence: string[] = [], attention = false): never { throw new Stop({ phase, expected, observed, evidence }, attention); }

/** The runner owns dispatch records, state changes, hashes and check context. */
export async function runWorkflow(options: RunOptions): Promise<RunResult> {
  const workflow = loadWorkflow(options.workflow), directory = safePath(options.directory), workspace = safePath(options.workspace);
  if (isCurrentWorkflow(workflow)) throw Error("Use runMethod(file, config, options) for this method.");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, "run.lock");
  let fd: number;
  try { fd = openSync(lock, "wx", 0o600); } catch { throw Error("RUN_LOCKED: this run is already active. Inspect the process before removing a stale lock."); }
  writeFileSync(fd, String(process.pid));
  let stateLock: { fd: number; path: string } | undefined;
  const event = (type: string, step?: string, detail?: string) => { const e: Event = { at: new Date().toISOString(), type, ...(step ? { step } : {}), ...(detail ? { detail } : {}) }; appendFileSync(join(directory, "events.jsonl"), JSON.stringify(e) + "\n", { mode: 0o600 }); options.onEvent?.(e); };
  const result: RunResult = { schema: "workflow-run/2", run_id: randomUUID(), status: "succeeded", outputs: {}, steps: {} };
  try {
    if (!Number.isInteger(options.concurrency ?? 4) || (options.concurrency ?? 4) < 1 || (options.concurrency ?? 4) > 32 || !Number.isFinite(options.timeout_ms ?? 300000) || (options.timeout_ms ?? 300000) <= 0) stop("input", "A concurrency from 1 to 32 and a positive process time limit", "Invalid execution settings.");
    const inputs = structuredClone(options.inputs);
    for (const [name, definition] of Object.entries(workflow.inputs ?? {})) {
      if (!Object.hasOwn(inputs, name) && definition.default !== undefined) inputs[name] = structuredClone(definition.default);
      const errors = shapeErrors(definition, inputs[name], `inputs.${name}`); if (errors.length) stop("input", definition.description ?? name, errors.join("\n"));
    }
    for (const key of Object.keys(inputs)) if (!workflow.inputs?.[key]) stop("input", "Declared run inputs", `Unexpected input ${key}.`);
    const resources = environmentResources(workflow, workspace, directory, options.resources);
    const stateRoot = safePath(options.state_directory ?? join(workspace, ".method", "data"));
    if (Object.keys(workflow.state ?? {}).length) {
      mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      const path = join(stateRoot, ".method-state.lock"); stateLock = { path, fd: openSync(path, "wx", 0o600) }; writeFileSync(stateLock.fd, String(process.pid));
    }
    const state = readState(workflow, stateRoot);
    const fingerprint = semanticDigest({ workflow, inputs, resources, workspace, stateRoot, executor: options.executor.name, verifier: options.verifier?.name ?? null, revision: options.runtime_revision });
    const journalPath = join(directory, "journal.json");
    let journal: Journal;
    if (existsSync(journalPath)) {
      if (!options.resume) stop("input", "A new run folder", "This run exists. Use --resume.");
      journal = JSON.parse(readFileSync(journalPath, "utf8"));
      if (journal.schema !== "workflow-journal/2" || journal.fingerprint !== fingerprint) stop("input", "The original method, inputs and environment", "Run definition changed. Create a separate run for an edited method.");
      if (!equal(journal.current_state, state.values)) stop("change", "State matching the saved run", "Persistent state changed outside this run. Inspect it before recovery.", [journalPath], true);
      result.run_id = journal.run_id;
    } else {
      if (options.resume) stop("input", "An existing run", "No saved run was found.");
      journal = { schema: "workflow-journal/2", fingerprint, run_id: result.run_id, started_at: new Date().toISOString(), initial_state: structuredClone(state.values), current_state: structuredClone(state.values), entries: {} };
      writePrivateJson(journalPath, journal);
      writePrivateJson(join(directory, "method.method"), workflow);
      writePrivateJson(join(directory, "inputs.json"), inputs);
      writePrivateJson(join(directory, "resources.json"), resources);
      writePrivateJson(join(directory, "state-before.json"), state.values);
      writePrivateJson(join(directory, "run.json"), { schema: "workflow-run-manifest/2", run_id: result.run_id, started_at: journal.started_at, workflow_sha256: semanticDigest(workflow), inputs_sha256: semanticDigest(inputs), resources_sha256: semanticDigest(resources), fingerprint });
    }
    const save = () => writePrivateJson(journalPath, journal);
    await options.onStart?.(); event(options.resume ? "run_resumed" : "run_started");
    const retries = new Set(options.retry_invocations ?? []);
    for (const id of retries) if (!options.resume || !journal.entries[id] || journal.entries[id]!.phase === "passed") stop("input", "An incomplete invocation in a saved run", `Invalid retry ${id}.`);
    const values: Record<string, Json> = { inputs, state: state.values, environment: resources as Json, run: { started_at: journal.started_at } };
    // Access probes are run observations, not authored setup workflows.
    for (const [id, requirement] of Object.entries(workflow.environment ?? {})) {
      const target = `environment.${id}`;
      const pendingOperations = Object.entries(workflow.steps)
        // Repeated steps may still have undispatched items, so keep their access check.
        .filter(([stepId, step]) => !!step.each || journal.entries[stepId]?.phase !== "passed")
        .filter(([, step]) => step.changes?.includes(target) || Object.values(step.in ?? {}).some(ref => ref === target || ref.startsWith(`${target}.`)))
        .map(([stepId, step]) => ({
          step_id: stepId,
          action: journal.entries[stepId]?.phase === "returned" || options.recoveries?.[stepId] ? "" : step.do ?? step.ask ?? "",
          check: typeof step.check === "string" ? step.check : step.check ? JSON.stringify(step.check) : null,
          changes: step.changes ?? []
        }));
      if (options.resume && pendingOperations.length === 0) continue;
      if (requirement.type === "files") { if (!resources[id]?.path || !existsSync(resources[id]!.path!)) stop("environment", requirement.description, `Folder unavailable: environment.${id}.`, [], true); continue; }
      if (!options.verifier) stop("environment", requirement.description, `A verifier is required to check environment.${id}.`, [], true);
      const observation = DecisionSchema.parse(await options.verifier.verify({ run_id: result.run_id, invocation: `environment/${id}`, directory: join(directory, "environment", id), run_directory: directory, workspace,
        instructions: `Check that this connection provides the access needed by pending_operations. The full method connection description is: ${requirement.description}. On resume, completed operations reuse saved results; do not require access used only by those completed operations. Verify the tools and services needed for the pending actions and their checks, including declared changes. An empty action means only its check remains. Require observed access for that remaining work; do not infer access from configured credentials alone. Observe access without changing account or business data.`, inputs: { pending_operations: pendingOperations }, outputs: {}, resources: { [id]: resources[id]! }, changes: {}, timeout_ms: options.timeout_ms ?? 300000 }));
      writePrivateJson(join(directory, "environment", `${id}.json`), observation);
      if (observation.result !== "pass" || !observation.evidence.length) stop("environment", requirement.description, observation.summary, observation.evidence, true);
    }
    let stopped = false;
    async function invoke(id: string, step: Step, invocation: string, item: Record<string, Json>): Promise<Record<string, Json>> {
      let local: Record<string, Json> = { ...item };
      const usedResources: Connections = {};
      for (const [name, ref] of Object.entries(step.in ?? {})) { local[name] = structuredClone(readValue(values, ref)); if (ref.startsWith("environment.")) usedResources[name] = resources[ref.slice(12)]!; }
      for (const artifact of fileArtifacts(local)) checkedFile(artifact, [directory, ...Object.values(resources).flatMap(r => r.path ? [r.path] : [])]);
      const scratch = join(directory, "steps", encodeURIComponent(invocation)); mkdirSync(scratch, { recursive: true, mode: 0o700 });
      const changes: StepRequest["changes"] = {};
      for (const target of step.changes ?? []) {
        const [kind, name] = target.split(".");
        if (kind === "state") changes[target] = { description: workflow.state![name!]!.description ?? name!, before: structuredClone(state.values[name!]!), definition: workflow.state![name!]! };
        else { const resource = resources[name!]!; changes[target] = { ...resource }; usedResources[target] = resource; }
      }
      let entry = journal.entries[invocation];
      if (entry?.phase === "returned") local = structuredClone(entry.inputs);
      if (entry?.phase === "passed") { result.steps[invocation] = entry.row!; event("step_resumed", invocation); return entry.row!.outputs ?? {}; }
      if (entry && entry.phase !== "returned" && !equal(entry.inputs, local)) stop("input", "The saved inputs for this invocation", `Inputs changed for ${invocation}.`, [scratch], true);
      if (entry?.phase === "started" && step.changes?.length && !options.recoveries?.[invocation]) stop("change", "Known outcome before another write", `The previous change in ${invocation} has an unknown outcome. Inspect its records.`, [scratch], true);
      if (entry?.phase === "failed" && !retries.has(invocation) && !options.recoveries?.[invocation]) stop("action", "An explicit retry after inspection", `Use --retry ${invocation} to retry this failed operation.`, [scratch], true);
      if (retries.has(invocation) && step.changes?.length) stop("change", "Reconciled external state", "A change cannot be retried as a read. Supply an inspected recovery result.", [scratch], true);
      const row: RunResult["steps"][string] = { status: "needs_attention", attempts: entry?.attempt ?? 0, checks: [], verification: step.check ? "checked" : "unchecked" }; result.steps[invocation] = row;
      const request: StepRequest = { run_id: result.run_id, invocation, attempt: (entry?.attempt ?? 0) + 1, timeout_ms: options.timeout_ms ?? 300000, directory: scratch, workspace,
        step: { ...step, id }, instructions: renderInstructions(step.do ?? step.ask!, local), inputs: local, resources: usedResources, outputs: step.out ?? {}, changes,
        files: Object.fromEntries(Object.entries(step.out ?? {}).filter(([, d]) => d.type === "file").map(([name, d]) => [name, join(scratch, "files", `${name}.${d.format === "markdown" ? "md" : d.format === "json" ? "json" : "txt"}`)])),
        ...(entry?.row?.failure ? { previous_failure: entry.row.failure.observed } : {}) };
      writePrivateJson(join(scratch, "request.json"), request);
      writePrivateJson(join(scratch, `request-${request.attempt}.json`), request);
      let candidate: StepResult;
      try {
        if (options.recoveries?.[invocation]) { if (!entry) stop("change", "An incomplete dispatch", "Recovery requires a saved invocation."); candidate = StepResultSchema.parse(options.recoveries[invocation]); }
        else if (entry?.phase === "returned") candidate = entry.candidate!;
        else {
          if (stopped) stop("action", "An active run", "Another operation stopped the run.");
          if (step.ask) {
            const response = await options.human?.execute?.(request);
            if (!response) { event("human_input_required", invocation, request.instructions); stop("input", "The user's response", `Waiting for a response to ${id}.`, [join(scratch, "request.json")], true); }
            candidate = StepResultSchema.parse(response);
          } else {
            entry = { step_id: id, inputs: structuredClone(local), attempt: request.attempt, phase: "started" }; journal.entries[invocation] = entry; save();
            event("step_started", invocation, `Attempt ${request.attempt}`);
            candidate = StepResultSchema.parse(await options.executor.execute(request));
          }
        }
        entry = { ...(entry ?? { step_id: id, inputs: structuredClone(local), attempt: request.attempt }), phase: "returned", candidate };
        journal.entries[invocation] = entry; save(); row.attempts = entry.attempt;
        writePrivateJson(join(scratch, `candidate-${entry.attempt}.json`), candidate);
        const outputs = structuredClone(candidate.outputs);
        for (const key of Object.keys(outputs)) if (!step.out?.[key]) stop("action", "Declared outputs", `Unexpected output ${key}.`);
        for (const [name, definition] of Object.entries(step.out ?? {})) {
          const errors = shapeErrors(definition, outputs[name], name); if (errors.length) stop("action", definition.description ?? name, errors.join("\n"), [scratch]);
          outputs[name] = captureFiles(definition, outputs[name]!, scratch);
        }
        for (const key of Object.keys(candidate.updates ?? {})) if (!step.changes?.includes(key) || !key.startsWith("state.")) stop("change", "Only declared state updates", `Unexpected update ${key}.`);
        const actualChanges: any = entry.change_records ?? {};
        for (const observation of candidate.observations ?? []) if (!step.changes?.includes(observation.target) || !observation.target.startsWith("environment.")) stop("change", "Declared external targets", `Unexpected observation ${observation.target}.`);
        for (const [target, change] of Object.entries(changes)) {
          if (actualChanges[target]) continue;
          if (target.startsWith("state.")) {
            const name = target.slice(6), after = candidate.updates?.[target];
            if (after === undefined) stop("change", `An update for ${target}`, "The operation returned no state update.");
            const errors = shapeErrors(workflow.state![name]!, after, target); if (errors.length) stop("change", change.description, errors.join("\n"));
            const before = structuredClone(state.values[name]!);
            // Write intent precedes the write. An interrupted commit requires reconciliation.
            writePrivateJson(join(scratch, `change-${name}.json`), { target, before, after, status: "prepared" });
            writePrivateJson(state.paths[name]!, after);
            state.values[name] = after; journal.current_state[name] = after;
            actualChanges[target] = { ...change, path: state.paths[name], before, after, status: "applied", sha256: createHash("sha256").update(readFileSync(state.paths[name]!)).digest("hex") };
            entry.change_records = actualChanges; save();
            writePrivateJson(join(scratch, `change-${name}.json`), actualChanges[target]);
          } else {
            const observations = candidate.observations?.filter(o => o.target === target) ?? [];
            if (observations.length !== 1 || observations[0]!.status !== "applied" || !observations[0]!.evidence.length) stop("change", `Observed completion of ${target}`, `The external change is not confirmed: ${target}.`, [scratch], true);
            actualChanges[target] = { ...change, ...observations[0] };
          }
        }
        entry.change_records = actualChanges; save(); writePrivateJson(join(scratch, "changes.json"), actualChanges);
        if (step.check) {
          const checked = typeof step.check === "string"
            ? options.verifier ? DecisionSchema.parse(await options.verifier.verify({ run_id: result.run_id, invocation, directory: join(scratch, "check"), run_directory: directory, workspace,
                instructions: step.check, inputs: local, outputs, resources: usedResources, changes: actualChanges, timeout_ms: options.timeout_ms ?? 300000 })) : { result: "ambiguous" as const, summary: "Configure a verifier for this check.", evidence: [] }
            : assertValue(step.check, { ...local, ...outputs }, [directory, ...Object.values(resources).flatMap(r => r.path ? [r.path] : [])]);
          if (checked.result === "pass" && !checked.evidence.length) { checked.result = "ambiguous"; checked.summary = "The check supplied no evidence."; }
          row.checks.push({ ...checked, id: "check", method: typeof step.check === "string" ? "agent" : "assert" });
          writePrivateJson(join(scratch, "checks.json"), row.checks); event("check_completed", invocation, checked.summary);
          if (checked.result !== "pass") stop("check", typeof step.check === "string" ? step.check : JSON.stringify(step.check), checked.summary, checked.evidence, checked.result === "ambiguous" || !!step.changes?.length);
        }
        if (step.changes?.some(t => t.startsWith("environment.")) && !step.check) stop("change", "An independent check of external changes", "The external change has no check.", [scratch], true);
        row.status = "passed"; row.outputs = outputs; entry.phase = "passed"; entry.row = row; save(); event("step_passed", invocation, row.verification); return outputs;
      } catch (error) {
        const failure = error instanceof Stop ? error.failure : { phase: "action" as const, expected: request.instructions, observed: errorText(error), evidence: [scratch] };
        row.status = error instanceof Stop && error.attention || !!step.changes?.length ? "needs_attention" : "failed"; row.failure = failure;
        if (entry) { entry.row = row; if (!step.changes?.length) entry.phase = "failed"; save(); }
        writePrivateJson(join(scratch, "failure.json"), failure); throw new Stop(failure, row.status === "needs_attention");
      }
    }
    const done = new Set<string>(), active = new Map<string, Promise<void>>(), held = new Set<string>();
    let firstFailure: unknown;
    const limit = Math.max(1, Math.min(32, options.concurrency ?? 4));
    while (done.size < Object.keys(workflow.steps).length || active.size) {
      if (!stopped) for (const [id, step] of Object.entries(workflow.steps)) {
        if (done.has(id) || active.has(id) || active.size >= limit || !stepDependencies(workflow, id).every(dep => done.has(dep))) continue;
        const locks = [...new Set([...(step.changes ?? []), ...Object.values(step.in ?? {}).filter(ref => ref.startsWith("state.") || ref.startsWith("environment.")).map(ref => ref.split(".").slice(0, 2).join(".")), ...Object.values(step.each ?? {}).filter(ref => ref.startsWith("state.")).map(ref => ref.split(".").slice(0, 2).join("."))])];
        if (locks.some(key => held.has(key))) continue;
        locks.forEach(key => held.add(key));
        const task = Promise.resolve().then(async () => {
          try {
            if (step.when && readValue(values, step.when) === false) { result.steps[id] = { status: "skipped", checks: [], attempts: 0 }; event("step_skipped", id); return; }
            const each = Object.entries(step.each ?? {})[0];
            if (each) {
              const items = readValue(values, each[1]); if (!Array.isArray(items)) stop("input", "A list", `${each[1]} is not a list.`);
              const aggregate: Record<string, Json[]> = Object.fromEntries(Object.keys(step.out ?? {}).map(name => [name, []]));
              // Stable snapshot/order; independent source steps still run concurrently.
              for (let i = 0; i < items.length; i++) { if (stopped) break; const item = items[i]!; const key = `${i}-${semanticDigest(item).slice(0, 10)}`; const output = await invoke(id, step, `${id}/${key}`, { [each[0]]: item }); for (const name of Object.keys(aggregate)) aggregate[name]!.push(output[name]!); }
              Object.assign(values, aggregate);
            } else Object.assign(values, await invoke(id, step, id, {}));
          } catch (error) {
            const failure = error instanceof Stop ? error.failure : { phase: "input" as const, expected: `Resolved inputs for ${step.name ?? id}`, observed: errorText(error), evidence: [] };
            if (!Object.entries(result.steps).some(([key, row]) => (key === id || key.startsWith(id + "/")) && row.failure)) result.steps[id] = { status: error instanceof Stop && error.attention ? "needs_attention" : "failed", checks: [], attempts: 0, failure };
            if (!stopped) firstFailure = error instanceof Stop ? error : new Stop(failure);
            stopped = true; event("step_stopped", id, failure.observed);
          }
          finally { done.add(id); locks.forEach(key => held.delete(key)); active.delete(id); }
        });
        active.set(id, task);
      }
      if (active.size) await Promise.race(active.values());
      else if (stopped) break;
      else if (done.size < Object.keys(workflow.steps).length) stop("input", "Runnable dependencies", "No operation can start.");
    }
    for (const id of Object.keys(workflow.steps)) if (!done.has(id)) result.steps[id] = { status: "skipped", checks: [], attempts: 0 };
    if (firstFailure) throw firstFailure;
    result.outputs = typeof workflow.result === "string" ? { result: readValue(values, workflow.result) } : Object.fromEntries(Object.entries(workflow.result).map(([name, ref]) => [name, readValue(values, ref)]));
    for (const artifact of fileArtifacts(result.outputs)) checkedFile(artifact, [directory, ...Object.values(resources).flatMap(r => r.path ? [r.path] : [])]);
  } catch (error) {
    result.status = error instanceof Stop && error.attention ? "needs_attention" : "failed";
    result.failure = error instanceof Stop ? error.failure : { phase: "environment", expected: "A ready execution environment", observed: errorText(error), evidence: [] };
    result.error = result.failure.observed;
  } finally {
    event("run_completed", undefined, result.status); writePrivateJson(join(directory, "result.json"), result);
    if (stateLock) { closeSync(stateLock.fd); unlinkSync(stateLock.path); } closeSync(fd); unlinkSync(lock);
  }
  return result;
}
function captureFiles(shape: Shape, value: Json, scratch: string): Json {
  const s = shapeObject(shape);
  if (s.type === "file") {
    const path = safePath((value as any).path);
    if (!path.startsWith(resolve(scratch) + "/")) throw Error("Output files must be in the assigned run folder.");
    return { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
  }
  if (s.type === "record") return Object.fromEntries(Object.entries(s.fields ?? {}).map(([key, child]) => [key, captureFiles(child, (value as Record<string, Json>)[key]!, scratch)]));
  if (s.type === "list") return (value as Json[]).map(item => captureFiles(s.fields ? { type: "record", fields: s.fields } : s.items!, item, scratch));
  return value;
}
