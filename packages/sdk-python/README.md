# Method Python SDK

Python 3.11+ uses the same Method runtime and CLI as JavaScript. Install Node.js 22+ and the JavaScript SDK first. The wheel uses a local Node bridge; it is not a separate executor. Packages are served from Method downloads, not a claimed PyPI release.

```sh
npm install -g https://app.withmethod.ai/downloads/withmethod-sdk-latest.tgz
pip install https://app.withmethod.ai/downloads/withmethod-0.4.1-py3-none-any.whl
withmethod authoring
```

```python
import json
from pathlib import Path
from withmethod import load_method, run_method

method = load_method(Path("task.method"))
config = json.loads(Path("runtime.json").read_text())
result = run_method("task.method", config, inputs={"text": "Hello\n"}, directory="runs/example")
print(result["status"])
```

Use `resume=True` with the same directory to continue accepted work. Supply `retry=["STEP:ITERATION"]` only after inspecting an unfinished action. Use `state=` for a new run's initial state and `human=` for actual answers to ask steps. Model access and limits come from operator configuration.

The earlier `run_workflow` callback API remains available for saved older methods. Read the [SDK guide](https://docs.withmethod.ai/sdk/overview) and `method authoring all` for current execution and compatibility.
