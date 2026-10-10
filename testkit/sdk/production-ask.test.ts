import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Method } from "../../packages/sdk/src/production.js";
import { open, seal } from "../../packages/sdk/src/run-data.js";
import { lastQuestion, packFolder, unpackFolder, type Executor } from "../../packages/sdk/src/worker.js";
import { connectCommand, answerCommand } from "../../packages/sdk/src/connect.js";

const key = "mk_live_" + "B".repeat(43);
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function folder() { const root = mkdtempSync(join(tmpdir(), "method-ask-")); roots.push(root); return root; }
const form = { type: "object", properties: { approved: { type: "boolean" }, note: { type: "string" } }, required: ["approved", "note"], additionalProperties: false };

/** A small runs API with questions: waiting, answers, snapshots, and sealed content, the way the server keeps them. */
function api(options: { runData?: "account" | "device"; credential?: string } = {}) {
  const credential = options.credential ?? key;
  const runs = new Map<string, any>(), calls: { path: string; method: string; body: any }[] = [], snapshots = new Map<string, Buffer>();
  let next = 0;
  const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname, method = init.method ?? "GET";
    const raw = init.body instanceof Uint8Array || Buffer.isBuffer(init.body) ? Buffer.from(init.body as Uint8Array) : null;
    const body = init.body && !raw ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body: raw ? `<${raw.length} bytes>` : body });
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${credential}`);
    if (path.startsWith("/v1/methods/")) return reply(200, { method_id: path.split("/").pop(), run_data: options.runData ?? "account", published_version_id: "v_1" });
    if (path === "/v1/runs" && method === "POST") {
      if ((options.runData ?? "account") === "device" && Object.keys(body.inputs).length) return reply(409, { code: "seal_inputs", message: "Seal." });
      const id = `00000000-0000-4000-8000-00000000000${++next}`;
      runs.set(id, { run_id: id, method_id: body.method, version_id: "v_1", status: "queued", run_data: options.runData ?? "account", attempts: 0, steps: [],
        inputs: body.inputs, sealed_inputs: body.sealed_inputs, answered_by: body.answered_by ?? "team", answers: {} as Record<string, any> });
      return reply(201, { run_id: id, version_id: "v_1", status: "queued" });
    }
    if (path === "/v1/worker/claim") {
      const run = [...runs.values()].find(r => r.status === "queued");
      if (!run) { await new Promise(r => setTimeout(r, Math.min(body.wait_ms, 30))); return reply(204); }
      const resume = Object.keys(run.answers).length > 0;
      Object.assign(run, { status: "running", attempts: run.attempts + (resume ? 0 : 1), lease_id: `lease-${++next}` });
      return reply(200, { run_id: run.run_id, method_id: run.method_id, version_id: run.version_id, inputs: run.inputs, ...(run.sealed_inputs ? { sealed_inputs: run.sealed_inputs } : {}),
        lease_id: run.lease_id, lease_ms: 60_000, attempt: run.attempts, run_data: run.run_data, resume, snapshot: snapshots.has(run.run_id), answers: run.answers });
    }
    const match = path.match(/^\/v1\/(?:worker\/)?runs\/([^/]+)(?:\/(heartbeat|complete|cancel|wait|answer|snapshot))?$/);
    const run = match ? runs.get(match[1]!) : undefined;
    if (!run) return reply(404, { message: "Run not found." });
    const action = match![2];
    if (action === "heartbeat") return reply(200, { lease_ms: 60_000, cancel_requested: false });
    if (action === "snapshot" && method === "PUT") { snapshots.set(run.run_id, raw!); return reply(200, { ok: true }); }
    if (action === "snapshot") return new Response(snapshots.get(run.run_id)!, { status: 200 });
    if (action === "wait") {
      Object.assign(run, { status: "waiting", lease_id: null, question: { id: `q-${run.run_id}`, run_id: run.run_id, step: body.step, answered_by: run.answered_by,
        asked_at: new Date().toISOString(), expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        ...(body.sealed_question ? { sealed: body.sealed_question } : { question: body.question, form: body.form }) }, timeout_ms: body.timeout_ms });
      return reply(200, run);
    }
    if (action === "answer") {
      if (run.status !== "waiting") return reply(409, { code: "not_waiting", message: "Not waiting." });
      run.answers[run.question.step] = body.sealed_answer ? { sealed: body.sealed_answer } : { outputs: body.answer };
      Object.assign(run, { status: "queued", question: undefined });
      return reply(200, run);
    }
    if (action === "complete") { Object.assign(run, { status: body.status, ...(run.run_data === "account" && body.result !== undefined ? { result: body.result } : {}) }); return reply(200, run); }
    const { inputs: _i, sealed_inputs: _s, lease_id: _l, answers: _a, answered_by: _b, timeout_ms: _t, ...shown } = run;
    return reply(200, shown);
  }) as typeof fetch;
  return { runs, calls, snapshots, fetcher };
}
/** An executor that asks once, then finishes with the answer, like the runtime does with --human. */
const asking: Executor = async (claim, { runDir }) => {
  mkdirSync(runDir, { recursive: true });
  const answer = claim.answers?.["approve:0"];
  if (!answer) { writeFileSync(join(runDir, "checkpoint.json"), JSON.stringify({ accepted: { draft: ["Hello Ada"] } })); return { status: "waiting", question: { step: "approve:0", question: "Send this message to Ada?", form }, timeoutMs: 3_600_000 }; }
  expect(JSON.parse(readFileSync(join(runDir, "checkpoint.json"), "utf8"))).toEqual({ accepted: { draft: ["Hello Ada"] } });
  return { status: "succeeded", result: { sent: (answer as any).outputs.approved, note: (answer as any).outputs.note, inputs: claim.inputs } };
};

it("gives a question to the run's ask handler, sends the answer, and continues the run in its saved folder", async () => {
  const server = api();
  const method = new Method({ apiKey: key, server: "http://127.0.0.1:9", fetch: server.fetcher, worker: { execute: asking, directory: folder(), waitMs: 10 } });
  const asked: any[] = [];
  const run = await method.run({ method: "wf_outreach", inputs: { member: "7" }, intervalMs: 20,
    onAsk: async event => { asked.push(event); return { approved: true, note: "Looks good." }; } });
  await method.close();
  expect(asked).toEqual([expect.objectContaining({ run_id: run.run_id, step: "approve:0", question: "Send this message to Ada?", form })]);
  expect(run).toMatchObject({ status: "succeeded", result: { sent: true, note: "Looks good.", inputs: { member: "7" } } });
  // The app answers, so the run does not go to the team inbox. The worker saved the folder and the step's timeout.
  expect(server.calls.find(c => c.path === "/v1/runs")!.body).toMatchObject({ answered_by: "app" });
  expect(server.calls.find(c => c.path.endsWith("/wait"))!.body).toMatchObject({ step: "approve:0", question: "Send this message to Ada?", form, timeout_ms: 3_600_000 });
  expect(server.snapshots.size).toBe(1);
});

it("starts the in-process worker on the first method.run, and a handler can answer later with runs.answer", async () => {
  const server = api();
  const method = new Method({ apiKey: key, server: "http://127.0.0.1:9", fetch: server.fetcher, worker: { execute: asking, directory: folder(), waitMs: 10 } });
  let later: Promise<unknown> | undefined;
  const run = await method.run({ method: "wf_outreach", inputs: {}, intervalMs: 20,
    onAsk: event => { later = new Promise(done => setTimeout(done, 50)).then(() => method.runs.answer(event.run_id, { approved: false, note: "Not now." })); } });
  await later; await method.close();
  expect(run).toMatchObject({ status: "succeeded", result: { sent: false, note: "Not now." } });
  expect(server.calls.filter(c => c.path === "/v1/worker/claim").length).toBeGreaterThan(0);
  // An answer that does not match the form is refused here, before it is sent.
  await expect(method.runs.answer(run.run_id, { approved: "yes" })).rejects.toThrow(/not_waiting|no question/);
});

it("checks an answer against the form before it sends it", async () => {
  const server = api();
  const method = new Method({ apiKey: key, server: "http://127.0.0.1:9", fetch: server.fetcher, worker: { execute: asking, directory: folder(), waitMs: 10 } });
  const { run_id } = await method.runs.start({ method: "wf_outreach" });
  (method as any).ensureWorker("wf_outreach");
  await vi.waitFor(() => expect(server.runs.get(run_id).status).toBe("waiting"));
  await expect(method.runs.answer(run_id, { approved: "yes", note: "x" })).rejects.toMatchObject({ code: "invalid_answer" });
  await method.runs.answer(run_id, { approved: true, note: "ok" });
  expect((await method.runs.wait(run_id, { intervalMs: 20 })).status).toBe("succeeded");
  await method.close();
});

it("seals a device run's inputs, question, answer, and run folder; the server sees only ciphertext", async () => {
  const server = api({ runData: "device" });
  const workerDir = folder();
  const method = new Method({ apiKey: key, server: "http://127.0.0.1:9", fetch: server.fetcher, worker: { execute: asking, directory: workerDir, waitMs: 10 } });
  const run = await method.run({ method: "wf_private", inputs: { member: "Ada Lovelace" }, intervalMs: 20,
    onAsk: ({ question }) => { expect(question).toBe("Send this message to Ada?"); return { approved: true, note: "private note" }; } });
  await method.close();
  expect(run).toMatchObject({ status: "succeeded", result: { sent: true, note: "private note", inputs: { member: "Ada Lovelace" } } });
  const sent = JSON.stringify(server.calls.map(c => c.body));
  for (const plain of ["Ada Lovelace", "Send this message", "private note", "Hello Ada"]) expect(sent).not.toContain(plain);
  expect([...server.snapshots.values()][0]!.subarray(0, 4).toString()).toBe("MRS1");
  expect([...server.snapshots.values()][0]!.toString("latin1")).not.toContain("Hello Ada");
  const stored = [...server.runs.values()][0];
  expect(open(key, "inputs", "wf_private", stored.sealed_inputs)).toEqual({ member: "Ada Lovelace" });
  // Another key cannot open it.
  expect(() => open("mk_live_" + "C".repeat(43), "inputs", "wf_private", stored.sealed_inputs)).toThrow(/another key/);
});

it("restores the saved run folder on a worker that does not have it", async () => {
  const dir = folder(), first = join(dir, "first", "run-1");
  mkdirSync(join(first, "artifacts"), { recursive: true });
  writeFileSync(join(first, "checkpoint.json"), "{}"); writeFileSync(join(first, "artifacts", "a.txt"), "A"); writeFileSync(join(first, "worker.stderr.log"), "log");
  mkdirSync(join(first, "source")); writeFileSync(join(first, "source", "x.py"), "x");
  const packed = packFolder(first);
  rmSync(first, { recursive: true });
  const restored = unpackFolder(packed, join(dir, "second", "run-1"));
  expect(restored).toBe(first);
  expect(readFileSync(join(restored, "artifacts", "a.txt"), "utf8")).toBe("A");
  expect(existsSync(join(restored, "worker.stderr.log"))).toBe(false);
  expect(existsSync(join(restored, "source"))).toBe(false);
});

it("reads the runtime's question and its form from the run folder", () => {
  const dir = folder();
  writeFileSync(join(dir, "events.jsonl"), [{ event: "step.started", step: "approve" }, { event: "human.required", step: "approve", iteration: 2, prompt: "OK?", schema: form }].map(e => JSON.stringify(e)).join("\n"));
  expect(lastQuestion(dir)).toEqual({ step: "approve:2", question: "OK?", form });
});

it("uses the CLI sign-in of this computer when no METHOD_API_KEY is set", async () => {
  const config = folder(), token = "method_" + "D".repeat(43), server = "http://127.0.0.1:9";
  vi.stubEnv("METHOD_API_KEY", ""); delete process.env.METHOD_API_KEY;
  vi.stubEnv("METHOD_CONFIG_DIR", config);
  writeFileSync(join(config, `${createHash("sha256").update(server).digest("hex").slice(0, 24)}.json`), JSON.stringify({ server, token }));
  const cwd = process.cwd(); process.chdir(folder());
  try {
    const mock = api({ credential: token });
    const method = new Method({ server, fetch: mock.fetcher, worker: { execute: async () => ({ status: "succeeded", result: 1 }), directory: folder(), waitMs: 10 } });
    expect(method.api.apiKey).toBe(token);
    expect((await method.run({ method: "wf_x", intervalMs: 20 })).status).toBe("succeeded");
    await method.close();
  } finally { process.chdir(cwd); }
});

it("reads METHOD_API_KEY from .env in the current folder", () => {
  delete process.env.METHOD_API_KEY;
  const app = folder(), cwd = process.cwd();
  writeFileSync(join(app, ".env"), `OTHER=1\nMETHOD_API_KEY="${key}"\n`);
  process.chdir(app);
  try { expect(new Method({ server: "http://127.0.0.1:9", worker: false }).api.apiKey).toBe(key); } finally { process.chdir(cwd); }
});

it("connect makes a key named after the app, writes it to .env without printing it, and prints the Python code", async () => {
  const root = folder(), app = join(root, "cuties-app"), cwd = process.cwd();
  mkdirSync(app); mkdirSync(join(root, ".git"));
  writeFileSync(join(app, "main.py"), "from fastapi import FastAPI\n"); writeFileSync(join(app, "requirements.txt"), "fastapi\n");
  writeFileSync(join(app, ".env"), "ARCHIVE_TOKEN=keep-me\n");
  writeFileSync(join(root, "profile.method"), [
    "format: method/3.4", "id: wf_" + "a".repeat(32), "name: Profile", "goal: Write a profile.",
    "inputs:", "  name: {type: text, description: Name.}", "  links: {type: list, items: text, description: Links.}",
    "secrets:", "  ARCHIVE_TOKEN: Reads the community archive.",
    "steps:", "  write:", "    name: Write", "    purpose: Write it.", "    in: {name: inputs.name}", "    do: {kind: run, runtime: python, entrypoint: w.py}",
    "    out: {profile: {type: text, description: Profile.}}", "result: profile", ""].join("\n"));
  const created: string[] = [];
  const client: any = { server: "http://127.0.0.1:9", token: () => "method_" + "E".repeat(43), login: async () => {},
    request: async (path: string, _method: string, body: any) => { created.push(body.name); return { key, name: body.name, prefix: key.slice(0, 12) }; } };
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ method_id: "wf_" + "a".repeat(32), run_data: "account", published_version_id: "v_9" }), { status: 200 }));
  process.chdir(root);
  try {
    const result = await connectCommand([app], client);
    expect(created).toEqual(["cuties-app"]);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(readFileSync(join(app, ".env"), "utf8")).toBe(`ARCHIVE_TOKEN=keep-me\nMETHOD_API_KEY=${key}\nMETHOD_SERVER=http://127.0.0.1:9\n`);
    expect(readFileSync(join(app, ".gitignore"), "utf8")).toBe(".env\n");
    expect(result).toMatchObject({ language: "python", published_version_id: "v_9", install: "pip install withmethod", secrets_to_set_on_the_host: ["ARCHIVE_TOKEN"] });
    expect(result.code).toContain(`method.run("wf_${"a".repeat(32)}", {"name": name, "links": links}`);
    // Again: the app keeps its key.
    await connectCommand([app], client);
    expect(created).toEqual(["cuties-app"]);
  } finally { process.chdir(cwd); }
});

