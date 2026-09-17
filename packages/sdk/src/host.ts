import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { z } from "zod";

/** Correlated JSON-line callbacks. Independent operations can reply out of order. */
export class JsonLineHost {
  private lines;
  private input;
  private sequence = 0;
  private pumping = false;
  private failure: Error | undefined;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(input: Readable = process.stdin, private output: (line: string) => void = line => { process.stdout.write(line); }) {
    this.lines = createInterface({ input, terminal: false });
    this.input = this.lines[Symbol.asyncIterator]();
  }

  send(value: unknown): void { this.output(`${JSON.stringify(value)}\n`); }

  async receive(): Promise<unknown> {
    const next = await this.input.next();
    if (next.done) throw new Error("HOST_CLOSED: the host closed the bridge.");
    return JSON.parse(next.value);
  }

  request(method: string, payload: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.send({ type: "request", id, method, payload }); }
      catch (error) { this.stop(error instanceof Error ? error : new Error(String(error))); }
      void this.pump();
    });
  }

  private stop(error: Error): void {
    this.failure = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.pending.size) {
        const response = z.strictObject({ id: z.number().int(), result: z.unknown().optional(), error: z.string().optional() }).parse(await this.receive());
        const request = this.pending.get(response.id);
        if (!request) throw new Error("HOST_PROTOCOL: response ID does not match an outstanding request.");
        this.pending.delete(response.id);
        if (response.error) request.reject(new Error(response.error));
        else request.resolve(response.result);
      }
    } catch (error) { this.stop(error instanceof Error ? error : new Error(String(error))); }
    finally { this.pumping = false; }
  }

  close(): void { this.stop(new Error("HOST_CLOSED: the host closed the bridge.")); this.lines.close(); }
}
