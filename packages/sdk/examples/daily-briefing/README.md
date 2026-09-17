# Write a daily briefing

Read TASK.md, daily-briefing.method, and the complete approved output. The writer uses the complete report as its example. The helpers accept ordinary Markdown and connect source links without requiring section names, paragraph markers, citation labels, or a limit on bold text. The Method has three steps; choose the steps your own work needs.

## Read and run the example

Copy this folder to a new working folder before you change it. Then run:

```sh
method validate daily-briefing.method
method save daily-briefing.method
method bind WORKFLOW_ID prepared_day --file sample
method run WORKFLOW_ID --version VERSION_ID --inputs inputs.json
```

Use the IDs returned by save. Method prepares Python, Node packages, and the browser. It uses the available signed-in coding agent. Use `method bind` with another folder to run another day. Add `--upload` only when you want that selected folder saved privately in your account for another computer.

The complete approved report and its two edited photos are included in the installed example. The first step opens the archive under the run’s artifacts folder. Open approved-output/website/index.html and approved-output/briefing.md there. Read approved-report.md for the complete text before a run. Expand sessions, passages, and citations. Their recorded hashes are retained.

sample/ contains one complete work conversation: 28 messages from the redacted day. It does not contain the entire day behind the approved report. A sample run must describe this limited evidence and must not copy the rest of the approved day's events. Expect a shorter cited briefing and a website with working source links, plus timing calculations when the writer chooses to make supported estimates. Calculations are optional.

Run files are under .method-runs. Open the website returned by the run and read the Markdown. Check that its claims follow the sample records and its links open the right sources. A valid definition or successful script does not prove that the writing is good.

## Why these steps

Check the input folders before asking the writer to work. Give the writer the complete approved example and the complete source records. Keep the writer's instructions short. Use scripts for calculations, source checks, website construction, and saving files. These scripts check files and references. They render the report in its written order. All browser records remain available on supporting pages; a session link on its own line displays that session at that point in the story. If a session link is unknown, the page says so and links to all saved sessions; the run reports the missing link. The writer chooses placement, as shown in the complete approved Markdown. Cards show the start of the saved session and let the reader expand the rest. Five-minute groups help browse the supporting records but do not create time estimates. The final step renders and saves once. Other Methods can need fewer or more steps.

## Files

- daily-briefing.method: adapted Method with portable run instructions.
- TASK.md: task recorded in the approved Method.
- briefing_*.py, briefing_browser.cjs, reader/: required helpers.
- runtime.json: portable tool declarations.
- pyproject.toml, uv.lock, package.json, package-lock.json: locked dependencies.
- sample/, inputs.json: small redacted input sample.
- approved-output.zip, approved-images/, images.json: complete expected reference output and its photo locations and hashes.
- approved-output/checks.json: checks recorded for the approved redacted reference.
- checks.json: checks recorded for this public package. Read their scope and limits.
- vendor/: Markdown renderer and its license.

Method does not enforce the example's tone, section names, number of steps, or subject matter. For a report, use the user's own approved output as the writing example when one is available. For work that changes a CRM or another saved system, use an example of the intended final state and test changes in a test destination.

The approved artifact stays unchanged. The writer receives its complete text with obsolete hidden display markers removed. The coding agent uses its normal file tools to read the selected records. Two Method tools remain: source-panel inspection (text and controls, not screenshots) and optional time calculations. Supporting files pass explicitly from the writer to the renderer.
