import { runMethod as currentRun } from "@withmethod/runtime/runner.js";
import { runWorkflow, type RunOptions } from "./runtime.js";
/** One Method entry point. Saved older methods retain their original behavior. */
export function runMethod(file: string, config: object, options?: object): ReturnType<typeof currentRun>;
export function runMethod(options: RunOptions): ReturnType<typeof runWorkflow>;
export function runMethod(file: string | RunOptions, config?: object, options: object = {}) {
  if (typeof file !== "string") return runWorkflow(file);
  if (!config) throw Error("Supply operator runtime configuration.");
  return currentRun(file, config, options);
}
