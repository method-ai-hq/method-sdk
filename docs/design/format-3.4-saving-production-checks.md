# Format 3.4, saving by content, production runs, and the issue checker

Status: approved by the user on 2026-10-09, in progress. This note fixes the contracts that the runtime (method-spec),
the SDK and CLI (method-sdk), and the server and dashboard (workflow-corp) share. Designs:
https://claude.ai/artifact/RwAa6xqnhHTwXiPQv73k4Q (parts 2–3) and https://claude.ai/artifact/C4eB6nYueuM3wESVybSicr.

## 1. Format method/3.4

New optional top-level fields. A 3.3 file still loads unchanged; a file that uses a new field declares `format: method/3.4`.

```yaml
format: method/3.4
id: wf_3cfa2d6d2c00552ce5a4ab723a8248fe   # written once by the CLI; not part of the content hash
models:                                    # what model names mean (was runtime.json models)
  writer: openai/gpt-6-luna
  fields_writer: {model: deepseek/deepseek-v4.1-flash, max_output_tokens: 4000, reasoning_effort: low}
steps:
  write:
    do: {kind: call, model: writer, prompt: ...}          # a name from models:
  intro:
    do: {kind: call, model: openai/gpt-6-luna, prompt: ...}  # or a model ID directly (provider/model)
  fields:
    do: {kind: call, prompt: ...}                          # or nothing: the account's default model
    accept: {prompt_multiple_tasks: "The user wants one combined field list."}   # accepted warnings
```

- `id` is the account Method's ID. The CLI writes it at the first signed-in save, as the second line. The content
  hash (document digest) leaves out `id`. A copy of a folder keeps the ID; `method new-id FILE` writes a new one.
- `models` values: a model ID string, or `{model, max_output_tokens?, reasoning_effort?}`. These are hosted models
  (backend `method`) when signed in. `--agent codex|claude` (or the computer setting `agent`) still runs every
  model step with the local agent instead.
- `model` on a step: a `models` name, a model ID (`provider/model`, pattern `^[a-z0-9-]+/[A-Za-z0-9._:-]+$`), or
  absent (account default). The old profile name `default` keeps meaning the account default.
- `accept: {CODE: reason}` on a step: accepts that warning on that step. Errors cannot be accepted.

## 2. No runtime.json, no sidecar

- The runtime keeps its programmatic `config` argument (RuntimeConfig) as an internal API. No file is read by
  default anymore; the SDK builds the config. `--config` is deleted from the CLI.
- Method-level `models` resolve before any computer setting. Saved versions that contain a `runtime.json` in their
  package still run: the runtime reads `models` from it when the document has no `models`.
- Computer settings live in `~/.config/method/computer.json` (mode 0600), written by the CLI:
  `{agent?: "codex"|"claude", bindings: {METHOD_ID: {CONNECTION: path}}, limits?: {...}}`.
  `method bind NAME PATH` (exists) writes `bindings`; `method config agent codex` writes `agent`.
  A folder connection inside the project needs no binding (relative to the Method file).
- Runtimes (python, node) are found on PATH; the run record notes the version. `allow_local_processes` is true for
  the user's own Methods.
- The sidecar `FILE.method.json`, the `FILE.lock` file, and the `pending` save state are deleted.
- One-time converter, this release only: the first run, validate, or publish of a Method that has a runtime.json or
  a sidecar moves `models` into the Method (format 3.4), moves environment paths into `computer.json` bindings, writes
  the `id:` line from the sidecar's `workflow_id`, deletes both files, and prints one line. The next release deletes
  the converter.

## 3. Saving by content

- Version ID = `v_` + first 32 hex of sha256(`${method_id}:${package_digest}`). The client knows it before any
  request. The same content is always the same version; going back in git finds the existing version.
- `PUT /api/cli/methods/:method_id/versions/:version_id` with `{workflow, package, parent_version_id?, reason}` is
  idempotent: the same body again returns the same version. A new Method is created by the first PUT for an ID that
  the client generated (`wf_` + 32 hex, random) — no request IDs, no pending state. Concurrent saves from two
  computers both succeed; each records its parent.
- The run starts at once. An outbox on the computer (`~/.cache/method/outbox/`) holds file uploads, version saves and
  run updates; it sends them in parallel (6 at a time), in any order the server accepts (the server accepts a run
  record before its version arrives and links them when it does), retries with backoff, and stops only when no bytes
  move for 60 s. Any later `method` command sends what is left. No fixed total timeout anywhere in saving.
- A save or sync failure never stops or fails a run. The run's line says "Saved as version N" or
  "Will save when online".
- `method publish FILE --reason TEXT` uses the current file's version ID, finishes its upload, runs the gate, then
  marks it published. `--reason` is required for `--accept-failing-case` (fix the default-reason bug).

## 4. Production runs (the split)

