import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

// Sealed run content for device runs in the production queue. The key is derived on the client from the credential
// that starts the run (a service key, or the CLI sign-in): HKDF-SHA256 of the credential, then AES-256-GCM. The server
// has only the SHA-256 of the credential, so it cannot derive the key and cannot open what it stores.
//
// Text:  "v1." + base64url(12-byte IV) + "." + base64url(ciphertext and 16-byte tag)
// Bytes: "MRS1" + IV + tag + ciphertext (a run folder)
// The additional data names what is sealed and for which Method, so one sealed value cannot stand in for another.

const SALT = Buffer.from("method-run-data/1");
const encryptionKey = (credential: string) => Buffer.from(hkdfSync("sha256", Buffer.from(credential, "utf8"), SALT, "aes-256-gcm", 32));
const digestKey = (credential: string) => Buffer.from(hkdfSync("sha256", Buffer.from(credential, "utf8"), SALT, "hmac-sha256", 32));

export type SealedKind = "inputs" | "question" | "answer" | "snapshot";
const aad = (kind: SealedKind, methodId: string) => Buffer.from(`method-run-data/1:${kind}:${methodId}`);

/** Seal a JSON value. */
export function seal(credential: string, kind: SealedKind, methodId: string, value: unknown): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", encryptionKey(credential), iv);
  cipher.setAAD(aad(kind, methodId));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `v1.${iv.toString("base64url")}.${body.toString("base64url")}`;
}
/** Open a sealed JSON value. Fails with code wrong_key when another credential sealed it. */
export function open<T = unknown>(credential: string, kind: SealedKind, methodId: string, sealed: string): T {
  const match = sealed.match(/^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)$/);
  if (!match) throw Object.assign(Error("This is not sealed run data."), { code: "invalid_sealed" });
  const body = Buffer.from(match[2]!, "base64url");
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(credential), Buffer.from(match[1]!, "base64url"));
    decipher.setAAD(aad(kind, methodId)); decipher.setAuthTag(body.subarray(body.length - 16));
    return JSON.parse(Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString("utf8")) as T;
  } catch {
    throw Object.assign(Error("This run's content was sealed with another key. Use the METHOD_API_KEY that started the run."), { code: "wrong_key" });
  }
}
export function sealBytes(credential: string, methodId: string, bytes: Uint8Array): Buffer {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", encryptionKey(credential), iv);
  cipher.setAAD(aad("snapshot", methodId));
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([Buffer.from("MRS1"), iv, cipher.getAuthTag(), body]);
}
export function openBytes(credential: string, methodId: string, sealed: Uint8Array): Buffer {
  const data = Buffer.from(sealed);
  if (data.subarray(0, 4).toString("latin1") !== "MRS1") throw Object.assign(Error("This is not a sealed run folder."), { code: "invalid_sealed" });
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(credential), data.subarray(4, 16));
    decipher.setAAD(aad("snapshot", methodId)); decipher.setAuthTag(data.subarray(16, 32));
    return Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]);
  } catch {
    throw Object.assign(Error("This run folder was sealed with another key. Use the METHOD_API_KEY that started the run."), { code: "wrong_key" });
  }
}
/** The idempotency digest of sealed inputs: equal inputs give an equal digest, and the server cannot reverse it. */
export function inputsDigest(credential: string, methodId: string, inputs: unknown): string {
  return createHmac("sha256", digestKey(credential)).update(`${methodId}\n${canonical(inputs)}`).digest("hex");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as any)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** `method __run-data seal|open KIND METHOD_ID`: the Python library seals with this (stdin JSON in, stdout out). */
export async function runDataCommand(args: string[]) {
  const [action, kind, methodId] = args;
  const credential = process.env.METHOD_API_KEY;
  if (!credential || !methodId || !["inputs", "question", "answer"].includes(kind ?? "") || !["seal", "open", "digest"].includes(action ?? ""))
    throw Error("Use METHOD_API_KEY=… method __run-data seal|open|digest inputs|question|answer METHOD_ID < VALUE");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const result = action === "seal" ? seal(credential, kind as SealedKind, methodId, JSON.parse(text))
    : action === "digest" ? inputsDigest(credential, methodId, JSON.parse(text))
    : open(credential, kind as SealedKind, methodId, text.trim());
  process.stdout.write(JSON.stringify(result) + "\n");
}
