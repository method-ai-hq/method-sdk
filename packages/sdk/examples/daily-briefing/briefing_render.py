"""Render, check, and save a briefing once. Inputs remain read-only."""
import contextlib
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile

from briefing_artifacts import digest, local, put, source_digest, tree
from briefing_files import folder
from briefing_manifest import website_manifest
from briefing_validation import supporting_files, check_website
from briefing_markdown import parse
from briefing_website import build
from briefing_progress import progress


def render_and_save(args):
    day, draft = args['selected_day'], args['draft']
    supporting, files = supporting_files(args)
    proposal = parse(draft, day, supporting=supporting)
    progress('Rendering the briefing and its sources.')
    temporary = Path(tempfile.mkdtemp(prefix='briefing-', dir=local('.')))
    try:
        (temporary/'briefing.md').write_text(draft)
        for name, path in files.items(): shutil.copyfile(path, temporary/name)
        website = temporary/'website'
        with contextlib.redirect_stdout(sys.stderr):
            build(folder('selected_day'), temporary/'briefing.md', website,
                  Path(__file__).parent/'vendor/marked.mjs', day, proposal)
        for target in proposal['local_files']:
            relative = target['path']
            destination = (website/relative).resolve()
            if not destination.is_relative_to(website.resolve()):
                raise ValueError('File target leaves the website: ' + relative)
            if destination.is_file(): continue
            source = files.get(relative)
            if source is None:
                source = (folder('selected_day')/relative).resolve()
                if not source.is_relative_to(folder('selected_day').resolve()):
                    raise ValueError('File target leaves the prepared folder: ' + relative)
            if not source.is_file(): raise ValueError('Missing linked file: ' + relative)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
        check_website(website)
        if source_digest() != day['source_digest']:
            raise ValueError('Prepared sources changed during the run')
        inventory = tree(website)
        extras = ['briefing.md', *files]
        signature = hashlib.sha256(json.dumps({'website': inventory,
            'files': {name:digest(temporary/name) for name in extras}}, sort_keys=True).encode()).hexdigest()
        destination = local('saved/'+signature)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            if tree(destination/'website') != inventory or any(digest(destination/name) != digest(temporary/name) for name in extras):
                raise ValueError('Existing saved output changed')
        else:
            temporary.rename(destination)
        published = website_manifest(destination, inventory, 'Briefing for '+day['day'], extras)
        receipt = put(destination/'briefing.json', {'day':day['day'], 'timezone':day['timezone'],
            'website':str((destination/'website/index.html').relative_to(local('.'))),
            'source_digest':day['source_digest'], 'supporting_files':list(files)})
        progress('Briefing saved. Website links are valid.')
        return {'saved_briefing':receipt, 'published_website':published}
    finally:
        if temporary.exists(): shutil.rmtree(temporary)


if __name__ == '__main__':
    print(json.dumps(render_and_save(json.load(sys.stdin)), ensure_ascii=False))
