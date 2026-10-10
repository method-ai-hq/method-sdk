"""Python production runs with ask steps: on_ask, the worker that method.run() starts, sealed device runs, and sign-in."""
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages/sdk-python/src"))
from withmethod import Method, MethodApiError  # noqa: E402

KEY = "mk_live_" + "Q" * 43
TOKEN = "method_" + "T" * 43
FORM = {"type": "object", "properties": {"approved": {"type": "boolean"}}, "required": ["approved"], "additionalProperties": False}
STATE: dict = {"runs": {}, "bodies": [], "device": False, "credential": KEY}


class Api(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        assert self.headers["authorization"] == f"Bearer {STATE['credential']}", self.headers["authorization"]
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        STATE["bodies"].append(body)
        runs = STATE["runs"]
        if self.path == "/v1/runs":
            if STATE["device"] and body["inputs"]:
                return self.reply(409, {"code": "seal_inputs", "message": "Seal the inputs."})
            run_id = f"run-{len(runs) + 1}"
            runs[run_id] = {"run_id": run_id, "method_id": body["method"], "status": "queued", "run_data": "device" if STATE["device"] else "account",
                            "request": body, "answer": None}
            return self.reply(201, {"run_id": run_id, "version_id": "v_1", "status": "queued"})
        parts = self.path.split("/")
        run = runs.get(parts[-2]) if len(parts) > 2 else None
        if run and self.path.endswith("/wait"):
            run.update(status="waiting", question={"id": "q-" + run["run_id"], "run_id": run["run_id"], "step": body["step"], "answered_by": "app",
                                                   "asked_at": "2026-10-09T10:00:00Z", "expires_at": "2026-10-16T10:00:00Z",
                                                   **({"sealed": body["sealed_question"]} if "sealed_question" in body else {"question": body["question"], "form": body["form"]})})
            return self.reply(200, run)
        if run and self.path.endswith("/complete"):
            run.update(status=body["status"])
            return self.reply(200, run)
        if run and self.path.endswith("/answer"):
            run.update(status="queued", answer=body, question=None)
            return self.reply(200, run)
        self.reply(404, {"message": "Not found."})

    def do_GET(self):
        assert self.headers["authorization"] == f"Bearer {STATE['credential']}"
        if self.path.startswith("/v1/methods/"):
            return self.reply(200, {"method_id": self.path.split("/")[-1], "run_data": "device" if STATE["device"] else "account", "published_version_id": "v_1"})
        run = STATE["runs"].get(self.path.split("/")[-1])
        if not run:
            return self.reply(404, {"message": "Run not found."})
        shown = {k: v for k, v in run.items() if k not in ("request", "answer") and v is not None}
        self.reply(200, shown)


# A stand-in for `method worker --methods-from-stdin`: it asks once, then prints the result with the answer.
FAKE_CLI = """import json, os, signal, sys, time, urllib.request
signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
args = sys.argv[1:]
server = args[args.index('--server') + 1]
assert '--methods-from-stdin' in args and args[args.index('--method') + 1] == 'wf_review', args
key = os.environ['METHOD_API_KEY']
def call(path, body=None):
    request = urllib.request.Request(server + path, data=None if body is None else json.dumps(body).encode(), method='GET' if body is None else 'POST',
                                     headers={'authorization': 'Bearer ' + key, 'content-type': 'application/json'})
    return json.loads(urllib.request.urlopen(request).read())
asked = set()
while True:
    try: run = call('/v1/runs/run-1')
    except Exception: time.sleep(0.05); continue
    if run['status'] == 'queued' and 'run-1' not in asked:
        asked.add('run-1')
        call('/v1/worker/runs/run-1/wait', {'lease_id': 'l', 'step': 'review:0', 'question': 'Publish the profile?', 'form': %s})
        print(json.dumps({'run_id': 'run-1', 'status': 'waiting'}), flush=True)
    elif run['status'] == 'queued':
        print(json.dumps({'run_id': 'run-1', 'status': 'succeeded', 'run_data': 'device', 'result': {'answered': True}}), flush=True)
        call('/v1/worker/runs/run-1/complete', {'lease_id': 'l', 'status': 'succeeded'})
        while True: time.sleep(1)
    time.sleep(0.05)
""" % repr(FORM)


class ProductionAskTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Api)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        STATE.update(runs={}, bodies=[], device=False, credential=KEY)

    def test_method_run_starts_the_worker_and_on_ask_answers(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = Path(directory) / "method"
            cli.write_text(f"#!{sys.executable}\n{FAKE_CLI}")
            cli.chmod(0o700)
            os.environ["METHOD_CLI"] = str(cli)
            try:
                method = Method(api_key=KEY, server=self.url)
                seen = []

                def on_ask(question):
                    seen.append((question.step, question.question, question.form, question["run_id"]))
                    return {"approved": True}

                run = method.run("wf_review", {"member": "7"}, on_ask=on_ask, timeout=20, interval=0.05)
                method.close(cancel=True)
            finally:
                del os.environ["METHOD_CLI"]
        self.assertEqual(run["status"], "succeeded")  # The server has no result: it came from the worker in this process.
        self.assertEqual(run["result"], {"answered": True})
        self.assertEqual(seen, [("review:0", "Publish the profile?", FORM, "run-1")])
        self.assertEqual(STATE["runs"]["run-1"]["request"]["answered_by"], "app")
        self.assertEqual(STATE["runs"]["run-1"]["answer"], {"step": "review:0", "answer": {"approved": True}})

    def test_answer_is_checked_against_the_form(self):
        method = Method(api_key=KEY, server=self.url, worker=False)
        run_id = method.runs.start("wf_review", {"member": "7"})["run_id"]
        STATE["runs"][run_id].update(status="waiting", question={"id": "q", "run_id": run_id, "step": "review:0", "answered_by": "team",
                                                                 "asked_at": "now", "expires_at": "later", "question": "OK?", "form": FORM})
        with self.assertRaises(MethodApiError) as refused:
            method.runs.answer(run_id, {"approved": "yes"})
        self.assertEqual(refused.exception.code, "invalid_answer")
        method.runs.answer(run_id, {"approved": False})
        self.assertEqual(STATE["runs"][run_id]["answer"]["answer"], {"approved": False})

    def test_device_run_seals_inputs_questions_and_answers(self):
        STATE["device"] = True
        method = Method(api_key=KEY, server=self.url, worker=False)
        run_id = method.runs.start("wf_private", {"member": "Ada Lovelace"}, on_ask=lambda q: {"approved": q.question == "Publish Ada's profile?"})["run_id"]
        request = STATE["runs"][run_id]["request"]
        self.assertEqual(request["inputs"], {})
        self.assertTrue(request["sealed_inputs"].startswith("v1."))
        self.assertEqual(method._run_data("open", "inputs", "wf_private", request["sealed_inputs"]), {"member": "Ada Lovelace"})
        # A worker seals the question with the same key.
        sealed = method._run_data("seal", "question", "wf_private", {"question": "Publish Ada's profile?", "form": FORM})
        STATE["runs"][run_id].update(status="waiting", question={"id": "q", "run_id": run_id, "step": "review:0", "answered_by": "app",
                                                                 "asked_at": "now", "expires_at": "later", "sealed": sealed})
        threading.Timer(1.5, lambda: STATE["runs"][run_id].update(status="succeeded")).start()
        self.assertEqual(method.runs.wait(run_id, timeout=20, interval=0.1)["status"], "succeeded")
        answer = STATE["runs"][run_id]["answer"]
        self.assertNotIn("answer", answer)
        self.assertEqual(method._run_data("open", "answer", "wf_private", answer["sealed_answer"]), {"approved": True})
        self.assertNotIn("Ada Lovelace", json.dumps(STATE["bodies"]))

    def test_uses_the_cli_sign_in_without_a_key(self):
        STATE["credential"] = TOKEN
        saved = {name: os.environ.pop(name, None) for name in ("METHOD_API_KEY", "METHOD_CONFIG_DIR", "METHOD_SERVER")}
        cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as config, tempfile.TemporaryDirectory() as app:
            os.environ["METHOD_CONFIG_DIR"] = config
            (Path(config) / (hashlib.sha256(self.url.encode()).hexdigest()[:24] + ".json")).write_text(json.dumps({"server": self.url, "token": TOKEN}))
            os.chdir(app)
            try:
                method = Method(server=self.url, worker=False)
                self.assertEqual(method.api_key, TOKEN)
                self.assertEqual(method.runs.start("wf_review", {"member": "7"})["status"], "queued")
                # A key in .env comes before the sign-in.
                (Path(app) / ".env").write_text(f"METHOD_API_KEY={KEY}\nMETHOD_SERVER={self.url}\n")
                self.assertEqual(Method(worker=False).api_key, KEY)
            finally:
                os.chdir(cwd)
                for name, value in saved.items():
                    os.environ.pop(name, None)
                    if value is not None:
                        os.environ[name] = value


if __name__ == "__main__":
    unittest.main()
