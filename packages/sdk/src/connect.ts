import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { authoringPath, readDocument } from "./authoring.js";
import type { MethodClient } from "./method-client.js";
import { dotenvValues, Method, MethodApiError, ServiceApi } from "./production.js";
import { open } from "./run-data.js";

// `method connect [APP_FOLDER]`: connect an app to the Method in this folder. It makes a service key named after the app,
// writes it to the app's .env without showing it, publishes the Method if it has no published version, and prints the
// install line and the code for the app's language. `method answer RUN_ID`: answer a production run's question.

const PRODUCTION_SERVER = "https://app.withmethod.ai";
type Language = "python" | "node";

/** The one Method file in a folder (not in run folders). */
function methodFile(folder: string, given?: string) {
  if (given) return authoringPath(given);
  const found = readdirSync(folder).filter(name => /\.method$/i.test(name) && statSync(join(folder, name)).isFile());
  if (found.length === 1) return join(folder, found[0]!);
  if (!found.length) throw Error("No .method file in this folder. Run method connect from the Method's folder, or give --file METHOD_FILE.");
  throw Error(`This folder has more than one Method (${found.join(", ")}). Give --file METHOD_FILE.`);
}
export function detectLanguage(app: string): Language {
  const has = (name: string) => existsSync(join(app, name));
  if (has("package.json")) return "node";
  if (["pyproject.toml", "requirements.txt", "setup.py", "Pipfile", "uv.lock", "poetry.lock"].some(has)) return "python";
  if (readdirSync(app).some(name => name.endsWith(".py"))) return "python";
  if (readdirSync(app).some(name => /\.(m?js|ts)$/.test(name))) return "node";
  throw Error(`Cannot tell the language of ${app}: add package.json (Node) or pyproject.toml or requirements.txt (Python).`);
}
function installLine(app: string, language: Language) {
  const has = (name: string) => existsSync(join(app, name));
  if (language === "node") {
    const pack = process.env.METHOD_NODE_PACKAGE || "@withmethod/sdk";
    return has("pnpm-lock.yaml") ? `pnpm add ${pack}` : has("yarn.lock") ? `yarn add ${pack}` : has("bun.lockb") || has("bun.lock") ? `bun add ${pack}` : `npm install ${pack}`;
  }
  const pack = process.env.METHOD_PYTHON_PACKAGE || "withmethod";
  return has("uv.lock") ? `uv add ${pack}` : has("poetry.lock") ? `poetry add ${pack}` : `pip install ${pack}`;
}
function example(document: any, language: Language, methodId: string, hasAsk: boolean) {
  const inputs = Object.entries(document.inputs ?? {}).filter(([, def]: any) => !Object.hasOwn(def ?? {}, "default"));
  if (language === "python") {
    const values = inputs.map(([name]) => `"${name}": ${name}`).join(", ");
    return [
      "from withmethod import Method",
      "",
      "method = Method()  # reads METHOD_API_KEY from the environment or .env",
      "",
      ...(hasAsk ? [
        "# The Method asks a person before it finishes, so start the run and answer it later.",
        `method.worker.start(methods=["${methodId}"])  # once, when the app starts: runs this Method's runs here`,
        `run_id = method.runs.start("${methodId}", {${values}}, idempotency_key=...)["run_id"]  # one key for each event; keep run_id`,
        "",
        "# Where the person decides (for example an approve endpoint):",
        "method.runs.answer(run_id, {...})  # the ask step's out fields",
        'result = method.runs.wait(run_id)["result"]',
      ] : [
        `run = method.run("${methodId}", {${values}}, idempotency_key=...)  # one key for each event`,
        `result = run["result"]`,
      ]),
    ].join("\n");
  }
  const values = inputs.map(([name]) => name).join(", ");
  return [
    'import { Method } from "@withmethod/sdk";',
    "",
    "const method = new Method(); // reads METHOD_API_KEY from the environment or .env",
    "",
    ...(hasAsk ? [
      "// The Method asks a person before it finishes, so start the run and answer it later.",
      `method.worker.start({ methods: ["${methodId}"] }); // once, when the app starts: runs this Method's runs here`,
      `const { run_id } = await method.runs.start({ method: "${methodId}", inputs: { ${values} }, idempotencyKey: ... }); // keep run_id`,
      "",
      "// Where the person decides (for example an approve endpoint):",
      "await method.runs.answer(run_id, { ... }); // the ask step's out fields",
      "const result = (await method.runs.wait(run_id)).result;",
    ] : [
      `const run = await method.run({ method: "${methodId}", inputs: { ${values} }, idempotencyKey: ... });`,
      "const result = run.result;",
    ]),
  ].join("\n");
}
/** Add KEY=VALUE to .env, or replace the line that sets KEY. */
function writeEnv(file: string, name: string, value: string) {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=.*$`, "m");
  if (pattern.test(text)) writeFileSync(file, text.replace(pattern, `${name}=${value}`), { mode: 0o600 });
  else writeFileSync(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${name}=${value}\n`, { mode: 0o600 });
}
/** Keep .env out of git: add it to the app's .gitignore when the app is in a git repository. */
function ignoreEnv(app: string) {
  let folder = resolve(app);
  for (;;) {
    if (existsSync(join(folder, ".git"))) break;
    const parent = resolve(folder, "..");
    if (parent === folder) return null;
    folder = parent;
  }
  const file = join(app, ".gitignore");
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).map(line => line.trim()) : [];
  if (lines.some(line => [".env", "/.env", ".env*", "*.env"].includes(line))) return null;
  appendFileSync(file, `${lines.length && lines.at(-1) !== "" ? "\n" : ""}.env\n`);
  return relative(process.cwd(), file) || file;
}