it("answer shows and answers a sealed question with the app's key from .env", async () => {
  const server = api({ runData: "device" });
  const method = new Method({ apiKey: key, server: "http://127.0.0.1:9", fetch: server.fetcher, worker: { execute: asking, directory: folder(), waitMs: 10 } });
  const { run_id } = await method.runs.start({ method: "wf_private", inputs: { member: "Ada" } });
  (method as any).ensureWorker("wf_private");
  await vi.waitFor(() => expect(server.runs.get(run_id).status).toBe("waiting"));
  expect(server.runs.get(run_id).question.sealed).toMatch(/^v1\./);
  const app = folder(), cwd = process.cwd();
  writeFileSync(join(app, ".env"), `METHOD_API_KEY=${key}\n`);
  delete process.env.METHOD_API_KEY;
  vi.stubGlobal("fetch", server.fetcher);
  const client: any = { server: "http://127.0.0.1:9", token: () => null, login: async () => { throw Error("no sign-in needed"); } };
  process.chdir(app);
  try {
    expect(await answerCommand([run_id], client)).toMatchObject({ step: "approve:0", question: "Send this message to Ada?", form });
    await answerCommand([run_id, "--answer", JSON.stringify({ approved: true, note: "from the CLI" })], client);
  } finally { process.chdir(cwd); }
  expect(open(key, "answer", "wf_private", server.runs.get(run_id).answers["approve:0"].sealed)).toEqual({ approved: true, note: "from the CLI" });
  expect((await method.runs.wait(run_id, { intervalMs: 20 })).result).toMatchObject({ note: "from the CLI" });
  await method.close();
  expect(seal(key, "answer", "wf_private", 1)).not.toBe(seal(key, "answer", "wf_private", 1));
});