- Service keys: `method keys create --name NAME` and the dashboard create organization keys
  (`mk_live_` + random); the server stores a hash; scopes `runs` and `worker`. Header `Authorization: Bearer KEY`.
  `METHOD_API_KEY` in the environment signs the CLI and the libraries in with that key.
- Runs API (service key):
  - `POST /v1/runs` `{method: METHOD_ID, version?: "published"|VERSION_ID, inputs, idempotency_key?, webhook_url?}` →
    `{run_id, version_id, status: "queued"}`. Default version: published. A run is pinned to one version.
  - `GET /v1/runs/:id` → status, timing, steps (metadata), and `result` only for `run_data: account`.
  - `POST /v1/runs/:id/cancel`.
- Worker API (service key with `worker` scope):
  - `POST /v1/worker/claim` `{worker_id, methods?: [METHOD_ID]}` long-polls up to 30 s →
    `{run_id, method_id, version_id, inputs, lease_ms}` or 204.
  - `POST /v1/worker/runs/:id/heartbeat` renews the lease (default 60 s; a run whose lease expires is queued again
    and resumes, reusing finished steps).
  - Run records sync through the existing `PUT /api/cli/runs/:id` path, accepting the service key.
  - `POST /v1/worker/runs/:id/complete` `{status, error?, result?}`; `result` is stored only for `run_data: account`.
- Results reach the app as: the library's return value (when the worker runs in the app's process and claimed the
  run), an `on_result` callback, or a webhook. Webhooks are signed: header `Method-Signature: t=TIMESTAMP,v1=HMAC`
  with the key's webhook secret. For device data the webhook carries only `{run_id, status}`, and the in-process
  library returns the result locally.
- The worker: `method worker [--method ID]...` in the CLI; `method.worker.start()` in the Node and Python libraries
  (Python uses the bundled CLI). It downloads the version package by ID, prepares dependencies once per version and
  caches them, reads declared secrets from the environment, and runs with the existing runtime.
- `ask` steps in production: the worker saves the run folder (`PUT /v1/worker/runs/:id/snapshot`), reports the question
  (`POST /v1/worker/runs/:id/wait`) and releases the lease; the run is `waiting`. The app answers (an `on_ask` handler or a
  `needs_input` webhook, `POST /v1/runs/:id/answer`), or the team answers in the inbox or through a one-time email link.
  The answer queues the run; a worker restores the folder if needed and resumes with `--human`. No default deadline; a
  step's `limits.timeout_ms` fails it. Device runs: client-sealed inputs, questions, answers, and folder (HKDF-SHA256 of
  the credential, AES-256-GCM).
- `method connect APP_FOLDER` makes the app's key, writes `.env`, publishes if needed, and prints the code.

## 5. Issues (the checker)

```ts
type Issue = {
  code: string;                       // e.g. "missing_secret", "script_calls_model", "unused_output"
  level: "error" | "warning" | "note";
  step?: string; field?: string; file?: string; line?: number;
  message: string;                    // what is wrong, one sentence
  fix: string;                        // what to do, one sentence
  evidence?: { probability?: number; check?: string; run_id?: string };
  accepted?: string;                  // the reason, when the step accepts this code
};
```

- The runtime exports `methodIssues(document, options) → Issue[]` for deterministic checks (existing format errors
  become level "error" issues with a fix; new code checks are listed below). `validateMethod` keeps throwing for
  errors (one implementation: it calls methodIssues and throws on the first error).
- Deterministic checks: format/references/types/cycles/prompts (error); service change without effect or reason
  (error); missing secret (error at run, warning in validate); a known secret value (exact match against values the
  caller passes in `options.secretValues`) in the document, a prompt, or an uploaded file (error; blocks upload, not
  the local run); classify result used by `when` or a changing step with no threshold step between (warning); agent
  that reads untrusted content (browser or web tools) and can also send or change things (warning); output that no
  step, result, or change uses (warning); agent step with no tools and no browser (note); check that repeats the
  output type (note).
- Deleted: `model_call_in_script` (host list, endpoint words, import list).
- Model checks (Jev yes/no through the account), run by the SDK in `validate` for steps whose text changed, cached by
  sha256 of (check version, step text, script text): `script_calls_model`, `prompt_multiple_tasks`,
  `check_enforces_wording`, `classify_needs_math`, `classify_no_unclear`, `prompt_no_missing_input`. Each starts in
  shadow mode: computed and recorded, not shown. A check is shown only after its precision on the frozen labeled set
  meets its level (warning ≥ 0.90, note ≥ 0.75). Shadow results are stored in `~/.cache/method/checks/` and sent with
  the version save for audits.
- Run-evidence checks after a run (warning): a script read an environment variable that is not a declared secret;
  wrote outside its folders. Shown on the dashboard and on the next validate.
- Output to the agent: `method validate` prints `issues` (errors first; at most 5 warnings, only on changed steps;
  notes only with `--notes`). `method publish` refuses errors and unaccepted warnings. An `accept` whose code no
  longer fires gives a note.
