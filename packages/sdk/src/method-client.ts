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
const Token = z.string().regex(/^method_[A-Za-z0-9_-]{43}$/);
/**
 * One signed-in account of this computer: the person and the workspace (known after the first answer from the server),
 * its credential, and the IDs of the Methods and comparisons that belong to it, so that a file with an ID always uses
 * the account that owns it.
 */
const SignIn = z.object({
  key: z.string(),
  token: Token,
  person: z.object({ id: z.string(), name: z.string(), email: z.string() }).optional(),
  workspace: z.object({ id: z.string(), name: z.string().nullable() }).optional(),
  ids: z.array(z.string()).default([]),
  added_at: z.number().default(0),
});
export type SignIn = z.infer<typeof SignIn>;
/** The accounts of one server, in one private file: the first is the current account, the others follow by last use. */
const SignIns = z.object({ server: z.string(), accounts: z.array(SignIn) });
/** The single sign-in that CLIs before 0.22.6 kept: it becomes the first account. */
const SingleSignIn = z.object({ server: z.string(), token: Token });
const tokenKey = (token: string) => `t_${sha256(token).slice(0, 16)}`;
/** The words for an account: the person, their email and the workspace. */
export function accountWords(account: Pick<SignIn, "person" | "workspace">) {
  if (!account.person) return "an account whose name Method does not know yet";
  return `${account.person.name} (${account.person.email})${account.workspace?.name ? `, workspace ${account.workspace.name}` : ""}`;
}
/**
 * The account a command uses (METHOD_ACCOUNT, set for this process and the processes it starts): the account that owns
 * the Method or comparison of the command. Without one, the current account.
 */
