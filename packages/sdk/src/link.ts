import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadWorkflow } from "../../workflow-language/src/validate.js";
import type { Workflow } from "../../workflow-language/src/schema.js";

export function isWorkflowLink(value: string): boolean { return /^https?:\/\//iu.test(value); }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

async function failure(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  let code = "";
  try { code = String((JSON.parse(text) as { error?: unknown }).error ?? ""); } catch { /* Not JSON. */ }
  if (code === "link_expired") return "LINK_EXPIRED: this link has expired. Open the method page, copy the command again, and run it.";
  if (code === "link_invalid") return "LINK_INVALID: this link is not valid. Copy the whole command from the method page and run it again.";
  if (code === "workflow_source_not_ready") return "WORKFLOW_NOT_READY: this method is still being built. When the method page shows it is ready, run the command again.";
  if (response.status === 404) return "LINK_NOT_FOUND: no method exists at this link. Copy the command from the method page again.";
  return `LINK_FAILED: the method link returned ${response.status}${text.trim() ? `: ${text.trim().slice(0, 200)}` : ""}.`;
}

/**
 * Download a signed workflow link and keep it as <id>.workflow in the directory.
 * The saved file is reused when its bytes match; a different file is never overwritten.
 */
export async function saveWorkflowLink(link: string, directory: string, fetchImpl: typeof fetch = fetch): Promise<{ path: string; reused: boolean; source: string; workflow: Workflow }> {
  let response: Response;
  try { response = await fetchImpl(link, { headers: { accept: "application/json" } }); }
  catch (error) { throw new Error(`LINK_UNREACHABLE: could not download ${link}: ${message(error)}`); }
  if (!response.ok) throw new Error(await failure(response));
  const source = await response.text();
  let workflow: Workflow;
  try { workflow = loadWorkflow(source); }
  catch (error) { throw new Error(`LINK_INVALID: the link did not return a valid method: ${message(error)}`); }
  const path = resolve(directory, `${workflow.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.method`);
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") === source) return { path, reused: true, source, workflow };
    throw new Error(`WORKFLOW_FILE_CONFLICT: ${path} already exists with different content. Move or rename it, then run the command again.`);
  }
  writeFileSync(path, source, { flag: "wx", mode: 0o600 });
  return { path, reused: false, source, workflow };
}
