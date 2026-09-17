"""One workflow format and one interpreter, with Python execution and review callbacks."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
from typing import Any, Callable
from concurrent.futures import ThreadPoolExecutor
from threading import Lock

Json = Any
Callback = Callable[[dict[str, Json]], Json]


class WorkflowError(RuntimeError):
    """A workflow validation, runtime, or host connection error."""


def runtime_command(entry: str = "bridge") -> list[str]:
    override = os.environ.get("METHOD_BRIDGE" if entry == "bridge" else "METHOD_CLI") or os.environ.get("WORKFLOW_CORP_BRIDGE" if entry == "bridge" else "WORKFLOW_CORP_CLI")
    if override:
        return [override]
    # Development checkout uses the source runtime, so tests cannot pass against an old build.
    project = Path(__file__).resolve().parents[4]
    source = project / "packages" / "sdk" / "src" / f"{entry}.ts"
    loader = project / "node_modules" / "tsx" / "dist" / "loader.mjs"
    if source.is_file() and loader.is_file():
        return ["node", "--import", str(loader), str(source)]
    installed = shutil.which("method-bridge" if entry == "bridge" else "method" if entry == "method" else "method-run") or shutil.which("workflow-bridge" if entry == "bridge" else "workflow")
    if installed:
        return [installed]
    raise WorkflowError("Install Node.js 22+ and @withmethod/sdk, or set METHOD_BRIDGE to the installed method-bridge executable.")


def _call(payload: dict[str, Json], callbacks: dict[str, Callback] | None = None,
          on_event: Callback | None = None, on_progress: Callback | None = None) -> Json:
    process = subprocess.Popen(runtime_command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=None, text=True, encoding="utf-8", bufsize=1)
    assert process.stdin is not None and process.stdout is not None
    callbacks = callbacks or {}
    concurrency = payload.get("concurrency", 4)
    concurrency = concurrency if isinstance(concurrency, int) and 1 <= concurrency <= 32 else 1
    pool = ThreadPoolExecutor(max_workers=concurrency)
    write_lock = Lock()

    def answer_request(response: dict[str, Json]) -> None:
        try:
            callback = callbacks.get(response["method"])
            if callback is None:
                raise WorkflowError(f"Missing host callback: {response['method']}")
            result = callback(response["payload"])
            encoded = json.dumps({"id": response["id"], "result": result}, allow_nan=False)
        except Exception as error:
            encoded = json.dumps({"id": response["id"], "error": str(error)})
        with write_lock:
            process.stdin.write(encoded + "\n")
            process.stdin.flush()

    try:
        process.stdin.write(json.dumps(payload, allow_nan=False) + "\n")
        process.stdin.flush()
        for line in process.stdout:
            response = json.loads(line)
            kind = response["type"]
            if kind == "result":
                return response["result"]
            if kind == "error":
                raise WorkflowError(response["error"])
            if kind == "event" and on_event:
                on_event(response["event"])
            elif kind == "progress" and on_progress:
                on_progress({"stage": response["stage"], "value": response["value"]})
            elif kind == "request":
                pool.submit(answer_request, response)
        raise WorkflowError(f"The runtime exited without a result (status {process.wait()}).")
    finally:
        pool.shutdown(wait=True)
        process.stdin.close()
        process.stdout.close()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def load_workflow(value: dict[str, Json] | str | Path) -> dict[str, Json]:
    """Load and validate Method YAML, including saved older formats, data shapes, and named references."""
    if isinstance(value, Path):
        value = value.read_text(encoding="utf-8")
    return _call({"op": "load", "workflow": value})


def render_prompt(workflow: dict[str, Json]) -> str:
    return _call({"op": "prompt", "workflow": workflow})


def run_workflow(workflow: dict[str, Json], *, inputs: dict[str, Json], directory: str | Path,
                 workspace: str | Path, resources: dict[str, Json] | None = None,
                 executor: Callback | None = None, verifier: Callback | None = None,
                 executor_name: str = "python-host", verifier_name: str = "python-review",
                 model: str | None = None, verifier_model: str | None = None,
                 state_directory: str | Path | None = None, concurrency: int = 4, timeout_ms: int = 300000, resume: bool = False,
                 human_execute: Callback | None = None,
                 recoveries: dict[str, Json] | None = None, retry_invocations: list[str] | None = None,
                 runtime_revision: str = "workflow-sdk/2",
                 on_event: Callback | None = None) -> dict[str, Json]:
    """Run the same durable runtime as TypeScript. Optional callbacks execute in this Python process.

    Executor callbacks receive the complete request, including timeout_ms.
    A callback must stop its tools before it raises. Unknown writes are never repeated by the SDK.
    """
    payload = {"op": "run", "workflow": workflow, "inputs": inputs, "directory": str(Path(directory).resolve()),
               "workspace": str(Path(workspace).resolve()), "resources": resources or {}, "concurrency": concurrency, "timeout_ms": timeout_ms,
               "resume": resume, "recoveries": recoveries or {}, "retry_invocations": retry_invocations or [],
               "runtime_revision": runtime_revision}
    if state_directory is not None:
        payload["state_directory"] = str(Path(state_directory).resolve())
    callbacks = {}
    for name, callback, identity in [("executor", executor, executor_name), ("verifier", verifier, verifier_name)]:
        if callback is not None:
            payload[name] = identity
            callbacks["execute" if name == "executor" else "verify"] = callback
    if model is not None:
        payload["model"] = model
    if verifier_model is not None:
        payload["verifier_model"] = verifier_model
    if human_execute is not None:
        payload["human"] = True
        callbacks["human_execute"] = human_execute or (lambda request: None)
    return _call(payload, callbacks, on_event=on_event)


def run_method(file: str | Path, config: dict[str, Json], *, inputs: dict[str, Json] | None = None,
               state: dict[str, Json] | None = None, directory: str | Path | None = None,
               resume: bool = False, retry: list[str] | None = None,
               human: dict[str, Json] | None = None, on_event: Callback | None = None) -> dict[str, Json]:
    """Run scripts, model calls, and bounded agents with the shared Method runtime."""
    options = {"inputs": inputs, "state": state, "runDir": str(Path(directory).resolve()) if directory else None,
               "resume": resume, "retry": retry or [], "human": human}
    return _call({"op": "run_method", "file": str(Path(file).resolve()), "config": config,
                  "options": {key: value for key, value in options.items() if value is not None}}, on_event=on_event)
