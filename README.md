# Method SDK

The canonical source for the JavaScript SDK, Python binding, and `method` CLI. Both packages are MIT licensed. Changes and releases are made in this public repository.

`@withmethod/runtime` owns the Method schema, validator, and executor in [method-spec](https://github.com/method-ai-hq/method-spec). This SDK pins one runtime commit and adds authoring, local setup, account access, saved versions, and run uploads. Python calls the same Node runtime.

## Install

```sh
npm install -g https://github.com/method-ai-hq/method-sdk/releases/download/v0.10.5/withmethod-sdk-0.10.5.tgz
method --version
```

Node.js 22 or later is required. Python 3.11 or later uses the installed Node package:

```sh
pip install https://github.com/method-ai-hq/method-sdk/releases/download/v0.10.5/withmethod-0.10.5-py3-none-any.whl
withmethod authoring
```

See [product docs](https://docs.withmethod.ai), the [CLI guide](docs/method-authoring.md), and [release changes](CHANGELOG.md).

## Build and test

```sh
npm ci
npm run build
npm test
npm run pack
```

Tests use local scripts and mocked providers. They do not need a Method account or paid model calls. Use `PYTHON=python3.11 npm test` when needed.

## Ownership and release

`packages/sdk` owns the JavaScript API and CLI. `packages/sdk-python` owns the Python binding. Shared public modules live under `packages/workflow-language`, `packages/contracts`, and `packages/method-document`; the SDK publishes explicit package exports for them. The private application consumes released packages and does not keep another SDK source copy.

The Release workflow builds the npm archive, Python wheel, and four self-contained CLI distributions. It publishes them with SHA-256 hashes in `manifest.json`. The private application can mirror those exact artifacts. It does not rebuild them.

## Breaking changes in 0.7

Methods use `format: method/3.1`. The SDK uses one current runtime.

Use `method`. The `workflow`, `sdk`, `method-run`, and `workflow-bridge` aliases are removed. Python keeps `withmethod`; `workflow-corp`, `method-python`, and the `workflow_corp` module are removed. `method-bridge` is the machine interface for Python.

JavaScript and Python use the same release version from 0.8 onward. Each versioned archive is immutable. Release builds start with clean staging, use a fixed wheel timestamp, and reject changed hashes for previously published filenames.
