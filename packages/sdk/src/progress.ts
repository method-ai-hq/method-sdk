import { writeSync } from "node:fs";
import { parseArgs } from "node:util";
import { progressMessage, codexProgress } from "@withmethod/runtime/progress.js";
import { readLines } from "@withmethod/runtime/io.js";

export type ProgressUpdate = { message: string; completed?: number; total?: number; unit?: string; child?: string };
/** Opt-in public text only. Does not write to the script's result stdout. */
export function reportProgress(update: ProgressUpdate): boolean {
  const value = progressMessage(update);
  const fd = Number(process.env.METHOD_PROGRESS_FD);
  if (!value || !Number.isInteger(fd) || fd < 3) return false;
  try { writeSync(fd, JSON.stringify(value) + "\n"); return true; }
  catch (error) { if (["EPIPE", "EBADF"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; }
}

/** Relay only supported public Codex JSON events from a child process. */
export async function relayCodexProgress(stream: AsyncIterable<Uint8Array>, child: string) {
  await readLines(stream, async (line: string) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    const value = codexProgress(event);
    if (value) reportProgress({ ...value, child });
  });
}

export async function progressMain(args: string[]) {
  const { values } = parseArgs({ args, options: { message: { type: "string" }, completed: { type: "string" }, total: { type: "string" }, unit: { type: "string" }, child: { type: "string" }, codex: { type: "boolean" } }, strict: true });
  if (values.codex) {
    if (!values.child || values.message) throw Error("Use method progress --codex --child NAME with Codex JSON on stdin.");
    await relayCodexProgress(process.stdin, values.child);
  } else {
    if (!values.message) throw Error("Supply --message TEXT, or --codex --child NAME.");
    reportProgress({ message: values.message, ...(values.child ? { child: values.child } : {}), ...(values.unit ? { unit: values.unit } : {}), ...(values.completed !== undefined ? { completed: Number(values.completed) } : {}), ...(values.total !== undefined ? { total: Number(values.total) } : {}) });
  }
}
