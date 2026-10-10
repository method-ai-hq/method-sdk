import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { configRoot as defaultConfigRoot } from "./computer-settings.js";
import { join } from "node:path";
import { z } from "zod";
import { sha256 } from "../../contracts/src/identity.js";
import { writePrivateJson } from "./files.js";

// METHOD_SERVER selects another server (staging, or a local server in tests) for every command.
export const DEFAULT_SERVER = process.env.METHOD_SERVER || "https://app.withmethod.ai";
export function serverOrigin(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      ))
  )
    throw Error(
      "Use an HTTPS Method server, or a loopback URL for local development.",
    );
  return url.origin;
}
// Upload chunk size: progress is seen at least once per chunk.
const chunkBytes = 64 * 1024;
const Credential = z.object({
  server: z.string(),
  token: z.string().regex(/^method_[A-Za-z0-9_-]{43}$/),
});
export class MethodClient {
  readonly server: string;
  readonly credentialFile: string;
  constructor(
    server = DEFAULT_SERVER,
    readonly fetcher: typeof fetch = fetch,
    configRoot = defaultConfigRoot(),
  ) {
    this.server = serverOrigin(server);
    this.credentialFile = join(
      configRoot,
      `${sha256(this.server).slice(0, 24)}.json`,
    );

  }
  token() {
    // A service key in METHOD_API_KEY signs a production worker in without a saved sign-in.
    if (process.env.METHOD_API_KEY) return process.env.METHOD_API_KEY;
    const file = this.credentialFile;
    if (!file || !existsSync(file)) return null;
    const saved = Credential.parse(
      JSON.parse(readFileSync(file, "utf8")),
    );
    if (saved.server !== this.server)
      throw Error("The saved Method sign-in belongs to another server.");
    return saved.token;
  }
  /**
   * One request. There is no fixed total timeout: the request stops only when no bytes move (sent or received) for
   * stallMs (default 15 s). onProgress receives the number of bytes sent so far.
   */
  async request<T = any>(
    path: string,
    method = "GET",
    body?: unknown,
    authenticated = true,
    options: {signal?: AbortSignal; stallMs?: number; maxResponseBytes?: number; onProgress?: (sent: number) => void} = {},
  ): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw Error("Use a Method API path.");
    const token = authenticated ? this.token() : null;
    if (authenticated && !token)
      throw Error("Sign in with method login first.");
    const data = body === undefined ? undefined : JSON.stringify(body);
    const { status, statusText, ok, bytes } = await this.send(path, method, {
      ...(data ? { body: data, type: "application/json" } : {}), token, ...options,
    });
    const text = Buffer.from(bytes).toString("utf8");
    let result: any;
    try { result = JSON.parse(text); }
    catch {
      const title = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1]?.split("|")[0]?.trim();
      throw Object.assign(Error(`${status}: ${title || statusText || "Method returned a non-JSON response"} (${method} ${path}). Local run files are preserved.`), {status});
    }
    if (!ok)
      throw Object.assign(Error(
        `${status}: ${String(result.message ?? result.error ?? "Method request failed").slice(0, 1000)}`,
      ), {status, code: typeof result.code === 'string' ? result.code.slice(0,100) : 'method_request_failed'});
    return result as T;
  }
  /** Upload (data) or download bytes. Retries a lost connection or a server error twice; stops only when no bytes move. */
  async transfer(path: string, data?: Uint8Array, options: {stallMs?: number; onProgress?: (sent: number) => void; attempts?: number} = {}): Promise<Uint8Array> {
    if (!path.startsWith('/api/cli/') || path.includes('://')) throw Error('Use a Method file API path.');
    const token = this.token();
    if (!token) throw Error('Sign in with method login first.');
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await this.send(path, data ? 'PUT' : 'GET', { token, stallMs: options.stallMs ?? 60_000, ...(options.onProgress ? {onProgress: options.onProgress} : {}), ...(data ? { body: data, type: 'application/octet-stream' } : {}) });
        if (!response.ok) throw Object.assign(new Error(`${response.status}: ${Buffer.from(response.bytes).toString('utf8').slice(0, 1000)}`), { status: response.status, retryable: response.status >= 500 || response.status === 429 });
        return response.bytes;
      } catch (error: any) {
        if (attempt >= (options.attempts ?? 3) || error.retryable === false) throw error;
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
      }
    }
  }
  /** Send bytes in chunks and read the answer in chunks; a watchdog aborts when no bytes moved for stallMs. */
  private async send(path: string, method: string, options: {body?: Uint8Array | string; type?: string; token: string | null; signal?: AbortSignal; stallMs?: number; maxResponseBytes?: number; onProgress?: (sent: number) => void}) {
    const stallMs = options.stallMs ?? 15_000, controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(Object.assign(new Error(`No data moved for ${Math.round(stallMs / 1000)} s (${method} ${path}).`), { name: 'TimeoutError', code: 'stalled' })), stallMs);
    };
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    touch();
    try {
      let body: BodyInit | undefined;
      const raw = options.body;
      const data = typeof raw === 'string' && raw.length > chunkBytes ? new TextEncoder().encode(raw) : raw;
      const size = typeof data === 'string' ? Buffer.byteLength(data) : data?.byteLength ?? 0;
      if (data && typeof data !== 'string' && data.byteLength > chunkBytes) {
        let offset = 0;
        body = new ReadableStream<Uint8Array>({
          pull(stream) {
            if (offset >= data.byteLength) { stream.close(); return; }
            const end = Math.min(offset + chunkBytes, data.byteLength);
            stream.enqueue(data.subarray(offset, end)); offset = end;
            touch(); options.onProgress?.(offset);
          },
        });
      } else if (data) body = data as unknown as BodyInit;
      const response = await this.fetcher(this.server + path, {
        method, redirect: "error", signal,
        headers: { ...(options.type ? { "content-type": options.type } : {}), ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
        ...(body === undefined ? {} : { body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) }),
      } as RequestInit);
      if (data && !(body instanceof ReadableStream)) options.onProgress?.(size);
      touch();
      const chunks: Uint8Array[] = []; let length = 0;
      const reader = response.body?.getReader();
      if (reader) for (;;) {
        const {done, value} = await reader.read(); if (done) break;
        touch(); length += value.byteLength;
        if (options.maxResponseBytes !== undefined && length > options.maxResponseBytes) { await reader.cancel(); throw Error('Method response exceeds the size limit.'); }
        chunks.push(value);
      }
      else if (typeof response.arrayBuffer === 'function') chunks.push(new Uint8Array(await response.arrayBuffer()));
      return { status: response.status, statusText: response.statusText, ok: response.ok, bytes: new Uint8Array(Buffer.concat(chunks)) };
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason;
      throw error;
    } finally { clearTimeout(timer); }
  }
  async login(openBrowser: (url: string) => void = openUrl) {
    if (this.token()) {
      try {
        await this.request("/api/cli/me");
        process.stderr.write("Method is connected.\n");
        return;
      } catch (error) {
        if (!String(error).includes("401:")) throw error;
      }
    }
    const pendingFile = `${this.credentialFile}.pending`;
    const prior = existsSync(pendingFile) ? JSON.parse(readFileSync(pendingFile, 'utf8')) : null;
    const token = prior?.expires_at > Date.now() ? prior.token : `method_${Buffer.from(randomBytes(32)).toString("base64url")}`;
    const started = prior?.expires_at > Date.now() ? prior : await this.request<{
      poll_secret: string;
      code: string;
      expires_at: number;
      verification_url: string;
    }>(
      "/auth/cli/start",
      "POST",
      { name: hostname(), token_hash: sha256(token) },
      false,
    );
    writePrivateJson(pendingFile, { ...started, token });
    const verification = new URL(started.verification_url);
    // The hosted app uses its API origin for WorkOS cookies. No credentials are sent to this URL.
    if (
      verification.protocol !== "https:" &&
      verification.origin !== this.server
    )
      throw Error("Invalid browser sign-in URL.");
    process.stderr.write(
      `Authorize Method in your browser. Check this code: ${started.code}\n${verification}\n`,
    );
    openBrowser(verification.toString());
    while (Date.now() < started.expires_at) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const result = await this.request<{ status: string }>(
        "/auth/cli/poll",
        "POST",
        { poll_secret: started.poll_secret },
        false,
      );
      if (result.status === "approved") {
        writePrivateJson(this.credentialFile, { server: this.server, token });
        rmSync(pendingFile, {force: true});
        process.stderr.write("Method is connected.\n");
        return;
      }
      if (result.status === "expired") break;
    }
    rmSync(pendingFile, {force: true});
    throw Error("Browser sign-in expired. Run method login again.");
  }
  async logout() {
    if (this.token()) await this.request("/api/cli/logout", "POST", {});
    rmSync(this.credentialFile, { force: true });
    rmSync(`${this.credentialFile}.pending`, { force: true });
  }
}
export function openUrl(url: string) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () =>
    process.stderr.write("Open the sign-in link above in your browser.\n"),
  );
  child.unref();
}
