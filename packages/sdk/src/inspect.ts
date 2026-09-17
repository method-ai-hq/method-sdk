import { inspectCurrentRun } from "./current-inspection.js";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { InspectionSchema, type RunInspection } from "../../workflow-language/src/inspection.js";

/** Export known run records. File previews are opt-in and must match saved hashes. */
export function inspectRun(directory: string, options: { includeFiles?: boolean; /** Internal: only called synchronously by the owning SDK process. */ activeSnapshot?: boolean } = {}): RunInspection {
  const requested = resolve(directory);
  if (requested.split(sep).includes("sensitive")) throw Error("INSPECT_PATH: choose a run outside sensitive/.");
  const root = realpathSync(requested);
  if (root.split(sep).includes("sensitive")) throw Error("INSPECT_PATH: choose a run outside sensitive/.");
  if (!existsSync(join(root,"method.json")) && existsSync(join(root,"setup-inspection.json")) && existsSync(join(root,"request.json"))) {
    const initial=JSON.parse(readFileSync(join(root,"setup-inspection.json"),"utf8"));
    const failure=existsSync(join(root,"setup-error.json"))?JSON.parse(readFileSync(join(root,"setup-error.json"),"utf8")):null;
    return InspectionSchema.parse({...initial,local_run_directory:root,...(failure?{status:'needs_attention',error:failure.error}:{}),events:existsSync(join(root,"setup.json"))?JSON.parse(readFileSync(join(root,"setup.json"),"utf8")):[]});
  }
  if (existsSync(join(root, "method.json"))) return inspectCurrentRun(root, options.activeSnapshot, options.includeFiles);
  throw Error("UNSUPPORTED_RUN: only current Method run records are supported.");
}
