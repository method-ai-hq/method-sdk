# Weekly summary from meeting notes

The smallest complete Method: a script reads a folder, one model call finds the items, and a script saves a file.

- The folders `notes/` and `out/` beside the Method are its two files connections, so they need no binding. `out/` is empty until the first run.
- The save step declares `changes: [environment.out]`. Nothing else is needed: the runtime reads the folder before and after the step, and the run fails if the step returns `out/weekly.md` but that file did not change.
- The prompt shows two items written the way they should be. They come from other notes, so the model copies their form, not their content.
- Run it: `method run notes-summary.method`.

## The case in cases/

The first version of the prompt asked for due dates as YYYY-MM-DD but said nothing about other dates. Its run wrote the decision "Move the client demo to 14 Oct." The correction was: write dates in decisions as YYYY-MM-DD too. The prompt now says so, and it shows an example decision with a date. The run after the change wrote "Move the client demo to 2026-10-14."

That correction is kept as a case. It was made from the two runs:

```sh
method case new notes-summary.method --id dates-in-decisions \
  --run BAD_RUN --passing-run FIXED_RUN \
  --note "The demo date in the decision says 14 Oct. Write dates in decisions as YYYY-MM-DD too, like the due dates." \
  --rubric "Every date in a decision is written as YYYY-MM-DD."
```

`method test notes-summary.method` runs it again: the summarize step changed since the bad run, so it runs live, and a model judges the saved summary against the rubric. `method publish` runs the cases first. Add a case in the same way for each correction that a later version must keep.
