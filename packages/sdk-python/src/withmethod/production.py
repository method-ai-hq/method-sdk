"""Production runs from Python: run a published Method from an app, answer its questions, and verify webhooks.

`method.run(...)` starts a worker by itself on first use: the bundled CLI (`method worker`) in a child process. Each
finished run arrives from it as one JSON line, so a device run's result reaches this process only.

The credential: `api_key`, else METHOD_API_KEY (the environment, then .env in the current folder), else the CLI sign-in
of this computer (`method login`). A device run's inputs, questions, and answers are sealed with a key derived from
that credential (HKDF-SHA256, AES-256-GCM), so the server stores only ciphertext. The CLI seals them for this library.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Iterable

from .client import WorkflowError, runtime_command

Json = Any
DEFAULT_SERVER = "https://app.withmethod.ai"
TERMINAL = {"succeeded", "failed", "cancelled"}
CREDENTIAL = re.compile(r"^(mk_live_|method_)[A-Za-z0-9_-]{43}$")


class MethodApiError(WorkflowError):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code


def verify_webhook(body: bytes | str, signature: str | None, secret: str, tolerance_seconds: int = 300,
                   now: float | None = None) -> bool:
    """Method-Signature is t=TIMESTAMP,v1=HEX(HMAC-SHA256(secret, f"{t}.{body}")). Pass the raw request body."""
    if not signature:
        return False
    parts = dict(part.split("=", 1) for part in signature.split(",") if "=" in part)
    timestamp, sent = parts.get("t", ""), parts.get("v1", "")
    if not timestamp.isdigit() or len(sent) != 64:
        return False
    if abs((now if now is not None else time.time()) - int(timestamp)) > tolerance_seconds:
        return False
    text = body if isinstance(body, bytes) else body.encode("utf-8")
    expected = hmac.new(secret.encode("utf-8"), timestamp.encode("ascii") + b"." + text, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sent)


def dotenv_values(folder: str | Path | None = None) -> dict[str, str]:
    """METHOD_API_KEY and METHOD_SERVER from .env in a folder. Other lines are not read."""
    path = Path(folder or os.getcwd()) / ".env"
    found: dict[str, str] = {}
    if not path.is_file():
        return found
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^\s*(?:export\s+)?(METHOD_API_KEY|METHOD_SERVER)\s*=\s*(.*?)\s*$", line)
        if match:
            value = match.group(2)
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            found[match.group(1)] = value
    return found


def _signed_in_token(server: str) -> str | None:
    """The CLI sign-in of this computer for a server (the same file `method login` writes)."""
    root = Path(os.environ.get("METHOD_CONFIG_DIR") or Path.home() / ".config" / "method")
    path = root / (hashlib.sha256(server.encode("utf-8")).hexdigest()[:24] + ".json")
    try:
        saved = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    token = saved.get("token")
    return token if saved.get("server") == server and isinstance(token, str) and CREDENTIAL.match(token) else None


def resolve_credential(api_key: str | None = None, server: str | None = None) -> tuple[str, str]:
    dotenv = dotenv_values()
    origin = (server or os.environ.get("METHOD_SERVER") or dotenv.get("METHOD_SERVER") or DEFAULT_SERVER).rstrip("/")
    key = api_key or os.environ.get("METHOD_API_KEY") or dotenv.get("METHOD_API_KEY") or _signed_in_token(origin)
    if not key:
        raise WorkflowError("Set METHOD_API_KEY (run method connect APP_FOLDER to write it to the app's .env), or sign in on this computer with method login.")
    if not CREDENTIAL.match(key):
        raise WorkflowError("Use a Method service key (mk_live_...). Run method connect APP_FOLDER to make one, or method login on this computer.")
    return key, origin


class Question:
    """A question of an ask step. Return the answer from on_ask, or call answer() later."""

    def __init__(self, method: "Method", run_id: str, step: str, question: str, form: dict[str, Json]):
        self._method = method
        self.run_id, self.step, self.question, self.form = run_id, step, question, form

    def answer(self, value: dict[str, Json]) -> dict[str, Json]:
        return self._method.runs.answer(self.run_id, value)

    def __getitem__(self, name: str) -> Json:
        return {"run_id": self.run_id, "step": self.step, "question": self.question, "form": self.form}[name]

    def __repr__(self) -> str:
        return f"Question(run_id={self.run_id!r}, step={self.step!r}, question={self.question!r})"


AskHandler = Callable[[Question], "dict[str, Json] | None"]


class _Webhooks:
    verify = staticmethod(verify_webhook)


def _check_answer(form: dict[str, Json], value: Json) -> None:
    """The fields that the form requires, with their JSON types. The server checks plain answers fully."""
    if not isinstance(value, dict):
        raise MethodApiError(422, "invalid_answer", "The answer must be an object.")
    kinds = {"string": str, "number": (int, float), "boolean": bool, "array": list, "object": dict}
    for name in form.get("required", []):
        if name not in value:
            raise MethodApiError(422, "invalid_answer", f"answer.{name} is required.")
    for name, item in value.items():
        schema = (form.get("properties") or {}).get(name)
        if schema is None:
            if form.get("additionalProperties") is False:
                raise MethodApiError(422, "invalid_answer", f"answer.{name} is not a field of this answer.")
            continue
        kind = kinds.get(schema.get("type"))
        if kind and (not isinstance(item, kind) or (schema.get("type") == "number" and isinstance(item, bool))):
            raise MethodApiError(422, "invalid_answer", f"answer.{name} must be {schema.get('type')}.")


class _Runs:
    def __init__(self, method: "Method"):
        self._method = method

    def start(self, method: str, inputs: dict[str, Json] | None = None, *, version: str | None = None,
              idempotency_key: str | None = None, webhook_url: str | None = None,
              on_ask: AskHandler | None = None) -> dict[str, Json]:
        """Queue a run of the published version (or `version`). Returns {run_id, version_id, status}."""
        owner = self._method
        values = inputs or {}
        handler = on_ask or owner._on_ask

        def send(sealed: bool) -> dict[str, Json]:
            body: dict[str, Json] = {"method": method, "inputs": {} if sealed else values}
            if sealed:
                body["sealed_inputs"] = owner._run_data("seal", "inputs", method, values)
                body["inputs_digest"] = owner._run_data("digest", "inputs", method, values)
            if version:
                body["version"] = version
            if idempotency_key:
                body["idempotency_key"] = idempotency_key
            if webhook_url:
                body["webhook_url"] = webhook_url
            if handler:
                body["answered_by"] = "app"
            return owner._request("POST", "/v1/runs", body)

        try:
            started = send(bool(values) and owner._keeps_on_device(method))
        except MethodApiError as error:
            if error.code != "seal_inputs":
                raise
            owner._device[method] = (True, time.monotonic())
            started = send(True)
        if handler:
            owner._handlers[started["run_id"]] = handler
        return started

    def get(self, run_id: str) -> dict[str, Json]:
        return self._method._with_local(self._method._request("GET", f"/v1/runs/{run_id}"))

    def cancel(self, run_id: str) -> dict[str, Json]:
        return self._method._with_local(self._method._request("POST", f"/v1/runs/{run_id}/cancel", {}))

    def answer(self, run_id: str, answer: dict[str, Json]) -> dict[str, Json]:
        """Answer the waiting question of a run. The answer must match the question's form."""
        run = self.get(run_id)
        question = run.get("question")
        if run["status"] != "waiting" or not question:
            raise MethodApiError(409, "not_waiting", f"The run is {run['status']}; it has no question to answer.")
        opened = self._method._open_question(run)
        _check_answer(opened["form"], answer)
        body: dict[str, Json] = {"step": question["step"]}
        if question.get("sealed"):
            body["sealed_answer"] = self._method._run_data("seal", "answer", run["method_id"], answer)
        else:
            body["answer"] = answer
        return self._method._request("POST", f"/v1/runs/{run_id}/answer", body)

    def wait(self, run_id: str, timeout: float = 1800, interval: float = 2, on_ask: AskHandler | None = None) -> dict[str, Json]:
        """Wait until the run ends. A question of a run with an ask handler goes to the handler."""
        deadline = time.monotonic() + timeout
        while True:
            run = self.get(run_id)
            if run["status"] in TERMINAL:
                self._method._handlers.pop(run_id, None)
                return run
            if run["status"] == "waiting" and run.get("question"):
                self._method._ask(run, on_ask)
            if time.monotonic() > deadline:
                raise MethodApiError(408, "wait_timeout", f"The run is still {run['status']}.")
            with self._method._finished:
                self._method._finished.wait_for(lambda: run_id in self._method._local, timeout=min(interval, max(0, deadline - time.monotonic())))

    def run(self, method: str, inputs: dict[str, Json] | None = None, *, timeout: float = 1800, interval: float = 2,
            **options: Any) -> dict[str, Json]:
        """Start a run and wait for its result. Needs a worker: method.run() starts one in this process."""
        return self.wait(self.start(method, inputs, **options)["run_id"], timeout=timeout, interval=interval)


