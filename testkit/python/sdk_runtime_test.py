"""Python runs the same current Method runtime."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages/sdk-python/src"))
from withmethod import load_method, MethodError

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

    def test_rejects_removed_execution(self):
        for format in ["method/2", "workflow/2"]:
            with self.assertRaisesRegex(MethodError, "UNSUPPORTED_FORMAT"):
                load_method({"format": format})

if __name__ == "__main__":
    unittest.main()
