# withmethod

MIT-licensed Python binding to the same installed Node Method runtime. Requires Python 3.11+ and the JavaScript SDK 0.11.3.

```sh
npm install -g https://github.com/method-ai-hq/method-sdk/releases/download/v0.11.3/withmethod-sdk-0.11.3.tgz
pip install https://github.com/method-ai-hq/method-sdk/releases/download/v0.11.3/withmethod-0.11.3-py3-none-any.whl
withmethod authoring
```

```python
from pathlib import Path
from withmethod import load_method, run_method
method = load_method(Path("task.method"))
result = run_method("task.method", {"allow_local_processes": True}, inputs={}, directory="runs/first")
print(result["status"])
```

Use method/3.2 for new Methods. Python calls the executor through the method-bridge command. Source and releases: https://github.com/method-ai-hq/method-sdk
