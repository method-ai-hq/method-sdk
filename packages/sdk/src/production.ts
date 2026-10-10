import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertSchema } from "@withmethod/runtime/validate.js";
import { DEFAULT_SERVER, MethodClient, serverOrigin } from "./method-client.js";
import { inputsDigest, open, seal } from "./run-data.js";
import { ProductionWorker, type WorkerOptions, type WorkerResult } from "./worker.js";

// The library API for production runs: start a run of a published Method from an app, answer its questions, and verify
// webhooks. `method.run()` starts a worker in this process on first use, so a laptop needs nothing else running.
//
// The credential: apiKey, else METHOD_API_KEY (the environment, then .env in the current folder), else the CLI sign-in
// of this computer (method login). A device run's inputs, questions, and answers are sealed with a key derived from
// that credential, so the server stores only ciphertext.

export type RunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
/** What an ask handler gets. Return the answer, or return nothing and call answer() (or method.runs.answer) later. */
export type AskEvent = {
  run_id: string;
  /** STEP:ITERATION, for example approve:0. */
  step: string;
  question: string;
  /** JSON Schema of the answer: the ask step's out types. */
  form: Record<string, unknown>;
  answer: (value: Record<string, unknown>) => Promise<ProductionRun>;
};
export type AskHandler = (event: AskEvent) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>;
export type StartRunOptions = {
  /** The Method ID (wf_…). */
  method: string;
  /** "published" (the default) or a version ID. A run stays on one version. */
  version?: string;
  inputs?: Record<string, unknown>;
  /** The same key returns the same run. Use one key for each business event, for example a request ID. */
  idempotencyKey?: string;
  /** HTTPS URL that receives {run_id, status, …} signed with Method-Signature: a needs_input event and the end of the run. */
  webhookUrl?: string;
  /** This app answers the run's questions. Without a handler or a webhook, questions go to the team inbox and email. */
  onAsk?: AskHandler;
};
export type StartedRun = { run_id: string; version_id: string; status: RunStatus };
export type ProductionQuestion = {
  id: string; run_id: string; step: string; answered_by: "app" | "team"; asked_at: string; expires_at: string | null;
  question?: string; form?: Record<string, unknown>; sealed?: string;
};
export type ProductionRun = {
  run_id: string; method_id: string; version_id: string; status: RunStatus; run_data: "account" | "device";
  attempts: number; created_at: string; started_at: string | null; finished_at: string | null; cancel_requested: boolean;
  error: { code?: string; message: string } | null; record_run_id: string | null;
  steps: { id: string; step_id: string; status: string; started_at: string | null; finished_at: string | null }[];
  /** Present while the run waits for an answer. A device run's question arrives sealed; the library opens it. */
  question?: ProductionQuestion;
  /** For run_data "account", from the server. For a device run, only when this process's worker ran it. */
  result?: unknown;
};
export type MethodOptions = {
  apiKey?: string; server?: string; fetch?: typeof fetch;
  /** The default ask handler of runs that this process starts. */
  onAsk?: AskHandler;
  /** false: method.run() does not start a worker in this process (use method worker or worker.start()). */
  worker?: boolean | Omit<WorkerOptions, "methods">;
};
export class MethodApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly body?: unknown) { super(message); }
}
const terminal = new Set<RunStatus>(["succeeded", "failed", "cancelled"]);

