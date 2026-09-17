# Release changes

## SDK 0.7.0 / Python 0.5.0 / runtime 0.5.0

The public SDK repo is now the source of record and owns package releases. The application installs a pinned package.

Removed the Method 2 executor, Codex executor/verifier classes, Python execution callbacks, old run recovery reader, and old CLI options (`--host`, `--legacy`, `--resources`, `--state-dir`, `--concurrency`, `--timeout-ms`, `--model`, `--verifier-model`, `--recoveries`). Current runtime configuration controls models and limits.

Removed old command aliases and the `workflow_corp` Python module. The runtime package installs no executable command. Use `method` from this SDK.

Use `runMethod(file, config, options)` in JavaScript and `run_method(file, config, ...)` in Python. `runWorkflow` and `run_workflow` no longer exist. Old-format files are rejected before execution. No compatibility executor is retained.
