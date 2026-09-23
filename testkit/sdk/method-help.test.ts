import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {authoringExamples,renderExample} from "../../packages/sdk/src/authoring-example.js";
import {exampleScript,exampleWorkflow} from '../fixtures/copy-message-example.js';
const approvedReport = readFileSync(resolve('packages/sdk/examples/daily-briefing/approved-report.md'),'utf8');
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

it("executes the copy-message editing fixture without adding it to the authoring guide", async () => {
  const dir = temp();
  expect(loadWorkflow(exampleWorkflow).format).toBe('method/3.2');
  expect(shell(dir,exampleScript())).toContain('"valid": true');
  const result = await runMethod(join(dir, 'message.method'), JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8')), {inputs: {message:'Hello\n  '}, runDir:join(dir,'run')});
  expect(result).toMatchObject({status:'completed',result:'Hello\n  '});
  expect(authoringGuide('commands')).not.toContain(exampleWorkflow);
},30_000);

it("keeps the repository manual equal to the guide shipped in the CLI", () => {
  const text = readFileSync(resolve("docs/method-authoring.md"), "utf8");
  expect(text.slice(text.indexOf("# Author with Method"))).toBe(authoringGuide("all"));
});


it('offers complete examples and renders the requested lesson', async () => {
  const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Offline'));
  for(const topic of ['start','all','examples','example']) {
    const guide=authoringGuide(topic);
    for(const example of authoringExamples)expect(guide).toContain(example.description);
    expect(guide).not.toContain('# Worked example:');
  }
  for(const example of authoringExamples) {
    const guide=authoringGuide('example',example.id);
    expect(guide.match(/# Worked example:/g)).toHaveLength(1);
    for(const name of example.lessonFiles)expect(guide).toContain(readFileSync(resolve('packages/sdk/examples',example.directory,name),'utf8').trimEnd());
    expect(guide).toContain(example.entrypoint);
  }
  expect(authoringGuide('example','daily-briefing')).toContain(approvedReport);
  expect(()=>authoringGuide('example','missing')).toThrow('daily-briefing, social-briefing, outbound-management, message-routing');
  const stdout=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
  await methodMain(['authoring','example','message-routing'],()=>{throw Error('No client needed');});
  expect(stdout).toHaveBeenCalledWith(renderExample('message-routing'));
  expect(fetch).not.toHaveBeenCalled();
});


it("retains the complete approved report unchanged", () => {
  const checks = JSON.parse(readFileSync(resolve("packages/sdk/examples/daily-briefing/checks.json"), "utf8"));
  expect(createHash("sha256").update(approvedReport).digest("hex")).toBe(checks.approved_report_sha256);
});
