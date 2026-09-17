#!/usr/bin/env node
/** JSON-lines host bridge. Python uses the same runtime instead of maintaining a second interpreter. */
import { runCurrentMethod } from "./current-runtime.js";
import { authoringPath } from "./authoring.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { writePrivateJson } from "./files.js";
import { z } from "zod";
import { JsonSchema } from "../../workflow-language/src/schema.js";
import { loadWorkflow } from "../../workflow-language/src/validate.js";
import { renderPrompt } from "../../compiler/src/conversion-report.js";
import { DecisionSchema, StepResultSchema } from "./contracts.js";
import { CodexExecutor, CodexVerifier } from "./codex.js";
import { runWorkflow } from "./runtime.js";
import { JsonLineHost } from "./host.js";

const host = new JsonLineHost();
const send = (value: unknown) => host.send(value);
const receive = () => host.receive();
const request = (method: string, payload: unknown) => host.request(method, payload);
async function main() {
  const message = z.object({ op: z.enum(["load", "prompt", "run", "run_method"]), workflow: z.unknown().optional() }).passthrough().parse(await receive());
  if (message.op === "run_method") {
    const data = z.object({ file: z.string(), config: z.record(z.unknown()), options: z.record(z.unknown()).default({}) }).parse(message);
    return runCurrentMethod(authoringPath(data.file), data.config, { ...data.options, onEvent: (event: unknown) => send({ type: "event", event }) });
  }
  if (message.op === "load") return loadWorkflow(message.workflow);
  if (message.op === "prompt") return renderPrompt(loadWorkflow(message.workflow));
  const args = z.object({
    state_directory: z.string().optional(), concurrency: z.number().int().min(1).max(32).default(4), timeout_ms: z.number().positive().default(300000),
    inputs: z.record(JsonSchema), directory: z.string(), workspace: z.string(),
    resources: z.record(z.object({ description: z.string(), path: z.string().optional() })).default({}),
    recoveries: z.record(StepResultSchema).default({}), retry_invocations: z.array(z.string()).default([]), resume: z.boolean().default(false), runtime_revision: z.string(),
    executor: z.string().optional(), verifier: z.string().optional(), model: z.string().optional(), verifier_model: z.string().optional(), human: z.boolean().default(false)
  }).parse(message);
  const executor = args.executor ? { name: args.executor, execute: async (payload: unknown) => StepResultSchema.parse(await request("execute", payload)) }
    : new CodexExecutor(args.model ? { model: args.model } : {});
  const verifier = args.verifier ? { name: args.verifier, verify: async (payload: unknown) => DecisionSchema.parse(await request("verify", payload)) }
    : new CodexVerifier(args.verifier_model ? { model: args.verifier_model } : args.model ? { model: args.model } : {});
  return runWorkflow({ workflow: loadWorkflow(message.workflow), inputs: args.inputs, directory: args.directory, workspace: args.workspace,
    resources: args.resources, state_directory: args.state_directory, concurrency: args.concurrency, timeout_ms: args.timeout_ms, recoveries: args.recoveries, retry_invocations: args.retry_invocations, resume: args.resume, runtime_revision: args.runtime_revision, executor, verifier,
    ...(args.human ? { human: {
      execute: async (payload: unknown) => { const value = await request("human_execute", payload); return value === null ? undefined : StepResultSchema.parse(value); }
    } } : {}), onEvent: event => send({ type: "event", event }) });
}
main().then(result => send({ type: "result", result }), error => { send({ type: "error", error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; }).finally(() => host.close());
