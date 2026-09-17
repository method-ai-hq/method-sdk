"""Read and write the files produced by a briefing run."""
import hashlib
import json
import os
from pathlib import Path

from briefing_files import folder


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tree(root):
    return {str(p.relative_to(root)): digest(p) for p in sorted(root.rglob('*')) if p.is_file()}


def source_digest():
    return hashlib.sha256(json.dumps(tree(folder('selected_day')),sort_keys=True).encode()).hexdigest()


def local(name):
    root=Path(os.environ['METHOD_OUTPUT_DIR']).resolve()
    path=(root/name).resolve()
    if not path.is_relative_to(root):raise ValueError('Path leaves the run folder')
    return path


def put(path, data):
    path=local(path)
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n');path.chmod(0o600)
    return {'path':str(path.relative_to(local('.'))),'sha256':digest(path)}


def load(ref):
    path=local(ref['path'])
    if digest(path)!=ref['sha256']:raise ValueError('The saved file changed')
    return json.loads(path.read_text())
