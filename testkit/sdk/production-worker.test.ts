import { afterEach, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Method, verifyWebhook } from "../../packages/sdk/src/production.js";
import type { Claim, Executor } from "../../packages/sdk/src/worker.js";

const key = "mk_live_" + "A".repeat(43);
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A small in-process runs API: one queue, leases, heartbeats, and completion. */
function api(options: { leaseMs?: number; runData?: "account" | "device" } = {}) {
  const runs = new Map<string, any>(), calls: { path: string; body: any }[] = [];
  let next = 0;
  const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname, body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${key}`);
    if (path === "/v1/runs" && init.method === "POST") {
      const id = `00000000-0000-4000-8000-00000000000${++next}`;
      runs.set(id, { run_id: id, method_id: body.method, version_id: "v_1", status: "queued", run_data: options.runData ?? "account", inputs: body.inputs, attempts: 0, steps: [] });
      return reply(201, { run_id: id, version_id: "v_1", status: "queued" });
    }
    if (path === "/v1/worker/claim") {
      const run = [...runs.values()].find(r => r.status === "queued");
      if (!run) { await new Promise(r => setTimeout(r, Math.min(body.wait_ms, 50))); return reply(204); }
      Object.assign(run, { status: "running", attempts: run.attempts + 1, lease_id: `lease-${run.attempts + 1}` });
      return reply(200, { run_id: run.run_id, method_id: run.method_id, version_id: run.version_id, inputs: run.inputs, lease_id: run.lease_id,
        lease_ms: options.leaseMs ?? 60_000, attempt: run.attempts, run_data: run.run_data });
    }
    const match = path.match(/^\/v1\/(?:worker\/)?runs\/([^/]+)(?:\/(heartbeat|complete|cancel))?$/);
    const run = match ? runs.get(match[1]!) : undefined;
    if (!run) return reply(404, { message: "Run not found." });
    if (match![2] === "cancel") { run.cancel = true; return reply(200, run); }
    if (match![2] === "heartbeat") return run.lost ? reply(409, { code: "lease_lost", message: "Lost." }) : reply(200, { lease_ms: 60_000, cancel_requested: !!run.cancel });
    if (match![2] === "complete") {
      if (body.retryable && run.attempts < 3) run.status = "queued";
      else Object.assign(run, { status: run.cancel && body.status !== "succeeded" ? "cancelled" : body.status, ...(run.run_data === "account" && body.result !== undefined ? { result: body.result } : {}) });
      return reply(200, run);
    }
    const { inputs: _inputs, lease_id: _lease, cancel: _cancel, lost: _lost, ...shown } = run;
    return reply(200, shown);
  }) as typeof fetch;
  return { runs, calls, method: new Method({ apiKey: key, server: "http://127.0.0.1:9", fetch: fetcher }) };
}
function directory() { const root = mkdtempSync(join(tmpdir(), "method-worker-")); roots.push(root); return root; }

it("claims a run, completes it with the result, and returns the result to runs.wait", async () => {
  const { method, calls } = api();
  const seen: Claim[] = [];
  const execute: Executor = async claim => { seen.push(claim); return { status: "succeeded", result: { links: ["https://cuties.example/m/7"] } }; };
  const results: unknown[] = [];
  const worker = method.worker.start({ execute, directory: directory(), waitMs: 10, onResult: result => { results.push(result); } });
  const run = await method.runs.run({ method: "wf_links", inputs: { member_id: 7 }, idempotencyKey: "member-7", intervalMs: 20 });
  await worker.stop();
  expect(seen).toEqual([expect.objectContaining({ method_id: "wf_links", inputs: { member_id: 7 }, attempt: 1 })]);
  expect(run).toMatchObject({ status: "succeeded", result: { links: ["https://cuties.example/m/7"] } });
  expect(results).toEqual([expect.objectContaining({ run_id: run.run_id, status: "succeeded", result: { links: ["https://cuties.example/m/7"] } })]);
  expect(calls.find(c => c.path === "/v1/runs")!.body).toEqual({ method: "wf_links", inputs: { member_id: 7 }, idempotency_key: "member-7" });
  expect(calls.find(c => c.path.endsWith("/complete"))!.body).toEqual({ lease_id: "lease-1", status: "succeeded", result: { links: ["https://cuties.example/m/7"] } });
});

it("keeps a device run's result in this process and never sends it to the server", async () => {
  const { method, calls } = api({ runData: "device" });
  const worker = method.worker.start({ execute: async () => ({ status: "succeeded", result: "score-80-for-member" }), directory: directory(), waitMs: 10 });
  const { run_id } = await method.runs.start({ method: "wf_private", inputs: {} });
  const run = await method.runs.wait(run_id, { intervalMs: 20 });
  await worker.stop();
  expect(run).toMatchObject({ status: "succeeded", run_data: "device", result: "score-80-for-member" });
  expect(calls.find(c => c.path.endsWith("/complete"))!.body).toEqual({ lease_id: "lease-1", status: "succeeded" });
  expect(JSON.stringify(calls.map(c => c.body))).not.toContain("score-80-for-member");
});

it("renews the lease, stops the run when it is cancelled, and stops without completing when the lease is lost", async () => {
  const { method, runs, calls } = api({ leaseMs: 3_000 });
  const execute: Executor = (_claim, { signal }) => new Promise(done => signal.addEventListener("abort", () => done({ status: "failed", error: { message: "Stopped." } })));
  const worker = method.worker.start({ execute, directory: directory(), waitMs: 10 });
  const first = await method.runs.start({ method: "wf_slow" });
  await vi.waitFor(() => expect(runs.get(first.run_id).status).toBe("running"));
  await method.runs.cancel(first.run_id);
  await vi.waitFor(() => expect(runs.get(first.run_id).status).toBe("cancelled"), { timeout: 3_000 });
  expect(calls.filter(c => c.path.endsWith("/heartbeat")).length).toBeGreaterThanOrEqual(1);

  const second = await method.runs.start({ method: "wf_slow" });
  await vi.waitFor(() => expect(runs.get(second.run_id).status).toBe("running"));
  runs.get(second.run_id).lost = true;
  await vi.waitFor(() => expect(calls.filter(c => c.path === `/v1/worker/runs/${second.run_id}/heartbeat`).length).toBeGreaterThanOrEqual(1), { timeout: 3_000 });
  await worker.stop();
  expect(calls.some(c => c.path === `/v1/worker/runs/${second.run_id}/complete`)).toBe(false);
});

it("queues a retryable failure again without reporting it as a result", async () => {
  const { method, runs } = api();
  let attempts = 0;
  const results: unknown[] = [];
  const worker = method.worker.start({ directory: directory(), waitMs: 10, onResult: result => { results.push(result); },
    execute: async () => ++attempts === 1 ? { status: "failed", retryable: true, error: { message: "Download failed." } } : { status: "succeeded", result: 1 } });
  const { run_id } = await method.runs.start({ method: "wf_retry" });
  await vi.waitFor(() => expect(runs.get(run_id).status).toBe("succeeded"));
  await worker.stop();
  expect(runs.get(run_id).attempts).toBe(2);
  expect(results).toHaveLength(1);
});

it("verifies webhook signatures with the key's webhook secret", () => {
  const secret = "whsec_test", body = JSON.stringify({ run_id: "r", status: "succeeded" }), t = Math.floor(Date.now() / 1000);
  const header = `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
  expect(verifyWebhook(body, header, secret)).toBe(true);
  expect(Method.webhooks.verify(Buffer.from(body), header, secret)).toBe(true);
  expect(verifyWebhook(body.replace("succeeded", "failed"), header, secret)).toBe(false);
  expect(verifyWebhook(body, header, "whsec_other")).toBe(false);
  expect(verifyWebhook(body, header, secret, { now: (t + 301) * 1000 })).toBe(false);
  expect(verifyWebhook(body, "v1=abc", secret)).toBe(false);
  expect(() => new Method({ apiKey: "method_device" })).toThrow(/service key/);
});
