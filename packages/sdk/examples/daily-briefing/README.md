# Write a daily briefing

TASK.md contains the task recorded in the Method's goal. daily-briefing.method implements it. approved-report.md contains the complete approved report that the writing step follows.

All people, places, and conversations in this example are fictional. Wren Talbot runs a pottery studio, Larkfield Ceramics, in the invented town of Millbrook.

## Run

Copy this folder to a working folder, then run:

```sh
cp -R sample prepared_day     # a folder named after the connection needs no binding
method validate daily-briefing.method
method run daily-briefing.method --inputs inputs.json
```

The run saves a version and prints the dashboard link. Method prepares the Python and Node dependencies. For another day, put that day's prepared records in `prepared_day/`, or bind another folder with `method bind daily-briefing.method prepared_day --file FOLDER`.

sample/ contains one complete conversation: 28 messages from the morning of May 11, in which Wren plans a glaze workshop. inputs.json selects that date and timezone. The approved report covers Wren's full day; the sample covers only this conversation.

Open the website returned by the run. Source links open the saved records and selected passages. The Markdown and supporting files are included with the website.

## Files

- daily-briefing.method: input checks, writing with a source check, and website rendering.
- daily-briefing.method `tools:`: the time calculation tool.
- briefing_*.py, reader/, vendor/: helpers and website assets.
- pyproject.toml, uv.lock, package.json, package-lock.json: dependencies.
- sample/, inputs.json: inputs for a sample run, kept outside the Method's saved files.
- approved-report.md: complete writing reference.
- sample-report.md, sample-output.zip: a briefing of the sample conversation, and the website that the Method's own scripts built from it. The draft was written for this example; the time tool, the source check, and the render step ran on it. checks.json records how, with the hashes.
