#!/bin/sh
# Claude Code and Codex run this at session start. Install the Method CLI once, put it on PATH, and tell the agent where it is.
bin="$HOME/.local/bin"
if ! command -v method >/dev/null 2>&1 && [ ! -x "$bin/method" ]; then
  curl -fsSL "${METHOD_INSTALL_URL:-https://app.withmethod.ai/install.sh}" | METHOD_SKIP_PLUGIN=1 sh >/dev/null 2>&1 \
    || { printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"The Method CLI could not be installed. Ask the user to run: curl -fsSL https://app.withmethod.ai/install.sh | sh"}}\n'; exit 0; }
fi
# Claude Code keeps PATH changes from this file. Codex does not, so the context names the full path.
[ -n "${CLAUDE_ENV_FILE:-}" ] && printf 'export PATH="%s:$PATH"\n' "$bin" >> "$CLAUDE_ENV_FILE"
version=$(PATH="$bin:$PATH" method --version 2>/dev/null)
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"The Method CLI is installed at %s/method (%s). If `method` is not on PATH, use that path."}}\n' "$bin" "$version"
exit 0
