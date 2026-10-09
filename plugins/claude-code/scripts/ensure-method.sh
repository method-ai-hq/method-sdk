#!/bin/sh
# Install the Method CLI once, and put it on PATH for this Claude Code session. Prints one line of context.
bin="$HOME/.local/bin"
if ! command -v method >/dev/null 2>&1 && [ ! -x "$bin/method" ]; then
  curl -fsSL "${METHOD_INSTALL_URL:-https://app.withmethod.ai/install.sh}" | sh >/dev/null 2>&1 \
    || { echo "The Method CLI could not be installed. Ask the user to run: curl -fsSL https://app.withmethod.ai/install.sh | sh"; exit 0; }
fi
[ -n "${CLAUDE_ENV_FILE:-}" ] && printf 'export PATH="%s:$PATH"\n' "$bin" >> "$CLAUDE_ENV_FILE"
PATH="$bin:$PATH" method --version 2>/dev/null | sed 's/^/Installed: /'
exit 0
