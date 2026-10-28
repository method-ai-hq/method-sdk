# Unreleased

- **Method's learner is one agent session.** A correction goes to one Claude Code or Codex session (the agent, model and effort of the Method's own steps, on your own subscription) in a private copy of the Method's folder. It reads the correction, the run (inputs, step outputs, result, transcripts, files), every earlier correction with its check and outcome, and the authoring guide. It writes the check of the correction with `method case new`, changes whatever the Method needs (a prompt, a learned rule, a new run step with a data file, a check, a split step, examples), and runs `method validate` and `method test`.
- **A gate in code decides.** Method applies the change only when the new check fails on the Method as it was and passes on the new one, every earlier check that passed still passes, the person's own words are unchanged, and `method validate` gives no errors. A failed gate goes back to the session with the exact failure, 3 tries in all; then the outcome is no fix found (or held, when the change breaks only checks that other people made). A usage limit is a plain error.
- **The person's own words stay.** Every paragraph of the goal, the prompts, the classify questions and options, the questions to people, the check prompts, and the .md and .txt files is the person's, except the paragraphs that Method's learner wrote (recorded in `.method/written.json`). The learner adds text beside them; it changes one only after the person answered a question that quotes it.
- **Each change is recorded.** A fix has its correction, a plain summary and a diff: `method wait --json`, `method changes --json` and the comparison page show them, and `method undo` takes the whole change back, the new files and the new check too.
- **Outcomes.** fixed, no change needed (the run, or the Method as it is now, already does what the correction asks; its check stays), no fix found, could not test, question, held. not_reproduced and not_fixable_here are gone.
- **Removed:** improve.method and its download (`METHOD_IMPROVE_METHOD`), the case writer (`caseFromCorrection`), correction kinds and candidate kinds, finding the step by trying, ranking by fewest words, the pruning sweep, the later check of other cases, `method __model`, and a learned rule added without a test.
- **Corrections are fixed on a computer.** Method no longer fixes corrections in the cloud. `method judge` and `method wait` say that a correction that no computer here takes will be fixed the next time the Method runs on a computer with Claude Code or Codex.
- **The authoring guide** starts with the principles of a Method that just works.
- **Comparisons:** the Method arm's learner is this session; it and the plain builder have the same model and the same 2 hours for each correction, and the page shows what each correction changed.

# 0.23.3

- **A Method arm whose agent is a session step runs its measured runs.** The clean room of a Method arm gets the sign-in of each session step's agent, not only of call and agent steps.
- **A run is evidence for a correction only for the same inputs.** The watch after a run judges only the corrections whose case was made from the same inputs, so a correction of another date or party is not reopened and fixed again by runs it does not apply to.
- **A comparison's training run reuses nothing.** Each training run of a Method learner runs fresh, as a plain arm's does.
- **A learned rule added without a test counts.** A correction that could not be tested but became a learned rule is received and changed the agent (rule added, not tested).
- **Plain reasons.** A fix that ended because the step changed after the run, because no fix here took the correction, or because it was given back, says so.
- **The builder's records.** A builder that edits the instructions after "right" is recorded as edited; corrections that gave no feedback stay out of its log.

# 0.23.2

Use runtime 0.16.8.

- **A correction's check is blocked only by approved runs of the same inputs.** A sentence such as "return is 14 days" must still pass on runs the person approved, but only on runs of the same request: an approved run of another date or another party may be right because the rule does not apply there. A conditional or dated rule no longer ends "could not test".
- **"Could not test" says why.** When no check could be made from a correction, the fix says so with the reason, instead of saying the run is not on this computer.
- **A winner needs two copies of each agent.** With one copy, Method cannot see how much copies differ, so the answer is "can't tell yet" and the result says why. The rule sentence says at least 2 copies.
- **A feedback writer says what it checked.** It prints {"correction", "checked"}; a writer that leaves out checked checked all of the output. Nothing wrong in one part it checked gives the agent no feedback (no feedback), never "your output is right".
- **Session steps learn rules.** A session step reads its learned rules after its prompt, each with its condition, and Method's fix can teach it learned rules as it teaches call and agent steps.
- **The fix and its checks think on the agent's model.** The case written from a correction and the judges of a Method's cases run on the model of the Method's own agent steps.

# 0.23.1

- **Questions for you on the comparison page.** The page asks the person one question at a time: whether to keep each of the writer's choices, whether the expert would give each correction whose words the writer wrote (an event's new `source` field says "written by us"), whether an assumption is true when its check names a member, and whether to run the trial and the full run. `method publish` and `method run` of a comparison print the answers with the exact edit for the agent (a kept choice goes into `decided_by_you`), and the run does not start while an answer waits for a change of the file.
- **Approvals from the page.** `method run NAME.compare` asks to run the trial, and a yes on the page lets a later run go on without asking, for the trial and for the full run. `method answer RUN_ID --answer '{"start": true}'` (trial) and `'{"go": true}'` (full run) still work.
- Each decision of a comparison names its `decided_by_you` entries.

# 0.23.0

Use runtime 0.16.7.

- **Received and changed are counted apart.** Each comparison line says how many corrections an agent received and how many changed it: "Corrections received: 12 of 12. Changed the agent: 3." A fix that found no fix, or found no change needed, is received and did not change the agent.
- **A correction that the run already meets needs no change.** When every check that Method writes from a correction holds on the corrected run, the fix ends "no change needed: the run already does what the correction asks", without running the fix. A comparison counts it as received instead of stopping.
- **A usage limit stops the fix with the limit.** A usage limit in a replay of a case stops `method test` with the usage-limit error; a fix that meets it stops, and a comparison stops with that reason. It is never "no fix found".
- **A comparison waits until a fix has ended completely.** The later check of earlier corrections and a pruning pass run after a fix's outcome; the comparison records the outcome and freezes a checkpoint only when the Method's fix is over. A fix that the later check undoes is fixed once more in the same fix; after a second undo it ends "no fix found" at once.
- **One correction, one judgment.** A rerun after a fix stopped fixes the same judgment of the same run again. After "could not test", the correction is given again with a new run and judgment, and the old judgment's case is removed.
- **A fix thinks on the agent's model.** The fix's own model steps run on the one model and effort that the Method's agent steps name (in a comparison: the arms' model).
- **The plain builder sees the case.** The session that edits a plain agent's instructions gets the task's files as the agent got them, and every earlier correction in order.
- **The noise that decides.** The trial runs every checking input at the start with 2 copies of each arm and shows the spread; it no longer stops the comparison. The decision says "can't tell yet" when two copies of the same arm differ at the deciding point by as much as the lead. `trial` is gone from the .compare file.
- **A shorter trial.** The trial gives the first copy of each arm only its first 2 corrections (what it received, what changed it, and the time of a fix), then the start grades and checks, then approval. The full run gives the rest.
- **The too easy check covers every measure of shares.** A code measure whose start values all lie from 0 to 1 is checked like a rubric or checklist.
- **Read-only files in a room.** Comparison folders and session rooms with read-only folders are removed without errors.

