import { runCurrentFile } from "./current-runtime.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { executionLabel } from "../../workflow-language/src/schema.js";
import { loadWorkflow } from "../../workflow-language/src/validate.js";
import { renderPrompt } from "../../compiler/src/conversion-report.js";
import { checkNode, checkCodex } from "./doctor.js";
import { writePrivateJson } from "./files.js";
import { isWorkflowLink, saveWorkflowLink } from "./link.js";
import { inspectRun } from "./inspect.js";
import type { MethodSync } from "./method-sync.js";
const help = "Use method run, check, steps, prompt, inspect, or doctor. See method help.";
export function parse(args: string[]) {
  return parseArgs({ args, allowPositionals: true, options: {
    agent: {type:"string"}, background: {type:"boolean"}, config: {type:"string"}, state: {type:"string"}, out: {type:"string"}, inputs: {type:"string"}, workspace: {type:"string"},
    "run-dir": {type:"string"}, resume: {type:"boolean"}, human: {type:"string"}, retry: {type:"string",multiple:true},
    "include-files": {type:"boolean"}, verbose: {type:"boolean"}, help: {type:"boolean"}
  }});
}
export async function run(target: string, flags: ReturnType<typeof parse>["values"], syncFactory?: () => MethodSync): Promise<void> {
  const path = isWorkflowLink(target) ? (await saveWorkflowLink(target, process.cwd())).path : resolve(target);
  loadWorkflow(readFileSync(path, "utf8"));
  await runCurrentFile(path, flags, syncFactory);
}
export async function localMain(args = process.argv.slice(2)) {
  const parsed = parse(args);
  const [command, target] = parsed.positionals;
  const flags = parsed.values;
  if (flags.help || !command) { process.stdout.write(help); return; }
  if (command === "inspect") {
    if (!target || parsed.positionals.length !== 2 || !flags.out) throw new Error("Use method inspect RUN_DIRECTORY --out inspection.json.");
    const output = resolve(flags.out);
    if (output.split(/[\\/]/u).includes("sensitive")) throw new Error("Use an inspection file outside sensitive/.");
    if (existsSync(output)) throw new Error("INSPECTION_EXISTS: choose a new output file.");
    writePrivateJson(output, inspectRun(target, { includeFiles: flags["include-files"] ?? false }));
    process.stdout.write(`Saved run evidence: ${output}\nContains run inputs and results. Load it in the method viewer; no upload occurs.\n`);
    return;
  }
  if (command === "doctor") {
    if (parsed.positionals.length !== 1) throw new Error(help);
    {
      const node = checkNode();
      process.stdout.write(node.detail + "\n");
      if (!node.ok) { process.exitCode = 1; return; }
      if (flags.config) {
        const { readDocument } = await import("@withmethod/runtime/io.js");
        const { validateConfig } = await import("@withmethod/runtime/validate.js");
        const { executable } = await import("@withmethod/runtime/io.js");
        const config = validateConfig(await readDocument(flags.config));
        for (const profile of Object.values(config.runtimes ?? {}) as any[]) await executable(profile.command);
        for (const profile of Object.values(config.models ?? {}) as any[]) {
          if (profile.backend === "openai-responses" && !process.env[profile.api_key_env]) throw Error(`Missing environment variable: ${profile.api_key_env}`);
          if (profile.backend === "codex") { const finding = await checkCodex(profile.command); if (!finding.ok) throw Error(finding.detail); }
        }
        if (!Object.keys(config.models ?? {}).length) {
          const finding = await checkCodex();
          if (!finding.ok) throw Error(finding.detail);
          process.stdout.write(finding.detail + "\n");
        }
        process.stdout.write("Runtime configuration checked. Unconfigured model profiles use Codex. No method was run.\n");
      } else {
        const finding = await checkCodex();
        process.stdout.write(finding.detail + "\n");
        if (!finding.ok) process.exitCode = 1;
        process.stdout.write("Supply --config runtime.json to check the scripts and tools.\n");
      }
      return;
    }
  }
  if (!["check", "steps", "prompt", "run"].includes(command) || !target || parsed.positionals.length !== 2) throw new Error(help);
  if (command === "run") return run(target, flags);
  const workflow = loadWorkflow(readFileSync(resolve(target), "utf8"));
  if (command === "check") { process.stdout.write(`Valid: ${workflow.name} (${Object.keys(workflow.steps).length} steps)\n`); return; }
  if (command === "steps") {
    process.stdout.write(Object.entries(workflow.steps).map(([id, step], index) => `${index + 1}. ${id}: ${step.name ?? id.replaceAll("_", " ")} (${executionLabel(step).toLowerCase()}; ${step.check ? "checked" : "unchecked"})`).join("\n") + "\n"); return;
  }
  process.stdout.write(renderPrompt(workflow) + "\n");
}
