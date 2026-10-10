# Worked example: notes-summary

The smallest complete Method: reads a folder of meeting notes, finds decisions and action items with one model call, and saves a summary file. The folder is observed automatically.

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
        give the owner, and the due date as YYYY-MM-DD when the notes give one;
        otherwise use an empty due. Do not add anything that the notes do not say.

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

## README.md

```markdown
# Weekly summary from meeting notes

The smallest complete Method: a script reads a folder, one model call finds the items, and a script saves a file.

- The save step declares `changes: [environment.out]`. Nothing else is needed: the runtime reads the folder before and after the step, and the run fails if the step returns `out/weekly.md` but that file did not change.
- Run it: `method run notes-summary.method`.
- When the user corrects the summary, fix the Method, run it again, and keep the rule as a case: `method case new notes-summary.method --id ... --run BAD_RUN --passing-run NEW_RUN --note "..." --rubric "..."`, then `method test notes-summary.method`.
```

## Installed files

- notes-summary/README.md
- notes-summary/TASK.md
- notes-summary/notes-summary.method
- notes-summary/notes/2026-10-05-standup.md
- notes-summary/notes/2026-10-07-planning.md
- notes-summary/out/.keep
- notes-summary/read-notes.mjs
- notes-summary/save.mjs