# 0.22.7

- **A feedback writer writes each correction from the arm's own output.** In a `.compare` treatment, an event can name a feedback writer (`{feedback: WRITER, input}`, with `treatment.feedback_writers`) in place of fixed words. After the event's training run, the writer reads that arm's own handed-in file and the input's hidden expected answer, and never which arm it is, and writes the correction that the arm gets: the note of `method judge RUN wrong` for a Method arm, the correction that a plain arm's builder edits from. A writer is a script (it reads `{input, values, output, expected}` on stdin and prints `{"correction": TEXT}` or `{"correction": null}`) or one Claude judge with your instruction. When it finds nothing wrong, the Method arm gets `method judge RUN right` and the builder reads that the work is right; the event is received as "was right". The page lists the words each copy received. Run, grade and treatment keys include the writer's hash; fixed-text corrections work as before.
- **`decided_by_you` names notes.** `notes.PART` marks the notes of a part as the user's.

# 0.22.6

- **Several Method accounts on one computer.** `method login` always opens the approval page. The account that approves becomes the current account: a new account is added, and an account that this computer already has gets a new credential. The other accounts stay signed in. The single sign-in of an earlier CLI becomes the first account, with nothing to do.
- **Each command uses the account that owns its Method.** A Method or comparison file with an `id:` line uses the account that owns it, whichever account is current: its runs, judgments, fixes, publishes, comparisons, arm copies and learners. Method remembers the owner when it saves an ID, and asks the server once with each account for an ID it does not know yet. A new file uses the current account.
- **`method status` names the accounts.** It shows the current account (person, email and workspace) and lists the other signed-in accounts. `method logout` signs out of the current account only, and says which account is current after it.

# 0.22.5

- **Publish a comparison as a draft for review.** `method publish NAME.compare` saves the comparison to your account as a draft, with its inputs, and prints its page. Nothing runs. The person reviews every part, then a `method run` of the same file continues from that draft. The comparisons guide says to publish the draft and give the user the link before any run.
- **A test that is too easy stops the trial.** With a rubric or checklist measure, when every agent already scores more than 1 minus the margin at the start, no agent can lead by the margin. The trial stops before approval and says so: "This test is too easy to show a difference: both agents already score X and Y before any correction, and the rule needs a lead of M." The page shows it as a trial result.
- **Method's rules have no semicolons.** Each rule on the page is plain sentences.

# 0.22.4

- **A stopped fix is given again.** A rerun of a comparison waits for an old judgment only while its fix is still working or waits for your answer. After a fix stopped or could not test a change, the rerun gives the correction again, with a new training run and a new judgment. The same outcome is not recorded twice.
- **Every trial run has its grade on the page.** A trial run that its cell could not save to your account is saved from its run folder on the next run, without running again. The trial sends its plan with the finished runs' grade keys, so each trial grade links, and a kept grade that the account lacks links again.
- **The estimate does not guess.** Time per correction comes only from corrections that were received; when an agent received none in the trial, its time and the total time are not known yet.
- **What an agent missed, in plain words, once.** One line for the correction that was not received (its words cut at a word), one line for the corrections not given after it, and no step, script or command; the cause's details stay in the CLI output. Method's rules, the treatment note and the guide say agent, copy and correction, name models as people say them ("Claude Opus 5.5"), and show no paths. Each agent "hands in the file that the task names" is the writer's choice on the page.

# 0.22.3

Use runtime 0.16.6.

- **A comparison's clean room keeps a working Claude Code sign-in.** The room links your login Keychain (or credentials file) instead of copying the token, so Claude Code in the room refreshes an expired token itself, and the fix inside `method judge` (and every agent that its scripts start) finds the same sign-in.
- **A learner's frozen copy never takes the learner's place.** A trial that ran a frozen copy (`after-0`) before the learner itself no longer stops the learner's runs with "This Method is saved from …", and every run of a frozen copy is saved to the learner's Method, so the page lists all trial runs.
- **A stopped fix says why in plain words**: what failed (such as "Claude Code is not installed or not signed in on this computer"), with no step or script name and one period.
- **The trial's estimate counts as the page does**: every graded run in all (with those the trial already ran), the treatment events left, and each arm's own time per event, training run and fix or edit included. The noise check sends each arm's start values; usage per correction goes with the estimate.
- **Arms have the names people use**: Method agent and plain Claude Code, on the page, in Method's rules and in the decision. A deliverable such as `work/{{deliverable}}` is "the file that the task names". A plain arm's starting instructions are yours only when `decided_by_you` names `arms.NAME.instructions`.

# 0.22.2

- **Two runs with the same document grade at the same time.** Each grade judges in its own work folder; before, two runs that handed in the same document shared one folder, and the trial failed with "Run is locked". The cached verdicts are still kept once per document.

# 0.22.1

- **A teaching input can have its own folder.** As for a measured input, `inputs/ID/` beside `inputs/ID.json` (one subfolder per files connection) replaces the arm's folders of those names for that input's training runs, for Method arms and a plain arm's builder alike. A training run sees only its own input's folders.
- **`decided_by_you` marks only what the user stated.** The question is the user's only in the user's own words; a rephrased question is the writer's. The comparisons chapter, the field text and `method validate`'s `writer_choices` (now `{reminder, values}`) say so, and the `support-replies` example marks only its arms.

# 0.22.0

Use runtime 0.16.5.

