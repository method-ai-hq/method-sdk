#!/bin/sh
# Claude Code and Codex run this when the person sends a message. When a Method ran in this chat, Method decides
# whether the message corrects or approves the result of the newest run, and records it against that run word for
# word (method judge); the agent is told what Method recorded.
bin="$HOME/.local/bin"
PATH="$bin:$PATH" method __correction "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null || exit 0
exit 0
