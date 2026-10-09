import { attachResultFiles } from "./result-files.js";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, sep, basename } from "node:path";
import { createHash } from "node:crypto";
import { loadWorkflow } from "../../workflow-language/src/validate.js";
import { InspectionSchema, type RunInspection } from "../../workflow-language/src/inspection.js";

/** Convert the public trace into the dashboard's stable inspection contract. */
export function inspectCurrentRun(root: string, activeSnapshot = false, includeFiles: boolean | "references" = false): RunInspection {
  const path = (name: string) => {
    const actual = realpathSync(join(root, name));
    if (!actual.startsWith(root + sep) || actual.split(sep).includes("sensitive")) throw Error("Run record escapes the run directory.");
    return actual;
  };
  const read = (name: string) => JSON.parse(readFileSync(path(name), "utf8"));
  const rawMethod = read("method.json");
  const workflow = loadWorkflow(rawMethod);
  const manifest = read("manifest.json");
  const digest = createHash("sha256").update(JSON.stringify(rawMethod)).digest("hex");
  if (manifest.method_sha256 !== digest) throw Error("Saved method hash does not match the run.");
  const active = existsSync(join(root, ".lock"));
  if (active && (!activeSnapshot || readFileSync(path(".lock"), "utf8") !== String(process.pid))) throw Error("Finish the run before exporting its records.");
  const summary = read("summary.json");
  const events = readFileSync(path("events.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const start = events.find(e => e.event === "run.started");
  const invocations: RunInspection["invocations"] = {};
  const setup = existsSync(join(root,'setup.json')) ? read('setup.json') : [];
  const runEvents: NonNullable<RunInspection["events"]> = setup;
  for (const event of events) {
    // Keep useful trace fields; do not upload tool arguments, environment values, or process stdout.
    const recorded: NonNullable<RunInspection["events"]>[number] = {
      ...(typeof event.provider === 'string' ? {provider:event.provider} : {}),
      ...(typeof event.model === 'string' ? {model:event.model} : {}),
      ...(event.kind === 'classify' ? {kind: 'classify' as const} : {}),
      ...(typeof event.request_id === 'string' ? {request_id: event.request_id} : {}),
      ...(typeof event.operation_id === 'string' ? {operation_id: event.operation_id} : {}),
      ...(typeof event.confidence === 'number' ? {confidence: event.confidence} : {}),
      ...(event.kind === 'classify' && event.usage !== undefined ? {usage: event.usage} : {}),
      ...(typeof event.duration_ms === 'number' ? {duration_ms: event.duration_ms} : event.event.startsWith('run.') && typeof event.elapsed_ms === 'number' ? {duration_ms: event.elapsed_ms} : {}),
      at: event.at, type: event.event === "human.required" ? "human_input_required" : event.event.replaceAll(".", "_"),
      ...(event.check ? { detail: `${event.check.status}: ${event.check.reason}` } : event.message || event.error ? { detail: String(event.message ?? event.error).slice(0, 4000) } : event.code ? { detail: String(event.code) } : {}),
      ...(Number.isInteger(event.sequence) ? { sequence: event.sequence } : {}),
      ...(["action", "check"].includes(event.phase) ? { phase: event.phase } : {}),
      ...(typeof event.tool === "string" ? { tool: event.tool } : {}),
      ...(typeof event.call_id === "string" ? { call_id: event.call_id } : {}),
      ...(typeof event.child === "string" ? { child: event.child } : {}),
      ...(Number.isSafeInteger(event.completed) && Number.isSafeInteger(event.total) ? { completed: event.completed, total: event.total, ...(typeof event.unit === "string" ? { unit: event.unit } : {}) } : {}),
      ...(event.entrypoint ? { command: [event.runtime, event.entrypoint, ...(event.args ?? [])].filter(Boolean).join(" ") } : typeof event.command === "string" ? { command: event.command } : {}),
      ...(event.exit_code !== undefined ? { exit_code: event.exit_code } : {}),
      ...(typeof event.diagnostics === "string" && event.diagnostics ? { diagnostics: event.diagnostics.length <= 4000 ? event.diagnostics : event.diagnostics.slice(0, 1000) + "\n[middle omitted]\n" + event.diagnostics.slice(-3000) } : {}),
    };
    // Effect verdicts are run events, so the dashboard shows them without a new inspection field.
    if (event.event === "effect.observed") recorded.detail = `${event.effect}: ${event.verdict}${event.final ? "" : " (observation continues)"}. ${String(event.reason ?? "")}`.slice(0, 4000);
    if (event.event === "run.status_changed") recorded.detail = `Status changed from ${event.from} to ${event.to} after a later observation.`;
    if (event.event === "effects.waived") recorded.detail = event.waived.map((w: any) => `Not observed: ${w.step} (${w.reason})`).join("; ").slice(0, 4000);
    if (event.event === "effects.fixtures_passed") recorded.detail = `${event.fixtures.length} effect fixtures gave their expected verdicts.`;
    if (event.event === "run.started" && event.forked_from) {
      const fork = event.forked_from;
      recorded.detail = `Forked from run ${fork.run_dir} (execution ${fork.execution_id}). Reused: ${fork.steps.map((s: any) => s.step).join(", ")}. `
        + (fork.changed_files.length ? `Changed files: ${fork.changed_files.map((f: any) => `${f.file} (${f.change})`).join(", ")}. Only the entrypoints of reused steps were compared.` : "No bundle file changed.");
    }
    if (!event.step) { runEvents.push(recorded); continue; }
    if (event.event === "step.imported") {
      // A fork reuses accepted iterations from its parent run; they have no started event here.
      const imported = { ...recorded, detail: `Reused from run ${event.parent_run_dir} (execution ${event.parent_execution_id})` };
      const iterations: unknown[] = event.skipped ? [null] : event.outputs ?? [];
      iterations.forEach((outputs, iteration) => {
        const row = invocations[`${event.step}:${iteration}`] ??= { step_id: event.step, status: "running", checks: [], changes: {}, events: [] };
        row.events.push(imported);
        if (event.skipped) row.status = "skipped";
        else { row.status = "passed"; row.outputs = outputs as Record<string, any>; }
      });
      continue;
    }
    const id = `${event.step}:${event.iteration ?? 0}`;
    const row = invocations[id] ??= { step_id: event.step, status: "running", checks: [], changes: {}, events: [] };
    if (event.event === "step.started") {
      row.events = []; row.changes = {}; delete row.prompts; delete row.verification; delete row.failure; delete row.observed_effects;
    }
    row.events.push(recorded);
    if (event.event === "prompt.rendered") (row.prompts ??= []).push({ sequence: event.sequence, phase: event.phase, template: event.template, rendered: event.rendered });
    if (event.event === "step.started") { row.status = "running"; row.inputs = event.inputs; row.checks = []; delete row.outputs; delete row.error; }
    if (event.event === "step.candidate") { const { state, ...outputs } = event.candidate; row.outputs = outputs; row.status = "returned"; }
    if (event.event === "check.completed") row.checks.push({ id: String(event.sequence), result: event.check.status === "unknown" ? "ambiguous" : event.check.status, summary: event.check.reason, evidence: event.check.evidence, method: typeof workflow.steps[event.step]?.check === "object" && Object.hasOwn(Object(workflow.steps[event.step]!.check), "kind") ? "executor" : "assert" });
    if (event.event === "step.accepted") { row.status = "passed"; row.outputs = event.outputs; row.changes = event.state; row.verification = event.check.status === "unchecked" ? "unchecked" : "checked"; if (event.observed_effects) row.observed_effects = event.observed_effects; }
    if (event.event === "process.failed" && event.phase === "action" && !event.tool && event.observed_effects) row.observed_effects = event.observed_effects;
    if (event.event === "step.skipped") row.status = "skipped";
    if (event.event === "human.required") row.status = "needs_attention";
  }
  if (!active && summary.status !== "completed") for (const row of Object.values(invocations)) if (["running", "returned"].includes(row.status)) { row.status = "needs_attention"; row.error = summary.error ?? "Run interrupted"; }
  const files = includeFiles ? attachResultFiles(workflow, invocations, [join(root, "artifacts")], join(root, "artifacts"), includeFiles === "references") : undefined;
  const lastAccepted = events.filter(e => e.event === "step.accepted").at(-1);
  return InspectionSchema.parse({ schema: "workflow-inspection/2", workflow, run_id: basename(root), local_run_directory: root,
    ...(typeof (summary.started_at ?? start?.at) === 'string' ? {started_at: summary.started_at ?? start.at} : {}),
    ...(typeof (summary.device_name ?? start?.device_name) === 'string' ? {device_name: summary.device_name ?? start.device_name} : {}),
    events: runEvents, ...(includeFiles ? { files } : {}), status: active ? "running" : summary.status === "completed" ? "succeeded" : "needs_attention",
    ...(summary.error ? { error: summary.error } : {}), inputs: start?.inputs ?? {}, state: lastAccepted?.state ?? start?.initial_state ?? {},
    resources: Object.fromEntries(Object.entries(start?.config?.environment ?? {}).map(([key, value]) => [key, { description: workflow.environment?.[key]?.description ?? key, path: value }])), invocations });
}