- **Method decides the rules of a comparison that a writer could get wrong.** Every arm runs on the same model and effort (a plain arm takes the Method arm's model; arms that differ are refused unless `tested: model`), in a clean room, with the same task prompt and no web unless `tested: tools`. Every arm hands in the file that `deliverable` names; a plain agent's last message is no output.
- **A plain arm with corrections is a builder.** After each correction, a Claude Code (or Codex) session gets the correction, the task and the wrong output of a training run, and edits the agent's instructions file; the edited file is the arm's state. Appending the correction's words is gone. The builder and Method's fixer each have up to 2 hours per correction.
- **`runs` counts separate learners.** Each learner is its own copy of the arm (a Method learner has its own Method ID, folder and cache) and gets every correction, one at a time. Each checkpoint measures each learner once per input.
- **What happened to each correction, per learner:** fixed, no change needed or no fix found (received), could not test or stopped (not received: the comparison stops), edited or not edited for a builder.
- **One Claude judge** marks each item met, partly or not met, and partly counts as half. It reads every source the agent read in full, in a read-only room. A measure can take its checklist from each input's expected answer (`checklist: expected`), and score only the items that corrections given so far cover (`covered: true`).
- **Noise check:** the trial runs each trial input at the start with 2 learners per arm, and stops before approval when they differ by more than half the margin.
- **Usage per correction** for each arm is shown and does not decide.
- **Who decided each value:** the page shows each value as yours (`decided_by_you`), the writer's, or Method's rule. New optional parts: a measure's `description`, `notes` by part, assumptions with `if_false`, `check` or `limit`, `about_inputs`, and a treatment `seed` for one shuffled order. None of them changes a run.
- **`method authoring comparisons`** teaches the six rules for writing a comparison, with the `support-replies` example. `method validate NAME.compare` lists the writer's choices.

# 0.21.1

- **A comparison's guard compares the winner with the other arm.** At the checkpoint that decides, the winning arm's guard measure must not be more than `max_drop` below the other arm's (with more than two arms, the best other arm's); otherwise the answer is "can't tell yet". Before, the guard compared an arm with its own score at the first checkpoint. The rule sentence says this.
- **Every arm gets the same folder for an input.** An input can have a folder of its own files (`inputs/ID/` beside `inputs/ID.json`, or a case's `snapshot/env/`), with one folder per files connection. For that input, a Method arm and a plain arm both get those folders in place of their own, and nothing of another input's folder. A plain arm's room is built for each run from the same folders as a Method arm's. An expected answer inside an input's folder is refused.
- **A grade that reads earlier runs grades again when one of them runs again.** A grade's key holds the runs of its arm up to and including its checkpoint, as they finished, so a measure that reads earlier checkpoints never keeps a stale number.

# 0.21.0

Use runtime 0.16.4.

- **A correction is judged on what the run made, not on Method's own records.** The prompt, events and transcript that the runtime keeps for each agent attempt are no longer shown to the correction judge as files the run wrote.

- **`method run NAME.compare` runs a comparison.** A `.compare` file asks one question about two or more agents: question, arms (Method files), the one difference, inputs (case IDs or JSON files), one main measure (code, model rubric or person), a fixed decision rule (`{margin, min_runs, at?, guard?}`) and runs per point; optional treatment over time, teaching inputs, other measures, expected answers and assumptions. Method refuses a file with a missing part, arms that share a Method ID, or a rule that cannot say "can't tell yet". It runs a trial, says what each arm received and stops when an arm is short, asks for approval with a time and cost estimate, runs every cell, grades and decides: "ARM is better" or "Can't tell yet", with the reason, the rule as a sentence, what each arm received and n per point. Each Method arm runs as its own copy, with its own Method ID and cache. A rerun reuses finished cells; a changed measure grades again without running the arms. `method validate NAME.compare` and `method schema compare` check and describe the file. A plain Claude Code or Codex arm (`{agent, instructions}`) runs each input as one session in the runtime's clean room, with only its instructions and the input and the same tools as Method's own agent steps; a correction is told to it in its instructions. Method arms, their training runs and their fixes run in a clean room too: a fresh home with only the agents' sign-ins, a short temporary folder, and a copy of each bound folder, so no arm sees the user's CLAUDE.md, memory or settings. The trial lists a readable transcript of each run.
- **A comparison has its page on the dashboard.** `method run NAME.compare` saves the file as a version of its comparison (an `id: cmp_…` line is written on the first run) and reports each stage: the trial with what each arm received and the estimate, the approval, each finished run (saved as a run of its arm) and grade, and the decision. The start line and the result link to the page. A cell is keyed by its content, so a cell that two versions share runs once. A rubric grader reads what the agent saw (the first prompt, each file it read and each tool result, in order) and gives each sentence a verdict (met, partly or not met) with its quote and the transcript line it judged. What each arm received names the models its runs actually used. A plain arm works in a folder with the same files that the Method arms get. For a Method whose run content stays on this computer, only run IDs and numbers go to the account, and the local Method server (127.0.0.1:47130, started when needed) shows the transcripts and verdicts to that account's dashboard.
- **`method answer RUN_ID --answer JSON` answers an ask step of a run on this computer**, such as a comparison's approval, so an agent can pass on the person's answer; the run continues from that step. A later run of the same comparison file does not ask again. `method run --human` is gone; the production worker keeps answers in the run folder the same way.
- **`method test --baseline` answers which version is better** (`comparison: {answer, reason}`): the new one when it fixes a case and breaks none, the old one when it breaks a case and fixes none, else can't tell yet.
- A resumed run (after an ask step) reuses matching steps of earlier runs, as a new run does.

# 0.20.5

`method run`, `method sync` and `method wait` upload a step's file output when the step returns its absolute path inside `$METHOD_OUTPUT_DIR`, as the runtime already accepts. Before, the upload stopped with "The output is outside the run artifacts folder."

# 0.20.4

Use runtime 0.16.3: a live Claude Code agent step may use web search and web fetch, as a Codex step can. A case test (`method test`) still gives the agent no shell and no network.

# 0.20.3

Restore the short three-step agent setup prompt, with explicit approval for the official Method plugin. Remove the Apple/Xcode step and the expanded setup checklist.

# 0.20.2

The shared setup prompt checks Apple Command Line Tools on a new Mac, explicitly approves the official agent plugin, and verifies the CLI and plugin separately. It explains permission approval and using the invited Method account.

# 0.20.1

Uses runtime 0.16.2.

- **A fix is undone only when it breaks a result that was right before.** After a fix, the later check runs the Method's other saved corrections. A correction that no fix has answered yet fails before and after the fix, so it no longer undoes the fix; only a correction that passes on the version before the fix and fails after it does.

# 0.20.0

Uses runtime 0.16.1. A correction gets a real, safe test, the answer comes back in plain words, and what the agent learned stays visible and can be undone.

- **`method judge RUN_ID wrong` returns at once.** It records the correction, starts the fix in its own process (one fix per Method on a computer, as before), and prints `Working on it. I'll test a fix on this run.` A shell time limit no longer loses a fix.
- **`method wait`** (or `method wait JUDGMENT_ID`) prints what the fix did, in plain words: `Fixed: replies now include the redline. Tested 3 times on this NDA and on 2 earlier ones. Undo: method undo.`, `No fix found yet: …`, `Could not test a fix safely: this agent can send email. I added your note as a rule and will check it on the next runs.`, and others. After a fix it prints what the fixed agent gives now, from the test, so the agent never runs a Method that sends things again to show it. It waits up to 100 seconds (`--timeout`); run it again when it says it is still working. The next `method run` of the Method prints the outcomes not yet shown first.
- **Questions.** When the fix needs one answer, `method wait` prints the question. `method answer JUDGMENT_ID "THEIR WORDS"` sends the person's words and starts the fix again with them. The plugin and the authoring guide tell the agent to show the question word for word and never to answer it. The 0.17.2 instruction to ask in chat before recording a correction is removed.
- **A correction is judged on what the person saw.** The case is made from the whole result (a result with several values works now), the files the run wrote, and the messages and calls it made, each with its ref (`result`, `file:PATH`, `effect:NAME`, `outputs.NAME`). A note about form or a missing action also gets a small check script. A sentence is kept only when it fails on the corrected run and passes on every approved run of the same step.
- **Two judges.** When both Claude Code and Codex are signed in, the case's sentences are judged on both (runtime option `judges`), in `method test`, in the fix loop's tests and when a correction's case is made; a sentence the two disagree on fails as unsure.
- **`method learned FILE`** lists the rules the agent learned from corrections, with who taught each one and how often it applied; `--remove NUMBER` retires one. `learned.json` is saved with each version.
- **`method undo [FILE]`** restores the Method, and the files the change wrote, as they were before Method's last fix, pruning change, or removed rule, and saves that as a new version.
- **Fixes are watched.** After a run, its output is judged in the background against the corrections that fixes and rules of the last 30 days answered, with no rerun, and the account gets `{held}` for each. When a problem comes back on 2 runs, the account opens the correction again and the next run says so, with `method undo`.
- **A later check after each fix.** After a fix is applied, the Method's other saved corrections run in the background. When one fails, the fix is undone and its correction waits for a new fix (the next run says so); when the failing one belongs to a rule that a cleanup removed, that rule comes back.
- **Pruning.** After every 5 corrections that a fix answered, or when the agent that runs the fixes changes, the fix runs a pruning pass that removes learned rules and prompt text that no longer change any result. The next run shows what it removed, with undo, and which instructions nothing checks.
- The fix reads improve.method's result as it is: `outcomes` (JSON text, one per correction), `background_cases` and `summary`. A correction marked `again` (another fix changed the same part) is fixed again in the next pass, on the changed file. `METHOD_IMPROVE_METHOD=PATH` runs a local improve.method for development.
- **`method test`** takes `--runs N`, `--min-pass N`, `--live STEP`, `--no-judge-cache` and `--keep-dir DIR`, for the fix loop's real tests.
- **Copies of what a run read stay on this computer.** A case's `snapshot/` folder is never uploaded with a version.
- **Plain lines.** The lines for people no longer name cases, steps, criteria, judges, versions, IDs, paths or run counts: `Gráinne's case dates-conflict` is now `Gráinne's correction ("…")`, and two opposite judgments read `Two people disagree about this result: …`.
- Run records keep the `considered` and `applied` rule IDs of `learned.applied` events, also in the device form.
- The outcomes sent to the account are `fixed`, `no_fix_found` (was `no_change`), `could_not_test` with its reason, `question` with the question, `held`, `not_reproduced`, `not_fixable_here` and `already_changed`.

# 0.19.0

Several people can change, run and correct the same Method at the same time. Nobody loses work, and only a true contradiction stops the work.

- **`method run FILE` always runs the newest version.** Before a run, a fix (`method judge`) or a publish, the file catches up with the newest version of its Method. An unchanged file takes it. A changed file combines it step by step and script file by script file, and one line says whose version it took and which of your changes are kept, for example `Updated to Gráinne's version from 10:42 (changed step judge). Your changes to step claims are kept.` This works for any file with the Method's `id:` line, not only the folder it was saved from. Offline, the file runs as it is, with one line.
- **A true conflict stops before the run.** When you and a teammate changed the same step or the same script file, nothing runs and no file changes. The result has status `needs_you`, both texts of each part, and the line `Gráinne also changed step judge. Combine the two texts in the file, then run again.` The exit code is 2. Combine the two texts in the file and run again: a part whose text you changed since the stop counts as combined, and every other change of the teammate comes in as usual.
- **Combining starts from the version that both sides come from.** The CLI asks the account for the newest version that both your last version and the newest one come from. A version that an earlier CLI kept beside a newer one is combined, not dropped from your file.
- **A save that a teammate's save overtook is kept beside it.** The line says `Saved beside Gráinne's newer version; your next run combines them.`, and the next run combines the two and saves the result on top of the newest version.
- **The automatic merge of account changes and the `.method/conflict-*.json` files are removed.** A change Method makes in the account is a new version, so the next run takes it like any other version.
- **`method run NAME`** runs the Method of your workspace with that name (not case-sensitive), as `method run ID` does. When several Methods have the name, nothing runs and the result lists their names and IDs.
- **A second run waits for the shared state.** While another person's run holds a Method's shared state, `method run ID` says `Waiting for Ryan's run (started 10:02) to finish with the shared state: <link>` once and starts when the state is free. When that run stopped while it held the state, the run stops and names the person who must check it and release it.
- **The same run says when it is already going.** When someone in the workspace is running the same version with the same inputs, one line says who and links to it; the run starts too. Each run record now carries a sha256 of its inputs, except a run whose content stays on devices.
- **Corrections from several people.** A correction of a step that someone changed after the run is not fixed, and the line names who changed it. A fix that passes only by breaking another person's case is held, not applied, and the line names both people. `method judge` shows two opposite judgments of one step as a held pair, and `method judge RUN_ID keep JUDGMENT_ID` keeps one. What the loop did with each correction (fixed, no change, already changed, held) is recorded in the account.
- **Cases name the person who made them.** A new case's author is the signed-in person, and a case made from a correction names the person who made the correction. The save gate and the run's case notice say `Gráinne's case dates-conflict: …`. Cases with no author read as before.
- **Missing keys and files are named.** A run lists every declared key that is not on this computer, each with `method secret set NAME`, before the first step. A step that stops because a file is not on this computer says `This Method reads capture/pages.json. It is not on this computer and is not saved in the Method. Ask Ryan (who saved this version) for it.`
- **A correction joins a fix that already runs on this computer.** One fix at a time runs per Method on a computer. A correction that arrives meanwhile is taken in one more pass of that fix, and its `method judge` prints that correction's own outcome. A fix whose process stopped no longer holds the Method.
- `mergeMethod` and the new `mergeFiles` are exported as `@method-ai-hq/sdk/merge`, so the server combines versions in the same way.

# 0.18.2

Every run that prints a dashboard link sends a record to it.

- **A run whose setup fails sends its failed record.** The run records its start before its setup, so a setup error (for example a damaged `computer.json`) shows on the run's page with its reason. Before, the run kept no account link and the page stayed empty.
- **`method run wf_ID` with an inputs file that cannot be read sends its failed record.** It reads the inputs after it records its start.
- **The start line has no link when the Method file does not load.** Such a run saves no version and can send no record; the error shows in the terminal.

# 0.18.1

Run links work again when a run must first save a new version of its Method.

- **The outbox no longer stops on an error from this computer.** A run folder that the CLI cannot read failed with a local error, and the outbox counted it as a lost connection. After three, it stopped before it sent the new version of a changed Method, so that run sent no records and its dashboard link stayed empty. Now only a lost connection, a stalled transfer, or a server error is retried. Any other failed item goes to the failed list, the CLI says why once, and the other items continue.
- **A run whose inputs file cannot be read sends its failed record.** The run read `--inputs` before it recorded its start, so it had no record to send and its outbox item could never be sent. The run now records its start first and fails with a setup failure record.

# 0.18.0

Uses runtime 0.15.0. Model steps run on your own Claude Code or Codex subscription, and a correction fixes the Method on your computer in one step.

- **Model steps run on your own Claude Code or Codex subscription when one is available.** A step that names no model runs on the agent that called `method` (Claude Code or Codex), else on a Claude Code or Codex that is installed and signed in on this computer. Hosted models on account credit are used only when neither is available. A model that the Method file names always wins.
- **`method config agent` and the `--agent` flag are removed.** The Method file and the agent you work in choose the model; there is no separate setting.
- Scripts get `USER`, `TMPDIR`, and the calling agent's variable (`CLAUDECODE` or `CODEX_THREAD_ID`).
- **`method judge RUN_ID wrong --note "…"` runs the improvement loop in the foreground**, on the user's own Claude Code or Codex (hosted models only when neither is signed in). It records the correction as a regression case in `cases/` (a model writes rule sentences from the note and the run's result, even from vague words, and keeps them only when they fail on the run), finds the step that causes the failure, makes up to three small changes, replays them on the corrected run, every earlier corrected run and approved run, and runs every case once. It changes the file only when a change fixes the run and breaks no earlier correction or case, saves it as a new version (restoring the version before it on the Method page undoes it), and prints one line: what changed and how many earlier corrections it passes, or `No safe change found` and why. `method judge RUN_ID right` records only.
- **Corrections that wait are fixed first.** A correction from the dashboard, or one whose fix stopped, waits in the account; the next `method run FILE` or `method judge` of that Method on a computer fixes it with the same loop and says so in one line.
- **`method improve` and `method apply` are gone.** A change Method made in the account that conflicts with your edits no longer needs `method apply`: the line names the parts, and both versions are saved in `.method/` for the agent to merge.
- improve.method's model requests (the candidate maker, the judges, and replays of model steps) go through the runtime's model choice with `method __model`, an internal command. Every request runs on the one agent that the runtime chooses (the calling agent, else the signed-in one; hosted only when none is). The judge is that agent in a fresh, blind session: it sees the two results in a random order and is not told which one is new. A subscription limit is an error, never a hosted fallback. Usage reports real model calls and minutes; dollars are null on a subscription.
- `method test --once` runs each case once, for the loop's quick check.

