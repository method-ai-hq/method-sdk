import { execFile } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, rmdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveExecutable } from "./executable.js";

export const MINIMUM_CODEX_VERSION = "0.153.0";
export const MINIMUM_NODE_MAJOR = 22;
export type Finding = { ok: true; detail: string } | { ok: false; detail: string };
type Executed = { code: number | null; stdout: string; stderr: string; missing: boolean };

function execute(command: string, args: string[]): Promise<Executed> {
  return new Promise(done => {
    execFile(command, args, { timeout: 30_000, maxBuffer: 4_000_000, windowsHide: true }, (error, stdout, stderr) => {
      const failure = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
      done({ code: failure ? typeof failure.code === "number" ? failure.code : null : 0,
        stdout: String(stdout), stderr: String(stderr), missing: failure?.code === "ENOENT" });
    });
  });
}
export function parseVersion(text: string): string | null {
  return text.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1, 4).join(".") ?? null;
}
/** Negative when left is older than right. */
export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}
const chatgpt = "Codex ships inside the ChatGPT app";
const again = "then check with `codex --version` and run this command again.";

export function checkNode(version = process.versions.node): Finding {
  const major = Number(version.split(".")[0]);
  if (major >= MINIMUM_NODE_MAJOR) return { ok: true, detail: `Node.js v${version}` };
  return { ok: false, detail: `Node.js v${version} is running, but Method needs Node.js ${MINIMUM_NODE_MAJOR} or later. Install the current Node.js from nodejs.org, then run this command again.` };
}

/** Requires codex ${MINIMUM_CODEX_VERSION}+ with `codex exec --dangerously-bypass-approvals-and-sandbox`. */
export async function checkCodex(command = "codex"): Promise<Finding> {
  command = resolveExecutable(command);
  const version = await execute(command, ["--version"]);
  if (version.missing) return { ok: false, detail: `The Codex CLI was not found on PATH. Method runs every step in Codex. ${chatgpt}: install or open the ChatGPT app, turn on Codex, ${again}` };
  const found = parseVersion(version.stdout);
  if (version.code !== 0 || !found) return { ok: false, detail: `\`codex --version\` did not print a version (${version.code === null ? "no exit code" : `exit ${version.code}`}${version.stderr.trim() ? `: ${version.stderr.trim().slice(0, 300)}` : ""}). ${chatgpt}: open the ChatGPT app, turn on Codex, ${again}` };
  if (compareVersions(found, MINIMUM_CODEX_VERSION) < 0) return { ok: false, detail: `Codex CLI ${found} is installed, but ${MINIMUM_CODEX_VERSION} or later is required. ${chatgpt}: update the ChatGPT app, ${again}` };
  const help = await execute(command, ["exec", "--help"]);
  if (help.code !== 0 || !help.stdout.includes("--dangerously-bypass-approvals-and-sandbox")) return { ok: false, detail: `Codex CLI ${found} does not support \`codex exec --dangerously-bypass-approvals-and-sandbox\`, which the local runner needs. ${chatgpt}: update the ChatGPT app, ${again}` };
  return { ok: true, detail: `Codex CLI ${found} with \`codex exec --dangerously-bypass-approvals-and-sandbox\`` };
}

/** The default run directory root must accept a private file. */
export function checkRunDirectory(root: string): Finding {
  const directory = resolve(root, ".method-runs");
  const created = !existsSync(directory);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const probe = join(directory, `.probe-${randomUUID()}`);
    closeSync(openSync(probe, "wx", 0o600));
    unlinkSync(probe);
    if (created) rmdirSync(directory);
    return { ok: true, detail: `Run directory ${directory} is writable` };
  } catch (error) {
    return { ok: false, detail: `Cannot write to ${directory}: ${error instanceof Error ? error.message : String(error)}. Run this command from a directory you can write to.` };
  }
}

export class RuntimeUnavailable extends Error {}
/** Before a run: one paragraph describing what is missing, then exit 1. */
export async function requireRuntime(): Promise<void> {
  for (const finding of [checkNode(), await checkCodex()]) if (!finding.ok) throw new RuntimeUnavailable(finding.detail);
}
export async function doctor(root = process.cwd()): Promise<{ ok: boolean; lines: string[] }> {
  const findings = [checkNode(), await checkCodex(), checkRunDirectory(root)];
  return { ok: findings.every(finding => finding.ok), lines: findings.map(finding => `${finding.ok ? "ok" : "fail"}`.padEnd(6) + finding.detail) };
}
