import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";

const cli = resolve("packages/sdk/src/cli.ts"), tsx = resolve("node_modules/tsx/dist/cli.mjs");
const workflow = { format: "method/2", name: "Host", goal: "Check host execution and review.", steps: Object.fromEntries(["first", "later"].map(id => [id, { do: "Return the observed count.", ...(id === "later" ? {after: "first"} : {}), out: {[id]: {type: "number",description:"Observed count."}}, check: "Confirm that the count is positive." }])), result: "later" };

async function runHost(respond: (request: any) => unknown | "close", saved?: string, definition = workflow) {
  const directory = saved ?? mkdtempSync(join(tmpdir(), "workflow-host-test-"));
  writeFileSync(join(directory, "task.method"), JSON.stringify(definition));
  const messages: any[] = [], errors: string[] = [];
  const child = spawn(process.execPath, [tsx, cli, "run", "task.method", "--host", "--run-dir", "run", ...(saved ? ["--resume"] : [])], {
    cwd: directory, env: { ...process.env, PATH: directory }, stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", chunk => errors.push(chunk.toString()));
  const lines = createInterface({ input: child.stdout });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  lines.on("line", async line => {
    const message = JSON.parse(line); messages.push(message);
    if (message.type !== "request") return;
    const response = await respond(message);
    if (response === "close") child.stdin.end();
    else child.stdin.write(`${JSON.stringify(response)}\n`);
  });
  const code = await new Promise<number | null>(done => child.on("close", done));
  clearTimeout(timeout); lines.close();
  return { directory, code, messages, errors: errors.join(""), result: JSON.parse(readFileSync(join(directory, "run/result.json"), "utf8")) };
}
const success = (request: any) => ({ id: request.id, result: request.method === "execute"
  ? { outputs: { [request.payload.step.id]: 2 }, note: "Synthetic host observation." }
  : { result: "pass", summary: "Count is positive.", evidence: ["evidence.count"] } });

describe("CLI host mode", () => {
  it("runs without Codex and sends checks without action instructions", async () => {
    const run = await runHost(success);
    expect(run.code, run.errors).toBe(0);
    expect(run.result.status).toBe("succeeded");
    const requests = run.messages.filter(m => m.type === "request");
    expect(requests.map(m => m.method)).toEqual(["execute", "verify", "execute", "verify"]);
    expect(requests[1].payload.outputs).toEqual({ first: 2 });
    expect(requests[1].payload.step).toBeUndefined();
    expect(requests[1].payload.workflow).toBeUndefined();
    const resumed = await runHost(success, run.directory);
    expect(resumed.code, resumed.errors).toBe(0);
    expect(resumed.messages.filter(m => m.type === "request")).toEqual([]);
  });

  it("stops before a later action when the host check fails", async () => {
    const run = await runHost(request => request.method === "verify"
      ? { id: request.id, result: { result: "fail", summary: "Observed wrong count.", evidence: ["evidence.count"] } }
      : success(request));
    expect(run.code).toBe(2);
    expect(run.result.status).toBe("failed");
    expect(run.messages.filter(m => m.type === "request").map(m => m.method)).toEqual(["execute", "verify"]);
  });

  it("rejects a reply for another request", async () => {
    const run = await runHost(request => ({ ...success(request), id: request.id + 1 }));
    expect(run.code).toBe(2);
    expect(JSON.stringify(run.result)).toContain("response ID does not match");
    expect(run.messages.filter(m => m.type === "request")).toHaveLength(1);
  });

  it("stops when the host disconnects without a result", async () => {
    const run = await runHost(() => "close");
    expect(run.code).toBe(2);
    expect(JSON.stringify(run.result)).toContain("HOST_CLOSED");
    expect(run.messages.filter(m => m.type === "request")).toHaveLength(1);
  });
});


it("CLI host overlaps independent requests and accepts reverse-order responses", async () => {
  const definition = structuredClone(workflow);
  for (const step of Object.values(definition.steps)) delete step.after;
  const waiting: Array<{ request: any; done: (value: unknown) => void }> = [];
  const run = await runHost(request => request.method === "verify" ? success(request) : new Promise(done => {
    waiting.push({ request, done });
    if (waiting.length === 2) for (const item of [...waiting].reverse()) item.done(success(item.request));
  }), undefined, definition);
  expect(run.code, run.errors).toBe(0);
  expect(run.result.status).toBe("succeeded");
  expect(run.messages.filter(m => m.type === "request").slice(0, 2).map(m => m.method)).toEqual(["execute", "execute"]);
});
