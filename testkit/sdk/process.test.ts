import { it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runProcess, CodexExecutor, CodexVerifier, type StepRequest, type CheckRequest } from "../../packages/sdk/src/index.js";
import { checkCodex } from "../../packages/sdk/src/doctor.js";
import { codexGenerator } from "../../packages/sdk/src/codex.js";
const roots: string[] = [];
function temporary() { const root = mkdtempSync(join(tmpdir(), "workflow-process-")); roots.push(root); return root; }
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
it.each([
  { events: [{ type: "error", message: "Earlier error" }, { type: "turn.failed", error: { message: "Selected model is at capacity. Please try a different model." } }, { type: "error", message: "Later warning" }], expected: "Codex reported: Selected model is at capacity." },
  { events: [{ type: "error", message: "Connection closed" }], expected: "Codex reported: Connection closed" },
  { events: [{ type: "item.completed", item: { type: "error", message: "Tool failed" } }], expected: "exited 7. Connector startup warning" }
])("reports the process failure from Codex events: $expected", async ({ events, expected }) => {
  const root = temporary(), command = join(root, "codex-test");
  // A large, partial first line exercises the bounded tail read.
  const stream = "x".repeat(70_000) + "\n" + events.map(event => JSON.stringify(event)).join("\n") + "\n{partial";
  writeFileSync(command, `#!/usr/bin/env node\nconst fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{fs.writeSync(1,${JSON.stringify(stream)});fs.writeSync(2,'Connector startup warning');process.exit(7);});`);
  chmodSync(command, 0o700);
  await expect(codexGenerator({ command })({ directory: root, workspace: root, prompt: "Check the saved result.", schema: {}, timeout_ms: 5000, tools: "isolated" })).rejects.toThrow(expected);
  const attempt = join(root, readdirSync(root).find(name => name.startsWith("codex-" ) && name !== "codex-test")!);
  expect(JSON.parse(readFileSync(join(attempt, "failure.json"), "utf8")).message).toContain(expected);
  expect(readFileSync(join(attempt, "stderr.log"), "utf8")).toBe("Connector startup warning");
});
it.skipIf(process.platform === "win32")("runs a symlinked Codex beside its bundled helper", async () => {
  const root = temporary(); const bundle = join(root, "app"); const bin = join(root, "bin");
  mkdirSync(bundle); mkdirSync(bin);
  const command = join(bundle, "codex"); const link = join(bin, "codex");
  writeFileSync(join(bundle, "helper-ready"), "ready");
  writeFileSync(command, `#!/bin/sh
test -f "$(dirname "$0")/helper-ready" || exit 42
exec node -e '
const fs = require("node:fs"), args = process.argv.slice(1);
if (args[0] === "--version") { console.log("codex-cli 0.153.0"); process.exit(0); }
if (args[1] === "--help") { console.log("--dangerously-bypass-approvals-and-sandbox"); process.exit(0); }
process.stdin.resume(); process.stdin.on("end", () => fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({ outputs: {count:2}, updates:{}, observations:[], note:"" })));
' "$@"
`);
  chmodSync(command, 0o700); symlinkSync(command, link);
  await expect(runProcess({ command: link, args: ["--version"], cwd: root }, "")).rejects.toThrow("exited 42");
  expect((await checkCodex(link)).ok).toBe(true);
  const request = { directory: root, workspace: root, changes: {}, inputs: {}, outputs: {count:{type:"number",description:"Count"}}, files:{}, instructions:"Return count.", resources: {}, step: {} } as unknown as StepRequest;
  expect((await new CodexExecutor({ command: link }).execute(request)).outputs).toEqual({ count: 2 });
});
it("passes untrusted values through stdin without shell expansion", async () => {
  const root = temporary();
  const value = '`echo leaked` $(echo leaked) $HOME\nsecond line';
  const result = await runProcess({ command: process.execPath, args: ["-e", "process.stdin.pipe(process.stdout)"], cwd: root }, value);
  expect(result.stdout).toBe(value);
});
it("keeps partial output when a process times out", async () => {
  const root = temporary();
  await expect(runProcess({ command: process.execPath, args: ["-e", "process.stdout.write('started'); setInterval(()=>{},1000)"], cwd: root,
    timeout_ms: 500, stdout_path: join(root, "events.jsonl") }, "")).rejects.toThrow("PROCESS_TIMEOUT");
  expect(readFileSync(join(root, "events.jsonl"), "utf8")).toBe("started");
});
it.skipIf(process.platform === "win32").each(["timeout", "failed exit"])("stops a descendant that ignores SIGTERM after %s", async mode => {
  const root = temporary(), receipt = join(root, "late-write"), descendant = join(root, "descendant.pid");
  const script = `const fs = require('node:fs');
    process.on('SIGTERM', () => {});
    fs.writeFileSync(${JSON.stringify(descendant)}, String(process.pid));
    setTimeout(() => fs.writeFileSync(${JSON.stringify(receipt)}, 'unexpected late write'), 1800);
    setInterval(() => {}, 1000);`;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(script)}], {stdio:'ignore'}); ${mode === "failed exit" ? "setTimeout(() => process.exit(7), 1000);" : "setInterval(() => {}, 1000);"}`;
  try {
    await expect(runProcess({ command: process.execPath, args: ["-e", parent], cwd: root, timeout_ms: mode === "timeout" ? 1000 : 5000 }, "")).rejects.toThrow(mode === "timeout" ? "PROCESS_TIMEOUT" : "exited 7");
    expect(existsSync(descendant)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(existsSync(receipt)).toBe(false);
  } finally {
    if (existsSync(descendant)) {
      try { process.kill(Number(readFileSync(descendant, "utf8")), "SIGKILL"); } catch { /* Already stopped. */ }
    }
  }
}, 10_000);
it("starts separate action and check processes with limited context", async () => {
 const root=temporary(), command=join(root,"codex-test"), log=join(root,"calls.jsonl");
 writeFileSync(command, `#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,text})+'\\n');const schema=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1]));fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(schema.properties.outputs?{outputs:{count:2},updates:{},observations:[],note:''}:{result:'pass',summary:'Count is 2',evidence:['count']}));});`);chmodSync(command,0o700);
 const action={run_id:"test",invocation:"count",attempt:1,timeout_ms:5000,directory:root,workspace:root,changes:{},inputs:{},outputs:{count:{type:"number",description:"Count"}},files:{},instructions:"ACTION_ONLY return count",resources:{},step:{id:"count",do:"ACTION_ONLY",check:"CHECK_ONLY"}} as StepRequest;
 expect((await new CodexExecutor({command}).execute(action)).outputs).toEqual({count:2});
 const check:CheckRequest={run_id:"test",invocation:"count",directory:root,run_directory:root,workspace:root,timeout_ms:5000,resources:{},inputs:{},outputs:{count:2},changes:{},instructions:"CHECK_ONLY count is 2"};
 expect((await new CodexVerifier({command}).verify(check)).result).toBe("pass");
 const calls=readFileSync(log,"utf8").trim().split('\n').map(l=>JSON.parse(l));expect(calls).toHaveLength(2);expect(calls[0].text).not.toContain("CHECK_ONLY");expect(calls[1].text).not.toContain("ACTION_ONLY");expect(calls.every(c=>c.args.includes("--ephemeral"))).toBe(true);expect(calls.every(c=>c.args.includes("--dangerously-bypass-approvals-and-sandbox"))).toBe(true);expect(calls.every(c=>!c.args.includes("--sandbox") && !c.args.includes("--add-dir"))).toBe(true);
});
it("checks artifact hashes before giving file contents to a verifier", async()=>{
 const root=temporary(), path=join(root,"result.txt");writeFileSync(path,"changed");
 const request:CheckRequest={run_id:"test",invocation:"file",directory:root,run_directory:root,workspace:root,timeout_ms:5000,resources:{},inputs:{},outputs:{report:{path,sha256:createHash("sha256").update("original").digest("hex")}},changes:{},instructions:"Check the file"};
 await expect(new CodexVerifier({command:"nonexistent"}).verify(request)).rejects.toThrow("ARTIFACT_CHANGED");
});
