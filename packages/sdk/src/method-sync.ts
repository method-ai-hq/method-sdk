import { MAX_RESULT_BYTES, MAX_RESULT_TRANSFER_BYTES } from "../../workflow-language/src/result-files.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { inspectRun } from "./inspect.js";
import { writePrivateJson } from "./files.js";
import { MethodClient } from "./method-client.js";
import {
  InspectionSchema,
  type RunInspection,
} from "../../workflow-language/src/inspection.js";

const SyncSchema = z.object({
  schema: z.literal("method-sync/1"),
  server: z.string(),
  id: z.string().uuid(),
  workflow_id: z.string(),
  version_id: z.string(),
  sequence: z.number().int().nonnegative(),
  dashboard_id: z.string().optional(),
});
export class MethodSync {
  private state: z.infer<typeof SyncSchema>;
  private pending: Promise<void> = Promise.resolve();
  private stopped = false;
  private sending = false;
  private initial: RunInspection | undefined;
  private warned = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private scheduled: ReturnType<typeof setTimeout> | undefined;
  constructor(
    readonly client: MethodClient,
    readonly directory: string,
    workflowId: string,
    versionId: string,
  ) {
    const path = join(directory, "method-sync.json");
    this.state = existsSync(path)
      ? SyncSchema.parse(JSON.parse(readFileSync(path, "utf8")))
      : {
          schema: "method-sync/1",
          server: client.server,
          id: randomUUID(),
          workflow_id: workflowId,
          version_id: versionId,
          sequence: 0,
        };
    if (
      this.state.server !== client.server ||
      this.state.workflow_id !== workflowId ||
      this.state.version_id !== versionId
    )
      throw Error("This run is linked to another Method method or server.");
    this.save();
  }
  private save() {
    writePrivateJson(join(this.directory, "method-sync.json"), this.state);
  }
  private async upload(inspection: RunInspection) {
    const payload = {
      workflow_id: this.state.workflow_id,
      version_id: this.state.version_id,
      sequence: ++this.state.sequence,
      inspection,
    };
    this.save();
    // Save before upload. Sync can be retried after an interrupted connection without running steps again.
    writePrivateJson(join(this.directory, "method-pending.json"), payload);
    await this.send(payload);
  }
  private async send(payload: unknown) {
    const result = await this.client.request<{ id: string }>(
      `/api/cli/runs/${this.state.id}`,
      "PUT",
      payload,
    );
    if (!this.state.dashboard_id)
      process.stderr.write(
        `Dashboard: ${this.client.server}/runs/${result.id}\n`,
      );
    this.state.dashboard_id = result.id;
    this.save();
    this.warned = false;
  }
  async start(
    workflow: RunInspection["workflow"],
    inputs: RunInspection["inputs"],
    resources: RunInspection["resources"],
  ) {
    // Require the initial dashboard record before starting any business action.
    this.initial = {
      schema: "workflow-inspection/2",
      workflow,
      run_id: this.state.id,
      status: "running",
      inputs,
      resources,
      invocations: {},
    };
    await this.upload(this.initial);
    this.timer = setInterval(() => this.capture(), 5000);
    this.timer.unref();
  }
  snapshot() {
    if (this.stopped || this.scheduled) return;
    // Coalesce tool bursts before reading the journal or encoding attachments.
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      this.capture();
    }, 1000);
    this.scheduled.unref();
  }
  private capture() {
    if (this.stopped) return;
    if (this.sending) { this.snapshot(); return; }
    // Read synchronously on the SDK event loop, before any await. Atomic SDK files cannot change during this read.
    let inspection: RunInspection;
    try {
      inspection = inspectRun(this.directory, { activeSnapshot: true, includeFiles: true });
    } catch {
      return;
    }
    this.sending = true;
    this.pending = this.upload(inspection).catch(error => this.warn(error)).finally(() => {
      this.sending = false;
    });
  }

  private warn(error: unknown) {
    if (!this.warned)
      process.stderr.write(
        `Dashboard sync paused: ${String(error)}\nRun records remain here. Retry with method sync ${JSON.stringify(this.directory)}.\n`,
      );
    this.warned = true;
  }
  async finish(failure?: unknown) {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.scheduled);
    await this.pending;
    try {
      let inspection: RunInspection;
      try {
        inspection = inspectRun(this.directory, { includeFiles: true });
      } catch (error) {
        if (!this.initial) throw error;
        inspection = {
          ...this.initial,
          status: "needs_attention",
          error:
            failure instanceof Error
              ? failure.message
              : String(failure ?? error),
        };
      }
      await this.upload(inspection);
    } catch (error) {
      this.warn(error);
    }
  }
  static async retry(directory: string, client?: MethodClient) {
    const state = SyncSchema.parse(
      JSON.parse(readFileSync(join(directory, "method-sync.json"), "utf8")),
    );
    const sync = new MethodSync(
      client ?? new MethodClient(state.server),
      directory,
      state.workflow_id,
      state.version_id,
    );
    // Export the final local state. Never rerun business actions during sync.
    let inspection = inspectRun(directory, { includeFiles: true });
    if (state.dashboard_id) {
      const saved=await sync.client.request<{run:{status:string;inspection:RunInspection}}>(`/api/workspace/runs/${state.dashboard_id}`);
      if (saved.run.status === "succeeded") {
        // Keep bytes already saved if the local file was removed or changed.
        const files = [...(saved.run.inspection.files ?? [])];
        let size = files.reduce((sum, file) => sum + (file.data !== undefined ? file.bytes ?? 0 : 0), 0);
        let transferred = files.reduce((sum, file) => sum + (file.data ? Buffer.from(file.data, "base64").length : 0) + (file.website?.archive ? Buffer.from(file.website.archive, "base64").length : 0), 0);
        for (const file of inspection.files ?? []) {
          const index = files.findIndex(old => old.path === file.path && old.sha256 === file.sha256);
          if (index >= 0 && files[index]!.data !== undefined && !(file.website?.archive && !files[index]!.website?.archive)) continue;
          const previous = index >= 0 ? files[index] : undefined;
          const priorBytes = previous?.data !== undefined ? previous.bytes ?? 0 : 0;
          const priorTransfer = (previous?.data ? Buffer.from(previous.data, "base64").length : 0) + (previous?.website?.archive ? Buffer.from(previous.website.archive, "base64").length : 0);
          const payloadSize = (file.data ? Buffer.from(file.data, "base64").length : 0) + (file.website?.archive ? Buffer.from(file.website.archive, "base64").length : 0);
          if (file.data !== undefined && (size - priorBytes + (file.bytes ?? 0) > MAX_RESULT_BYTES || transferred - priorTransfer + payloadSize > MAX_RESULT_TRANSFER_BYTES)) continue;
          transferred += payloadSize - priorTransfer;
          size += (file.data !== undefined ? file.bytes ?? 0 : 0) - priorBytes;
          if (index >= 0) files[index] = file;
          else files.push(file);
        }
        inspection = { ...saved.run.inspection, files };
      }
    }
    const pendingPath = join(directory, "method-pending.json");
    if (existsSync(pendingPath)) {
      const pending = JSON.parse(readFileSync(pendingPath, "utf8"));
      if (
        JSON.stringify(InspectionSchema.parse(pending.inspection)) ===
        JSON.stringify(inspection)
      ) {
        await sync.send(pending);
        return;
      }
    }
    await sync.upload(inspection);
  }
}
