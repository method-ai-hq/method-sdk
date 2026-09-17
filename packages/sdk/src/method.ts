#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, openSync, closeSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { localAuthoring, authoringPath, readDocument, writeDocument } from "./authoring.js";
import { semanticDigest, workflowDocumentDigest } from "../../contracts/src/identity.js";
import { MethodClient, DEFAULT_SERVER } from "./method-client.js";
import { MethodSync } from "./method-sync.js";
import { progressMain } from "./progress.js";
import { run, parse, localMain } from "./cli.js";
import { writePrivateJson } from "./files.js";
import { loadWorkflow } from "../../workflow-language/src/validate.js";

import { methodHelp, overviewHelp as help } from "./method-help.js";

function safePath(path: string) {
  return authoringPath(path);
}
export async function methodMain(args = process.argv.slice(2), clientFactory: (server: string) => MethodClient = server => new MethodClient(server)) {
  if (args.length === 1 && args[0] === "--version") { process.stdout.write("Method SDK 0.5.7; runtime 0.3.1; current format method/3.1\n"); return; }
  const localCommand = ["prompt", "inspect", "doctor"].includes(args[0] ?? "")
    || args[0] === "check" && /\.(method|workflow)$/i.test(args[1] ?? "")
    || ["run", "steps"].includes(args[0] ?? "") && /\.(method|workflow)$|^https?:\/\//i.test(args[1] ?? "");
  if (localCommand) return localMain(args);
  const requestedHelp = methodHelp(args);
  if (requestedHelp !== undefined) { process.stdout.write(requestedHelp); return; }
  if (args[0] === "progress") return progressMain(args.slice(1));
  if (await localAuthoring(args)) return;
  // Strip only Method flags. Pass run flags unchanged to the existing SDK parser.
  const methodOptions = new Set([
    "server",
    "version",
    "file",
    "base-version",
    "reason",
    "workflow",
    "method",
    "request-id",
  ]);
  const values: Record<string, string> = {},
    rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const match = args[i]!.match(/^--([^=]+)(?:=(.*))?$/);
    if (match && methodOptions.has(match[1]!)) {
      const value = match[2] ?? args[++i];
      if (!value || value.startsWith("--"))
        throw Error(`Supply --${match[1]}.`);
      values[match[1]!] = value;
    } else rest.push(args[i]!);
  }
  if (!values.workflow && values.method) values.workflow = values.method;
  const [command, target, step] = rest;
  if (!command || command === "--help" || command === "help") {
    process.stdout.write(help);
    return;
  }
  if (command === "sync") {
    if (!target) throw Error("Use method sync RUN_DIRECTORY.");
    await MethodSync.retry(
      safePath(target),
      values.server ? new MethodClient(values.server) : undefined,
    );
    return;
  }
  const authorFile = command === "save" ? target : command === "create" ? values.file : undefined;
  const metaFile = authorFile ? safePath(`${authorFile}.method.json`) : undefined;
  const meta = metaFile && existsSync(metaFile) ? readDocument(metaFile) : {};
  if (authorFile && meta.server && values.server && meta.server !== values.server.replace(/\/$/, ""))
    throw Error("This draft belongs to another server. Use method get from the intended server into a new file.");
  if (!["status","login","logout","devices","revoke","list","get","steps","step","update","run","runs","logs","create","save"].includes(command)) throw Error(help);
  const client = clientFactory(values.server ?? meta.server ?? DEFAULT_SERVER);
  if (command === "login") {
    await client.login();
    return;
  }
  if (command === "logout") {
    await client.logout();
    process.stdout.write("Method is disconnected.\n");
    return;
  }
  if (command === "status") {
    let signedIn = false;
    if (client.token()) {
      try { await client.request("/api/cli/me"); signedIn = true; }
      catch (error) { if (!/^401:/.test(String((error as Error).message))) throw error; }
    }
    process.stdout.write(JSON.stringify({ installed: true, server: client.server, signed_in: signedIn, ...(!signedIn ? { next: "Run method login to sign in with browser approval." } : {}) }, null, 2) + "\n");
    return;
  }
  // The first real command starts browser approval if no credential is saved.
  if (!client.token()) await client.login();
  const print = (v: unknown) =>
    process.stdout.write(JSON.stringify(v, null, 2) + "\n");
  if (command === "devices") {
    print(await client.request("/api/cli/devices"));
    return;
  }
  if (command === "revoke") {
    if (!target) throw Error("Supply a device ID.");
    print(
      await client.request(
        `/api/cli/devices/${encodeURIComponent(target)}/revoke`,
        "POST",
        {},
      ),
    );
    return;
  }
  if (command === "list") {
    print(await client.request("/api/methods"));
    return;
  }
  if (command === "runs") {
    print(
      await client.request(
        `/api/workspace/runs${values.workflow ? `?workflow_id=${encodeURIComponent(values.workflow)}` : ""}`,
      ),
    );
    return;
  }
  if (command === "logs") {
    if (!target) throw Error("Supply a run ID.");
    print(
      await client.request(`/api/workspace/runs/${encodeURIComponent(target)}`),
    );
    return;
  }
  if (command === "create" || command === "save") {
    if (!authorFile || !metaFile) throw Error("Use method create --file FILE or method save FILE --reason TEXT.");
    if (command === "create" && meta.workflow_id) throw Error("This draft is already saved. Use method save to create a new version.");
    const lock = safePath(`${authorFile}.lock`);
    let fd: number;
    try { fd = openSync(lock, "wx", 0o600); } catch { throw Error("The draft is locked. Wait for the other command."); }
    try {
      const workflow = loadWorkflow(readDocument(authorFile));
      const latest = existsSync(metaFile) ? readDocument(metaFile) : {};
      if (JSON.stringify(latest) !== JSON.stringify(meta)) throw Error("The draft was saved by another process. Retry.");
      const digest = workflowDocumentDigest(workflow);
      const confirm = async (id: string, version: string) => {
        const stored = await client.request<any>(`/api/cli/methods/${encodeURIComponent(id)}?version=${encodeURIComponent(version)}`);
        if (stored.version_id !== version || workflowDocumentDigest(loadWorkflow(stored.workflow)) !== digest) throw Error("The saved version does not match this draft. Keep the draft and its sidecar; retry the save before making changes.");
      };
      if (!meta.pending && meta.digest === digest && meta.workflow_id) { await confirm(meta.workflow_id, meta.base_version); print({ confirmed: true, document_sha256: digest, unchanged: true, workflow_id: meta.workflow_id, version_id: meta.base_version, url: `${client.server}/methods/${meta.workflow_id}?version=${meta.base_version}` }); return; }
      if (meta.pending && meta.pending.digest !== digest && (meta.digest_format || meta.pending.digest !== semanticDigest(workflow))) throw Error("A previous save has no confirmed response. Restore that draft and retry before changing it.");
      const reason = meta.pending?.reason ?? values.reason;
      if (meta.workflow_id && !reason) throw Error("Supply --reason for the new version.");
      const requestId = meta.pending?.request_id ?? values["request-id"] ?? randomUUID();
      const pending = { ...meta, digest_format: "document/1", server: client.server, pending: { digest, request_id: requestId, reason } };
      writePrivateJson(metaFile, pending);
      const saved = meta.workflow_id
        ? await client.request<any>(`/api/cli/methods/${encodeURIComponent(meta.workflow_id)}`, "POST", { workflow, base_version: meta.base_version, reason })
        : await client.request<any>("/api/cli/methods", "POST", { workflow, request_id: requestId });
      const workflowId = meta.workflow_id ?? saved.workflow_id;
      await confirm(workflowId, saved.version_id);
      writePrivateJson(metaFile, { server: client.server, workflow_id: workflowId, base_version: saved.version_id, digest, digest_format: "document/1" });
      print({ ...saved, confirmed: true, document_sha256: digest, workflow_id: workflowId, server: client.server, url: `${client.server}/methods/${workflowId}?version=${saved.version_id}` });
    } finally { closeSync(fd); unlinkSync(lock); }
    return;
  }
  if (!target) throw Error(help);
  const path = `/api/cli/methods/${encodeURIComponent(target)}`;
  if (command === "update") {
    if (!values.file || !values["base-version"] || !values.reason)
      throw Error(
        "Supply --file, --base-version, and --reason. Use method get to read the current version first.",
      );
    const workflow = loadWorkflow(readFileSync(safePath(values.file), "utf8"));
    print(
      await client.request(path, "POST", {
        workflow,
        base_version: values["base-version"],
        reason: values.reason,
      }),
    );
    return;
  }
  if (!["get", "steps", "step", "run"].includes(command)) throw Error(help);
  const saved = await client.request<{
    workflow_id: string;
    version_id: string;
    version_number: number;
    workflow: unknown;
  }>(
    path +
      (values.version ? `?version=${encodeURIComponent(values.version)}` : ""),
  );
  const workflow = command === "get" ? saved.workflow as any : loadWorkflow(saved.workflow);
  if (command === "steps") {
    print({ version_id: saved.version_id, steps: workflow.steps });
    return;
  }
  if (command === "step") {
    const found = step ? workflow.steps[step] : undefined;
    if (!found) throw Error("Step not found. Use method steps WORKFLOW_ID.");
    print({ version_id: saved.version_id, step: found });
    return;
  }
  if (command === "get") {
    const parsed = parseArgs({
      args: rest.slice(2),
      options: { out: { type: "string" } },
    });
    if (parsed.values.out) {
      const out = safePath(parsed.values.out);
      if (existsSync(out))
        throw Error("Choose a new output file; this file already exists.");
      const metadataPath = safePath(`${out}.method.json`);
      if (existsSync(metadataPath)) throw Error("Choose a file without existing Method metadata.");
      writeDocument(out, workflow);
      writePrivateJson(metadataPath, { server: client.server, workflow_id: saved.workflow_id, base_version: saved.version_id, digest: workflowDocumentDigest(loadWorkflow(workflow)), digest_format: "document/1" });
      print({
        workflow_id: saved.workflow_id,
        version_id: saved.version_id,
        version_number: saved.version_number,
        file: out,
      });
    } else print({ ...saved, workflow });
    return;
  }
  const flags = parse(rest.slice(2)).values;
  if (flags.host) throw Error("Saved Method runs use the configured runtime. Do not pass --host.");
  if (flags.resume && !flags["run-dir"])
    throw Error("Supply --run-dir for a resumed Method run.");
  const directory = safePath(
    flags["run-dir"] ??
      join(
        process.cwd(),
        ".method-runs",
        saved.workflow_id,
        new Date().toISOString().replaceAll(":", "-"),
      ),
  );
  if (flags.resume && !existsSync(join(directory, "method-sync.json")))
    throw Error("This is not a saved Method run.");
  if (!flags.resume && existsSync(join(directory, "method-sync.json")))
    throw Error(
      "Run already exists. Use --resume, or choose a new run directory.",
    );
  const file = (workflow.format === "method/3" || workflow.format === "method/3.1") ? safePath(`${directory}.method`) : join(directory, "method.method");
  if (existsSync(file)) {
    if (
      JSON.stringify(loadWorkflow(readFileSync(file, "utf8"))) !==
      JSON.stringify(workflow)
    )
      throw Error(
        "The saved run uses a different method. Resume with its original --version.",
      );
  } else writePrivateJson(file, workflow);
  await run(
    file,
    { ...flags, "run-dir": directory, ...((workflow.format === "method/3" || workflow.format === "method/3.1") ? { workspace: flags.workspace ?? process.cwd() } : { "state-dir": flags["state-dir"] ?? join(resolve(flags.workspace ?? process.cwd()), ".method", "data", saved.workflow_id) }) },
    () => new MethodSync(client, directory, saved.workflow_id, saved.version_id),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
)
  methodMain().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
