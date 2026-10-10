#!/bin/sh
# Claude Code runs this before Read, Grep and Bash: the Method CLI decides whether the call opens a key file.
method="$HOME/.local/bin/method"
[ -x "$method" ] || method=$(command -v method) || exit 0
exec "$method" guard-keys
