# Write a daily briefing

TASK.md contains the task recorded in the Method's goal. daily-briefing.method implements it. approved-report.md contains the complete approved report.

## Run

Copy this folder to a working folder, then run:

```sh
method validate daily-briefing.method
method save daily-briefing.method
method bind WORKFLOW_ID prepared_day --file sample
method run WORKFLOW_ID --version VERSION_ID --inputs inputs.json
```

Use the IDs returned by save. Method prepares the dependencies and uses the signed-in coding agent. Bind another prepared folder to run another day.

sample/ contains one complete work conversation: 28 redacted messages from May 11. inputs.json selects that date and timezone. The approved report covers the full day. The sample run covers this conversation.

Open the website returned by the run. Source links open the saved records and selected passages. The Markdown and supporting files are included with the website.

## Files

- daily-briefing.method: input checks, writing with a source check, and website rendering.
- runtime.json: website inspection and time calculation tools.
- briefing_*.py, reader/, vendor/: helpers and website assets.
- pyproject.toml, uv.lock, package.json, package-lock.json: dependencies.
- sample/, inputs.json: inputs for a sample run, kept outside the Method's saved files.
- approved-report.md: complete writing reference.
- sample-report.md, sample-output.zip: actual draft and website from the recorded sample run.
- checks.json: recorded checks and reference hashes.
