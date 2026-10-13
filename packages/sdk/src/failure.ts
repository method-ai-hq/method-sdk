import { failureRecord } from "@withmethod/runtime/failure.js";
import { FailureOwnerSchema, FailureSchema, ownerText, type FailureOwner, type RunFailure } from "../../workflow-language/src/inspection.js";

/**
 * The failure record of a run that stopped before its first step. A runtime error carries its own record; an SDK error
 * gets one from the runtime's templates: an SDK setup error has a code or is a plain Error, and any other error type
 * is a bug in Method.
 */
export function setupFailure(error: any): RunFailure {
  if (FailureSchema.safeParse(error?.failure).success) return error.failure;
  const owner: FailureOwner = FailureOwnerSchema.safeParse(error?.owner).success ? error.owner
    : error?.code === "needs_input" ? "needs_you"
    : error?.code || error?.constructor === Error ? "setup" : "method_platform";
  const message = error instanceof Error ? error.message : String(error);
  return FailureSchema.parse(failureRecord({ message, owner, ...(error?.code ? { code: error.code } : {}), ...(error?.missing ? { missing: error.missing } : {}) }, { phase: "setup" }));
}

/** The record of a run whose own record Method could not read. */
export function unreadableRecord(error: unknown): RunFailure {
  const message = error instanceof Error ? error.message : String(error);
  return { ...FailureSchema.parse(failureRecord({ message, owner: "method_platform", code: "unreadable_record" })), headline: "Method could not read this run's record." };
}

/** The three plain lines that a failed run prints on stderr. */
export function failureLines(failure: RunFailure): string {
  return `Failed: ${failure.headline}\nWhose problem: ${ownerText(failure.owner)}\nNext: ${failure.next.text}\n`;
}