/** The production API client. Every request sends Authorization: Bearer CREDENTIAL. */
export class ServiceApi {
  readonly server: string;
  constructor(readonly apiKey: string, server: string, readonly fetcher: typeof fetch = fetch) {
    if (!/^(mk_live_|method_)[A-Za-z0-9_-]{43}$/.test(apiKey))
      throw Error("Use a Method service key (mk_live_…). Run method connect APP_FOLDER to make one, or method login on this computer.");
    this.server = serverOrigin(server);
  }
  async request<T>(path: string, method = "GET", body?: unknown, timeoutMs = 30_000, signal?: AbortSignal): Promise<{ status: number; body: T }> {
    const response = await this.send(path, method, body === undefined ? undefined : JSON.stringify(body), body === undefined ? {} : { "content-type": "application/json" }, timeoutMs, signal);
    if (response.status === 204) return { status: 204, body: null as T };
    const text = await response.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { throw new MethodApiError(response.status, "invalid_response", `${response.status}: Method returned a non-JSON response (${method} ${path}).`); }
    if (!response.ok) throw new MethodApiError(response.status, String(parsed.code ?? parsed.error ?? "request_failed"), `${response.status}: ${String(parsed.message ?? parsed.error ?? "Method request failed")}`, parsed);
    return { status: response.status, body: parsed as T };
  }
  /** Send or get raw bytes (a run folder). */
  async bytes(path: string, method: string, body?: Uint8Array, headers: Record<string, string> = {}): Promise<Buffer> {
    const response = await this.send(path, method, body, { ...headers, ...(body ? { "content-type": "application/octet-stream" } : {}) }, 120_000);
    const data = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      let parsed: any = {};
      try { parsed = JSON.parse(data.toString("utf8")); } catch { /* Not JSON. */ }
      throw new MethodApiError(response.status, String(parsed.code ?? "request_failed"), `${response.status}: ${String(parsed.message ?? "Method request failed")}`, parsed);
    }
    return data;
  }
  private send(path: string, method: string, body: string | Uint8Array | undefined, headers: Record<string, string>, timeoutMs: number, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    return this.fetcher(this.server + path, {
      method, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { authorization: `Bearer ${this.apiKey}`, ...headers }, ...(body === undefined ? {} : { body: body as BodyInit }),
    });
  }
}

/** Verify a webhook: Method-Signature is t=TIMESTAMP,v1=HEX(HMAC-SHA256(secret, `${t}.${body}`)). Pass the raw body. */
export function verifyWebhook(body: string | Uint8Array, signature: string | null | undefined, secret: string, options: { toleranceSeconds?: number; now?: number } = {}) {
  const match = signature?.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
  if (!match) return false;
  const age = Math.abs((options.now ?? Date.now()) / 1000 - Number(match[1]));
  if (age > (options.toleranceSeconds ?? 300)) return false;
  const text = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
  const expected = createHmac("sha256", secret).update(`${match[1]}.${text}`).digest();
  return timingSafeEqual(expected, Buffer.from(match[2]!, "hex"));
}

/** METHOD_API_KEY and METHOD_SERVER from .env in a folder. Other lines are not read. */
export function dotenvValues(folder = process.cwd()): { METHOD_API_KEY?: string; METHOD_SERVER?: string } {
  const file = join(folder, ".env");
  if (!existsSync(file)) return {};
  const found: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?(METHOD_API_KEY|METHOD_SERVER)\s*=\s*(.*?)\s*$/);
    if (match) found[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return found;
}
/** The credential of the libraries: apiKey, METHOD_API_KEY, .env, then the CLI sign-in. */
export function resolveCredential(options: { apiKey?: string; server?: string } = {}) {
  const dotenv = dotenvValues();
  const server = options.server ?? process.env.METHOD_SERVER ?? dotenv.METHOD_SERVER ?? DEFAULT_SERVER;
  const key = options.apiKey ?? process.env.METHOD_API_KEY ?? dotenv.METHOD_API_KEY;
  if (key) return { key, server };
  let signedIn: string | null = null;
  try { signedIn = new MethodClient(server).token(); } catch { /* No sign-in for this server. */ }
  if (signedIn) return { key: signedIn, server };
  throw Error("Set METHOD_API_KEY (run method connect APP_FOLDER to write it to the app's .env), or sign in on this computer with method login.");
}

