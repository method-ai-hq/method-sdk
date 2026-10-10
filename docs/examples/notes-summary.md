# Worked example: notes-summary

The smallest complete Method: reads a folder of meeting notes, finds decisions and action items with one model call that shows two good items, and saves a summary file. A recorded case keeps one correction.

## TASK.md

```markdown
# Request

Every Friday, read this week's meeting notes and save a summary with the decisions and the action items. Each item names its owner, its due date when the notes give one, and the note it came from.
```

## notes-summary.method

```yaml
format: method/3.4
name: Weekly summary from meeting notes
goal: Read this week's meeting notes and save a summary with the decisions and the action items, each with its owner, due date and source note.
environment:
  notes:
    type: files
    description: Folder of Markdown meeting notes.
  out:
    type: files
    description: Folder where the summary is saved.
steps:
  read:
    name: Read the notes
    purpose: Reads every Markdown file in the notes folder, oldest name first, and returns their text headed by the file name.
    in: {notes: environment.notes}
    do: {kind: run, runtime: node, entrypoint: read-notes.mjs}
    out:
      material: {type: text, description: "All notes, each headed by its file name."}
  summarize:
    name: Find decisions and action items
    in: {material: material}
    do:
      kind: call
      model: default
      prompt: |
        From these meeting notes, list every decision and every action item.
        For each item, give the note file it comes from. For an action item,
        give the owner and the due date. Write every date as YYYY-MM-DD, also
        inside a decision; take the year from the note's file name. When the
        notes give no due date, leave due empty. Do not add anything that the
        notes do not say.

        Two items from other notes, written the way they should be:
        - "Decision: ship the beta on 3 Nov." in 2026-10-28-review.md is the decision
          text "Ship the beta on 2026-11-03.", source "2026-10-28-review.md".
        - "Lee will book the venue." in 2026-10-28-review.md is the action
          "Book the venue.", owner "Lee", due "", source "2026-10-28-review.md".

        {{material}}
    out:
      summary:
        type: record
        fields:
          decisions: {type: list, fields: {text: text, source: text}}
          actions: {type: list, fields: {action: text, owner: text, due: text, source: text}}
  save:
    name: Save the summary
    purpose: Writes the decisions and action items to out/weekly.md as Markdown and returns the file path.
    in: {summary: summary, out: environment.out}
    do: {kind: run, runtime: node, entrypoint: save.mjs}
    changes: [environment.out]
    out:
      path: {type: text, description: Path of the saved summary.}
result: path
```

## read-notes.mjs

```javascript
import {readFileSync, readdirSync} from 'node:fs';
const {notes} = JSON.parse(readFileSync(0, 'utf8'));
const files = readdirSync(notes).filter(name => name.endsWith('.md')).sort();
console.log(JSON.stringify({material: files.map(name => `## ${name}\n${readFileSync(`${notes}/${name}`, 'utf8')}`).join('\n\n')}));
```

## save.mjs

```javascript
import {readFileSync, writeFileSync} from 'node:fs';
const {summary, out} = JSON.parse(readFileSync(0, 'utf8'));
const lines = ['# Weekly summary', '', '## Decisions', ...summary.decisions.map(d => `- ${d.text} (${d.source})`), '', '## Action items',
  ...summary.actions.map(a => `- ${a.action} — ${a.owner}${a.due ? `, due ${a.due}` : ''} (${a.source})`), ''];
const path = `${out}/weekly.md`;
writeFileSync(path, lines.join('\n'));
console.log(JSON.stringify({path}));
```

## cases/dates-in-decisions/case.json

```json
{
  "format": "method-case/1",
  "id": "dates-in-decisions",
  "status": "active",
  "method_file": "notes-summary.method",
  "note": "The demo date in the decision says 14 Oct. Write dates in decisions as YYYY-MM-DD too, like the due dates.",
  "author": null,
  "created": "2026-10-10T02:18:15.490Z",
  "source": {
    "run_dir": "/work/notes-summary/run2",
    "execution_id": "e8348baa-6be6-421e-b50d-0f86e4df765f",
    "method_sha256": "a444edf4f50b1263e1a0b1037a26ba2db91a95f3508e2e6f11747f44d468fa7d",
    "passing_run_dir": "/work/notes-summary/run3"
  },
  "expect": [
    {
      "kind": "rubric",
      "ref": "outputs.path",
      "criteria": [
        {
          "id": "c1",
          "text": "Every date in a decision is written as YYYY-MM-DD."
        }
      ]
    }
  ],
  "runs": null,
  "min_pass": null,
  "supersedes": [],
  "superseded_by": null,
  "files": {
    "/work/notes-summary/out/weekly.md": "files/0"
  },
  "retention_until": "2027-10-10",
  "redacted": true
}
```

## README.md

````markdown
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
````

## Installed files

- notes-summary/README.md
- notes-summary/TASK.md
- notes-summary/cases/dates-in-decisions/case.json
- notes-summary/cases/dates-in-decisions/examples.json
- notes-summary/cases/dates-in-decisions/files/0
- notes-summary/cases/dates-in-decisions/recording.json
- notes-summary/notes-summary.method
- notes-summary/notes/2026-10-05-standup.md
- notes-summary/notes/2026-10-07-planning.md
- notes-summary/out/.keep
- notes-summary/read-notes.mjs
- notes-summary/save.mjs
