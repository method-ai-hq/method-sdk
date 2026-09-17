"""Python uses the same workflow/2 execution and recovery rules."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages/sdk-python/src"))
from workflow_corp import load_workflow, run_workflow, WorkflowError

def workflow():
    return {"format":"workflow/2","name":"Count","goal":"Preserve count", "inputs":{"count":{"type":"number","description":"Count"}}, "steps":{"copy":{"in":{"count":"inputs.count"},"do":"Return count as copied", "out":{"copied":{"type":"number","description":"Copied count"}},"check":{"equals":{"actual":"copied","expected":"count"}}}},"result":"copied"}

class PythonRuntimeTest(unittest.TestCase):
    def test_current_method_uses_shared_runtime_and_completed_resume(self):
        from withmethod import load_method, run_method
        config = json.loads((ROOT / "examples/runtime.json").read_text())
        file = ROOT / "examples/checked-file.method"
        self.assertEqual(load_method(file)["format"], "method/3.1")
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory) / "run"
            result = run_method(file, config, inputs={"text": "Python current Method\n"}, directory=run_dir)
            self.assertEqual(result["status"], "completed")
            resumed = run_method(file, config, directory=run_dir, resume=True)
            self.assertEqual(resumed, result)
            self.assertEqual((run_dir / "artifacts/message.txt").read_text(), "Python current Method\n")

    def test_load(self):
        self.assertEqual(load_workflow(json.dumps(workflow()))["format"], "workflow/2")
        bad=workflow(); bad["steps"]["copy"]["in"]["count"]="missing"
        with self.assertRaises(WorkflowError): load_workflow(bad)

    def test_callbacks_and_resume(self):
        calls=[]
        def execute(request):
            calls.append(request)
            return {"outputs":{"copied":request["inputs"]["count"]}}
        with tempfile.TemporaryDirectory() as directory:
            args=dict(inputs={"count":2},directory=directory,workspace=directory,executor=execute)
            self.assertEqual(run_workflow(workflow(),**args)["outputs"],{"result":2})
            self.assertEqual(run_workflow(workflow(),resume=True,**args)["status"],"succeeded")
            self.assertEqual(len(calls),1)
            self.assertEqual(run_workflow(workflow(),resume=True,**{**args,"inputs":{"count":3}})["status"],"failed")

    def test_parallel_callbacks(self):
        flow=workflow(); flow["steps"]["other"]={"do":"Return another value", "out":{"other_value":{"type":"number","description":"Other count"}}}
        barrier=threading.Barrier(2,timeout=5)
        def execute(request):
            barrier.wait()
            return {"outputs":{"copied" if request["step"]["id"]=="copy" else "other_value":2}}
        with tempfile.TemporaryDirectory() as directory:
            result=run_workflow(flow,inputs={"count":2},directory=directory,workspace=directory,executor=execute,concurrency=2)
        self.assertEqual(result["status"],"succeeded",result)

    def test_human_pause(self):
        flow=workflow(); del flow["steps"]["copy"]["do"]; flow["steps"]["copy"]["ask"]="Ask for the count"
        with tempfile.TemporaryDirectory() as directory:
            args=dict(inputs={"count":2},directory=directory,workspace=directory)
            self.assertEqual(run_workflow(flow,**args)["status"],"needs_attention")
            result=run_workflow(flow,resume=True,human_execute=lambda r:{"outputs":{"copied":2}},**args)
            self.assertEqual(result["status"],"succeeded")