class Worker:
    """`method worker` in a child process. stop() lets the current runs finish; stop(cancel=True) stops them too."""

    def __init__(self, method: "Method", methods: Iterable[str] | None, concurrency: int,
                 on_result: Callable[[dict[str, Json]], Any] | None, grow: bool = False):
        command = runtime_command("cli") + ["worker", "--server", method.server, "--concurrency", str(concurrency)]
        for item in methods or []:
            command += ["--method", item]
        if grow:
            command.append("--methods-from-stdin")
        env = dict(os.environ)
        # A service key goes to the child. The CLI sign-in reaches it through its saved file.
        if method.api_key.startswith("mk_live_"):
            env["METHOD_API_KEY"] = method.api_key
        self._process = subprocess.Popen(command, stdout=subprocess.PIPE, stdin=subprocess.PIPE if grow else subprocess.DEVNULL,
                                         stderr=None, text=True, encoding="utf-8", env=env, start_new_session=True)
        self._method, self._on_result = method, on_result
        self._thread = threading.Thread(target=self._read, name="method-worker", daemon=True)
        self._thread.start()

    def add_method(self, method_id: str) -> None:
        """Claim runs of one more Method (a worker that method.run() started)."""
        if self._process.stdin and self.running:
            self._process.stdin.write(method_id + "\n")
            self._process.stdin.flush()

    def _read(self) -> None:
        assert self._process.stdout is not None
        for line in self._process.stdout:
            try:
                result = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(result, dict) or "run_id" not in result:
                continue
            if result.get("status") == "waiting":
                with self._method._finished:
                    self._method._finished.notify_all()
                continue
            with self._method._finished:
                self._method._local[result["run_id"]] = result
                self._method._finished.notify_all()
            if self._on_result:
                try:
                    self._on_result(result)
                except Exception as error:  # A callback error must not stop the worker.
                    print(f"Method worker on_result failed: {error}", flush=True)

    @property
    def running(self) -> bool:
        return self._process.poll() is None

    def stop(self, cancel: bool = False, timeout: float | None = None) -> int:
        if self.running:
            self._process.send_signal(signal.SIGINT)
            if cancel:
                time.sleep(0.2)
                self._process.send_signal(signal.SIGINT)
        code = self._process.wait(timeout=timeout)
        self._thread.join(timeout=5)
        return code


