import { readFileSync } from "node:fs";
import { runMethod as executeMethod } from "@withmethod/runtime/runner.js";
import { localSetup } from "./local-setup.js";
import { authoringPath } from "./authoring.js";
import type { MethodSync } from "./method-sync.js";
import type { parse } from "./cli.js";

export { executeMethod as runCurrentMethod };
export async function runCurrentFile(file: string, flags: ReturnType<typeof parse>["values"], syncFactory?: () => MethodSync) {
  for (const flag of ["host", "resources", "state-dir", "model", "verifier-model", "concurrency", "timeout-ms", "recoveries"] as const) {
    if (flags[flag]) throw Error(`--${flag} is for older saved methods. Use --config for this method.`);
  }
  const json = (path: string | undefined) => path ? JSON.parse(readFileSync(authoringPath(path), "utf8")) : undefined;
  const { config, sourceRoot } = await localSetup(file, flags);
  const controller = new AbortController();
  const stop = () => controller.abort(Object.assign(new Error("Interrupted by operator"), { code: "interrupted" }));
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  let sync: MethodSync | undefined;
  let failure: unknown;
  try {
    const result = await executeMethod(authoringPath(file), config, {
      runDir: flags["run-dir"] ? authoringPath(flags["run-dir"]) : undefined,
      inputs: json(flags.inputs), state: json(flags.state), resume: flags.resume, retry: flags.retry,
      human: json(flags.human), signal: controller.signal,
      sourceRoot,
      onStart: async ({ method, inputs }: any) => {
        sync = syncFactory?.();
        await sync?.start(method, inputs, Object.fromEntries(Object.entries(config.environment ?? {}).map(([key, path]) => [key, { description: method.environment[key].description, path: String(path) }])));
      },
      onEvent: (event: any) => { sync?.snapshot(); if (flags.verbose) process.stderr.write(JSON.stringify(event) + "\n"); },
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (result.status !== "completed") process.exitCode = result.status === "needs_input" ? 2 : 1;
  } catch (error) { failure = error; throw error; }
  finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); await sync?.finish(failure); }
}
