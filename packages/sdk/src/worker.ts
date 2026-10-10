import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { writePrivateJson } from "./files.js";
import { DEFAULT_SERVER, MethodClient } from "./method-client.js";
import { methodCache } from "./prepare.js";
import type { ServiceApi } from "./production.js";
import { open, openBytes, seal, sealBytes } from "./run-data.js";

// The production worker. It claims a queued run (the server waits up to 25 s for one), renews the lease every third of
// the lease time, runs the saved version with the existing runtime in a child `method run` process, and completes the
// run. The child downloads the version package by ID, prepares dependencies once per lockfile (cached under
// ~/.cache/method/environments), reads declared secrets from the environment, and sends the run record with the key.
//
// An ask step: the child stops with needs_input. The worker saves the run folder on the server (sealed for a device
// run), reports the question, and lets go of the run: no process waits for the answer. When the answer arrives the run
// is queued again; the worker that claims it restores the folder if it does not have it and continues the run with the
// answers, so the finished steps are not run again.

type Answer = { outputs: Record<string, unknown> } | { sealed: string };
export type Claim = {
  run_id: string; method_id: string; version_id: string; inputs: Record<string, unknown>; sealed_inputs?: string;
  lease_id: string; lease_ms: number; attempt: number; run_data: "account" | "device";
  /** The run waited for answers before. */
  resume?: boolean; snapshot?: boolean;
  /** Answers by STEP:ITERATION, opened by the worker before the executor runs. */
  answers?: Record<string, Answer>;
};
/** A question of an ask step: STEP:ITERATION, the question text, and the JSON Schema of the answer. */
export type Question = { step: string; question: string; form: Record<string, unknown> };
export type Outcome =
  | { status: "succeeded" | "failed" | "cancelled"; result?: unknown; error?: { code?: string; message: string }; retryable?: boolean }
  | { status: "waiting"; question: Question; timeoutMs?: number };
export type Executor = (claim: Claim, context: { directory: string; runDir: string; signal: AbortSignal; api: ServiceApi }) => Promise<Outcome>;
export type WorkerResult = {
  run_id: string; method_id: string; version_id: string; status: "succeeded" | "failed" | "cancelled"; run_data: Claim["run_data"];
  result?: unknown; error?: { code?: string; message: string }; run_dir: string;
};
export type WorkerOptions = {
  /** Claim only runs of these Methods. Default: every Method of the organization. A Set may grow while the worker runs. */
  methods?: string[] | Set<string>;
  /** Runs at the same time in this worker. Default 1. */
  concurrency?: number;
  workerId?: string;
  /** How long one claim request waits on the server. Default 25 s; 0 polls. */
  waitMs?: number;
  /** Called with each finished run before the server marks it finished. A device run's result exists only here. */
  onResult?: (result: WorkerResult) => void | Promise<void>;
  /** Called when a run starts to wait for an answer, after the server has the question. */
  onWaiting?: (run: { run_id: string; method_id: string; question: Question }) => void | Promise<void>;
  onError?: (error: Error) => void;
  /** Where run folders are kept. Default ~/.cache/method/worker. A claim of the same run resumes its folder. */
  directory?: string;
  execute?: Executor;
};

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(done => {
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); done(); }, { once: true });
});

