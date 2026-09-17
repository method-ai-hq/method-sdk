import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { approvedReport } from "../../packages/sdk/src/authoring-example.js";
import { authoringGuide, commandHelp, guideTopics } from "../../packages/sdk/src/method-help.js";
import { methodMain } from "../../packages/sdk/src/method.js";
import { loadWorkflow } from "../../packages/workflow-language/src/validate.js";
import { runMethod } from "../../packages/sdk/src/run-method.js";

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); vi.restoreAllMocks(); process.exitCode = 0; });
function temp() { const dir = mkdtempSync(join(tmpdir(), "method-guide-")); dirs.push(dir); return dir; }
function shell(dir: string, script: string) {
  const bin = join(dir, "bin"); mkdirSync(bin, { recursive: true });
  const quote = (v: string) => "'" + v.replaceAll("'", "'\\''") + "'";
  const loader = createRequire(import.meta.url).resolve("tsx");
  writeFileSync(join(bin, "method"), `#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(loader)} ${quote(resolve("packages/sdk/src/method.ts"))} "$@"\n`, { mode: 0o700 });
  return execFileSync("/bin/sh", ["-c", `set -eu\n${script}`], { cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
}

it("provides offline command-specific help and rejects unknown topics before creating a client", async () => {
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const client = vi.fn(() => { throw Error("Help must not create a network client"); });
  for (const name of Object.keys(commandHelp)) {
    stdout.mockClear();
    await methodMain([...name.split(" "), "--help"], client);
    const text = stdout.mock.calls.map(c => c[0]).join("");
    expect(text).toContain(`## ${name}\n`);
    expect(text).toContain("Arguments and defaults:");
    expect(text).toContain("Result and changes:");
    expect(text).toContain("Common errors:");
    if (commandHelp[name]!.errors) expect(text).toContain(commandHelp[name]!.errors);
    expect(text).toContain("Example:");
    stdout.mockClear();
    await methodMain(["help", ...name.split(" ")], client);
    expect(stdout.mock.calls.map(c => c[0]).join("")).toBe(text);
  }
  for (const topic of [...guideTopics, "all"]) await methodMain(["authoring", topic], client);
  await expect(methodMain(["authoring", "missing"], client)).rejects.toThrow("Unknown authoring topic");
  await expect(methodMain(["missing", "--help"], client)).rejects.toThrow("Unknown command");
  expect(client).not.toHaveBeenCalled();
});

it("runs the exact shell example printed in the guide and checks its data connections with the executor", async () => {
  const dir = temp();
  const source = authoringGuide("commands").match(/```yaml\n([\s\S]*?)\n```/)![1]!;
  expect(loadWorkflow(source).format).toBe("method/3.1");
  const script = authoringGuide("commands").split("## Example: build with editing commands")[1]!.match(/```sh\n([\s\S]*?)\n```/)![1]!;
  const out = shell(dir, script);
  expect(out).toContain('"valid": true');
  const workflow = loadWorkflow(readFileSync(join(dir, "message.method"), "utf8"));
  const commandDir = temp();
  const commands = authoringGuide("commands").split("## Example: build with editing commands")[1]!.match(/```sh\n([\s\S]*?)\n```/)![1]!;
  shell(commandDir, commands);
  expect(loadWorkflow(readFileSync(join(commandDir, "message.method"), "utf8"))).toEqual(workflow);
  const result = await runMethod(join(dir, "message.method"), JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8")), { inputs: { message: "Hello\n  " }, runDir: join(dir, "run") });
  expect(result.status).toBe("completed");
  expect("result" in result && result.result).toBe("Hello\n  ");
  expect(authoringGuide("recipes")).toContain("evidence hashes");
}, 30_000);

it("keeps the repository manual equal to the guide shipped in the CLI", () => {
  const text = readFileSync(resolve("docs/method-authoring.md"), "utf8");
  expect(text.slice(text.indexOf("# Author with Method"))).toBe(authoringGuide("all"));
});


it("shows the complete request, executable YAML, and approved result in that order", () => {
  const guide = authoringGuide();
  const method = guide.match(/```yaml\n([\s\S]*?)\n```/)![1]!;
  const definition = loadWorkflow(method);
  expect(definition.steps.write_briefing.check).toEqual({kind: "run", runtime: "python", entrypoint: "briefing_validation.py"});
  expect(guide.indexOf("## Request")).toBeLessThan(guide.indexOf("## Method"));
  expect(guide.indexOf("## Method")).toBeLessThan(guide.indexOf("## Complete approved report"));
  const beforeExample = guide.split("# Worked example")[0];
  expect(beforeExample).not.toContain("approved example");
  expect(guide).toContain(approvedReport);
});


it("retains the complete approved report unchanged", () => {
  const checks = JSON.parse(readFileSync(resolve("packages/sdk/examples/daily-briefing/checks.json"), "utf8"));
  expect(createHash("sha256").update(approvedReport).digest("hex")).toBe(checks.approved_report_sha256);
});
