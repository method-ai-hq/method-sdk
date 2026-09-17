import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { method } from "../fixtures/method.js";
import { runMethod, loadMethod } from "../../packages/sdk/src/index.js";
import { inspectRun } from "../../packages/sdk/src/inspect.js";
import { MethodClient, DEFAULT_SERVER } from "../../packages/sdk/src/method-client.js";
import { writePrivateJson } from "../../packages/sdk/src/files.js";
const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "method-migration-")); dirs.push(dir); return dir; };
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

it("reads and resumes a legacy snapshot without changing its format, hash, or completed actions", async () => {
  const workspace = temp(), directory = join(workspace, "run");
  const workflow = loadMethod({ ...method(), format: "workflow/2" });
  expect(workflow.format).toBe("workflow/2");
  const execute = vi.fn(async () => ({ outputs: { copied_message: "Hello" } }));
  const options = { workflow, inputs: {}, workspace, directory, runtime_revision: "test", executor: { name: "test", execute } };
  expect((await runMethod(options)).status).toBe("succeeded");
  const manifest = readFileSync(join(directory, "run.json"), "utf8");
  renameSync(join(directory, "method.method"), join(directory, "workflow.workflow"));
  expect(inspectRun(directory).workflow.format).toBe("workflow/2");
  expect((await runMethod({ ...options, resume: true })).status).toBe("succeeded");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(readFileSync(join(directory, "run.json"), "utf8")).toBe(manifest);
});

it("uses the old production credential only for the new production host and clears it on logout", async () => {
  const root = temp();
  const old = new MethodClient("https://app.workflowcorp.ai", fetch, root);
  const token = `method_${"a".repeat(43)}`;
  writePrivateJson(old.credentialFile, { server: old.server, token });
  const request = vi.fn(async () => new Response("{}"));
  const current = new MethodClient(DEFAULT_SERVER, request as typeof fetch, root);
  expect(current.token()).toBe(token);
  expect(new MethodClient("https://unrelated.example", fetch, root).token()).toBeNull();
  await current.logout();
  expect(request).toHaveBeenCalledWith(`${DEFAULT_SERVER}/api/cli/logout`, expect.objectContaining({ headers: expect.objectContaining({ authorization: `Bearer ${token}` }) }));
  expect(existsSync(old.credentialFile)).toBe(false);
});
