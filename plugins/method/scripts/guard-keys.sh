#!/bin/sh
# Claude Code runs this before Read, Grep and Bash. A key file's values would go into the chat, so opening one needs the
# person's approval. `method secret find` and `method secret import` read key files without showing values.
input=$(cat)
printf '%s' "$input" | grep -q '"method secret\|"method connect' && exit 0
if printf '%s' "$input" | grep -Eq '(/|"|[[:space:]])(\.env(\.[A-Za-z0-9_-]+)?|secrets\.env|secrets\.json)("|[[:space:]]|$)' \
  && ! printf '%s' "$input" | grep -Eq '\.env\.(example|sample|template)'; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"This opens a key file, so its values would go into the chat. To give keys to a Method, use method secret find and method secret import."}}\n'
fi
exit 0