export class Method {
  readonly api: ServiceApi;
  /** Results of runs that this process's worker finished. A device run's result exists only here. */
  private readonly local = new Map<string, WorkerResult>();
  private readonly waiting = new Map<string, Set<() => void>>();
  private readonly handlers = new Map<string, AskHandler>();
  private readonly asked = new Set<string>();
  private readonly runData = new Map<string, { value: "account" | "device"; at: number }>();
  private readonly lazyMethods = new Set<string>();
  private lazyWorker: ProductionWorker | undefined;
  private lazyRuns = 0;
  readonly runs = {
    start: async (options: StartRunOptions): Promise<StartedRun> => {
      const inputs = options.inputs ?? {};
      const send = async (sealed: boolean) => (await this.api.request<StartedRun>("/v1/runs", "POST", {
        method: options.method, ...(options.version ? { version: options.version } : {}),
        ...(sealed ? { inputs: {}, sealed_inputs: seal(this.api.apiKey, "inputs", options.method, inputs), inputs_digest: inputsDigest(this.api.apiKey, options.method, inputs) } : { inputs }),
        ...(options.idempotencyKey ? { idempotency_key: options.idempotencyKey } : {}), ...(options.webhookUrl ? { webhook_url: options.webhookUrl } : {}),
        ...(options.onAsk ?? this.options.onAsk ? { answered_by: "app" } : {}),
      })).body;
      // A device run's inputs are sealed here. The server says which Methods keep run content on devices.
      const sealIt = Object.keys(inputs).length > 0 && await this.keepsOnDevice(options.method);
      let started: StartedRun;
      try { started = await send(sealIt); }
      catch (error) {
        if (!(error instanceof MethodApiError && error.code === "seal_inputs")) throw error;
        this.runData.set(options.method, { value: "device", at: Date.now() });
        started = await send(true);
      }
      const handler = options.onAsk ?? this.options.onAsk;
      if (handler) this.handlers.set(started.run_id, handler);
      return started;
    },
    get: async (runId: string): Promise<ProductionRun> => this.withLocal((await this.api.request<ProductionRun>(`/v1/runs/${encodeURIComponent(runId)}`)).body),
    cancel: async (runId: string): Promise<ProductionRun> => this.withLocal((await this.api.request<ProductionRun>(`/v1/runs/${encodeURIComponent(runId)}/cancel`, "POST", {})).body),
    /** Answer the waiting question of a run. The answer must match the question's form. */
    answer: async (runId: string, answer: Record<string, unknown>): Promise<ProductionRun> => {
      const run = await this.runs.get(runId);
      if (run.status !== "waiting" || !run.question) throw new MethodApiError(409, "not_waiting", `The run is ${run.status}; it has no question to answer.`);
      const asked = this.openQuestion(run);
      try { assertSchema(asked.form, answer, "Answer"); }
      catch (error) { throw new MethodApiError(422, "invalid_answer", (error as Error).message); }
      const body = run.question.sealed ? { step: run.question.step, sealed_answer: seal(this.api.apiKey, "answer", run.method_id, answer) } : { step: run.question.step, answer };
      return this.withLocal((await this.api.request<ProductionRun>(`/v1/runs/${encodeURIComponent(runId)}/answer`, "POST", body)).body);
    },
    /**
     * Wait until the run ends. Checks the server every intervalMs, and returns at once when this process's worker finishes
     * it. A question of a run with an ask handler goes to the handler.
     */
    wait: async (runId: string, options: { timeoutMs?: number; intervalMs?: number; onAsk?: AskHandler } = {}): Promise<ProductionRun> => {
      const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
      for (;;) {
        const run = await this.runs.get(runId);
        // This process's worker saves a result before it completes the run, so a finished run has its local result here.
        if (terminal.has(run.status)) { this.handlers.delete(runId); return run; }
        if (run.status === "waiting" && run.question) await this.ask(run, options.onAsk);
        if (Date.now() > deadline) throw new MethodApiError(408, "wait_timeout", `The run is still ${run.status}.`);
        await new Promise<void>(resolve => {
          const wake = () => { clearTimeout(timer); this.waiting.get(runId)?.delete(wake); resolve(); };
          const timer = setTimeout(wake, Math.min(options.intervalMs ?? 2_000, Math.max(0, deadline - Date.now())));
          this.waiting.set(runId, (this.waiting.get(runId) ?? new Set()).add(wake));
        });
      }
    },
    /** Start a run and wait for its result. Needs a worker: method.run() starts one in this process. */
    run: async (options: StartRunOptions & { timeoutMs?: number; intervalMs?: number }): Promise<ProductionRun> =>
      this.runs.wait((await this.runs.start(options)).run_id, options),
  };
  readonly worker = {
    /** Claim and run queued runs in this process. Results reach onResult, runs.wait, and the dashboard. */
    start: (options: WorkerOptions = {}) => {
      const worker = new ProductionWorker(this.api, { ...options,
        onResult: async result => {
          this.local.set(result.run_id, result);
          this.wake(result.run_id);
          await options.onResult?.(result);
        },
        onWaiting: async waiting => { this.wake(waiting.run_id); await options.onWaiting?.(waiting); } });
      worker.start();
      return worker;
    },
  };
  readonly webhooks = { verify: verifyWebhook };
  static readonly webhooks = { verify: verifyWebhook };

