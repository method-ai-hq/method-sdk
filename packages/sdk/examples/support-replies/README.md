# Which reply agent follows corrections better

A comparison of a Method agent against plain Claude Code. Both get the same 20 corrections on four past tickets, one at a time, and are measured on three new tickets after every 5.

- `replies.compare` is the comparison. Run it with `method run replies.compare`: Method runs a trial, measures the noise, and asks before the full run.
- `support-reply.method` is the Method arm. It saves its reply to `work/reply.md`; `deliverable: work/reply.md` makes the plain arm hand in the same file.
- `plain-instructions.md` is the plain arm's starting instructions: the same words as the Method's prompt. A builder edits them after each correction.
- `expected/` holds each new ticket's checklist. Each item names the corrections that cover it (`covered_by`, by their place in the file), so the main measure counts only items that a correction given so far covers.
- The user named the arms (`decided_by_you`). The question rephrases the user's request, so it is the writer's. Every other value is the writer's choice, and the comparison page asks the user to review it.
