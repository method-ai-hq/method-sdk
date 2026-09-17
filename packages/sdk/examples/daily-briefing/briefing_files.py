"""Read the example and selected day's files. No model calls or source rewriting."""
import json
import os
import sys
import zipfile
import hashlib
from pathlib import Path

ROOTS = {'example', 'selected_day', 'run'}


def folder(which):
    if which not in ROOTS:
        raise ValueError('Choose example, selected_day, or run')
    if which == 'example':
        parent=Path(os.environ.get('METHOD_OUTPUT_DIR',Path(__file__).parent))
        target=parent/'approved-output'
        if not (target/'.ready').exists():
            with zipfile.ZipFile(Path(__file__).parent/'approved-output.zip') as archive:
                for entry in archive.infolist():
                    name=Path(entry.filename)
                    if name.is_absolute() or '..' in name.parts or not name.parts or name.parts[0]!='approved-output':
                        raise ValueError('Invalid approved example archive path')
                    destination=parent/name
                    if entry.is_dir():
                        destination.mkdir(parents=True,exist_ok=True)
                    else:
                        destination.parent.mkdir(parents=True,exist_ok=True)
                        destination.write_bytes(archive.read(entry));destination.chmod(0o600)
            for asset in json.loads((Path(__file__).parent/'images.json').read_text()):
                data=b''.join((Path(__file__).parent/part).read_bytes() for part in asset['parts'])
                if hashlib.sha256(data).hexdigest()!=asset['sha256']:
                    raise ValueError('Approved photo checksum failed')
                destination=parent/asset['path'];destination.parent.mkdir(parents=True,exist_ok=True)
                destination.write_bytes(data);destination.chmod(0o600)
            (target/'.ready').write_text('ready')
        return target.resolve(strict=True)
    if which == 'run':
        return Path(os.environ['METHOD_OUTPUT_DIR']).resolve(strict=True)
    return Path(json.loads(os.environ['METHOD_ENVIRONMENT'])['prepared_day']).resolve(strict=True)


def local_path(which, name):
    root = folder(which)
    path = (root / name).resolve(strict=True)
    if not path.is_relative_to(root):
        raise ValueError('Path is outside the selected folder')
    return path


def page(text, offset):
    if not isinstance(offset, int) or not 0 <= offset <= len(text):
        raise ValueError('Invalid character offset')
    end = min(len(text), offset + 20000)
    return {'content': text[offset:end], 'next_offset': end if end < len(text) else -1,
            'total_chars': len(text)}
