"""Describe only the generated website and its explicit supporting outputs."""
import mimetypes
from pathlib import PurePosixPath
from briefing_artifacts import digest, local, put


def website_manifest(destination, inventory, title, extras):
    destination = local(destination)
    files = []
    for relative, expected in inventory.items():
        path = PurePosixPath(relative)
        if path.is_absolute() or any(part in ('..', 'sensitive') for part in path.parts):
            raise ValueError('Invalid website output path')
        files.append({'path': 'website/' + relative, 'sha256': expected,
                      'media_type': mimetypes.guess_type(relative)[0] or 'application/octet-stream'})
    for name in extras:
        if PurePosixPath(name).name != name or name == 'sensitive':
            raise ValueError('Invalid supporting output path')
        files.append({'path': name, 'sha256': digest(destination / name),
                      'media_type': mimetypes.guess_type(name)[0] or 'application/octet-stream'})
    return put(destination / 'website-result.json', {
        'schema': 'method-website/1', 'title': title, 'entrypoint': 'website/index.html', 'files': files,
    })
