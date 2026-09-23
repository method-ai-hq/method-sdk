# @withmethod/sdk

MIT-licensed JavaScript API and the `method` CLI. Source and releases: https://github.com/method-ai-hq/method-sdk

```sh
npm install https://github.com/method-ai-hq/method-sdk/releases/download/v0.11.4/withmethod-sdk-0.11.4.tgz
npx method --version
```

```js
import {readFileSync} from 'node:fs';
import {loadMethod, runMethod, inspectRun} from '@withmethod/sdk';
const method = loadMethod(readFileSync('task.method', 'utf8'));
const result = await runMethod('task.method', {allow_local_processes: true}, {inputs: {}, runDir: 'runs/first'});
console.log(result.status, inspectRun('runs/first'));
```

New Methods use method/3.2; existing method/3.1 documents remain supported. The executor is the pinned @withmethod/runtime dependency. Python uses method-bridge to call the same runtime.

Browser-safe document modules are available at `@withmethod/sdk/schema`, `/validate`, `/execution`, `/inspection`, and `/result-files`. Node tools use `/identity`, `/method-package`, `/method-client`, `/method-sync`, and `/process`. Do not import the Node package root into a browser bundle.

Before creating, editing, or proposing a Method, run `method authoring` and read its guidance. Do this before choosing an existing Method as a reference. The package includes reviewed examples. Saving and syncing need a Method account; local validation and execution do not.
