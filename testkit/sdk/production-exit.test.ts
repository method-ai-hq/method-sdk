import { afterEach, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// A script that calls method.run() and never calls close() must exit when the run is done.
it("lets a script that calls method.run() exit without close()", async () => {
  const root = mkdtempSync(join(tmpdir(), "method-exit-")); roots.push(root);
  const production = pathToFileURL(resolve("packages/sdk/src/production.ts")).href;
  const script = join(root, "script.mts");
  writeFileSync(script, `
import { Method } from ${JSON.stringify(production)};
const runs = new Map<string, any>();
const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
const fetcher = (async (url: string, init: RequestInit) => {
  const path = new URL(url).pathname, body = init.body ? JSON.parse(String(init.body)) : undefined;
  if (path === "/v1/runs") { runs.set("r1", { run_id: "r1", method_id: body.method, version_id: "v_1", status: "queued", run_data: "account" }); return reply(201, { run_id: "r1", version_id: "v_1", status: "queued" }); }
  if (path === "/v1/worker/claim") {
    // A long poll, as on the server: it answers when a run is queued, after 60 s, or when the worker stops.
    const until = Date.now() + 60_000;
    let run;
    while (!(run = [...runs.values()].find(r => r.status === "queued"))) {
      if (init.signal?.aborted || Date.now() > until) return reply(204);
      await new Promise(done => setTimeout(done, 20));
    }
    run.status = "running";
    return reply(200, { run_id: "r1", method_id: run.method_id, version_id: "v_1", inputs: {}, lease_id: "l1", lease_ms: 60_000, attempt: 1, run_data: "account" });
  }
  if (path.endsWith("/complete")) { Object.assign(runs.get("r1"), { status: body.status, result: body.result }); return reply(200, runs.get("r1")); }
  if (path.endsWith("/heartbeat")) return reply(200, { lease_ms: 60_000, cancel_requested: false });
  return reply(200, runs.get("r1"));
}) as typeof fetch;
const method = new Method({ apiKey: "mk_live_" + "A".repeat(43), server: "http://127.0.0.1:9", fetch: fetcher,
  worker: { waitMs: 25_000, directory: ${JSON.stringify(join(root, "worker"))}, execute: async () => ({ status: "succeeded", result: "done" }) } });
const run = await method.run({ method: "wf_x", intervalMs: 20 });
console.log(JSON.stringify({ status: run.status, result: run.result }));
`);
  const started = Date.now();
  const { code, out } = await new Promise<{ code: number | null; out: string }>(done => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, script], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.once("exit", code => { clearTimeout(timer); done({ code, out }); });
  });
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ status: "succeeded", result: "done" });
  expect(Date.now() - started).toBeLessThan(15_000);
}, 30_000);