class _WorkerFactory:
    def __init__(self, method: "Method"):
        self._method = method

    def start(self, methods: Iterable[str] | None = None, concurrency: int = 1,
              on_result: Callable[[dict[str, Json]], Any] | None = None) -> Worker:
        """A separate worker in a child process. method.run() starts one by itself; use this for more control."""
        return Worker(self._method, methods, concurrency, on_result)


class Method:
    """The production runs client.

    `api_key` defaults to METHOD_API_KEY (the environment, then .env), then the CLI sign-in; `server` to METHOD_SERVER.
    `on_ask` answers the questions of ask steps in runs that this process starts. `worker=False`: method.run() does not
    start a worker in this process.
    """
    webhooks = _Webhooks()

    def __init__(self, api_key: str | None = None, server: str | None = None, *, on_ask: AskHandler | None = None,
                 worker: bool = True):
        self.api_key, self.server = resolve_credential(api_key, server)
        self._on_ask, self._lazy = on_ask, worker
        self._local: dict[str, dict[str, Json]] = {}
        self._finished = threading.Condition()
        self._handlers: dict[str, AskHandler] = {}
        self._asked: set[str] = set()
        self._device: dict[str, tuple[bool, float]] = {}
        self._worker: Worker | None = None
        self._worker_methods: set[str] = set()
        self._lock = threading.Lock()
        self.runs = _Runs(self)
        self.worker = _WorkerFactory(self)

    def run(self, method: str, inputs: dict[str, Json] | None = None, *, on_ask: AskHandler | None = None,
            idempotency_key: str | None = None, webhook_url: str | None = None, version: str | None = None,
            timeout: float = 1800, interval: float = 2) -> dict[str, Json]:
        """Run a published Method and wait for its result. The first call starts a worker in a child process."""
        self._ensure_worker(method)
        return self.runs.run(method, inputs, timeout=timeout, interval=interval, on_ask=on_ask,
                             idempotency_key=idempotency_key, webhook_url=webhook_url, version=version)

    def close(self, cancel: bool = False) -> None:
        """Stop the worker that method.run() started. Runs in progress finish first."""
        with self._lock:
            worker, self._worker = self._worker, None
        if worker:
            worker.stop(cancel=cancel, timeout=60)

    def _ensure_worker(self, method: str) -> None:
        if not self._lazy:
            return
        with self._lock:
            if self._worker and self._worker.running:
                if method not in self._worker_methods:
                    self._worker_methods.add(method)
                    self._worker.add_method(method)
                return
            self._worker_methods.add(method)
            self._worker = Worker(self, sorted(self._worker_methods), 1, None, grow=True)

    def _keeps_on_device(self, method: str) -> bool:
        known = self._device.get(method)
        if known and time.monotonic() - known[1] < 300:
            return known[0]
        try:
            found = self._request("GET", f"/v1/methods/{method}")
        except MethodApiError:
            return False  # The server refuses plain inputs of a device run (seal_inputs); start seals them then.
        device = found.get("run_data") == "device"
        self._device[method] = (device, time.monotonic())
        return device

    def _run_data(self, action: str, kind: str, method_id: str, value: Json) -> Json:
        """Seal, open, or digest run content with the bundled CLI (AES-256-GCM is not in the Python standard library)."""
        result = subprocess.run(runtime_command("cli") + ["__run-data", action, kind, method_id],
                                input=value if action == "open" else json.dumps(value), capture_output=True, text=True,
                                encoding="utf-8", env={**os.environ, "METHOD_API_KEY": self.api_key}, timeout=60)
        if result.returncode != 0:
            message = (result.stderr or "").strip().splitlines()[-1:] or ["The run content could not be sealed."]
            raise MethodApiError(0, "wrong_key" if "another key" in message[0] else "run_data_failed", message[0])
        return json.loads(result.stdout)

    def _open_question(self, run: dict[str, Json]) -> dict[str, Json]:
        question = run["question"]
        if question.get("sealed"):
            return self._run_data("open", "question", run["method_id"], question["sealed"])
        return {"question": question.get("question", ""), "form": question.get("form") or {}}

    def _ask(self, run: dict[str, Json], override: AskHandler | None) -> None:
        handler = override or self._handlers.get(run["run_id"])
        question = run["question"]
        asked = f"{question['id']}:{question['asked_at']}"
        if not handler or asked in self._asked:
            return
        self._asked.add(asked)
        opened = self._open_question(run)
        value = handler(Question(self, run["run_id"], question["step"], opened["question"], opened["form"]))
        if isinstance(value, dict):
            self.runs.answer(run["run_id"], value)

    def _request(self, method: str, path: str, body: Json = None) -> dict[str, Json]:
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(self.server + path, data=data, method=method, headers={
            "authorization": f"Bearer {self.api_key}", **({"content-type": "application/json"} if data is not None else {})})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read() or b"null")
        except urllib.error.HTTPError as error:
            try:
                parsed = json.loads(error.read())
            except ValueError:
                parsed = {}
            raise MethodApiError(error.code, str(parsed.get("code", "request_failed")),
                                 f"{error.code}: {parsed.get('message', 'Method request failed')}") from None

    def _with_local(self, run: dict[str, Json]) -> dict[str, Json]:
        local = self._local.get(run.get("run_id", ""))
        if local and "result" in local and "result" not in run:
            return {**run, "result": local["result"]}
        return run
