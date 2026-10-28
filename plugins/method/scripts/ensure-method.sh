#!/bin/sh
# Claude Code and Codex run this at session start. Install the Method CLI once, update it when it is older than this
# plugin, put it on PATH, and tell the agent where it is. Updates happen in the background and print nothing.
bin="$HOME/.local/bin"
url="${METHOD_INSTALL_URL:-https://app.withmethod.ai/install.sh}"
root="${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}"
installed=$(PATH="$bin:$PATH" method --version 2>/dev/null | sed -n 's/^Method SDK \([0-9.]*\);.*/\1/p')
if [ -z "$installed" ]; then
  curl -fsSL "$url" | METHOD_SKIP_PLUGIN=1 sh >/dev/null 2>&1 \
    || { printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"The Method CLI could not be installed. Ask the user to run: curl -fsSL https://app.withmethod.ai/install.sh | sh"}}\n'; exit 0; }
else
  wanted=$(sed -n 's/.*"version": *"\([0-9.]*\)".*/\1/p' "$root/.claude-plugin/plugin.json" 2>/dev/null | head -1)
  lowest=$(printf '%s\n%s\n' "$installed" "${wanted:-$installed}" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)
  if [ -n "$wanted" ] && [ "$installed" != "$wanted" ] && [ "$lowest" = "$installed" ]; then
    (curl -fsSL "$url" | METHOD_SKIP_PLUGIN=1 sh >/dev/null 2>&1 &)
  fi
fi
# Claude Code keeps PATH changes from this file. Codex does not, so the context names the full path.
[ -n "${CLAUDE_ENV_FILE:-}" ] && printf 'export PATH="%s:$PATH"\n' "$bin" >> "$CLAUDE_ENV_FILE"
# A project with Methods: a change to what the project does may belong in a Method, so the skill comes first.
found=$(find "${CLAUDE_PROJECT_DIR:-$PWD}" -maxdepth 4 -type f -name '*.method' -not -path '*/node_modules/*' -not -path '*/.method-runs/*' 2>/dev/null | head -1)
project=""
[ -n "$found" ] && project=" This project has Methods (.method files). Load the method skill before you change what the project or its app does: that change may belong in a Method."
# Work the person will give again belongs in a Method, so that a correction is kept and tested, not only answered.
repeat="Method is installed for work the person will repeat: when they will give you the same kind of task again, load the method skill and build it as a Method. Send each correction of its result through \`method judge RUN_ID wrong --note 'their words'\` so that it is kept and tested."
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s The Method CLI is installed at %s/method. If `method` is not on PATH, use that path.%s"}}\n' "$repeat" "$bin" "$project"
exit 0
