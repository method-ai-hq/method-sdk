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
# A project with Methods: a change to what the project does may belong in a Method, so the skill comes first.
found=$(find "${CLAUDE_PROJECT_DIR:-$PWD}" -maxdepth 4 -type f -name '*.method' -not -path '*/node_modules/*' -not -path '*/.method-runs/*' 2>/dev/null | head -1)
project=""
[ -n "$found" ] && project=" This project has Methods (.method files). Load the method skill before you change what the project or its app does, such as its results or a person's approval: that change may belong in a Method."
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"The Method CLI is installed at %s/method (%s). If `method` is not on PATH, use that path.%s"}}\n' "$bin" "$version" "$project"
exit 0