# 0.17.3

Methods keep run data in the account unless the user asks.

- The authoring guide and the plugin tell the agent to set `run_data: device` only when the user explicitly asks for it. Before it sets it, the agent gets the user's confirmation and tells them in one line that the dashboard will no longer show inputs or results, and that improvements, Run now and Method Cloud stop working.
- The `support-triage` example keeps its run data in the account. It set `run_data: device` although its task did not ask for it, and agents copied it into new Methods.

# 0.17.2

Uses runtime 0.14.1. A converted agent keeps the user's rules, and a case cannot make the Method break them.

- **`method case new` checks a new case against the Method's instructions.** It reads the instructions of the model steps and the information that each step received on the recorded run. When a rule of the case can be met only by breaking an instruction (for example, the rule needs a fact that the inputs do not give, and a prompt says not to invent facts; or the rule requires what a prompt forbids), it refuses the case with `case_conflicts` and names the rule and the instruction. `--accept-conflict "the person's answer"` keeps the case; `case.json` records the answer and the conflicts.
- The authoring guide tells the agent to keep the user's rules word for word when it converts an agent or a prompt: copy the instruction files unchanged, give their complete text to every model step that applies them, and never reword, shorten, or split them. Before the Method replaces the old agent, the agent runs both on the same 3 to 5 sample inputs and shows the user every difference.
- The correction recipe tells the agent to ask what the user means when their words do not say what the right result is before it changes the Method or records a case, and never to choose a reading that breaks the user's instructions.
- Packages saved with runtime 0.14.0 still run.

