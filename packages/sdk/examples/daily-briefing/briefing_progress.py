"""Report public work milestones without changing the final JSON result."""
import json
import os


def progress(message, completed=None, total=None, unit=None):
    fd = os.environ.get('METHOD_PROGRESS_FD')
    if fd is None:
        return
    update = {'message': message}
    if completed is not None and total is not None:
        update.update(completed=completed, total=total)
    if unit:
        update['unit'] = unit
    try:
        os.write(int(fd), (json.dumps(update) + '\n').encode())
    except (OSError, ValueError):
        pass
