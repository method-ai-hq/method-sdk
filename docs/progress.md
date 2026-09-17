# Progress from a running Method

The executor sends step and tool events to the dashboard. Native Codex steps also forward public assistant updates, command start/end events, and supported tool events as they arrive. Reasoning, tool arguments, command text, and tool output are not forwarded as progress. The original local process log and final result are kept.

The CLI combines event bursts into a snapshot about once per second. It also sends a heartbeat every five seconds during quiet work. The open run page polls every three seconds. An event should normally appear within about five seconds, plus network time. This is not a guarantee that the work produces a new message every five seconds. A quiet agent may produce no public message for longer. The page shows elapsed time and the age of the last received update. After a minute without an upload it says the run may still be working on the local computer. It does not mark that work as failed.

## Scripts

Keep stdout for the script's final JSON result. Method supplies `METHOD_PROGRESS_FD`, a separate writable pipe, to each script and tool. Write one JSON object per line to that descriptor. No authentication token is needed.

```python
import json, os

def progress(message, completed=None, total=None, unit=None):
    fd = os.environ.get('METHOD_PROGRESS_FD')
    if fd is None:
        return
    update = {'message': message}
    if completed is not None and total is not None:
        update.update(completed=completed, total=total)
    if unit:
        update['unit'] = unit
    try:
        os.write(int(fd), (json.dumps(update) + '\n').encode())
    except (BrokenPipeError, OSError):
        pass

progress('Rendered 12 of 40 pages', 12, 40, 'pages')
print(json.dumps({'result': 'Final output'}))
```

Node scripts can import `reportProgress` from `@withmethod/sdk`. A shell can use `method progress --message 'Rendered 12 of 40 pages' --completed 12 --total 40 --unit pages`.

Report real milestones or measured counts, and combine rapid updates at the producer. Use a short public sentence, not raw source contents or secrets. The executor adds the time, sequence, step, iteration, and phase. A message cannot override those fields. Counts must be nonnegative integers with `completed <= total` and `total > 0`. Text is limited to 1,000 characters, a child label to 100, and the unit to 50. Lines over 16 KB, malformed JSON, and bytes after the first 1 MB of progress per process are ignored. The result channel and exit status still work. Existing scripts need no changes if they do not report progress.

## Agents started by a script

A script can start another agent and relay its public updates. It must keep the child's stdout separate from its own final JSON. In Node, with the SDK installed as a dependency:

```js
import { spawn } from 'node:child_process';
import { relayCodexProgress } from '@withmethod/sdk';
const child = spawn('codex', ['exec', '--json', '--output-last-message', 'result.json', 'Do the requested work.'], {
  stdio: ['ignore', 'pipe', 'inherit'], env: process.env
});
const exited = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', code => code === 0 ? resolve() : reject(Error(`Agent exited ${code}`)));
});
await Promise.all([relayCodexProgress(child.stdout, 'Writer'), exited]);
// Read and validate result.json, then print the script's one final JSON object.
```

The wrapper labels these messages “Writer.” The same allowlist as native Codex applies. With a shell, use `set -o pipefail` and `codex exec --json ... | method progress --codex --child Writer`; check the pipeline status and read the final output from a file. With Python `subprocess`, descriptors are closed by default: pass `pass_fds=(int(os.environ['METHOD_PROGRESS_FD']),)` to the relay process. Pass the descriptor explicitly when a child script itself writes progress. A child agent whose public output is neither relayed nor written to the pipe remains unobservable except for the parent script's updates.

Supply any tool paths and authentication environment through the existing runtime configuration. Never send credentials as progress. Use the native `kind: agent` step when Method can call that agent directly.

## Results and readable names

Use `reading.output_name` for a short, honest name for a step's returned result, such as “Research brief” or “Input records.” This labels the result button and panel; it does not rename output keys or change execution. Use `reading.outputs` to explain what the result contains. Follow `docs/result-files.md` to attach an actual website, rather than calling an arbitrary JSON file an openable website.

## Existing runs

New executor events improve new and resumed runs. They do not reconstruct missing tool names, source passages, or progress for completed historical runs. Use `method sync RUN_DIRECTORY` to retry a failed upload without executing the steps again. A paused run page continues to refresh so it can detect a resumed executor.