# 0.17.1

- `method improve` (for Methods that keep run content on the computer) sends only the note, the step and the run to improve.method; `--case` is gone. An improvement gives a tested change or none; case, rubric and script-description proposals are gone, so `method apply` has no manual step for them.

# 0.17.0

- Uses runtime 0.14.0: `validate` follows text from web pages and services across steps. When it can reach a step that sends or changes things without a question to the person, it reports `untrusted_reaches_action` with the path and a patch that adds the question. This replaces `untrusted_content_can_act`; rename that code in `accept:`.

Method fixes a Method from the person's reactions to its results.

- **`method judge RUN_ID right|wrong`** records the person's reaction to a run's result. `--note` takes their words (at most 4000 characters), `--corrected FILE` the result they say is right (JSON is sent as JSON, other text as text; at most 1 MB), and `--step` the step whose output was wrong. RUN_ID is the `run_id` of the run's start line or the run ID on the dashboard. A wrong judgment makes Method fix the Method in the background: it applies a tested change that the person can undo, or changes nothing. The command prints one line, for example `Recorded: wrong on step choose. Method is fixing it in the background.`; `--json` prints the judgment.
- **`method changes FILE`** lists the changes that Method applied to a Method: the date, the version, and the cause of each. Commands that take a signed-in FILE still merge a new change into the file first and print one line. `method proposals` and its `--wait` are removed.
- **`method improve FILE` is for Methods that keep run content on this computer** (`run_data: device`, or an organization that keeps run content on devices). It runs the improvement on this computer as before, and `method apply FILE` merges its proposal. For a Method that keeps run content in the account, it starts nothing and says to record the person's reaction with `method judge`.
- **`method apply`** merges local proposals. It no longer takes the newest accepted proposal from the account; give it the ID that a conflict line names to merge a change that Method applied.
- The plugin and the authoring guide tell the agent to record the person's reaction with `method judge` after it shows a result, without asking the person to confirm it, and then to continue with what they asked.
- **A new check, `undeclared_change`,** looks for a step that can send or change something (a message, a post, a record in a service, a file outside its output folder) that its `changes` and effects do not declare. For a script step, code analysis decides when it finds a network host or a write, with no model request; when the script uses a library that can send or runs a command, Jev answers one yes/no question. An agent step with tools gets one question. The check starts in shadow mode: its answers are recorded on this computer and not shown, until its precision on the labeled set is measured.

