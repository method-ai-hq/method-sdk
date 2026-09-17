"""Python binding to the public Method runtime."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
from typing import Any, Callable

Json = Any
Callback = Callable[[dict[str, Json]], Json]


class WorkflowError(RuntimeError):
    """A workflow validation, runtime, or host connection error."""


def runtime_command(entry: str = "bridge") -> list[str]:
    override = os.environ.get("METHOD_BRIDGE" if entry == "bridge" else "METHOD_CLI")
    if override:
        return [override]
    # Development checkout uses the source runtime, so tests cannot pass against an old build.
    project = Path(__file__).resolve().parents[4]
    source = project / "packages" / "sdk" / "src" / f"{entry}.ts"
    loader = project / "node_modules" / "tsx" / "dist" / "loader.mjs"
    if source.is_file() and loader.is_file():
        return ["node", "--import", str(loader), str(source)]
    installed = shutil.which("method-bridge" if entry == "bridge" else "method")
    if installed:
        return [installed]
    raise WorkflowError("Install Node.js 22+ and @withmethod/sdk, or set METHOD_BRIDGE to the installed method-bridge executable.")


def _call(payload: dict[str, Json], on_event: Callback | None = None) -> Json:
    process = subprocess.Popen(runtime_command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=None, text=True, encoding="utf-8", bufsize=1)
    assert process.stdin is not None and process.stdout is not None
    try:
        process.stdin.write(json.dumps(payload, allow_nan=False) + "\n")
        process.stdin.flush()
        for line in process.stdout:
            response = json.loads(line)
            if response["type"] == "result":
                return response["result"]
            if response["type"] == "error":
                raise WorkflowError(response["error"])
            if response["type"] == "event" and on_event:
                on_event(response["event"])
        raise WorkflowError(f"The runtime exited without a result (status {process.wait()}).")
    finally:
        process.stdin.close()
        process.stdout.close()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=5)


def load_workflow(value: dict[str, Json] | str | Path) -> dict[str, Json]:
    """Load and validate Method YAML, data shapes, and named references."""
    if isinstance(value, Path):
        value = value.read_text(encoding="utf-8")
    return _call({"op": "load", "workflow": value})


def render_prompt(workflow: dict[str, Json]) -> str:
    return _call({"op": "prompt", "workflow": workflow})


def run_method(file: str | Path, config: dict[str, Json], *, inputs: dict[str, Json] | None = None,
               state: dict[str, Json] | None = None, directory: str | Path | None = None,
               resume: bool = False, retry: list[str] | None = None,
               human: dict[str, Json] | None = None, on_event: Callback | None = None) -> dict[str, Json]:
    """Run scripts, model calls, and bounded agents with the shared Method runtime."""
    options = {"inputs": inputs, "state": state, "runDir": str(Path(directory).resolve()) if directory else None,
               "resume": resume, "retry": retry or [], "human": human}
    return _call({"op": "run_method", "file": str(Path(file).resolve()), "config": config,
                  "options": {key: value for key, value in options.items() if value is not None}}, on_event=on_event)