  constructor(private readonly options: MethodOptions = {}) {
    const { key, server } = resolveCredential(options);
    this.api = new ServiceApi(key, server, options.fetch);
  }
  /**
   * Run a published Method and wait for its result. The first call starts a worker in this process (unless the options
   * say worker: false), so the run needs nothing else running. The worker stops when no method.run() call is waiting,
   * so a script that calls method.run() exits when it is done; close() is not needed.
   */
  async run(options: StartRunOptions & { timeoutMs?: number; intervalMs?: number }): Promise<ProductionRun> {
    this.ensureWorker(options.method);
    this.lazyRuns++;
    try { return await this.runs.run(options); }
    // The worker stops claiming at once; a run it holds still finishes. run() returns without waiting for that.
    finally { if (--this.lazyRuns === 0) void this.close().catch(() => {}); }
  }
  /** Stop this process's worker. Runs in progress finish first. */
  async close(options: { cancel?: boolean } = {}) {
    const worker = this.lazyWorker;
    this.lazyWorker = undefined;
    await worker?.stop(options);
  }
  private ensureWorker(method: string) {
    if (this.options.worker === false) return;
    this.lazyMethods.add(method);
    if (this.lazyWorker?.running) return;
    const extra = typeof this.options.worker === "object" ? this.options.worker : {};
    this.lazyWorker = this.worker.start({ ...extra, methods: this.lazyMethods });
  }
  private wake(runId: string) { for (const wake of this.waiting.get(runId) ?? []) wake(); }
  private async keepsOnDevice(method: string) {
    const known = this.runData.get(method);
    if (known && Date.now() - known.at < 5 * 60_000) return known.value === "device";
    try {
      const found = (await this.api.request<{ run_data: "account" | "device" }>(`/v1/methods/${encodeURIComponent(method)}`)).body;
      this.runData.set(method, { value: found.run_data, at: Date.now() });
      return found.run_data === "device";
    } catch { return false; /* The server refuses plain inputs of a device run (seal_inputs), and start seals them then. */ }
  }
  private openQuestion(run: ProductionRun): { question: string; form: Record<string, unknown> } {
    const asked = run.question!;
    if (!asked.sealed) return { question: asked.question ?? "", form: asked.form ?? {} };
    return open<{ question: string; form: Record<string, unknown> }>(this.api.apiKey, "question", run.method_id, asked.sealed);
  }
  /** Give a waiting question to the run's ask handler, once. */
  private async ask(run: ProductionRun, override?: AskHandler) {
    const handler = override ?? this.handlers.get(run.run_id);
    const question = run.question!, id = `${question.id}:${question.asked_at}`;
    if (!handler || this.asked.has(id)) return;
    this.asked.add(id);
    const opened = this.openQuestion(run);
    const answer = (value: Record<string, unknown>) => this.runs.answer(run.run_id, value);
    const value = await handler({ run_id: run.run_id, step: question.step, question: opened.question, form: opened.form, answer });
    if (value && typeof value === "object") await answer(value);
  }
  private withLocal(run: ProductionRun): ProductionRun {
    const local = this.local.get(run.run_id);
    return local && local.result !== undefined && run.result === undefined ? { ...run, result: local.result } : run;
  }
}