const ROUTED = "METHOD_ACCOUNT";
export class MethodClient {
  readonly server: string;
  readonly credentialFile: string;
  constructor(
    server = DEFAULT_SERVER,
    readonly fetcher: typeof fetch = fetch,
    readonly configRoot = defaultConfigRoot(),
    /** The key of the account this client always uses, whatever account is current. */
    readonly accountKey?: string,
  ) {
    this.server = serverOrigin(server);
    this.credentialFile = join(
      configRoot,
      `${sha256(this.server).slice(0, 24)}.json`,
    );
  }
  /** Every signed-in account of this server, the current one first. */
  accounts(): SignIn[] {
    const file = this.credentialFile;
    if (!existsSync(file)) return [];
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const single = SingleSignIn.safeParse(raw);
    if (single.success && !("accounts" in raw)) {
      if (single.data.server !== this.server) throw Error("The saved Method sign-in belongs to another server.");
      const accounts = [SignIn.parse({ key: tokenKey(single.data.token), token: single.data.token, added_at: 0 })];
      writePrivateJson(file, { server: this.server, accounts });
      return accounts;
    }
    const saved = SignIns.parse(raw);
    if (saved.server !== this.server) throw Error("The saved Method sign-in belongs to another server.");
    return saved.accounts;
  }
  private saveAccounts(accounts: SignIn[]) {
    writePrivateJson(this.credentialFile, { server: this.server, accounts });
  }
  /** The account this client uses: its own, else the one routed to this process, else the current one. */
  account(): SignIn | undefined {
    const accounts = this.accounts();
    const wanted = this.accountKey ?? process.env[ROUTED];
    return accounts.find(a => a.key === wanted) ?? accounts[0];
  }
  /** A client that always uses this account. */
  as(key: string) { return new MethodClient(this.server, this.fetcher, this.configRoot, key); }
  /** A client that always uses the account known to own this Method or comparison; without one, this client. */
  owner(id: string) {
    try { const found = this.accounts().find(a => a.ids.includes(id)); return found ? this.as(found.key) : this; } catch { return this; }
  }
  token() {
    // A service key in METHOD_API_KEY signs a production worker in without a saved sign-in.
    if (process.env.METHOD_API_KEY) return process.env.METHOD_API_KEY;
    return this.account()?.token ?? null;
  }
  /** Note that a Method or comparison ID belongs to the account this client uses (and to no other). */
  remember(id: string) {
    if (process.env.METHOD_API_KEY) return;
    try {
      const accounts = this.accounts(), owner = this.account();
      if (!owner || owner.ids.includes(id) && accounts.every(a => a === owner || !a.ids.includes(id))) return;
      this.saveAccounts(accounts.map(a => ({ ...a, ids: a.key === owner.key ? [...a.ids.filter(x => x !== id), id] : a.ids.filter(x => x !== id) })));
    } catch { /* The next command asks the server again. */ }
  }
  /**
   * Use the account that owns this Method, comparison or run, for this process and the processes it starts. A known ID
   * uses its account. Otherwise, with more than one account, each account asks the server once; the owner is
   * remembered. No owner (a new ID): the account in use stays.
   */
  async route(id: string) {
    if (process.env.METHOD_API_KEY) return;
    const accounts = this.accounts();
    let owner = accounts.find(a => a.ids.includes(id));
    if (!owner && accounts.length > 1) {
      const first = this.account()!.key;
      const order = [...accounts.filter(a => a.key === first), ...accounts.filter(a => a.key !== first)];
      const path = /^cmp_/.test(id) ? `/api/comparisons/${encodeURIComponent(id)}`
        : /^wf_/.test(id) ? `/api/cli/methods/${encodeURIComponent(id)}` : `/api/workspace/runs/${encodeURIComponent(id)}`;
      const owns = await Promise.all(order.map(async a => {
        try { const answer = await this.send(path, "GET", { token: a.token, signal: AbortSignal.timeout(5000), stallMs: 5000 }); return answer.ok || answer.status === 409; }
        catch { return false; }
      }));
      owner = order[owns.indexOf(true)];
      if (owner && /^(wf|cmp)_/.test(id)) this.as(owner.key).remember(id);
    }
    if (owner) process.env[ROUTED] = owner.key;
  }
  /** The person and workspace of a credential, from the server. Throws 401 when it no longer works. */
  async whoIs(token: string): Promise<Pick<SignIn, "person" | "workspace">> {
    const answer = await this.send("/api/cli/me", "GET", { token, stallMs: 15_000 });
    const text = Buffer.from(answer.bytes).toString("utf8");
    if (!answer.ok) throw Object.assign(Error(`${answer.status}: ${text.slice(0, 300)}`), { status: answer.status });
    const me = JSON.parse(text);
    return { person: { id: String(me.user.id), name: String(me.user.name ?? me.user.email), email: String(me.user.email) },
      workspace: { id: String(me.user.organization_id), name: typeof me.organization?.name === "string" ? me.organization.name : null } };
  }
  /** Each account with whether its credential still works, and its person and workspace as the server has them now. */
  async check(): Promise<Array<SignIn & { signed_in: boolean }>> {
    const accounts = this.accounts();
    const checked = await Promise.all(accounts.map(async a => {
      try { return { ...a, ...await this.whoIs(a.token), signed_in: true }; }
      catch (error: any) { if (error?.status === 401) return { ...a, signed_in: false }; throw error; }
    }));
    const now = this.accounts();
    this.saveAccounts(now.map(a => { const c = checked.find(x => x.key === a.key); return c?.person ? { ...a, person: c.person, workspace: c.workspace } : a; }));
    return checked;
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
    // A lost connection: a read is tried again (three attempts in all, like transfer); any request says which server.
    let sent: Awaited<ReturnType<typeof this.send>>;
    for (let attempt = 1; ; attempt++) {
      try {
        sent = await this.send(path, method, { ...(data ? { body: data, type: "application/json" } : {}), token, ...options });
        break;
      } catch (error: any) {
        const lost = error?.name === "TypeError" && !options.signal?.aborted;
        if (lost && method === "GET" && attempt < 3) { await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); continue; }
        if (lost) throw this.unreachable(method, path, error);
        throw error;
      }
    }
    const { status, statusText, ok, bytes } = sent;
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
      ), {status, code: typeof result.code === 'string' ? result.code.slice(0,100) : 'method_request_failed', body: result});
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
        if (attempt >= (options.attempts ?? 3) || error.retryable === false) throw error?.name === 'TypeError' ? this.unreachable(data ? 'PUT' : 'GET', path, error) : error;
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
      }
    }
  }
  /** A lost connection: code network, and the message says which server. */
  private unreachable(method: string, path: string, error: any) {
    return Object.assign(Error(`Method cannot be reached at ${this.server} (${method} ${path}): ${error.cause?.code ?? error.message}. Check the connection and run again.`), { code: "network" });
  }
  /** Send bytes in chunks and read the answer in chunks; a watchdog aborts when no bytes moved for stallMs. */
  private async send(path: string, method: string, options: {body?: Uint8Array | string; type?: string; token: string | null; signal?: AbortSignal; stallMs?: number; maxResponseBytes?: number; onProgress?: (sent: number) => void}) {
    const stallMs = options.stallMs ?? 15_000, controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // stallMs 0: no watchdog, for a server that sends nothing until its answer is complete (a model request).
    const touch = () => {
      clearTimeout(timer);
      if (stallMs === 0) return;
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
  /**
   * Browser approval. The account that approves is added, or refreshed when this computer already has it, and becomes
   * the current account. The other accounts stay signed in.
   */
  async login(openBrowser: (url: string) => void = openUrl) {
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
      `Approve Method in your browser. Check this code: ${started.code}\n${verification}\n` +
      (this.accounts().length ? "The account you approve with becomes the current account. To add another account, open the link where you are signed in to it, for example in a private window.\n" : ""),
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
        const added = await this.addAccount(token);
        rmSync(pendingFile, {force: true});
        const others = this.accounts().slice(1);
        process.stderr.write(`Method is connected. The current account is ${accountWords(added)}.${others.length ? ` Also signed in: ${others.map(accountWords).join("; ")}.` : ""}\n`);
        return;
      }
      if (result.status === "expired") break;
    }
    rmSync(pendingFile, {force: true});
    throw Error("Browser sign-in expired. Run method login again.");
  }
  /** Keep an approved credential as the current account: a known person and workspace gets the new credential. */
  private async addAccount(token: string) {
    const identity = await this.whoIs(token).catch(() => ({}) as Pick<SignIn, "person" | "workspace">);
    // An account from before the person was known is named now, so it is found when the same person approves again.
    const accounts: SignIn[] = [];
    for (const a of this.accounts()) {
      if (a.person) { accounts.push(a); continue; }
      try { accounts.push({ ...a, ...await this.whoIs(a.token) }); }
      catch (error: any) { if (error?.status !== 401) accounts.push(a); }
    }
    const known = identity.person ? accounts.find(a => a.person?.id === identity.person!.id) : undefined;
    const added = SignIn.parse({ key: known?.key ?? identity.person?.id ?? tokenKey(token), token, ...identity, ids: known?.ids ?? [], added_at: known?.added_at ?? Date.now() });
    this.saveAccounts([added, ...accounts.filter(a => a !== known)]);
    // The credential it replaces no longer works.
    if (known && known.token !== token) await this.send("/api/cli/logout", "POST", { token: known.token, body: "{}", type: "application/json" }).catch(() => {});
    return added;
  }
  /** Sign out of the current account only. The next most recent account becomes the current one. */
  async logout(): Promise<{ signed_out: SignIn | null; current: SignIn | null }> {
    rmSync(`${this.credentialFile}.pending`, { force: true });
    const [current, ...rest] = this.accounts();
    if (!current) return { signed_out: null, current: null };
    // The server no longer accepts the credential. One that already stopped working (401) is removed all the same.
    const answer = await this.send("/api/cli/logout", "POST", { token: current.token, body: "{}", type: "application/json" })
      .catch(error => { throw error?.name === "TypeError" ? this.unreachable("POST", "/api/cli/logout", error) : error; });
    if (!answer.ok && answer.status !== 401) throw Error(`${answer.status}: Method did not sign this computer out. Run method logout again.`);
    if (rest.length) this.saveAccounts(rest); else rmSync(this.credentialFile, { force: true });
    return { signed_out: current, current: rest[0] ?? null };
  }
}
export function openUrl(url: string) {
  // $BROWSER, as many command-line tools read it, picks the program that opens the link.
  const chosen = process.env.BROWSER?.trim();
  const command = chosen
    ? chosen
    : process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32"
        : "xdg-open";
  const args =
    !chosen && process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () =>
    process.stderr.write("Open the sign-in link above in your browser.\n"),
  );
  child.unref();
}
