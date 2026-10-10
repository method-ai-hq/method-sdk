"""Python production runs: the runs API over HTTP, the worker through the CLI, and webhook signatures."""
import hashlib
import hmac
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
from withmethod import Method, MethodApiError, verify_webhook  # noqa: E402

KEY = "mk_live_" + "B" * 43
RUNS: dict = {}


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
        assert self.headers["authorization"] == f"Bearer {KEY}"
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        if self.path == "/v1/runs":
            if not body["inputs"]:
                return self.reply(422, {"code": "missing_inputs", "message": "Send the required inputs: member_id."})
            run_id = f"run-{len(RUNS) + 1}"
            RUNS[run_id] = {"run_id": run_id, "status": "queued", "run_data": "device", "inputs": body["inputs"]}
            return self.reply(201, {"run_id": run_id, "version_id": "v_1", "status": "queued"})
        if self.path.endswith("/cancel"):
            run = RUNS[self.path.split("/")[3]]
            run["status"] = "cancelled"
            return self.reply(200, run)
        self.reply(404, {"message": "Not found."})

    def do_GET(self):
        run = RUNS.get(self.path.split("/")[-1])
        self.reply(200, {k: v for k, v in run.items() if k != "inputs"}) if run else self.reply(404, {"message": "Run not found."})


# A stand-in for `method worker`: it "runs" each queued run and prints one JSON line, as the CLI does.
FAKE_CLI = """import json, os, signal, sys, time, urllib.request
signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
server = sys.argv[sys.argv.index('--server') + 1]
assert os.environ['METHOD_API_KEY'].startswith('mk_live_')
done = set()
while True:
    for run_id in ('run-1', 'run-2'):
        if run_id in done: continue
        request = urllib.request.Request(server + '/v1/runs/' + run_id, headers={'authorization': 'Bearer ' + os.environ['METHOD_API_KEY']})
        try: run = json.loads(urllib.request.urlopen(request).read())
        except Exception: continue
        if run['status'] != 'queued': continue
        done.add(run_id)
        print(json.dumps({'run_id': run_id, 'status': 'succeeded', 'run_data': 'device', 'result': {'links': ['https://cuties.example/m/7']}}), flush=True)
        os.environ['DONE_' + run_id] = '1'
    time.sleep(0.05)
"""


class ProductionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Api)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def test_runs_api_and_worker_return_a_device_result_locally(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = Path(directory) / "method"
            cli.write_text(f"#!{sys.executable}\n{FAKE_CLI}")
            cli.chmod(0o700)
            os.environ["METHOD_CLI"] = str(cli)
            try:
                method = Method(api_key=KEY, server=self.url)
                with self.assertRaises(MethodApiError) as refused:
                    method.runs.start("wf_links", {})
                self.assertEqual(refused.exception.code, "missing_inputs")
                seen = []
                worker = method.worker.start(methods=["wf_links"], on_result=seen.append)
                started = method.runs.start("wf_links", {"member_id": 7}, idempotency_key="member-7")
                self.assertEqual(started["status"], "queued")
                # The fake server never marks the run finished: the result reaches this process from the worker.
                deadline = time.monotonic() + 10
                while not seen and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.assertEqual(seen[0]["result"], {"links": ["https://cuties.example/m/7"]})
                self.assertEqual(method.runs.get(started["run_id"])["result"], {"links": ["https://cuties.example/m/7"]})
                self.assertEqual(method.runs.cancel(started["run_id"])["status"], "cancelled")
                worker.stop(cancel=True, timeout=10)
                self.assertFalse(worker.running)
            finally:
                del os.environ["METHOD_CLI"]

    def test_verify_webhook(self):
        body, secret, t = b'{"run_id":"r","status":"succeeded"}', "whsec_test", int(time.time())
        header = f"t={t},v1=" + hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
        self.assertTrue(verify_webhook(body, header, secret))
        self.assertTrue(Method.webhooks.verify(body.decode(), header, secret))
        self.assertFalse(verify_webhook(body.replace(b"succeeded", b"failed"), header, secret))
        self.assertFalse(verify_webhook(body, header, secret, now=t + 301))
        self.assertFalse(verify_webhook(body, None, secret))


if __name__ == "__main__":
    unittest.main()
