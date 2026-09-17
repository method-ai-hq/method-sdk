#!/usr/bin/env node
import { isCurrentWorkflow } from "../../workflow-language/src/schema.js";
import { runCurrentFile } from "./current-runtime.js";
import { environmentResources } from "./environment.js";
import { existsSync, realpathSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { JsonSchema, executionLabel, type Json, type Workflow } from "../../workflow-language/src/schema.js";
import { loadWorkflow } from "../../workflow-language/src/validate.js";
import { renderPrompt } from "../../compiler/src/conversion-report.js";
import { semanticDigest } from "../../contracts/src/identity.js";
import { CodexExecutor, CodexVerifier } from "./codex.js";
import { DecisionSchema, StepResultSchema, type Connections } from "./contracts.js";
import { doctor, checkNode, checkCodex, requireRuntime } from "./doctor.js";
import { writePrivateJson } from "./files.js";
import { isWorkflowLink, saveWorkflowLink } from "./link.js";
import { askInputs, askResources, missingInputsMessage, terminalIo } from "./prompts.js";
import { createReporter, formatEvent } from "./report.js";
import { runWorkflow } from "./runtime.js";
import { inspectRun } from "./inspect.js";
import { pathToFileURL } from "node:url";
import type { MethodSync } from "./method-sync.js";
import { JsonLineHost } from "./host.js";

const help = `Method local runner

method run FILE [--config runtime.json] [--inputs FILE] [--state FILE] [--workspace DIR]
method check FILE
method steps FILE
method prompt FILE
method inspect RUN_DIRECTORY --out FILE [--include-files]
method doctor

Run options: --run-dir DIR, --state-dir DIR, --resume, --retry INVOCATION,
--recoveries FILE, --human FILE, --model MODEL, --verifier-model MODEL,
--concurrency N, --timeout-ms N, --verbose, --host.

Current methods use configured scripts, model calls, and bounded agents.
Older saved methods keep their Codex execution and legacy options.
Human answers use {steps: {invocation: {outputs: {...}}}}.
See method authoring for the format and authoring commands.
`;
const ResourcesSchema = z.record(z.strictObject({ description: z.string().min(1), setup: z.string().optional(), path: z.string().optional() }));
export function parse(args: string[]) {
  return parseArgs({ args, allowPositionals: true, options: {
    legacy: { type: "boolean" }, config: { type: "string" }, state: { type: "string" }, out: { type: "string" }, inputs: { type: "string" }, resources: { type: "string" }, workspace: { type: "string" },
    "run-dir": { type: "string" }, "state-dir": { type: "string" }, concurrency: { type: "string" }, "timeout-ms": { type: "string" }, model: { type: "string" }, "verifier-model": { type: "string" },
    resume: { type: "boolean" }, human: { type: "string" }, recoveries: { type: "string" }, retry: { type: "string", multiple: true },
    "include-files": { type: "boolean" }, verbose: { type: "boolean" }, host: { type: "boolean" }, help: { type: "boolean" }

  } });
}
type Flags = ReturnType<typeof parse>["values"];
function json(path: string | undefined, fallback: unknown = {}) { return path ? JSON.parse(readFileSync(resolve(path), "utf8")) as unknown : fallback; }

function latestRun(...roots: string[]): string {
  const runs = roots.flatMap(root => existsSync(root) ? readdirSync(root).filter(name => existsSync(join(root, name, "journal.json"))).map(name => ({ name, path: join(root, name) })) : []).sort((a, b) => a.name.localeCompare(b.name));
  const latest = runs.at(-1);
  if (!latest) throw new Error(`RUN_MISSING: no saved run under ${roots.join(" or ")}. Use --run-dir DIR for a run saved elsewhere.`);
  return latest.path;
}
export async function run(target: string, flags: Flags, syncFactory?: () => MethodSync): Promise<void> {

  if (flags.host && (flags.model || flags["verifier-model"])) throw new Error("HOST_OPTIONS: the calling host selects its models; do not pass --model or --verifier-model with --host.");
  const cwd = process.cwd();
  const workspace = resolve(flags.workspace ?? cwd);
  let path: string;
  if (isWorkflowLink(target)) {
    const saved = await saveWorkflowLink(target, cwd);
    path = saved.path;
    process.stderr.write(`${saved.reused ? "Method" : "Saved method"}: ${path}\n`);
  } else path = resolve(target);
  const workflow = loadWorkflow(readFileSync(path, "utf8"));
  if (isCurrentWorkflow(workflow)) return runCurrentFile(path, flags, syncFactory);
  if (!flags.host) await requireRuntime();
  const resume = flags.resume ?? false;
  const runsRoot = join(cwd, ".method-runs", workflow.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
  const directory = flags["run-dir"] ? resolve(flags["run-dir"]) : resume ? latestRun(runsRoot, join(cwd, ".workflow-runs", workflow.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"))) : join(runsRoot, new Date().toISOString().replaceAll(":", "-"));
  process.stderr.write(`Run directory: ${directory}\n`);
  const savedInputs = join(directory, "inputs.json");
  const savedResources = join(directory, "resources.json");
  const io = !flags.host && process.stdin.isTTY === true ? terminalIo() : null;
  let inputs: Record<string, Json>;
  let resources: Connections;
  try {
    if (flags.inputs) inputs = z.record(JsonSchema).parse(json(flags.inputs));
    else if (resume && existsSync(savedInputs)) inputs = z.record(JsonSchema).parse(json(savedInputs));
    else if (io) {
      inputs = await askInputs(workflow.inputs, io);
      writePrivateJson(savedInputs, inputs);
      process.stderr.write(`Inputs saved: ${savedInputs}\n`);
    } else if (Object.values(workflow.inputs ?? {}).every(d => d.default !== undefined)) inputs = {};
    else { process.stderr.write(missingInputsMessage(workflow)); process.exitCode = 2; return; }
    resources = flags.resources ? ResourcesSchema.parse(json(flags.resources))
      : resume && existsSync(savedResources) ? ResourcesSchema.parse(json(savedResources))
      : await askResources(workflow, workspace, io);
  } finally { io?.close(); }
  resources = environmentResources(workflow, workspace, directory, resources);
  const human = z.strictObject({ steps: z.record(StepResultSchema).default({}) }).parse(json(flags.human));
  const recoveries = z.record(StepResultSchema).parse(json(flags.recoveries));
  const verbose = flags.verbose ?? false;
  const reporter = createReporter(workflow, line => { if (!verbose) process.stderr.write(`${line}\n`); });
  const host = flags.host ? new JsonLineHost() : null;
  let failure:unknown;
  let sync:MethodSync|undefined;
  try {
    const result = await runWorkflow({ workflow, inputs, directory, workspace, resources, state_directory: flags["state-dir"], concurrency: flags.concurrency ? Number(flags.concurrency) : undefined, timeout_ms: flags["timeout-ms"] ? Number(flags["timeout-ms"]) : undefined, recoveries, retry_invocations: flags.retry ?? [],
      executor: host ? { name: "json-lines-host/1", execute: async request => StepResultSchema.parse(await host.request("execute", request)) }
        : new CodexExecutor(flags.model ? { model: flags.model } : {}),
      verifier: host ? { name: "json-lines-host-check/1", verify: async request => DecisionSchema.parse(await host.request("verify", request)) }
        : new CodexVerifier(flags["verifier-model"] ? { model: flags["verifier-model"] } : flags.model ? { model: flags.model } : {}),
      resume, runtime_revision: "workflow-sdk/2",
      onStart: async () => { sync = syncFactory?.(); await sync?.start(workflow, inputs, resources); },
      human: {
        execute: async request => {
          if (human.steps[request.invocation]) return human.steps[request.invocation];
          if (!host) return undefined;
          const value = await host.request("human_execute", request);
          return value == null ? undefined : StepResultSchema.parse(value);
        }
      },
      onEvent(event) { sync?.snapshot(); if (host) host.send({ type: "event", event }); else { if (verbose) process.stderr.write(`${formatEvent(event)}\n`); reporter.onEvent(event); } }
    });
    if (host) {
      host.send({ type: "result", result });
      if (result.status !== "succeeded") process.exitCode = 2;
      return;
    }
    const stopped = reporter.stopped();
    process.stdout.write(`Run ${result.status.replaceAll("_", " ")}.\n`);
    if (stopped) process.stdout.write(`Stopped at ${stopped.position} ${stopped.invocation} — ${stopped.reason}\n`);
    else if (result.error) process.stdout.write(`Error: ${result.error}\n`);
    process.stdout.write(`Result: ${join(directory, "result.json")}\n`);
    if (result.status !== "succeeded") process.exitCode = 2;
  } catch(error) { failure=error; throw error; } finally { host?.close(); await sync?.finish(failure); }
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
    if (!flags.legacy) {
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
    const report = await doctor();
    process.stdout.write(`${report.lines.join("\n")}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
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
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) localMain().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