# 0.16.0

A failed run says what went wrong, whose problem it is, and what to do next (runtime 0.13.0).

- **One failure record.** A run that stops has `failure` in its result, its `summary.json`, and its dashboard record: `owner` (whose problem it is: the Method's code, the agent's work, a service outside Method, a limit, your setup, your answer, or Method itself), `code`, a one-sentence `headline`, the step, its name and the failed tasks, the phase and check, `next` (an action and one sentence, sometimes a command), and the `evidence`, `details`, and `diagnostics`. The top-level `code`, `error`, `failed_step`, `iteration`, `diagnostics`, `fix`, and `recovery` fields are gone. A run that waits for an answer has `failure.next.text` that says to ask the user.
- **Three plain lines for a failed run.** `method run` prints `Failed:`, `Whose problem:`, and `Next:` on stderr. The JSON on stdout keeps its form.
- **`method wait` ends with the run's status** (`succeeded`, `unconfirmed`, `waiting_for_you`, or `failed`) and the headline of a failure, not `finished`.
- **Run records use the runtime's statuses.** An inspection has `status` `running`, `waiting_for_you`, `succeeded`, `unconfirmed`, or `failed` (no `needs_attention`) and the failure record (no `error`). The failed tasks of the failed step are `failed`; other tasks that were running when the run stopped are `stopped`, with no copied error. Only the final run event gives the run a duration. Events keep a task `total` without a count, and notices keep their `key`, `attempt`, and `attempts`. A `run_data: device` record keeps the failure record without its evidence, details, and diagnostics.
- **The runtime gives the agent one more attempt after a failed check** of an `agent` or `call` step with no `changes` or `effects`, with the check's reason and evidence in the prompt. The run records `step.retry`. A failed task of a parallel `each` step no longer stops the other tasks; the step fails after they end, with all failed tasks in `failure.failed_iterations`.
- **Notices.** The run records a `notice` event for each retry of a model or service, each error or warning that Codex or Claude Code reports, and a limit that is 80% used. Each user-facing event has a plain `message`.
- `ownerText(owner)` from `@method-ai-hq/sdk/inspection` gives the words for each owner.
- The authoring guide tells the agent to read `failure.headline` and `failure.next` when a run fails.

# 0.15.1

- The start link of a saved Method's run opens the run. Its records now use the run ID of the start line, so the page no longer waits for a record that never comes.

# 0.15.0

