# @withmethod/sdk

MIT-licensed JavaScript API and the `method` CLI. Source and releases: https://github.com/method-ai-hq/method-sdk

```sh
npm install https://github.com/method-ai-hq/method-sdk/releases/download/v0.14.0/withmethod-sdk-0.14.0.tgz
npx method --version
```

```js
import {readFileSync} from 'node:fs';
import {loadMethod, runMethod, inspectRun} from '@withmethod/sdk';
const method = loadMethod(readFileSync('task.method', 'utf8'));
const result = await runMethod('task.method', {allow_local_processes: true}, {inputs: {}, runDir: 'runs/first'});
console.log(result.status, inspectRun('runs/first'));
```

New Methods use method/3.4: models, limits, tools, secret names, and the Method ID are in the Method file. Documents in method/3.1 to 3.3 load and run unchanged. `runMethod` is the bare runtime: it does not sign in, save versions, or use hosted models; `method run` does. The executor is the pinned @withmethod/runtime dependency. Python uses method-bridge to call the same runtime.

To run a published Method from an app, use `new Method().run({method: 'wf_…', inputs})`. See https://docs.withmethod.ai/guides/production.

Browser-safe document modules are available at `@withmethod/sdk/schema`, `/validate`, `/execution`, `/inspection`, and `/result-files`. Node tools use `/identity`, `/method-package`, `/method-client`, `/method-sync`, and `/process`. Do not import the Node package root into a browser bundle.

Before creating, editing, or proposing a Method, run `method authoring` and read its guidance. Do this before choosing an existing Method as a reference. The package includes reviewed examples. Saving versions, hosted models, and production runs need a Method account; local validation and script runs do not.