export async function connectCommand(args: string[], client: MethodClient) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { file: { type: "string" }, server: { type: "string" } } });
  const app = resolve(positionals[0] ?? ".");
  if (!existsSync(app) || !statSync(app).isDirectory()) throw Error(`${app} is not a folder. Use method connect APP_FOLDER.`);
  const file = methodFile(process.cwd(), values.file);
  const document = readDocument(file);
  const language = detectLanguage(app);
  if (!client.token()) await client.login();
  const envFile = join(app, ".env");
  // An app that has a working key keeps it: connect again makes no second key.
  let key = dotenvValues(app).METHOD_API_KEY, keyName = basename(app), madeKey = false;
  if (key) {
    try { await new ServiceApi(key, client.server).request("/v1/methods/" + encodeURIComponent(document.id ?? "wf_none")); }
    catch (error) { if (error instanceof MethodApiError && error.status === 401) key = undefined; }
  }
  if (!key) {
    const created = await client.request<{ key: string; name: string; prefix: string }>("/api/service-keys", "POST", { name: keyName });
    key = created.key; keyName = created.name; madeKey = true;
    writeEnv(envFile, "METHOD_API_KEY", key);
  }
  // A server other than the hosted one (a local or test server) goes to .env too, so the app reaches the same server.
  if (client.server !== PRODUCTION_SERVER) writeEnv(envFile, "METHOD_SERVER", client.server);
  const ignored = ignoreEnv(app);
  // The app runs the published version. Publish the current file when the Method has none.
  let methodId: string | undefined = document.id, published: string | null = null, publishedNow = false;
  if (methodId) {
    try { published = (await new ServiceApi(key, client.server).request<{ published_version_id: string | null }>(`/v1/methods/${encodeURIComponent(methodId)}`)).body.published_version_id; }
    catch (error) { if (!(error instanceof MethodApiError && error.status === 404)) throw error; }
  }
  if (!published) {
    const { publish } = await import("./versions.js");
    const result = await publish(client, file, `Connected to ${basename(app)}.`);
    methodId = result.workflow_id; published = result.version_id; publishedNow = true;
  }
  const hasAsk = Object.values(document.steps ?? {}).some((step: any) => step?.ask);
  const secrets = Object.keys(document.secrets ?? {});
  return {
    app, language, method_id: methodId, published_version_id: published, ...(publishedNow ? { published: "now" } : {}),
    key: madeKey ? { name: keyName, written_to: envFile, note: "The key is in .env only. It is not shown." } : { kept: envFile },
    ...(ignored ? { gitignore: `Added .env to ${ignored}.` } : {}),
    install: installLine(app, language),
    code: example(document, language, methodId!, hasAsk),
    secrets_to_set_on_the_host: secrets,
    next: [
      `Run in ${app}: ${installLine(app, language)}`,
      "Add the code where the app handles the event. The first run starts a worker in the app's process; on a server, run `method worker` beside it with the same METHOD_API_KEY if you prefer.",
      ...(secrets.length ? [`Set these secrets where the app runs: ${secrets.join(", ")}. On this computer, method secret set NAME works.`] : []),
      hasAsk ? "Questions of ask steps go to the ask handler; without one, to the dashboard inbox and an email to the person who published the Method." : "",
      "Production runs show on the dashboard under Production.",
    ].filter(Boolean),
  };
}

/** `method answer RUN_ID [--answer JSON]`: show a production run's question, or answer it. */
export async function answerCommand(args: string[], client: MethodClient) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { answer: { type: "string" }, server: { type: "string" } } });
  const runId = positionals[0];
  if (!runId) throw Error("Use method answer RUN_ID [--answer JSON].");
  // A device run's question is sealed with the key that started it: METHOD_API_KEY, the app's .env in this folder, or
  // this computer's sign-in (runs that an app started on this laptop without a key).
  if (!process.env.METHOD_API_KEY && !dotenvValues().METHOD_API_KEY && !client.token()) await client.login();
  const credential = process.env.METHOD_API_KEY ?? dotenvValues().METHOD_API_KEY ?? client.token()!;
  const method = new Method({ apiKey: credential, server: client.server, worker: false });
  const run = await method.runs.get(runId);
  if (run.status !== "waiting" || !run.question) return { run_id: runId, status: run.status, message: "This run has no question to answer." };
  const question = run.question;
  const asked: { question: string; form: unknown } = question.sealed ? open(credential, "question", run.method_id, question.sealed) : { question: question.question ?? "", form: question.form };
  if (values.answer === undefined)
    return { run_id: runId, step: question.step, question: asked.question, form: asked.form, expires_at: question.expires_at,
      next: `method answer ${runId} --answer '${JSON.stringify(Object.fromEntries(Object.keys((asked.form as any)?.properties ?? {}).map(name => [name, "…"])))}'` };
  return await method.runs.answer(runId, JSON.parse(values.answer));
}