- **Run again with the inputs of an earlier run.** `method run FILE|ID --inputs-from RUN_ID` uses the inputs of that run. `--inputs FILE` given with it replaces single values. The inputs of an account run come from the account. The inputs of a `run_data: device` run come from its run folder on this computer (in `.method-runs` here and beside the Method, and in the CLI's run cache), found by its dashboard run ID; so do the inputs of any run when the account cannot be reached. When no run has the ID, the error says where it looked.
- **A device run says which phase failed.** A run with `run_data: device` keeps the phase of its failure and of each step's failure (environment, input, action, check, or change) in the record it sends to the dashboard, so the dashboard no longer says that the cause was not recorded. The expected and observed text, the evidence, and the error message stay on this computer.
- **`method proposals` says when an improvement found no safe change.** When the newest improvement has no proposal and its outcome is `none`, the printed `improvement` has `outcome: "none"`, and `next` says to add a note on a run with `method improve FILE --note TEXT` or to record a case with `method case new`. `--wait` returns with the same result.
- The authoring guide and the plugin tell the agent to give each Method a `run_label` that tells its runs apart (the resolved value when a default picks it), to put the readable output in `result`, to write a `run_prompt` that says where each input comes from and what to show, and to use `--inputs-from RUN_ID` for a "Run again" prompt from the dashboard.

# 0.14.6

- **A run links to its dashboard page from the start.** When this computer is signed in, the start line of `method run` has `dashboard`, the link to the run's page. The final result and the last line of `method wait` have it too. Before the run's first record arrives, the page waits for it. The `Dashboard:` line on stderr is gone.
- The authoring guide and the plugin tell the agent to give the user the link as soon as the run starts.

# 0.14.5

- A Method file in JSON keeps its home: a copy no longer takes over the home of a JSON Method file.

# 0.14.4

A Method keeps working when Method changes, with nothing for the user to do or to answer.

- **The CLI updates itself.** An installed CLI checks for a newer release at most once a day and installs it in the background, with no message; the next command uses it. The Method plugin also updates a CLI that is older than the plugin when a session starts. `METHOD_NO_UPDATE=1` turns this off. `method status` and `method run` no longer print an update notice.
- **A resume uses the release that started the run**, so a run that waits on an ask step continues after an update.
- **Older Method folders convert themselves.** `method run`, `method validate` and `method get` move a `runtime.json` and a `FILE.method.json` into the Method (format 3.4) and delete them: profiles become `models` (a direct OpenAI or Anthropic profile becomes the same model, hosted), limits become `limits`, folder paths become this computer's bindings. When the result would not validate, nothing changes and validate reports `older_format`. `method get` of an older saved version now gives a file that runs.
- **One file for each Method on a computer.** Versions are saved from one file (all checkouts of one Git repository count as one). A copy in a temporary or another folder does not run while that file exists, and the error names the file. When that file is unchanged since its last save and the account has a newer version, a run takes it first, with no message.
- **A run that waits for a person shows the question.** The `needs_input` result has the `question` text and its answer form, and the fix says to ask the user. `--human` accepts `"STEP"` for the first iteration.
- `method validate` names the local agent for model steps when this computer runs them with one.
- The authoring guide and the plugin tell the agent to talk about the user's work, not Method's versions, files, or settings, and to run a Method to show that it works.
- The Method plugin no longer puts the CLI version in the session context.

# 0.14.3

- The Python package is now `method-ai` on PyPI (`pip install method-ai`); the import stays `from withmethod import Method`.

# 0.14.2

- The Python library works with Method's production server: it names itself in each request (`withmethod-python/<version>`), because Cloudflare refuses the default Python user agent.

# 0.14.1

- The npm package is now `@method-ai-hq/sdk` (was `@withmethod/sdk`). Update imports and install lines.

# 0.14.0

A first Method needs fewer steps, no keys, and no extra commands (runtime 0.12.0).

- **Method plugin for Claude Code and Codex.** The installer adds it to each of these agents that it finds, so later sessions know Method. By hand: `claude plugin marketplace add method-ai-hq/method-sdk && claude plugin install method@method`, or `codex plugin marketplace add method-ai-hq/method-sdk && codex plugin add method@method`. It installs the CLI on first use and starts the guide when the user asks for repeated work.
- **Sign in first; hosted models.** Signed in, `call` and `agent` steps without a configured profile use a hosted model through the Method account, with no key and no local agent. Each account has a model credit. Not signed in, runs use a local agent as before.
- **Each prompt is a step.** `method validate` warns when a script calls a model API (`script_calls_model`); it never refuses the Method.
- **Keys stay on this computer.** Declare `secrets:` with names and purposes. `method secret import FILE NAME...` copies values from a file; `method secret set NAME` opens a private form in the browser; `method secret list` shows where each one is found. A missing secret stops the run before its first step. Replaces `runtimes.*.env`.
- **Versions save themselves; `method publish` replaces `save`.** A signed-in run of a local file saves a version when the file changed and sends the run to the dashboard. `publish` runs the cases and marks a version published. `create`, `save`, and `update` are removed.
- **Unchanged steps are reused.** A new run reuses each iteration whose definition, inputs, and executed files match an earlier accepted run on this computer. `--rerun STEP` and `--fresh` run steps again. `--from-run` and `--reuse` are removed.
- **`run_data: device`** keeps run content on this computer; the dashboard shows the run's steps and timing.
- **Private runs.** Hosted model and classifier requests go only to providers that do not train on them and keep no copy (`model_not_private` when a model has none); the organization setting "Keep run content on devices" (off by default) makes every run work as `run_data: device`; secret values are redacted in every run file, `checkpoint.json` too (runtime 0.12.0); run folders under `~/.cache/method/runs` unchanged for 30 days are deleted when a run starts.
- **Clearer failures.** A failed run reports `failed_step`, `iteration`, `diagnostics`, and `fix`, also when it fails before its first step. A classification that the service briefly cannot answer gets three attempts. Saving a version waits up to two minutes.
- The default `method authoring` guide is short and starts with the rules for a first Method, with a field reference; `method schema` without a name prints the same reference. `method validate` lists each step with its runner and the secrets it needs. An `each` step whose `in` repeats the item names the fix. The installer adds the CLI to PATH. `METHOD_SERVER` selects another server.
- **Put a Method in your app.** `method connect APP_FOLDER` writes a service key to the app's `.env` (never shown), publishes the Method if needed, and prints the install line and code for Node or Python. `method.run(...)` starts a worker in the app's process on first use; without `METHOD_API_KEY` a laptop uses the CLI sign-in. `ask` steps work in production: the run waits with no process held, the app's `onAsk`/`on_ask` handler (or a `needs_input` webhook) answers, or else the team inbox and an email with a one-time link; `method answer RUN_ID` answers from a computer. The run waits until it is answered, unless the step sets `limits.timeout_ms`. For `run_data: device`, inputs, questions, answers, and the saved run folder are encrypted with a key derived from the app's key, so the server stores only ciphertext.
- `method status` and `method run` name a newer release, checked once a day.
- **Classify answers yes/no and scores.** Besides `options`, a classify step takes `answer: yes_no` (value `{answer, probability}`) or `levels: [LOW, ..., HIGH]` (2–10 ordered names; value `{level, score, probabilities}`, where score is the expected level index).
- **Classification through OpenRouter.** Jev now runs through OpenRouter: the Method account uses the organization's OpenRouter key, so classification and hosted models share one model credit, and its cost appears in `usage.cost_usd`. A key in the environment alone no longer changes where classification runs (`TYPESAFE_API_KEY` is gone).
- **Your own OpenRouter key.** `method config model-key` opens a private form for `OPENROUTER_API_KEY` (the value stays in this computer's secret store). Then every hosted model step and every classify step on this computer calls OpenRouter with that key, and the run says "Using your own OpenRouter key". `--off` goes back to the account's model credit.
- **No runtime.json.** Models, limits (`limits`, `limits.step`), and tools are in the Method (format 3.4). `method validate` and `method run` stop with `legacy_runtime_json` or `legacy_sidecar` when a runtime.json or FILE.method.json is next to the Method, and the fix says what to move where; validate changes no file. A step `model: NAME` that is not in `models:`, not a model ID, and not `default` is the error `unknown_model`.
- **`method test` and `method case new` judge with the account's model** when this computer is signed in; `--agent` still selects a local agent.
- **`method deploy` is removed.** Production runs use `method connect`, `method worker`, or Method Cloud (`method publish --cloud`).

# 0.13.1

- Fix items that run at once: they wrote `state.json` through one shared temporary file, so a run could fail under load (runtime 0.11.1).

# 0.13.0

- **Run items at once.** Add `concurrency: N` (1–32) to an `each` step to run up to N items at the same time, for example a classify or `call` over many records. The operator limit `max_concurrency` (default 8) caps it. The step cannot use `ask`, `changes`, or `effects`. Outputs keep item order. The first failure stops the other items; resume runs only the items that did not finish (runtime 0.11.0).
- **Call Anthropic and OpenRouter directly.** New model backends `anthropic-messages` and `openrouter-chat` sit next to `openai-responses`. A `call` or tool-using `agent` step uses the provider's API without an agent process. Each backend has a fixed endpoint; the profile names the key's environment variable (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`), `model`, and `max_output_tokens`.
- **Use your own Typesafe key.** With `TYPESAFE_API_KEY` set (or `classification.api_key_env` in runtime.json), classify steps call Typesafe directly: no Method sign-in, and no Method allowance. The key is redacted from run records.
- Run Methods saved with SDK 0.12.x (runtime 0.10.0).

# 0.12.1

- Run Methods saved with SDK 0.11.8 (runtime 0.9.5). SDK 0.12.0 refused their packages and asked for an update.

# 0.12.0

- Method 3.3 (runtime 0.10.0): the runtime confirms external changes by reading the changed system, not by trusting a receipt.
  - **Local files need nothing.** For a `files` connection in `changes`, the runtime reads the folder before and after the step, records the changed files, keeps a copy of what the step wrote, and fails the run when the step returns a path that did not change. A step with nothing to save may change nothing.
  - **Other connections** (a service, email, a browser that sends) need an effect or a one-sentence `no_effect_reason`. Built-in observers need no script: `http` (JSON fields, `increases` for a trend), `sqlite` (read-only; extra rows are a duplicate), and `file`. Effects default to one reading at once, a 1-minute horizon, positive proof, and the changed connection read-only. A contradiction fails the run; no confirmation by the horizon makes it `unconfirmed` (exit code 3).
  - `changes` defaults to none. `method observe` makes later readings, for example a bounce a day later.
- **Corrections become cases**, handled by the user's own coding agent: fix the Method, run it again, and on the user's yes record the rule with `method case new FILE --id ID --run BAD_RUN --passing-run GOOD_RUN --note "..." --rubric "plain sentence"`. The case must fail on the bad run and pass on the good one. A rubric is judged by a model with quotes that must exist in the output, 3 votes, cached; a classification judge is used only where it agrees with the examples.
- `method test` replays the cases: every case must pass. Unchanged steps return recorded outputs; written folders become scratch copies; only the steps a case needs run; cases run in parallel and stop early.
- `method save` (and `update`) refuse a version that breaks an approved case, unless `--accept-failing-case ID --reason TEXT` is given; the version records the result. `method run` notes when the cases were not checked since the Method changed.
- `method effect list|add` with the reviewed `mail.delivery` observer (IMAP, read-only).
- A case with a live model step runs three times by default, and a rule kept only sometimes is reported as unreliable. `method save` says how many cases it checks, then the time, live model steps and judge calls. `method case new` warns when `cases/` (which holds run data) would be committed to Git.
- A saved Method whose run ends `unconfirmed` now releases its shared account state.
- Observed folders are listed in about a second; a folder over 20,000 files or 3 seconds is reported once as not observed.
- Clearer errors: schema errors name the field and explain a YAML comma in `{ }`; an input that shares a name with an output names the step. `method validate` shows managed runtimes as a note. A run that waits for an effect reading shows progress.
- Examples use Method 3.3. New smallest example: `notes-summary`. The ticket example confirms its ticket with the built-in `http` observer.
- The guide treats local runs as the normal path, explains effects with one short example, and gives the correction loop as a recipe.

# 0.11.8

- Add `method run FILE --from-run RUN_DIR --reuse STEP[,STEP]`. A new run reuses accepted steps of a stopped or completed run when their definition, referenced inputs, model, tools, entrypoint files, and runtime are unchanged. The run records `forked_from`, and the run page shows reused steps (runtime 0.9.5).
- A failed run's recovery text names the steps that a fork can reuse.
- Tell authors to test later scripts on saved inputs before an expensive step, and to fork after a fix to steps that were not accepted.

# 0.11.7

- Default authoring to no additional task check. Require a concrete task purpose for each added check.
- Tell authors and repair agents to delete unnecessary checks and their supporting tests and instructions.
- Show summary and research designs without automatic checking steps, and explain the check-free routing example.
- Report declared-check failure without claiming that the output is wrong (runtime 0.9.4).

# 0.11.6

- Guide browser research authors to select Method's browser connection and use the existing social-briefing example.

# 0.11.5

- Replace the input-only run label field with `run_label`, a reference to a saved input or step output. Runtime 0.9.3 validates the reference.

# 0.11.4

- Guide authors through execution choices, step boundaries, and a concise proposal before consulting complete examples.
- Include three contrasting design outlines and require reading authoring guidance before proposing a Method.
- Move account sign-in to the save stage in the shared setup prompt.

# 0.11.3

- Support method-owned `run_label_input` with runtime 0.9.2. Existing methods remain valid.

# 0.11.2

- Preserve authored classifier option order in saved document and package identities, so an order-only change creates a version.

# 0.11.1

- Preserve total run duration in inspection and sync.
- Use runtime 0.9.1 with complete run metadata types and explicit cancellation and iteration-ID checks.

# 0.11.0

- Add Method 3.2 classification through the Method account, with a saved model version and one request per invocation.
- Require script descriptions and record stable operation IDs for retry. Preserve run start time, device, classifier usage, and attempt-specific evidence in inspection.
- Ship four complete authoring examples. Select one by structure with `method authoring example EXAMPLE_ID`; the general guide shows the catalog.
- Include an offline ticket recovery test that proves retry creates no duplicate and reuses accepted classification.
- Use runtime 0.9.0. Existing Method 3.1 definitions remain supported.

# 0.10.9

- Remove the sample briefing README from the source folder and start reading at the timeline.

# 0.10.8

- Preserve complete Claude result events within the existing process output limit.
- Check Linux worker processes without requiring ps; retain macOS process checks. Report inspection errors instead of claiming a worker stopped.

# 0.10.7

- Deploy writable folders from their completed-run contents into persistent runner storage.
- Keep runner changes on repeated setup, later runs, and container recreation. Local originals remain unchanged.

# 0.10.6

- Clarify that visible browser tasks return to headless mode.

# 0.10.5

- Omit Node development headers and documentation from standalone CLI downloads. Keep Node, npm, and licenses.

# 0.10.4

- Accept dependency-free Node packages during run setup.

# 0.10.3

- Remove reference photos and the old website archive from the briefing example. Read the complete approved report directly.
- Remove the unused website inspection tool and its Playwright dependency.
- Ship compiled SDK code and one copy of the example; development source remains in the public repository.

# 0.10.2

- Stop the active step when a browser connection fails. Keep normal action failures available to the agent.
- Preserve the original run error if browser cleanup also fails.
- Use executor 0.8.2.

# 0.10.1

Use the calling Codex or Claude agent ahead of a generic configured default. Honor explicit agent selection and preserve it throughout a run. Remove the native Claude turn cap.

# SDK 0.10.0

Run browser steps through the local browser-use library with the existing Codex or Claude agent. Supply its standard tools from one browser declaration. Use headless Chrome by default and copy the last-used Mac Chrome profile to reuse sign-ins. Keep each run separate and export only visited sites.

Prepare deployment from a successful run. Review the exact files, inputs, dependencies, account access, and target once before transfer. Use the same SDK and executor on the Docker runner, check access, and retain private sessions for later runs. Saved stateful Methods use the existing shared state and lock. Stop for unsupported local services and writable folders.

Support saved runtime 0.7.2 after its upgrade checks. Keep the full daily briefing one-shot unchanged.

# SDK 0.9.4

Run saved packages from tested runtimes 0.7.0 and 0.7.1 without saving replacement Methods. Record the actual executor version and require that exact version before resuming unfinished work, including before SDK setup and shared-state access. Completed results can still be uploaded after an upgrade. Clarify connection access and operation order in the execution guide; keep the complete one-shot unchanged.

# SDK 0.9.3

Select the calling agent without a machine-wide remembered preference. Ask for a choice when the caller is unclear and both agents are available. Keep the selected profiles when a run resumes, and reject checkpoints that have lost that selection. An explicit --agent selects unconfigured profiles ahead of the configured default.

# SDK 0.9.2

Keep the complete daily briefing one-shot in `method authoring`, with its recorded request, YAML Method, and full approved report in order. Remove report-specific instructions from the general guide and edit history from the example. Declare the writer's source check in the Method and keep sample inputs separate from saved files. Include the new sample run and its actual output.

# SDK 0.9.1

Include the declared runtime.json in the installed daily briefing example. Check all declared example files in the packed release.

# Changes

## 0.9.0

Use method/3.1 and the current runtime. Removed old format conversion, runtime-version dispatch, old account credential lookup, Builder report payloads, ZIP result payloads, and old example document parsing. The installer installs the current release.
