"""Prepare the supplied sample. This does not start a Method run."""
import argparse
import hashlib
import json
import subprocess
import urllib.request
import zipfile
from pathlib import Path
from briefing_config import make_config

root = Path(__file__).resolve().parent
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--prepared', type=Path, default=root/'sample')
p.add_argument('--playwright', type=Path, default=root/'node_modules/playwright')
a = p.parse_args()
if not a.playwright.is_dir():
    raise SystemExit('Install the browser helper: npm install && npx playwright install --with-deps chromium')
with zipfile.ZipFile(root/'approved-output.zip') as archive:
    archive.extractall(root)
for item in json.loads((root/'images.json').read_text()):
    destination = root/item['path']
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists() or hashlib.sha256(destination.read_bytes()).hexdigest() != item['sha256']:
        request = urllib.request.Request(item['url'], headers={'User-Agent': 'MethodCLI/0.4.2'})
        with urllib.request.urlopen(request, timeout=60) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != item['sha256']:
            raise SystemExit('Example image hash does not match: '+item['path'])
        destination.write_bytes(data)
config = make_config(root/'approved-output', a.prepared, root, a.playwright)
(root/'runtime.json').write_text(json.dumps(config, indent=2)+'\n')
(root/'runtime.json').chmod(0o600)
try:
    subprocess.run(
        [str(root/'node-runtime.sh'), str(root/'briefing_browser.cjs')],
        input=json.dumps({'page': 'index.html', 'target': '', 'action': 'read', 'offset': 0}),
        text=True, capture_output=True, check=True, timeout=45,
    )
except subprocess.CalledProcessError as error:
    raise SystemExit(error.stderr or error.stdout or 'The example browser failed to start.')
except subprocess.TimeoutExpired:
    raise SystemExit('The example browser did not open within 45 seconds.')
print('Ready. Run method validate daily-briefing.method, then method save daily-briefing.method. Use the returned IDs with method run WORKFLOW_ID --version VERSION_ID --inputs inputs.json.')
