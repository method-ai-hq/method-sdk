# Weekly summary from meeting notes

The smallest complete Method: a script reads a folder, one model call finds the items, and a script saves a file.

- The save step declares `changes: [environment.out]`. Nothing else is needed: the runtime reads the folder before and after the step, and the run fails if the step returns `out/weekly.md` but that file did not change.
- Run it: `method run notes-summary.method`.
- When the user corrects the summary, fix the Method, run it again, and keep the rule as a case: `method case new notes-summary.method --id ... --run BAD_RUN --passing-run NEW_RUN --note "..." --rubric "..."`, then `method test notes-summary.method`.
