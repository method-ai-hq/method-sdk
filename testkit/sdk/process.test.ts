import { it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runProcess } from "../../packages/sdk/src/index.js";
import { checkCodex } from "../../packages/sdk/src/doctor.js";
const roots: string[] = [];
function temporary() { const root = mkdtempSync(join(tmpdir(), "workflow-process-")); roots.push(root); return root; }
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
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
