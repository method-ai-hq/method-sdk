import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { inspectRun } from "./inspect.js";
import { methodCache } from "./prepare.js";
import { writePrivateJson } from "./files.js";
import { authoringPath } from "./authoring.js";
import type { MethodClient } from "./method-client.js";
import type { parse } from "./local-cli.js";

type Flags = ReturnType<typeof parse>["values"];
type Inputs = Record<string, unknown>;

/** The run folders on this computer where an earlier run can be: this folder's, the Method folder's, and the CLI's cache. */
export function runFolders(methodFile?: string) {
  return [...new Set([join(process.cwd(), ".method-runs"), ...(methodFile ? [join(dirname(resolve(methodFile)), ".method-runs")] : []), join(methodCache(), "runs")].map(path => resolve(path)))];
}

/** The inputs of a local run folder whose method-sync.json links it to the dashboard run RUN_ID. */
function localInputs(runId: string, folders: string[]): Inputs | undefined {
  for (const folder of folders) {
    let names: string[] = [];
    try { names = readdirSync(folder); } catch { continue; }
    for (const name of names) {
      const directory = join(folder, name), link = join(directory, "method-sync.json");
      if (!existsSync(link)) continue;
      let state: any;
      try { state = JSON.parse(readFileSync(link, "utf8")); } catch { continue; }
      if (state?.dashboard_id !== runId && state?.id !== runId) continue;
      try { return inspectRun(directory).inputs; }
      catch {
        for (const file of ["setup-inspection.json", "requested-inputs.json"]) {
          const path = join(directory, file);
          if (!existsSync(path)) continue;
          const saved = JSON.parse(readFileSync(path, "utf8"));
          return file === "setup-inspection.json" ? saved.inputs ?? {} : saved;
        }
      }
    }
  }
  return undefined;
}

/**
 * The inputs of an earlier run. An account run gives them from the server. A device run keeps them on the computer that
 * ran it, so they come from its run folder; so do the inputs of any run when the server cannot be reached.
 */
export async function inputsOfRun(runId: string, client: MethodClient | undefined, folders: string[]): Promise<Inputs> {
  let reason = "This computer is not signed in, so the account was not asked.";
  if (client?.token()) {
    try {
      const { run } = await client.request<{ run?: { inspection?: { content?: string; inputs?: Inputs } } }>(`/api/workspace/runs/${encodeURIComponent(runId)}`);
      if (run?.inspection && run.inspection.content !== "device") return run.inspection.inputs ?? {};
      reason = "The account keeps no inputs for this run: its content stays on the computer that ran it.";
    } catch (error) { reason = `The account did not give the run (${error instanceof Error ? error.message : String(error)}).`; }
  }
  const found = localInputs(runId, folders);
  if (found) return found;
  throw Object.assign(Error(`Found no inputs of run ${runId}. ${reason} No run folder for it (method-sync.json) is in ${folders.join(", ")}. Run this command on the computer that ran it, from its folder, or give the inputs with --inputs FILE.`), { code: "inputs_not_found" });
}

/**
 * --inputs-from RUN_ID: the inputs of that run become this run's inputs, saved as inputs-from.json in the run folder.
 * --inputs FILE replaces single values. The returned flags name that file with --inputs.
 */
export async function withInputsFrom(flags: Flags, runDir: string, methodFile: string | undefined, client: MethodClient | undefined): Promise<Flags> {
  const runId = flags["inputs-from"];
  if (!runId) return flags;
  if (flags.resume) throw Error("A resumed run keeps the inputs it started with. Leave out --inputs-from.");
  const earlier = await inputsOfRun(runId, client, runFolders(methodFile));
  const explicit = flags.inputs ? JSON.parse(readFileSync(authoringPath(flags.inputs), "utf8")) : {};
  const file = join(resolve(runDir), "inputs-from.json");
  writePrivateJson(file, { ...earlier, ...explicit });
  const { "inputs-from": _, ...rest } = flags;
  return { ...rest, inputs: file };
}

/** Command arguments without the named options and their values. */
export function withoutOptions(args: string[], names: string[]) {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const match = args[i]!.match(/^--([^=]+)(=.*)?$/);
    if (match && names.includes(match[1]!)) { if (match[2] === undefined) i++; continue; }
    out.push(args[i]!);
  }
  return out;
}
