"""The Python CLI uses the product CLI and its exact options."""
import subprocess
import sys
from .client import runtime_command, WorkflowError


def main() -> int:
    try:
        return subprocess.call([*runtime_command("method"), *sys.argv[1:]])
    except WorkflowError as error:
        print(str(error), file=sys.stderr)
        return 1
