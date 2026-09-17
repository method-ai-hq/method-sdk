import { DecisionSchema, StepResultSchema, type CheckRequest, type Executor, type StepRequest, type Verifier } from "./contracts.js";
import { runProcess, type ProcessCommand } from "./process.js";

/** Explicit host-configured adapter. Workflow files cannot specify shell commands to this adapter. */
export class CommandExecutor implements Executor {
  readonly name = "command";
  constructor(private command: (request: StepRequest) => ProcessCommand) {}
  async execute(request: StepRequest) {
    const output = await runProcess({ timeout_ms: request.timeout_ms, ...this.command(request) }, JSON.stringify(request));
    return StepResultSchema.parse(JSON.parse(output.stdout));
  }
}
export class CommandVerifier implements Verifier {
  readonly name = "command-review";
  constructor(private command: (request: CheckRequest) => ProcessCommand) {}
  async verify(request: CheckRequest) {
    const output = await runProcess({ timeout_ms: request.timeout_ms, ...this.command(request) }, JSON.stringify(request));
    return DecisionSchema.parse(JSON.parse(output.stdout));
  }
}
