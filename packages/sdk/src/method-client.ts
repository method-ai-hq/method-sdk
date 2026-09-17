import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { sha256 } from "../../contracts/src/identity.js";
import { writePrivateJson } from "./files.js";

export const DEFAULT_SERVER = "https://app.withmethod.ai";
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
const Credential = z.object({
  server: z.string(),
  token: z.string().regex(/^method_[A-Za-z0-9_-]{43}$/),
});
export class MethodClient {
  readonly server: string;
  readonly credentialFile: string;
  private readonly legacyCredentialFile?: string;
  constructor(
    server = DEFAULT_SERVER,
    readonly fetcher: typeof fetch = fetch,
    configRoot = join(homedir(), ".config", "method"),
  ) {
    this.server = serverOrigin(server);
    this.credentialFile = join(
      configRoot,
      `${sha256(this.server).slice(0, 24)}.json`,
    );
    if (this.server === DEFAULT_SERVER) {
      this.legacyCredentialFile = join(configRoot, `${sha256("https://app.workflowcorp.ai").slice(0, 24)}.json`);
    }
  }
  token() {
    const file = existsSync(this.credentialFile) ? this.credentialFile : this.legacyCredentialFile;
    if (!file || !existsSync(file)) return null;
    const saved = Credential.parse(
      JSON.parse(readFileSync(file, "utf8")),
    );
    const expectedServer = file === this.legacyCredentialFile ? "https://app.workflowcorp.ai" : this.server;
    if (saved.server !== expectedServer)
      throw Error("The saved Method sign-in belongs to another server.");
    return saved.token;
  }
  async request<T = any>(
    path: string,
    method = "GET",
    body?: unknown,
    authenticated = true,
  ): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw Error("Use a Method API path.");
    const token = authenticated ? this.token() : null;
    if (authenticated && !token)
      throw Error("Sign in with method login first.");
    const response = await this.fetcher(this.server + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = (await response.json()) as any;
    if (!response.ok)
      throw Error(
        `${response.status}: ${result.message ?? result.error ?? "Method request failed"}`,
      );
    return result as T;
  }
  async transfer(path: string, data?: Uint8Array): Promise<Uint8Array> {
    if (!path.startsWith('/api/cli/') || path.includes('://')) throw Error('Use a Method file API path.');
    const token = this.token();
    if (!token) throw Error('Sign in with method login first.');
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.fetcher(this.server + path, {
          method: data ? 'PUT' : 'GET', redirect: 'error', signal: AbortSignal.timeout(120_000),
          headers: { authorization: `Bearer ${token}`, ...(data ? {'content-type':'application/octet-stream'} : {}) },
          ...(data ? { body: data as unknown as BodyInit } : {}),
        });
        if (!response.ok) throw Object.assign(new Error(`${response.status}: ${await response.text()}`), { retryable: response.status >= 500 || response.status === 429 });
        return new Uint8Array(await response.arrayBuffer());
      } catch (error: any) {
        if (attempt >= 2 || error.retryable === false) throw error;
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
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
    if (this.legacyCredentialFile) rmSync(this.legacyCredentialFile, { force: true });
  }
}
function openUrl(url: string) {
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
