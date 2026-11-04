#!/bin/sh
# Claude Code and Codex run this when the person sends a message. When a Method ran in this project, the agent is told
# which run is the newest, so a correction of its result goes to method judge on that run, not only into the reply.
bin="$HOME/.local/bin"
out=$(PATH="$bin:$PATH" method __newest-run "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null) || exit 0
[ -n "$out" ] || exit 0
id=$(printf '%s' "$out" | sed -n 's/.*"run_id":"\([^"]*\)".*/\1/p')
file=$(printf '%s' "$out" | sed -n 's/.*"file":"\([^"]*\)".*/\1/p')
[ -n "$id" ] || exit 0
printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"The newest run of a Method in this project is %s (%s). If this message corrects or approves a result of that run, record it before anything else: method judge %s wrong --note \\"THEIR WORDS\\" (or method judge %s right). A correction that is only answered in the chat is not kept."}}\n' "$id" "$(basename "$file")" "$id" "$id"
exit 0
