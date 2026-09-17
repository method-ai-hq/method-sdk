import type { LegacyWorkflow as Workflow } from "../../workflow-language/src/schema.js";
import type { Event } from "./contracts.js";

/** The raw event line used by --verbose. */
export function formatEvent(event: Event): string {
  return `${event.type}${event.step ? ` ${event.step}` : ""}${event.detail ? `: ${event.detail}` : ""}`;
}

/** `CHECK_FAILED: step. same_count: summary` becomes `check same_count: summary`. */
export function stopReason(invocation: string, detail: string): string {
  const prefix = `CHECK_FAILED: ${invocation}. `;
  if (!detail.startsWith(prefix)) return detail;
  const rest = detail.slice(prefix.length);
  return /^[A-Z][A-Z_]+: /u.test(rest) ? rest : `check ${rest}`;
}

export type Stopped = { invocation: string; position: string; reason: string };
/** One line per finished step: ok, skip, or stop. */
export function createReporter(workflow: Workflow, write: (line: string) => void) {
  const total = Object.keys(workflow.steps).length;
  const index = new Map(Object.keys(workflow.steps).map((id, i) => [id, i + 1]));
  const names = new Map(Object.entries(workflow.steps).map(([id, step]) => [id, step.name ?? id.replaceAll("_", " ")]));
  let stopped: Stopped | undefined;
  const position = (invocation: string) => `${index.get(invocation.split("/")[0]!) ?? "?"}/${total}`;
  const line = (tag: string, invocation: string, text: string) => write(`${tag.padEnd(6)}${position(invocation)} ${invocation} — ${text}`);
  const name = (invocation: string) => names.get(invocation.split("/")[0]!) ?? invocation;
  return {
    onEvent(event: Event): void {
      if (["environment_started", "environment_phase", "environment_ready", "environment_stopped"].includes(event.type)) {
        write(`Environment: ${event.detail ?? event.type}`); return;
      }
      const step = event.step;
      if (!step) return;
      if (event.type === "step_passed") line("ok", step, name(step));
      else if (event.type === "step_resumed") line("ok", step, `${name(step)} (saved)`);
      else if (event.type === "step_skipped") line("skip", step, name(step));
      else if (event.type === "step_stopped") {
        stopped = { invocation: step, position: position(step), reason: stopReason(step, event.detail ?? "stopped") };
        line("stop", step, stopped.reason);
      }
    },
    stopped: () => stopped
  };
}