export class ProductionWorker {
  readonly id: string;
  done: Promise<void> = Promise.resolve();
  private readonly stopping = new AbortController();
  private readonly active = new Map<string, AbortController>();
  private cancelActive = false;
  constructor(readonly api: ServiceApi, readonly options: WorkerOptions = {}) {
    this.id = options.workerId ?? `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
  }
  get running() { return !this.stopping.signal.aborted; }
  start() {
    const slots = Math.max(1, Math.min(32, Math.floor(this.options.concurrency ?? 1)));
    this.done = Promise.all(Array.from({ length: slots }, () => this.loop())).then(() => undefined);
    return this;
  }
  /** Stop claiming. Running runs finish, unless cancel is true: then they stop and go back to the queue. */
  async stop(options: { cancel?: boolean } = {}) {
    this.stopping.abort();
    if (options.cancel) { this.cancelActive = true; for (const controller of this.active.values()) controller.abort(); }
    await this.done;
  }
  private report(error: unknown) {
    const value = error instanceof Error ? error : new Error(String(error));
    if (this.options.onError) this.options.onError(value);
    else process.stderr.write(`Method worker: ${value.message}\n`);
  }
  private async loop() {
    let backoff = 1_000;
    const waitMs = this.options.waitMs ?? 25_000;
    while (!this.stopping.signal.aborted) {
      let claim: Claim;
      try {
        const methods = [...this.options.methods ?? []];
        const response = await this.api.request<Claim>("/v1/worker/claim", "POST",
          { worker_id: this.id, wait_ms: waitMs, ...(methods.length ? { methods } : {}) },
          waitMs + 15_000, this.stopping.signal);
        backoff = 1_000;
        if (response.status === 204) { if (!waitMs) await sleep(3_000, this.stopping.signal); continue; }
        claim = response.body;
      } catch (error: any) {
        if (this.stopping.signal.aborted) break;
        // A key without the worker scope, or a revoked key, cannot recover by retrying.
        if (error?.status === 401 || error?.status === 403) { this.report(error); this.stopping.abort(); break; }
        this.report(error);
        await sleep(backoff, this.stopping.signal);
        backoff = Math.min(backoff * 2, 30_000);
        continue;
      }
      await this.handle(claim);
    }
  }
  private async handle(claim: Claim) {
    const controller = new AbortController(), directory = resolve(this.options.directory ?? join(methodCache(), "worker"));
    this.active.set(claim.run_id, controller);
    let lost = false, cancelled = false, runDir = join(directory, claim.run_id);
    const path = `/v1/worker/runs/${encodeURIComponent(claim.run_id)}`;
    const heartbeat = setInterval(async () => {
      try {
        const response = await this.api.request<{ cancel_requested: boolean }>(`${path}/heartbeat`, "POST", { lease_id: claim.lease_id });
        if (response.body.cancel_requested && !cancelled) { cancelled = true; controller.abort(); }
      } catch (error: any) {
        // Another worker holds the run now. Stop this copy and do not complete it.
        if (error?.status === 409) { lost = true; controller.abort(); } else this.report(error);
      }
    }, Math.max(1_000, Math.floor(claim.lease_ms / 3)));
    // The run itself keeps the process alive; the heartbeat alone must not.
    heartbeat.unref();
    let outcome: Outcome;
    try {
      const opened = this.open(claim);
      // A run that waited continues its folder. A worker that does not have the folder gets it from the server.
      if (claim.resume && !existsSync(join(runDir, "checkpoint.json"))) {
        if (!claim.snapshot) throw Object.assign(Error("The run folder of this waiting run is not on this worker and was not saved."), { code: "run_folder_missing" });
        runDir = await this.restore(claim, runDir);
      }
      outcome = await (this.options.execute ?? cliExecutor())(opened, { directory, runDir, signal: controller.signal, api: this.api });
    } catch (error: any) {
      const final = ["wrong_key", "run_folder_missing", "invalid_sealed"].includes(error?.code);
      outcome = { status: "failed", error: { code: error?.code ?? "worker_failed", message: String(error?.message ?? error) }, retryable: !final };
    } finally { clearInterval(heartbeat); this.active.delete(claim.run_id); }
    if (lost) return;
    if (outcome.status === "waiting" && !cancelled && !this.cancelActive) { await this.wait(claim, runDir, outcome); return; }
    if (outcome.status === "waiting") outcome = cancelled ? { status: "cancelled", error: { code: "cancelled", message: "The run was cancelled." } }
      : { status: "failed", error: { code: "worker_stopped", message: "The worker stopped." }, retryable: true };
    if (cancelled && outcome.status !== "succeeded") outcome = { status: "cancelled", error: { code: "cancelled", message: "The run was cancelled." } };
    else if (this.cancelActive && outcome.status !== "succeeded") outcome = { status: "failed", error: { code: "worker_stopped", message: "The worker stopped." }, retryable: true };
    const done = outcome as Exclude<Outcome, { status: "waiting" }>;
    const finished: WorkerResult = { run_id: claim.run_id, method_id: claim.method_id, version_id: claim.version_id, status: done.status,
      run_data: claim.run_data, run_dir: runDir,
      ...(done.result !== undefined ? { result: done.result } : {}), ...(done.error ? { error: done.error } : {}) };
    // A requeued run is not finished; it runs again.
    if (!(done.status === "failed" && done.retryable && claim.attempt < 3)) {
      try { await this.options.onResult?.(finished); } catch (error) { this.report(error); }
    }
    const body = { lease_id: claim.lease_id, status: done.status, ...(done.error ? { error: done.error } : {}),
      ...(done.retryable ? { retryable: true } : {}),
      // A device run's result stays on this computer.
      ...(claim.run_data === "account" && done.result !== undefined ? { result: done.result } : {}) };
    await this.send(`${path}/complete`, body);
  }
  private async send(path: string, body: unknown) {
    for (let attempt = 0; ; attempt++) {
      try { await this.api.request(path, "POST", body); return true; }
      catch (error: any) {
        if (error?.status && error.status < 500 && error.status !== 429 || attempt >= 4) { this.report(error); return false; }
        await sleep(1_000 * 2 ** attempt);
      }
    }
  }
  /** Open sealed inputs and answers with this worker's credential. */
  private open(claim: Claim): Claim {
    const key = this.api.apiKey;
    const inputs = claim.sealed_inputs ? open<Record<string, unknown>>(key, "inputs", claim.method_id, claim.sealed_inputs) : claim.inputs;
    const answers = Object.fromEntries(Object.entries(claim.answers ?? {}).map(([step, answer]) =>
      [step, "sealed" in answer ? { outputs: open<Record<string, unknown>>(key, "answer", claim.method_id, answer.sealed) } : answer]));
    const { sealed_inputs: _sealed, ...rest } = claim;
    return { ...rest, inputs, answers };
  }
  /** Save the run folder, report the question, and let go of the run. */
  private async wait(claim: Claim, runDir: string, outcome: Extract<Outcome, { status: "waiting" }>) {
    const path = `/v1/worker/runs/${encodeURIComponent(claim.run_id)}`;
    try {
      const packed = packFolder(runDir);
      const bytes = claim.run_data === "device" ? sealBytes(this.api.apiKey, claim.method_id, packed) : packed;
      await this.api.bytes(`${path}/snapshot`, "PUT", bytes, { "method-lease": claim.lease_id });
    } catch (error) {
      // Without a saved folder only this worker can continue the run. Report the question anyway.
      this.report(new Error(`The run folder was not saved, so only this worker can continue run ${claim.run_id}: ${(error as Error).message}`));
    }
    const asked = claim.run_data === "device"
      ? { sealed_question: seal(this.api.apiKey, "question", claim.method_id, { question: outcome.question.question, form: outcome.question.form }) }
      : { question: outcome.question.question, form: outcome.question.form };
    const sent = await this.send(`${path}/wait`, { lease_id: claim.lease_id, step: outcome.question.step, ...asked,
      ...(outcome.timeoutMs ? { timeout_ms: outcome.timeoutMs } : {}) });
    if (sent) try { await this.options.onWaiting?.({ run_id: claim.run_id, method_id: claim.method_id, question: outcome.question }); } catch (error) { this.report(error); }
  }
  /** Get the saved run folder. It goes back to the path it had, when this computer can write there, so the run can resume. */
  private async restore(claim: Claim, fallback: string) {
    const response = await this.api.bytes(`/v1/worker/runs/${encodeURIComponent(claim.run_id)}/snapshot`, "GET", undefined, { "method-lease": claim.lease_id });
    const packed = claim.run_data === "device" ? openBytes(this.api.apiKey, claim.method_id, response) : response;
    return unpackFolder(packed, fallback);
  }
}

const skipped = (path: string) => /(^|\/)(source|node_modules|\.venv|__pycache__)(\/|$)/.test(path) || /\.log$/.test(path);
/** The run folder as gzip JSON: its own path and each file. */
export function packFolder(dir: string): Buffer {
  const files: { path: string; data: string }[] = [];
  const visit = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const full = join(folder, name), rel = relative(dir, full).split(sep).join("/");
      if (skipped(rel)) continue;
      const stat = lstatSync(full);
      if (stat.isDirectory()) visit(full);
      else if (stat.isFile()) {
        files.push({ path: rel, data: readFileSync(full).toString("base64") });
      }
    }
  };
  visit(dir);
  return gzipSync(JSON.stringify({ schema: "method-run-folder/1", dir, files }));
}
export function unpackFolder(packed: Uint8Array, fallback: string): string {
  const folder = JSON.parse(gunzipSync(packed).toString("utf8")) as { schema: string; dir: string; files: { path: string; data: string }[] };
  if (folder.schema !== "method-run-folder/1") throw Error("Unknown run folder format.");
  let target = fallback;
  // The run's saved configuration names its folder, so the original path lets the runtime resume it.
  try { mkdirSync(folder.dir, { recursive: true, mode: 0o700 }); target = folder.dir; } catch { mkdirSync(fallback, { recursive: true, mode: 0o700 }); }
  for (const file of folder.files) {
    const path = resolve(target, file.path);
    if (!path.startsWith(resolve(target) + sep)) throw Error("The saved run folder has a file outside the folder.");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, Buffer.from(file.data, "base64"), { mode: 0o600 });
  }
  return target;
}

/** The last question the runtime asked in a run folder: the human.required event. */
export function lastQuestion(dir: string): Question | null {
  let lines: string[];
  try { lines = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n"); } catch { return null; }
  for (const line of lines.reverse()) {
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.event !== "human.required") continue;
    let form = event.schema;
    if (!form) {
      // A runtime that does not record the form: derive it from the step's out types.
      try { form = outputForm(JSON.parse(readFileSync(join(dir, "saved.method"), "utf8")).steps?.[event.step]?.out ?? {}); } catch { form = { type: "object", properties: {} }; }
    }
    return { step: `${event.step}:${event.iteration ?? 0}`, question: String(event.prompt ?? ""), form };
  }
  return null;
}
function outputForm(out: Record<string, any>): Record<string, unknown> {
  const one = (def: any): any => {
    const d = typeof def === "string" ? { type: def } : def ?? {};
    const base = d.type === "number" ? { type: "number" } : d.type === "boolean" ? { type: "boolean" } : d.type === "list" ? { type: "array", items: d.fields ? outputForm(d.fields) : one(d.items) }
      : d.type === "record" ? outputForm(d.fields ?? {}) : { type: "string" };
    return d.description ? { ...base, description: d.description } : base;
  };
  return { type: "object", properties: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, one(v)])), required: Object.keys(out), additionalProperties: false };
}

const finalCodes = new Set(["needs_input", "needs_update", "missing_secret", "invalid_inputs", "model_not_private"]);
/** Run a claim with `method run METHOD_ID --version VERSION_ID` in a child process, then read its summary. */
export function cliExecutor(options: { command?: string[] } = {}): Executor {
  return async (claim, { runDir: dir, signal, api }) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The run record uses the production run ID, so the dashboard links both.
    if (!existsSync(join(dir, "request.json")))
      writePrivateJson(join(dir, "request.json"), { run_id: claim.run_id, workflow_id: claim.method_id, version_id: claim.version_id, server: api.server });
    const inputs = join(dir, "production-inputs.json");
    writePrivateJson(inputs, claim.inputs);
    // Answers of ask steps, in the runtime's --human format.
    const answers = Object.entries(claim.answers ?? {});
    const human = join(dir, "production-answers.json");
    if (answers.length) writePrivateJson(human, { steps: Object.fromEntries(answers.map(([step, answer]) => [step, { outputs: (answer as { outputs: unknown }).outputs }])) });
    const command = options.command ?? methodCommand();
    const out = openSync(join(dir, "worker.stdout.log"), "a", 0o600), err = openSync(join(dir, "worker.stderr.log"), "a", 0o600);
    // The CLI sign-in of this computer reaches the child through its saved credential, not the environment.
    const credential = api.apiKey.startsWith("mk_live_") ? { METHOD_API_KEY: api.apiKey } : {};
    const child = spawn(command[0]!, [...command.slice(1), "run", claim.method_id, "--version", claim.version_id, "--server", api.server,
      "--run-dir", dir, "--inputs", inputs, "--resume", ...(answers.length ? ["--human", human] : [])], {
      detached: true, stdio: ["ignore", out, err],
      env: { ...process.env, ...credential, METHOD_RUN_WORKER: "1", METHOD_NO_EXPLAIN: "1" },
    });
    closeSync(out); closeSync(err);
    const stop = () => {
      try { process.kill(-child.pid!, "SIGTERM"); } catch { /* Already stopped. */ }
      setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* Stopped. */ } }, 10_000).unref();
    };
    signal.addEventListener("abort", stop, { once: true });
    const code = await new Promise<number | null>((done, fail) => { child.once("error", fail); child.once("exit", done); })
      .finally(() => signal.removeEventListener("abort", stop));
    const read = (name: string) => { try { return JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { return null; } };
    const summary = read("summary.json");
    if (summary?.status === "completed" || summary?.status === "unconfirmed") return { status: "succeeded", result: summary.result };
    if (signal.aborted) return { status: "cancelled", error: { code: "cancelled", message: "The run was stopped." } };
    if (summary?.status === "needs_input") {
      // An ask step: the run waits for an answer, until it is answered or cancelled, or for the step's limits.timeout_ms.
      const question = lastQuestion(dir);
      if (question) {
        let timeoutMs: number | undefined;
        try { timeoutMs = JSON.parse(readFileSync(join(dir, "saved.method"), "utf8")).steps?.[question.step.split(":")[0]!]?.limits?.timeout_ms; } catch { /* Default. */ }
        return { status: "waiting", question, ...(typeof timeoutMs === "number" ? { timeoutMs } : {}) };
      }
      return { status: "failed", error: { code: "needs_input", message: String(summary.error ?? "The run needs input that a production worker cannot give.") } };
    }
    if (summary?.status === "failed") return { status: "failed", error: { code: summary.code ?? "execution_failed", message: String(summary.error ?? "The run failed.") } };
    const setup = read("setup-error.json");
    if (setup) return { status: "failed", error: { code: setup.code, message: String(setup.error) }, retryable: !finalCodes.has(setup.code) };
    return { status: "failed", error: { code: "worker_failed", message: `The run process stopped (exit ${code}). See ${join(dir, "worker.stderr.log")}.` }, retryable: true };
  };
}
function methodCommand() {
  const source = import.meta.url.endsWith(".ts");
  return [process.execPath, ...(source ? process.execArgv : []), fileURLToPath(new URL(`./method.${source ? "ts" : "js"}`, import.meta.url))];
}

/** `method worker` and `method keys`. */
export async function productionCommand(args: string[], clientFactory: (server: string) => MethodClient) {
  const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  if (args[0] === "worker") {
    const { values } = parseArgs({ args: args.slice(1), options: { method: { type: "string", multiple: true }, concurrency: { type: "string" }, server: { type: "string" },
      // The Python library sends more Method IDs on stdin, one a line, as its app starts runs of them.
      "methods-from-stdin": { type: "boolean" } } });
    const concurrency = values.concurrency === undefined ? 1 : Number(values.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw Error("Use --concurrency 1 to 32.");
    const { Method } = await import("./production.js");
    // METHOD_API_KEY, or the CLI sign-in of this computer.
    const method = new Method({ server: values.server ?? DEFAULT_SERVER, worker: false });
    const methods = new Set(values.method ?? []);
    // One JSON line for each finished run, and one for each run that waits for an answer. A device run's result is printed here only.
    const worker = method.worker.start({ concurrency, ...(methods.size || values["methods-from-stdin"] ? { methods } : {}),
      onResult: result => { process.stdout.write(JSON.stringify(result) + "\n"); },
      onWaiting: run => { process.stdout.write(JSON.stringify({ run_id: run.run_id, status: "waiting", question: run.question }) + "\n"); } });
    if (values["methods-from-stdin"]) {
      process.stdin.setEncoding("utf8");
      let pending = "";
      process.stdin.on("data", chunk => {
        pending += chunk;
        const lines = pending.split("\n"); pending = lines.pop() ?? "";
        for (const line of lines) if (/^wf_[A-Za-z0-9_]+$/.test(line.trim())) methods.add(line.trim());
      });
    }
    process.stderr.write(`Method worker ${worker.id} is waiting for runs on ${method.api.server}. Press Ctrl+C to stop after the current runs.\n`);
    let signals = 0;
    const stop = () => { signals++; void worker.stop({ cancel: signals > 1 }); if (signals === 1) process.stderr.write("Stopping after the current runs. Press Ctrl+C again to stop them now.\n"); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    try { await worker.done; } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); process.stdin.pause(); }
    return;
  }
  const { values, positionals } = parseArgs({ args: args.slice(1), allowPositionals: true, options: { name: { type: "string" }, server: { type: "string" } } });
  const client = clientFactory(values.server ?? DEFAULT_SERVER);
  if (!client.token()) await client.login();
  const action = positionals[0];
  if (action === "create") {
    if (!values.name) throw Error("Use method keys create --name NAME.");
    const created = await client.request("/api/service-keys", "POST", { name: values.name });
    print({ ...created, next: "Save key as METHOD_API_KEY and webhook_secret as METHOD_WEBHOOK_SECRET in your app's secret store. They are shown only once. To write the key to an app's .env without showing it, use method connect APP_FOLDER." });
    return;
  }
  if (action === "list" || !action) { print(await client.request("/api/service-keys")); return; }
  if (action === "revoke" && positionals[1]) { print(await client.request(`/api/service-keys/${encodeURIComponent(positionals[1])}/revoke`, "POST", {})); return; }
  throw Error("Use method keys create --name NAME, method keys list, or method keys revoke KEY_ID.");
}
