# withmethod

MIT-licensed Python binding to the same installed Node Method runtime. Requires Python 3.11+ and the JavaScript SDK 0.8.0.

```sh
npm install -g https://github.com/method-ai-hq/method-sdk/releases/download/v0.8.0/withmethod-sdk-0.8.0.tgz
pip install https://github.com/method-ai-hq/method-sdk/releases/download/v0.8.0/withmethod-0.8.0-py3-none-any.whl
withmethod authoring
```

```python
from pathlib import Path
from withmethod import load_method, run_method
method = load_method(Path("task.method"))
result = run_method("task.method", {"allow_local_processes": True}, inputs={}, directory="runs/first")
print(result["status"])
```

Use method/3 or method/3.1. The old run_workflow callback API, workflow_corp package, and old command aliases are removed. Source and releases: https://github.com/method-ai-hq/method-sdk
