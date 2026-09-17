"""Read the example and selected day's files. No model calls or source rewriting."""
import json
import os
import sys
from pathlib import Path

ROOTS = {'example': 'DAILY_BRIEFING_EXAMPLE', 'selected_day': 'DAILY_BRIEFING_PREPARED', 'run': 'METHOD_OUTPUT_DIR'}


def folder(which):
    if which not in ROOTS:
        raise ValueError('Choose example, selected_day, or run')
    return Path(os.environ[ROOTS[which]]).resolve(strict=True)


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
