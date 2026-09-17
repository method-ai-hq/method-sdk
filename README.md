# Method SDK

The JavaScript and Python SDKs and the full `method` CLI. Write a reusable procedure as YAML, run it locally, check its outputs, and inspect the saved evidence. Use the CLI to author Methods, save versions, and sync runs to the Method dashboard.

[Documentation](https://docs.withmethod.ai/sdk/overview) · [Quickstart](https://docs.withmethod.ai/guides/quickstart) · [CLI reference](docs/method-authoring.md) · [Issues](https://github.com/method-ai-hq/method-sdk/issues)

## Install a release

Node.js 22 or later is required. Downloads are hosted by Method; these commands do not use an npm or PyPI registry release.

```sh
npm install -g https://app.withmethod.ai/downloads/withmethod-sdk-latest.tgz
method --version
method authoring
```

Python 3.11 or later uses the same installed Node runtime:

```sh
pip install https://app.withmethod.ai/downloads/withmethod-0.4.1-py3-none-any.whl
withmethod authoring
```

See the [download manifest](https://app.withmethod.ai/downloads/manifest.json) for immutable versioned filenames and SHA-256 hashes. `SOURCE.json` records the source snapshot and package versions in this repo. Downloaded releases can have different package metadata from the current source checkout.

## Build from source

```sh
git clone https://github.com/method-ai-hq/method-sdk.git
cd method-sdk
npm ci
npm run build
npm test
npm run method -- --version
```

Tests run scripts and mocked model calls locally. They need no Method account or model API key. Use `PYTHON=python3.11 npm test` if `python3` is not Python 3.11 or later. The build and test commands support macOS and Linux.

To install the local build, run `npm run pack`, then `npm install -g ./dist/withmethod-sdk-0.5.7.tgz`. For Python development, run `python3 -m pip install -e ./packages/sdk-python` in a virtual environment after installing the Node SDK.

## Run a checked example

From the repo root after `npm ci`:

```sh
npm run method -- validate examples/checked-file.method
npm run method -- run examples/checked-file.method --config examples/runtime.json --inputs examples/inputs.json --run-dir runs/first
npm run method -- inspect runs/first
```

This example writes a text file and checks its contents. It uses no model credentials. See [the JavaScript guide](packages/sdk/README.md) and [the Python guide](packages/sdk-python/README.md) for API examples. Local validation and execution need no Method account. Saving versions and syncing runs require browser sign-in.

## Source layout

| Path | Contents |
| --- | --- |
| `packages/sdk/src` | JavaScript API, CLI, account client, authoring, inspection, sync, and compatibility support |
| `packages/sdk-python/src` | Python API and CLI bridge to the same Node runtime |
| `packages/workflow-language`, `packages/contracts`, `packages/compiler` | Shared SDK types, validation adapters, and migration support |
| `examples` | Small runnable script and website examples |
| `packages/sdk/examples/daily-briefing` | Public authoring example and sample data |
| `testkit` | SDK, compatibility, and Python tests |

The separate [method-spec](https://github.com/method-ai-hq/method-spec) repo defines the Method format, validator, and executor (`@withmethod/runtime`). This SDK pins that dependency to an exact commit. The standalone `method3` command from that repo is distinct from this SDK's full `method` command. The hosted application and service code are not part of this repo.

## Contribute

Open an issue or pull request here. This repo is a reviewed export from Method's development repo. Maintainers integrate accepted changes there and publish an updated export, so SDK source and hosted releases stay aligned. CI builds the packages and runs the tests on Node 22 and 24 with Python 3.11. No private repository access is needed to build, test, or use this code.

## License and execution

[MIT](LICENSE). The vendored Markdown parser keeps its own license in its example directory. Scripts and agents are trusted local processes. Review a Method and its helper files before running them. The Codex backend uses the existing local sign-in and disables its approval and sandbox prompts. Model checks can be wrong; inspect the run evidence.
