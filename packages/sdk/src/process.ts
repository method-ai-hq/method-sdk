import { spawn } from "node:child_process";
import { openSync, closeSync, writeSync, writeFileSync } from "node:fs";

export type ProcessCommand = {
  command: string;
  args?: string[];
  cwd: string;
  timeout_ms?: number;
  env?: NodeJS.ProcessEnv;
  stdout_path?: string;
  stderr_path?: string;
  pid_path?: string;
};

/** Run an explicitly configured local command, without shell interpolation. */
export async function runProcess(command: ProcessCommand, input: string): Promise<{
  stdout: string; stderr: string;
}> {
  return new Promise((resolve, reject) => {
    let stdoutFile: number | undefined;
    let stderrFile: number | undefined;
    try {
      if (command.stdout_path) stdoutFile = openSync(command.stdout_path, "wx", 0o600);
      if (command.stderr_path) stderrFile = openSync(command.stderr_path, "wx", 0o600);
    } catch (error) {
      if (stdoutFile !== undefined) closeSync(stdoutFile);
      reject(error); return;
    }
    const child = spawn(command.command, command.args ?? [], {
      cwd: command.cwd, env: command.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32"
    });
    let stdout = "";
    let stderr = "";
    let failure: Error | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* Already exited. */ }
    };
    const stop = (message: string) => {
      if (failure) return;
      failure = new Error(message);
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 2_000);
    };
    const timer = setTimeout(() => stop("PROCESS_TIMEOUT: inspect effects before retrying."), command.timeout_ms ?? 300_000);
    const interrupt = () => stop("PROCESS_INTERRUPTED: inspect effects before resuming.");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    child.on("spawn", () => {
      try { if (command.pid_path) writeFileSync(command.pid_path, JSON.stringify({ pid: child.pid, parent_pid: process.pid }) + "\n", { mode: 0o600 }); }
      catch { stop("PROCESS_LOG_FAILED"); }
    });
    child.stdout.on("data", (chunk: Buffer) => {
      try { if (stdoutFile !== undefined) writeSync(stdoutFile, chunk); }
      catch { stop("PROCESS_LOG_FAILED"); }
      stdout += chunk.toString();
      if (stdout.length > 5_000_000) stop("PROCESS_OUTPUT_LIMIT");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      try { if (stderrFile !== undefined) writeSync(stderrFile, chunk); }
      catch { stop("PROCESS_LOG_FAILED"); }
      // Keep bounded diagnostics in memory; callers decide what can be saved.
      stderr = (stderr + chunk.toString()).slice(-64_000);
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      // The parent can exit on SIGTERM while a descendant ignores it. Stop the
      // remaining group before cancelling escalation and reporting failure.
      if (failure || code !== 0) kill("SIGKILL");
      clearTimeout(timer);
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      if (stdoutFile !== undefined) closeSync(stdoutFile);
      if (stderrFile !== undefined) closeSync(stderrFile);
      if (killTimer) clearTimeout(killTimer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`PROCESS_FAILED: ${command.command} exited ${code}. ${stderr.slice(-1500)}`));
      else resolve({ stdout, stderr });
    });
    child.stdin.on("error", () => { /* The exit handler reports early termination. */ });
    child.stdin.end(input);
  });
}
