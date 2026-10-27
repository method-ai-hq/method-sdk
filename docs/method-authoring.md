<!-- Generated from packages/sdk/src/method-help.ts. -->

# Build a Method

1. **Sign in first.** Run `method status`. If it is not signed in, run `method login` and let the user approve in the browser. Signed in, model and classification steps need no keys, each run saves a version when the file changed, and runs appear on the dashboard.
2. **Each model or classifier request is its own step**: `call`, `agent`, or `classify`, with its prompt in the Method, so the user can change one prompt, run again, and compare. A script never calls a model API. When the user already has code that does the work, keep its fixed logic as `run` steps and move each prompt and rubric into its own step; do not wrap the code. "The same thing" means the same behavior in steps. If a request cannot become a step because Method lacks a feature, tell the user what is missing.
3. **Show the design, then build it in the same turn.** Show each step with its type, purpose, and output, and a table of the prompts, instructions, and rubrics in the user's existing work, each with the steps that receive it. Do not wait for approval unless the user asked to approve first. Ask only for information that you cannot find and that would change the design.
4. **Run early and often.** Write the first steps, validate, run, then add the next steps. Fix errors. Fix each warning, or accept it with the user's reason. Never add a check only to remove a warning. A new run reuses every step whose definition and inputs did not change, so each run executes only what changed. `--rerun STEP` runs a step again anyway; `--fresh` runs every step.
5. **Keep the inputs of the existing code.** If the code takes an ID and looks up the record, the Method takes the same ID and looks it up the same way.
6. **Keep the user's rules word for word.** When you convert an agent, a prompt, a playbook, or a guide that the user wrote, copy each of their instruction files unchanged beside the Method and list them in `files`. A run step reads them and returns their complete text, and every model step that applies them receives that text in `in`. Each step prompt says the step's own task and tells the model to follow every rule in that text. Do not reword, shorten, summarize, or split the user's rules, and do not leave one out as background: a reworded rule can change its meaning, for example when a condition ("only when", "unless", "after") or an exception is lost. In the table of rule 3, list each instruction file with the steps that receive it.
7. **Compare with the old agent before the Method replaces it.** Choose 3 to 5 sample inputs from the user's data, including the hard ones. Run the old agent as the user runs it and run the Method on the same inputs, and show the user every difference side by side. Fix each difference that the user does not accept, and run again. Do not say that the Method replaces the old agent, or does what it did, until the user has seen this comparison.
8. **Use the defaults without asking.** Model steps that name no model run on the user's own Claude Code or Codex subscription when one is signed in (hosted models on account credit only when none is), and `classify` uses Method's classifier, so no model or classifier keys are needed. To keep the model that existing code uses, add `models: {writer: provider/model}` to the Method and use `model: writer` in the steps (or `model: provider/model` on the step); it needs no key. Keep the models that the Method or the existing code names: when a model step fails, show the error and ask before you change its model. Run records go to the user's account. Set `run_data: device` only when the user explicitly asks for it. If they do ask for it, get confirmation from them and tell them in one line that the dashboard will no longer show inputs or results, and that improvements, Run now and Method Cloud stop working.
9. **Keys stay out of chat.** Declare each key that a script needs under `secrets:` with its purpose; every script of the Method receives all of its declared secrets. Run `method secret find` in the Method's folder: it lists the key files nearby and the names in each, never the values, and prints the import command. Run that command and tell the user which file each key came from: the key stays on this computer, so there is nothing to ask. If it finds nothing, ask the user to run `method secret set NAME`, which opens a private form in their browser. Never open, print, or search a key file (`cat`, `grep`, an editor), including Method's own secret store, and never ask for a value in chat: the values would go into the chat. When a run says Method's model credit is used up, run `method config model-key` yourself: it takes the user's own OpenRouter key from the one nearby key file that holds it, or opens a private form for it. Then run again.
10. **Choose a sample yourself** from the user's data, and check that it has the sources the Method needs. Ask only when there is no good sample.
11. **Iterate.** `method run` prints a `dashboard` link when the run starts and again with its result. Give the user the link as soon as the run starts. After a good run, show the result and the link, and ask what to change. Change the step and run again. Show only results that a run made: never write or edit a result by hand, and fix a wrong result in the Method, not in the data it reads. If you cannot run, say so.
12. **Publish** with `method publish FILE --reason TEXT` when the user wants to share or schedule a version. It runs the Method's cases first.
13. **Talk about the work, not about Method.** Unless the user asks, do not mention Method's versions, formats, settings files, or other internal files, and do not ask the user about them, about models, or about which saved version to use. Method updates itself and converts older Method files when it runs them. When the user asks whether a Method works, or asks you to make it work, run it with the inputs of a recent run (`--inputs-from RUN_ID`) and show the result and the dashboard link in a few sentences. Say that it works only after a run completed.
14. **One file for each Method.** Change and run a Method in its own file. Do not copy it to a temporary or other folder to change it: Method does not run or save the copy while the Method's file exists, and names that file.
15. **Questions in a run are for the user.** When a run stops with `needs_input`, ask the user its `question` in plain words, wait for the answer, and continue the run with it as the output says. Never answer it yourself.
16. **Make each run easy to find and to run again.** Give the Method a `run_label` that tells its runs apart, such as `inputs.topic`. When an input can be empty and a default picks the value, point `run_label` at the step output that holds the resolved value, not at the input. Put the readable output, such as the report text or the message, in `result`, not only in files. Write a `run_prompt` that says where each input comes from (for example "as_of is today's date in YYYY-MM-DD") and what to show at the end. Leave SDK, runtime, and version details out of it.
17. **Run again from the dashboard.** When the user pastes a "Run again" prompt from the dashboard, run with `--inputs-from RUN_ID` and change only what the prompt names: put those values in a file and add `--inputs FILE`.

When a run fails, read failure.headline and failure.next, change what they name, and run again.

# Write each prompt

- **One task per prompt.** If a prompt says "then" or has several jobs, make several steps. Split the tasks, not the user's rules: every step that applies them receives all of them, word for word.
- **Say what to do.** Leave out background that does not change the output. The user's own rules and instructions are not background: pass them unchanged as an input, and do not restate them in your own words.
- **Show 1 to 3 examples of good output.** Take them from the user's work: examples in an existing prompt, a past output that the user approved, or the first run that the user accepts. Pass a long example as an input, not as text in the prompt.
- **Put the output shape in `out`**, not in the prompt.
- **Say what to do when the input does not have the answer**, for example "leave due empty". For classify, add an option such as `unclear`.

Before:

```text
You are an expert support analyst with years of experience. Our company values clear
communication. Read the tickets, decide which ones are urgent, write a summary, and
return JSON with a "summary" key. Make it good.
```

After (urgency is a classify step before this one; the shape is in `out`):

```text
Write a five-sentence summary of this week's support tickets for the team.
Start with the high-urgency tickets. Quote no customer names.
Write it in the style of this summary from an earlier week:

{{example}}
```

# A complete small Method

```yaml
format: method/3.4
name: Weekly ticket summary
goal: Score this week's support tickets by urgency and write a short summary for the team.
inputs:
  week:
    type: text
    description: Monday of the week to summarize, as YYYY-MM-DD.
  example:
    type: text
    description: A past summary that the team liked. The summary step copies its style.
secrets:
  HELPDESK_TOKEN: Read-only token for the help desk export.
steps:
  read:
    name: Read the tickets
    purpose: Downloads the week's tickets from the help desk export and returns each ticket's id and text. Changes nothing.
    in: {week: inputs.week}
    do: {kind: run, runtime: python, entrypoint: read_tickets.py}
    out:
      tickets: {type: list, fields: {id: text, text: text}, description: The week's tickets.}
  urgency:
    name: Score urgency
    each: {ticket: tickets}
    concurrency: 8
    do:
      kind: classify
      question: How urgent is this support ticket?
      options:
        high: High - a customer cannot work, or data is at risk.
        normal: Normal - a problem with a workaround.
        low: Low - a question or a request.
        unclear: Unclear - the ticket does not say enough to tell.
    out: urgency
  join:
    name: Join tickets and scores
    purpose: Gives each ticket its urgency. Marks a ticket unsure when the choice is unclear or its probability is below 0.7. Changes nothing.
    in: {tickets: tickets, urgency: urgency}
    do: {kind: run, runtime: python, entrypoint: join_scores.py}
    out:
      scored: {type: list, fields: {id: text, text: text, urgency: text, unsure: boolean}, description: Each ticket with its urgency.}
  summary:
    in: {scored: scored, example: inputs.example}
    do:
      kind: call
      model: default
      prompt: |
        Write a five-sentence summary of this week's support tickets for the team.
        Start with the high-urgency tickets. Quote no customer names.
        End with "Check these:" and the ids of the unsure tickets, or "Check these: none".
        Write it in the style of this summary from an earlier week:

        {{example}}
    out:
      summary: {type: text, description: The summary for the team.}
result: summary
```

What this example shows:
- **One task per step.** The classifier only scores urgency. The script applies the 0.7 rule. The call only writes.
- **An example output.** The `example` input is a past summary that the team liked. One real example makes the style clear in fewer words than a description of it.
- **A way to say "I do not know".** The `unclear` option and the 0.7 rule mark tickets for a person to check, so a guess is not hidden.
- **The output shape is in `out`**, not in the prompt.

`read_tickets.py` reads HELPDESK_TOKEN from its environment. The classify and call steps use the Method account, so they need no key.

```sh
method validate tickets.method
method run tickets.method --inputs inputs.json   # prints the run's dashboard link at the start and with the result
# change the summary prompt, then:
method run tickets.method --inputs inputs.json   # reuses read, urgency and join; runs summary
```

# Watch it

- Look at failed and unconfirmed runs on the dashboard. A run that needs attention says which step failed and why.
- For classify, watch how often the choice is `unclear` or below your threshold. A rise means the inputs changed.
- For slow effects such as email delivery, schedule `method observe --pending`.

# After it works

- **Put it in an app:** `method connect APP_FOLDER` publishes it and prints the code to add.
- **Record each reaction:** after you show a result, run `method judge RUN_ID wrong --note "THEIR WORDS"` (with `--corrected FILE` when they gave the right result) when the user corrects it or asks to change the Method because of it, and `method judge RUN_ID right` when they use or approve it. Do not ask them to confirm it, and do not edit the Method yourself for the same correction. A wrong judgment returns at once and tests a fix in the background with the user's own Claude Code or Codex. Run `method wait` for the result and tell the user its line. After a fix, show the tested output that `method wait` prints; never run a Method that sends or changes things again just to show it. When it prints a question, show it to the user word for word, never answer it yourself, and send their words with `method answer JUDGMENT_ID "THEIR WORDS"`. `method learned FILE` lists what the agent learned from corrections; `method undo` restores the Method as it was before Method's last change.
- **Explain the scripts:** `method explain FILE` writes a card for each script step.

# Field reference

```text
format: method/3.4
name, goal          text
inputs              {NAME: DATA}           values the run receives (--inputs FILE)
secrets             {NAME: purpose}        keys that scripts receive as environment variables
environment         {NAME: {type: files | service | browser | desktop | tool, description}}
files               [PATH]                 helper files that scripts import or read
steps               {ID: STEP}
result              REF, or {NAME: REF}
run_data            account (default) | device   device only when the user explicitly asks; it turns off dashboard results, improvements, Run now and Method Cloud

DATA   {type: text | number | boolean | record | list | file, description,
        fields: {NAME: TYPE}   (a record, or a list of records)
        items: TYPE            (a list of one type)
        default: VALUE}        A bare type such as text works inside fields and items.
REF    inputs.NAME | an output NAME | NAME.field | state.NAME | environment.NAME

STEP   name, purpose          give a run step both; purpose states its rules, result, and external changes
       in: {ALIAS: REF}       the values that the step receives
       each: {ITEM: LIST_REF} run once per item; ITEM is given to the step, so do not repeat it in in
       concurrency: 1-32      items at once, for an each step that changes nothing
       when: BOOLEAN_REF      after: ID or [ID]      repeat: {max_iterations, until: BOOLEAN_OUTPUT}
       do: one of
         {kind: run, runtime: python | node, entrypoint: FILE, args: [...]}
             reads one JSON object (its in) on stdin, prints one JSON object (its out); files go under $METHOD_OUTPUT_DIR
         {kind: call, model: NAME, prompt: TEXT}
             the step's in go to the model as JSON; {{ALIAS}} puts a text, number, or boolean value into the prompt
         {kind: agent, model: NAME, prompt: TEXT, tools: [TOOL]}
         {kind: classify, question: TEXT, options: {ID: description}}   value: {choice, probabilities}
         {kind: classify, question: TEXT, answer: yes_no}                value: {answer, probability} (of yes)
         {kind: classify, question: TEXT, levels: [LOW, ..., HIGH]}      value: {level, score, probabilities}; 2-10 levels
             Do counting, math, and date comparisons in a run step; the classifier reads the question literally. Choose thresholds from a few labeled samples.
       ask: TEXT              in place of do: a question for the user
       out: {NAME: DATA}      (classify: out: NAME)
       changes: [state.NAME | environment.NAME]; a service change needs effects or no_effect_reason
       check, limits: {timeout_ms, max_model_requests, max_agent_turns}
       accept: {CODE: reason}   keep a warning or note with the user's reason

models: {NAME: provider/model | {model, max_output_tokens, reasoning_effort}}   hosted models; no key. A step without model runs on your Claude Code or Codex, else the account default.
        NAME: {agent: codex | claude, model, reasoning_effort}   a step with model: NAME runs on that local agent (it must be installed).
limits: {timeout_ms, max_model_requests, max_invocations, max_tool_calls, max_concurrency, ..., step: {timeout_ms, max_agent_turns, max_model_requests}}
tools:  {NAME: {description, in, out, run, effects}}   script tools that agent steps list in tools
id: wf_...   written by the CLI at the first signed-in save; keep it. method new-id FILE makes a copy a new Method.
Connections: a files connection uses the folder NAME beside the Method, or method bind FILE NAME --file PATH (this computer only).
Issues: errors block; warnings and notes do not.
```

`method schema method` prints the complete JSON schema.

# Choose the design

| Requirement | Step type |
| --- | --- |
| Fixed rules, calculations, file changes, or an API that is not a model | run |
| A structured model answer from supplied information | call |
| Model-directed investigation or tool use | agent |
| A choice from named options, a yes/no, or a score on ordered levels, with probabilities | classify |
| An answer or decision that must come from the user | ask |

For browser work, declare a browser environment and select it with do.browser: environment.NAME; see method authoring example social-briefing.

Add a check only when it catches a failure that matters to the result. A change to a service, an API, email, or a browser that sends needs an effect that reads the result back; local file writes need neither. When you convert existing code, do not keep its checks and tests only because they exist. The rules are in method authoring concepts.

Use when for conditions, each for collections, repeat for bounded iteration, and after for order without a data dependency. Split steps for a check, a retry, a human decision, or an external change.


Use method schema for field definitions, method authoring concepts for the format, method authoring execution for setup, and method COMMAND --help for command arguments.

# Example catalog

- `method authoring example notes-summary`: The smallest complete Method: reads a folder of meeting notes, finds decisions and action items with one model call that shows two good items, and saves a summary file. A recorded case keeps one correction. Teaches: files connection, call with examples of good output, a recorded case in cases/.
- `method authoring example message-routing`: Classifies a customer message with Method's classifier, then a script rule chooses a support destination. ticket.method adds one ticket write that a retry does not repeat. Teaches: classify with an unclear option, a threshold in a script, an effect that reads the ticket back, retry without a duplicate write.
- `method authoring example support-triage`: Reads a help desk ticket, classifies its team, refund request, and urgency, drafts a first reply, updates the ticket, and asks a person when the team is unclear. Teaches: models and secrets, classify with options, yes_no and levels, an unclear path, ask, effects with an http observer, a committed case, method connect.
- `method authoring example outbound-management`: Reads email and prospect sources, updates persistent CRM state, and saves daily tasks and outreach drafts for review. Teaches: state across runs, script checks, examples of good output, accept, fixtures.
- `method authoring example social-briefing`: Researches a topic through Grok, alphaXiv, and LinkedIn in the browser, then writes a briefing with quotes and source links. Teaches: browser agent, call, no_effect_reason, accept.
- `method authoring example daily-briefing`: Turns prepared records of one fictional day into a cited briefing website, using an approved writing example, a source check, and rendering scripts. Teaches: approved example as an input, script tool, source check, website result.
- `method authoring example support-replies`: A comparison: is a Method reply agent better than plain Claude Code at following a support lead's 20 corrections? Both get the same corrections one at a time and are measured on new tickets after every 5. Teaches: a .compare file: question, arms, deliverable, treatment with checkpoints and a seed, a checklist from each expected answer with covered items, the rule with a guard, learners, assumptions, notes, decided_by_you.

After choosing the step types, read the examples that fit the design. Use their syntax; choose the steps for this task yourself.


# Method concepts

Before describing execution cost, check how the model steps run. A step that names no model runs on the user's Claude Code or Codex subscription when one is signed in on the computer (one local agent process per step; no account credit); otherwise on the account's hosted model. With hosted models, a call is one request without tools, and an agent step can make several requests and use tools, paid from account credit. A step on a models: entry with agent: codex or claude starts that local agent process. State the expected model requests and agent processes when they are known; mark unknown counts as unknown.

# Checks

Add a check only when it catches a concrete failure that matters to the result. Output types and the runtime already validate shapes; do not repeat them. Do not check wording, headings, keywords, lengths, or counts unless the task requires them: "write accurate prose" is not a reason to match strings.

Use the simplest check that proves the fact: a built-in equals, count, present, or file check, a script, or an agent check. Local file writes need no check: the runtime observes files connections itself. A change to a service, an API, email, or a browser that sends needs an effect that reads the result back, because a receipt or a 200 status shows only that the request was accepted. Use a built-in observer (http, sqlite, file) when one fits. When a change cannot or need not be observed, such as a browser step that only reads, write no_effect_reason instead.

Existing checks and tests are implementation choices, not user requirements. Remove a check that is unnecessary, repeats other validation, or enforces a requirement that nobody asked for. Delete the tests and instructions that exist only for it, and do not replace it. Do not change useful output only to satisfy a check.


# Contrasting design outlines

These are design outlines, not runnable Method files.

| Request | Design | Explanation |
| --- | --- | --- |
| Summarize supplied text | call → return summary | The model receives all source text. Add a save step only if a saved file is requested. Use an agent if it must find or inspect additional sources. |
| Investigate a claim | agent to research and assess → return findings | Add a separate planning, checking, or saving step only when the task needs that boundary or result. When the user requires that the findings say only what the sources say, add an agent check on the assess step (method authoring recipes). |
| Route a message with human review for low confidence | classify → threshold run → conditional ask | Classification returns probabilities. Code applies the threshold. Human input resolves cases below the threshold. Add a separate action with an effect if the Method must send or change anything. |
| Send a daily summary email | call to write → run to send, with an effect | The send script puts METHOD_OPERATION_ID in the Message-ID. A mail.delivery effect searches the bounce mailbox through its own read-only connection until a 5-day horizon. A bounce fails the run; no bounce by the horizon is unrefuted, not proven. |


A method has format, name, goal, steps, and result, and optional id, inputs, secrets, state, environment, files, models, limits, tools, run_data, run_label, and run_prompt (see the field reference in method authoring).
Each step uses do or ask. The do kinds are run, call, agent, and classify. Give script actions a name and a purpose; describe script checks in reading.check. A classify action takes bound inputs, a question, and one of options (a named choice with probabilities), answer: yes_no (answer and the probability of yes), or levels (2-10 ordered names; the most likely level, an expected level index as score, and probabilities). Use a script to apply business rules to that result.
run uses runtime and entrypoint; call uses model and prompt; agent can select browser: environment.NAME and optional custom tools.
Optional run_label selects one saved text, number, or boolean value, such as inputs.topic or steps.prepare.outputs.plan.date. Step references must select a step without each or repeat. Choose a short non-sensitive value that tells runs apart. When an input can be empty and a default picks the value, select the step output that holds the resolved value, not the input. The site uses the current Method's reference with each run's recorded inputs or outputs; absent or empty values keep timestamps. Set it with method set task.method /run_label --json '"steps.prepare.outputs.plan.date"'.

Optional run_prompt is plain text for the outside agent that starts a saved Method. Write which Method to run, where each input comes from (for example "as_of is today's date in YYYY-MM-DD"), and what to show when finished. Leave out SDK, runtime, and version details. Save it with the Method version and update it when inputs or outputs change. The copy button appends the exact version link and shared CLI setup; do not repeat them in run_prompt. This field is not a step prompt and does not expand variables. Set it with method set task.method /run_prompt --text-file run-prompt.txt.

Model and human prompts use {{date}} for the step input declared as in.date. Nested fields such as {{customer.name}} are allowed. Only text, numbers, and booleans can be inserted; pass lists and records as structured inputs. Whitespace inside braces is allowed. Escape a literal placeholder with a backslash before its opening braces (use a YAML block scalar). Values are inserted once, never evaluated or expanded again. Unknown variables, invalid paths, and non-scalar values fail validation. Missing runtime values fail before model execution. Defaults belong in input declarations. Human ask text uses the same scope; agent check prompts use {{inputs.date}} and {{outputs.answer}}. Script commands, labels, and tool descriptions are not templates. Single braces are ordinary text.
Runs record prompt.rendered with the template and expanded instructions for each invocation and phase; the run page shows the recorded expansion, with templates in technical details. Model and agent work uses finite default limits; steps can override them.
An optional step reading object explains inputs, outputs, condition, and check in plain text for the reading page. These descriptions do not alter execution. Describe the declared data and actual checks; keep them in sync when editing the step. The page always shows the exact do and check instructions as well. Give a separate executable check a short reading.check_name, such as “Compare saved text”, and use reading.check to explain what it checks. These fields change presentation only. Do not imply that a file or reference check verifies facts, or add a check just to fill the display.
Inputs and outputs have a type. Describe the outputs of script steps; other descriptions are optional. Types: text, number, boolean, record, list, file. Records need fields; lists need items or fields. Files have path and sha256.
Online runs upload declared file outputs separately, up to 20,000 files and 100 MB total, with 25 MB per file. Hash-checked receipts let interrupted transfers resume with only missing files. The single-file inspect export retains its separate 20 MB compressed-data limit. For a website, declare format: method-website and write a JSON file {schema: "method-website/1", title, entrypoint, files: [{path, sha256, media_type}]}. Paths in the file list are relative to that file; list every asset and identify an HTML start page. The run page opens the website only when all listed assets are attached. It can also download the complete website as a ZIP. No workspace scan occurs. See docs/result-files.md for the full contract. method sync RUN_DIRECTORY uploads files without executing steps again.
Bind step inputs with in aliases and use named outputs as downstream references. These references set execution order. Use after for required order without a data reference, such as operations that share a browser session. Every output has one producer.
Checks use equals, count, present, file, a script, or a bounded agent. Checker output is {status: pass|fail|unknown, reason, evidence}. Unknown never passes.
Use changes for state.NAME or environment.NAME on a step that changes them; other steps need no changes field. State changes commit only after acceptance. State is saved in state.json.
Local files need nothing more. For a files connection in changes, the runtime reads the folder before and after the step and records the changed files. When the step returns a path inside that folder, that file must have changed, or the run fails ("the step said it saved weekly.md, but weekly.md did not change"). A step that has nothing to save may change nothing.
A change to anything else (a service, an API, email, a browser that sends) needs an effect: the intended result, and how to read it back. A receipt or a 200 status shows only that a request was accepted. A short effect for a JSON service:
  effects:
    saved:
      intent: The CRM has one contact with this email address.
      in: {email: inputs.email}
      observe: {kind: http, path: "/contacts?email={inputs.email}", expect: {fields: {count: 1}}}
The observer reads the connection that the step changes, read-only. in may use inputs and earlier steps' outputs, but not this step's own outputs. Other built-in observers: kind: file (expect exists, contains, sha256) and kind: sqlite (one read-only SELECT; expect rows; more rows than intended is a duplicate). Templates insert {inputs.ALIAS} and {token}, the action's METHOD_OPERATION_ID. Defaults: one reading at once, a 1-minute horizon, and positive proof. For mail and other slow systems, use a reviewed observer (method effect list) or set schedule: {first, then, horizon} and confirm: unrefuted_at_horizon. For systems without a built-in observer, write a script observer with a deterministic judge and fixtures.
A run fails when an observer finds that the change did not happen, and is unconfirmed (exit 3) when nothing confirms it by the horizon. Readings due within five minutes happen inside the run; schedule method observe --pending for later ones.
When nothing can or needs to observe a change, write no_effect_reason with one sentence instead, for example "Reads pages only; sends and posts nothing." for a browser step. The run report lists every waiver.
Use each for a collection, repeat for bounded iteration, when for a boolean condition, and after for dependencies. Each and repeat cannot be combined.
Add concurrency: N (1-32) to an each step to run up to N items at once, for example a classify or call over many records. The Method's top-level limits.max_concurrency (default 8) caps it. The step cannot use ask, changes, or effects. Outputs keep item order; the first failure stops the other items, and resume runs only unfinished items. Raise limits.max_invocations for collections over 100 items.
Run a single step with repeat: {max_iterations: N, until: BOOLEAN_OUTPUT}. The final accepted output is returned; all iterations are recorded.

## Script steps

**Split scripts at retry boundaries.** Put operations in separate steps when
retrying one could repeat another completed action. Keep calculations together
when they serve one decision. A routing script chooses a destination; a later
action sends the message.

**Describe the behavior.** Give each script action a name and a purpose that
explains its rules, boundary values, result, and external changes. Describe
script checks in reading.check and tools in their existing description field.
When code, arguments, helpers, or dependencies change, review affected
descriptions and update them with the behavior.

**Declare the data.** Read business data through declared inputs and connections.
Include helpers and dependency lockfiles in the package. Supply time, random
seeds, and external observations as inputs when a decision depends on them.

**Validate before acting.** Check requirements that types cannot express before
changing an external system. Declare those changes in changes. Use finite loops
and request timeouts within the step's limits. Report invalid data as a failure.

**Return an inspectable result.** Write one JSON result to stdout, diagnostics to
stderr, and public progress through Method's progress channel. Return the rule
used for an important decision and the receipt or record ID for an external
write. Declare keys under secrets:.

**Test later scripts before the expensive step.** A script after an agent or a
long call fails only after that work is done. Run each such script on a saved
input before a full run: pipe one JSON object, such as the step inputs in a
step.started event of events.jsonl, to the entrypoint on stdin. Check that the
result has exactly the declared out names. Keep one real or redacted input as a
test fixture beside the helpers. Add a case for each input that broke the script.

**Make recovery explicit.** For external writes, describe what a retry does and
declare the effect that confirms completion. Use a stable operation or business key when
the service supports duplicate prevention. Test decision boundaries and an
interruption after the service commits but before the script saves its receipt.

Example purpose: “Chooses Billing when Billing is the selected category and its
probability is at least 90%. Otherwise chooses Manual review. Returns the
destination and the rule used.”




# Execution setup

Use method run FILE_OR_ID [--inputs inputs.json] [--inputs-from RUN_ID] [--state state.json] [--run-dir DIR] [--workspace HELPERS_FOLDER] [--background].
A Method needs no configuration file. What changes the result is in the Method: models, limits, tools, and secrets (the names). What belongs to this computer is in ~/.config/method/computer.json: method config (own model key) and method bind (folders and connections). python and node are found on PATH and prepared automatically. A saved version carries its helpers; versions saved without files still need --workspace DIR.

## Models

A call or agent step names model: NAME from the Method's models: ({NAME: provider/model | {model, max_output_tokens, reasoning_effort}}), a model ID such as openai/gpt-6-luna, or default. A step without model uses default: the user's own subscription first, which is the Claude Code or Codex that started the run, else an installed and signed-in Claude Code or Codex (Claude Code when both are); the account's default hosted model on account credit only when no local agent is signed in. If the local agent fails, for example at a usage limit, the step fails like any other outside service; run again later. Each step's run record names the backend and model that ran it (model.used). Hosted models need no key and no local agent. They are private by default: requests go only to providers that do not train on them and keep no copy (zero data retention). method models lists those models; validate warns with model_not_private when a step names another, and hosted runs refuse it. Hosted models and classification share the account's model credit; the run summary reports usage.cost_usd. When the credit is used, run method config model-key: hosted model and classify steps on this computer then call OpenRouter with the user's own key.
A models: entry {agent: codex | claude, model, reasoning_effort} runs the steps that name it with that local agent, which must be installed on the computer that runs the Method. A step that names a model keeps it; no flag or computer setting overrides the Method's models:. Declared tools reach the agent through a temporary local MCP connection; no persistent agent configuration is edited. The model choice of a run stays fixed on resume.

## Classification

classify uses Method's classifier (Jev) through the account, with no key and no agent installation; it needs sign-in and network access. The SDK saves the pinned classifier version before execution and reuses it on resume. Each invocation makes one request; uncertain answers complete normally. Questions and option descriptions are literal text. Bind JSON inputs through in or each, and use out: RESULT_NAME for the result record. There must be 2–255 options or 2–10 levels. Classifiers cannot receive declared files or declare changes. Classification sends the step's declared inputs to Method and its classification provider. Saved runs contain the declared inputs and results.

## Browser

An agent with browser: environment.NAME receives the standard direct browser-use controls. The agent chooses the browser actions. Method opens the selected browser, keeps its sign-ins private, and reuses the session across steps. On macOS, Method copies the user's last-used Chrome profile and runs headless, so ask the user to sign in to the sites in Chrome before the run. For a visible browser, attach a Chrome session that permits control with method browser connect --cdp URL. Validation does not open a browser. Each run has a separate profile; resume reads the current page, not a saved web snapshot.

## Secrets, scripts, and tools

Declare each key that a script needs under secrets: with its purpose. Every script of the Method (run steps, script checks, tools, and observers) receives all of the Method's declared secrets as environment variables. Supply values with method secret find, method secret import, or method secret set; they stay on this computer and are never sent to Method. A missing value stops the run before its first step.
Scripts are trusted local processes; Method does not sandbox them. They receive one JSON object on stdin and return one JSON object on stdout. Write artifacts under METHOD_OUTPUT_DIR. State updates are returned under state.
Declare custom script tools at the top level, tools: {NAME: {description, in, out, run, effects}}, and list them in the agent step's tools:. Browser controls are supplied automatically; interactive controls require changes: [environment.NAME]. Check tools cannot declare external effects.
METHOD_OPERATION_ID identifies a script action or check within a run. It stays the same when that invocation is retried. Use it as the service’s idempotency key to prevent duplicate writes during recovery. Use a business key when duplicates must also be prevented across separate runs. Agent tools define duplicate prevention in their own contracts.

## Limits

Defaults: one hour per run, ten minutes per step, 100 model requests, 100 step invocations, 200 tool calls, 16 MiB for input and output, and 8 concurrent items per step; 32 agent turns and model requests per step. Change them in the Method: limits: {timeout_ms, max_model_requests, max_invocations, max_tool_calls, max_output_bytes, max_request_bytes, max_concurrency, step: {timeout_ms, max_agent_turns, max_model_requests}}. limits.step applies to every step without its own step limits:. max_model_requests counts direct model and classification requests; a local agent manages its own internal requests and built-in tools, and Method enforces its process timeout, prompt and output size, and tool-call limit.

## Runs and records

A version includes declared files, script and tool entrypoints, dependency lockfiles, and the runtime release. Run accepts a Method ID or dashboard URL and restores that version.
Use method inspect RUN_DIRECTORY --out inspection.json for a saved run; online runs sync to the same Method dashboard.
Use method bind FILE NAME --file FOLDER to remember an input on this computer. Add --upload only to save that selected input folder privately in the account.
Use method state ID --enable --file state.json to opt into shared account state. Concurrent runs cannot overwrite it. Account state is JSON; an uploaded SQLite input is a snapshot, not a shared database. Use a live service connection for a shared database. A stopped run keeps ownership until continued or explicitly released with method state ID --release RUN_ID after inspecting its actions.
CLI runs of local files and saved Methods have their own process. Use --background to return immediately, method run-status DIR, method wait DIR, or method cancel DIR. New runs accept package runtime versions explicitly tested by the installed SDK. The saved package stays unchanged; run records identify the executor used. Resume the same Method version and exact executor with --resume --run-dir DIR. Use method sync DIR to retry uploads without repeating work.

## Progress and result names

For live progress, native Codex forwards public updates as they arrive. Scripts use METHOD_PROGRESS_FD; run method progress --help for the message and child-agent relay protocol. Keep stdout for the final JSON result. Report real milestones without source passages or secrets. Quiet work still sends a five-second heartbeat; the page polls every three seconds. A heartbeat shows the executor is connected, not that new work has completed. See https://github.com/method-ai-hq/method-sdk/blob/main/docs/progress.md for complete examples.

Use reading.output_name to give a returned result a short, honest name. Use reading.outputs to explain its contents.


# Recipes

## Corrections become cases

When the user says a result was wrong:
1. Record it: method judge RUN_ID wrong --note "the user's words" (--corrected FILE when they gave the right result). Use their words even when they are vague. Do not ask them to confirm it, and do not edit the Method for the same correction. method judge returns at once with one line and tests a fix in the background, on a private copy of the run, with every message held back.
2. Get the result with method wait. It waits up to 100 seconds; when it says it is still working, run it again. Tell the user the line it prints, in their words.
3. After a fix, show the user what the fixed agent gives now: method wait prints the output from the test. Do not run the Method again to show it, above all when it sends or changes things: that would send it again.
4. When method wait prints a question, show it to the user word for word and never answer it yourself. Send their own words with the command it prints: method answer JUDGMENT_ID "their words". Then run method wait again.
5. When the user wants to see or remove what the agent learned from corrections, run method learned FILE, and method learned FILE --remove NUMBER. To go back to how the agent worked before Method's last change, run method undo.
6. For a rule the user states outside a run, record it: method case new FILE --id ID --run BAD_RUN --passing-run GOOD_RUN --note "the user's words" --rubric "plain sentence that must be true" (repeat --rubric for each rule). --ref names what to judge (default: the Method's result; result, outputs.NAME, file:PATH for a file the run wrote, or effect:NAME for what a tool or effect sent). When a rule compares the output with the sources, add --context with the step output that holds them, for example --context outputs.material. Make each sentence fail on the bad run; case new warns about one that does not. For an exact value, use --expect instead.
7. case new refuses a case that can pass only by breaking one of the Method's instructions (case_conflicts). Show the user the rule and the instruction, and ask which one is right. When the user says the case is right, change the instruction first and record the case again. Add --accept-conflict "the user's answer" only when the user wants both.
8. After any edit by hand, run method test FILE. Every case must pass. method publish refuses a version that breaks a case.
For a one-time preference, edit and run again; a case is not needed.

## Checked on every run, or on every new version

A case checks future versions of the Method: method test and method publish run it. A check on a step checks every run, and a failed check stops the run before later steps (for example before the save), with the check's reason in the error. When the user wants something "checked every time", add a step check; when they also want the rule kept for future edits, add a case too. A check that the output says only what the sources say:
  check:
    kind: agent
    model: default
    prompt: |
      Sources:
      {{inputs.material}}

      Report:
      {{outputs.report}}

      Return fail if the report states any fact, number, or cause that the sources do not give.
  reading: {check_name: Only what the sources say, check: Fails when the report states something the sources do not give.}
Check prompts insert the step's inputs as {{inputs.NAME}} and its outputs as {{outputs.NAME}}. Never edit or delete a case to make a change pass. When a rule really changed, retire the old case: method case retire FILE ID --reason TEXT.

For incremental exports, keep a declared state ledger of source IDs and evidence hashes. Compare new evidence to that ledger and rebuild only changed days. Supply the prior run's state.json with --state for a new run.
Resume continues the same input set and saved version. A new run can collect new files.
To edit a failed method, read its exact saved version and logs, compare the current version, change it, and run it. Publish with --reason when the user wants to share the repair.



# Recovery

For a stopped run, read summary.json, events.jsonl, and checkpoint.json. Resume with the original method, --run-dir DIR, and --resume. Accepted steps and iterations are reused.
An unfinished action needs --retry STEP:ITERATION after inspection of its external effects. A retry consumes the remaining run budget. Budgets do not reset on resume. Resume always uses the run's saved bundle, so a code fix needs a new run.
To fix a failed or wrong step, change it and run the Method again. The new run reuses every iteration whose step definition, inputs, model, tools, runtime, and (for script steps) bundle files match an earlier accepted run on this computer, and copies their declared file outputs. Steps with ask or effects, steps that change state or a service, and tools with effects are never reused. Use --rerun STEP to run a step again anyway, or --fresh to reuse nothing.
For ask, the run stops (exit 2) with its run_id and the question; pass the user's actual answer with method answer RUN_ID --answer JSON, and the run continues. Checks still run.
A save never blocks a run: a run that cannot save says "Will save when online", and any later method command sends the outbox.
State commits after checks. A local checkpoint cannot roll back an external write. Inspect external state before an explicit retry.
Two computers can save different content of one Method; each becomes a version with its parent. Going back to earlier content finds its existing version. The id: line keeps a renamed or moved file on its Method; method new-id FILE makes a copy a new Method. On one computer a Method is saved from one file (every checkout of one Git repository counts as one): a copy in another folder or a temporary folder does not run while that file exists, and the error names the file to change. Before a run, a fix or a publish, the file takes the newest version of its Method: an unchanged file takes it, a changed file combines it step by step and file by file, and a step or a script file that you and a teammate changed in different ways stops the command with both texts, until you combine them in the file. A save that a teammate's newer save overtook is kept beside it, and the next run combines the two.
Use method sync RUN_DIRECTORY to repair a dashboard upload without executing the method again.
After a failed action with effects, failure.next.text lists what the observers saw. A confirmed effect means the change happened: do not retry the action. A run that is unconfirmed finished all its steps; inspect effects.jsonl and the external system before relying on its result.


# Comparisons

When the user asks whether one agent is better than another, write a NAME.compare file (YAML or JSON) and run it with `method run NAME.compare`. Method checks the file, runs a trial, measures the noise, asks the user to approve, runs every cell, and answers "ARM is better" or "Can't tell yet" by a fixed rule. The comparison's page on the dashboard shows every value with who decided it: you (the user), the writer (you, the agent that wrote the file) or Method.

## The six rules

1. Write the question so that it names the treatment and the test.
2. Mark `decided_by_you` only for a value the user stated. The question is the user's only when the file has it in the user's own words; when you rephrase it, it is the writer's. Everything else is the writer's choice, and the page asks the user to review it. Naming an arm (`arms.plain`) says which agent it is; a plain arm's starting instructions are the user's only as `arms.plain.instructions`.
3. Write corrections as the expert would say them: "It needs to be X because Y". Use the expert's real corrections when you have them.
4. One main measure, in plain words, scored on what each input has.
5. Assumptions are only things that must be true for the answer to mean something. Each one has "if false" and "how to check". Notes go with their part. The user reads the question, the difference, the notes and the assumptions on the page: write them in the user's words, name files and folders by what they are ("the 30 corrections", "the expected answers"), never by their path, and leave out how Method gives each arm its corrections, which the page says. The difference is one short phrase, such as "How a correction changes the agent."
6. After the trial, read one run of each agent, and show the user the page before they approve.

## What Method decides

Do not write these into the file; Method applies them to every comparison and shows them on the page.

- Every arm runs on the same model and effort, with no personal instructions, memory, settings or plugins, and with the same task prompt, tools and output file. A plain arm takes the Method arm's model. No arm uses the web unless `tested: tools`; arms differ in model only with `tested: model`.
- Every arm hands in the file `deliverable` names; a plain agent's last message is not its output.
- With corrections, a plain arm learns from each correction this way: a Claude Code (or Codex) session gets the correction and the wrong output of a training run, and edits the agent's instructions file. A Method arm gets each correction through `method judge`. Corrections arrive one at a time; each fix or edit has up to 2 hours.
- `runs` counts separate copies of each arm (learners). Each copy gets the full treatment; each checkpoint measures each copy once per input. The trial teaches one copy of each arm; the full run teaches every copy.
- A correction is received when its fix found a change, found no change was needed, or found no fix, or when the session that edits the instructions finished. A fix that could not test or that stopped is not received, and the comparison stops.
- One Claude judge marks each item met, partly or not met; partly counts as half. It reads every source the agent read in full.
- The trial runs each trial input at the start with 2 copies of each arm. If they differ by more than half the margin, the comparison stops before approval.
- Usage per correction is shown for each arm and does not decide.

## The file

Required: `question`; `arms` (a short name for each: a .method file, or {agent: claude|codex, instructions: FILE}); `difference`; `inputs` (JSON files of input values or case IDs, the same for each arm; an input's own folder, inputs/ID/ beside inputs/ID.json with one subfolder per files connection, replaces the arm's folders of those names for that input. This holds for teaching inputs too: a training run sees only its own input's folders); `measure` ({name, description, and one of code: SCRIPT, rubric: [sentences], checklist: expected (each input's expected answer is its checklist; add covered: true to score only the items that corrections given so far cover), person: QUESTION}); `rule` ({margin, min_runs, at?, guard?: {measure, max_drop}}); `runs` (learners per arm).

Optional: `deliverable` (the file each arm hands in, such as work/reply.md; needed with a plain arm); `treatment` ({events: [{correction, input} or {input}], checkpoints, seed?}); `teaching` (the inputs the events use); `expected` ({INPUT: FILE}; for a checklist, "- item" lines or JSON [{text, covered_by: [EVENT, ...]}], events by their place in the file); `other_measures`; `trial` (inputs in the trial, 2 by default); `assumptions` (text, or {text, if_false, check}, or {text, limit: true} for a known limit); `notes` ({PART: [text]}); `about_inputs` ({noun, description, teaching_description, names: {INPUT: NAME}}); `tested` (model or tools); `decided_by_you` ([PART or PART.FIELD, ...]). `method validate NAME.compare` checks the file and lists the writer's choices; `method schema compare` prints the full form.

## Worked example: a support-reply agent with 20 corrections

The support lead corrects a reply agent every week. The user asks whether the Method agent follows those corrections better than plain Claude Code. Both arms get the same 20 corrections on four past tickets, one at a time in one shuffled order, and are measured on three new tickets after every 5. Each new ticket's checklist is its expected answer, and each item names the corrections that cover it. The user named the arms, so only `arms` is marked `decided_by_you`. The question is the writer's: it rephrases the user's request.

```yaml
question: After the support lead gives the same 20 corrections to both reply agents, which one follows them better on new tickets?
arms:
  method: support-reply.method
  plain: {agent: claude, instructions: plain-instructions.md}
difference: How a correction changes the agent.
inputs: [tickets/t-201.json, tickets/t-202.json, tickets/t-203.json]
teaching: [teach/t-101.json, teach/t-102.json, teach/t-103.json, teach/t-104.json]
about_inputs:
  noun: ticket
  description: Three new tickets that the corrections never saw.
  teaching_description: Four past tickets that the support lead corrected.
  names: {tickets/t-201.json: Cracked lamp, tickets/t-202.json: Parcel not moving, tickets/t-203.json: Late return}
deliverable: work/reply.md
treatment:
  seed: 7
  checkpoints: [0, 5, 10, 15, 20]
  events:
    - {input: teach/t-101.json, correction: "It needs to ask for one photo of the damage first, because we approve a damaged-item refund only with a photo."}
    - {input: teach/t-101.json, correction: "It needs to say the money goes back to the card that paid, because customers ask where the refund goes."}
    - {input: teach/t-102.json, correction: "It needs to say that 7 days with no movement counts as lost, because that is our rule and it ends the waiting."}
    - {input: teach/t-102.json, correction: "It needs to leave out the carrier's phone number, because we handle the carrier ourselves."}
    - {input: teach/t-101.json, correction: "It needs to leave out store credit, because we offer it only when the customer asks for it."}
    - {input: teach/t-102.json, correction: "It needs to say we send a replacement now, because a lost parcel is replaced without more waiting."}
    - {input: teach/t-104.json, correction: "It needs to check the date against the 30-day limit, because refunds stop 30 days after delivery."}
    - {input: teach/t-103.json, correction: "It needs to say the address can change only until the label is printed, because after that we cannot stop it."}
    - {input: teach/t-101.json, correction: "It needs to call the item what the customer called it, because our product codes mean nothing to them."}
    - {input: teach/t-102.json, correction: "It needs to apologize once, in the first sentence, because repeated apologies read as a script."}
    - {input: teach/t-104.json, correction: "It needs to promise only what the articles allow, because an exception we cannot keep makes a second complaint."}
    - {input: teach/t-103.json, correction: "It needs to ask for the new address in full, because a partial address delays the change."}
    - {input: teach/t-104.json, correction: "It needs to stay under 120 words, because customers read replies on their phones."}
    - {input: teach/t-104.json, correction: "It needs to give the refund time as 5 business days after approval, because that is when the bank shows it."}
    - {input: teach/t-102.json, correction: "It needs to stop asking the customer to wait longer, because 7 days is already the limit."}
    - {input: teach/t-103.json, correction: "It needs to say express shipping takes 1 to 2 business days, because the customer asked how fast it can be."}
    - {input: teach/t-104.json, correction: "It needs to name the order number the customer gave, because it shows we found the right order."}
    - {input: teach/t-102.json, correction: "It needs to give the replacement's shipping time as 3 to 5 business days, because customers plan around it."}
    - {input: teach/t-104.json, correction: "It needs to say no when the articles say no, because a vague maybe makes the customer write again."}
    - {input: teach/t-101.json, correction: "It needs to end with one clear next step, because a reply without one gets a follow-up question."}
expected:
  tickets/t-201.json: expected/t-201.json
  tickets/t-202.json: expected/t-202.json
  tickets/t-203.json: expected/t-203.json
measure:
  name: corrected items right
  description: For each new ticket, the share of its checklist items, already covered by a correction, that the reply meets.
  checklist: expected
  covered: true
other_measures:
  - name: all items right
    description: For each new ticket, the share of all its checklist items that the reply meets.
    checklist: expected
rule:
  margin: 0.1
  min_runs: 2
  at: 20
  guard: {measure: all items right, max_drop: 0.05}
runs: 2
assumptions:
  - text: The judge marks the checklist the way the support lead would.
    if_false: The scores show the judge's taste, not the support lead's.
    check: The support lead marks 10 verdicts on the run pages.
  - text: The checklist items are what the support lead requires.
    if_false: An agent can win by following the wrong rules.
    check: The support lead reviews the 14 corrected items before the full run.
  - text: The corrections and the checklist come from the same support lead, so both agents are told what the test checks.
    limit: true
notes:
  inputs: [Each ticket runs alone with an empty work folder.]
  treatment: [The corrections come from the support lead's notes on four past tickets.]
decided_by_you: [arms]
```

The Method arm, its starting instructions, the tickets and the checklists are in `method authoring example support-replies`.


# Command reference

Local authoring commands edit draft files. A signed-in run saves a version when the file changed. publish marks a version for sharing. run also executes a saved version by ID.

Server: https://app.withmethod.ai by default. --server selects another server and its login.
Success exits 0. Errors exit 1 with text on stderr, unless the command specifies another result.

Common errors:
File commands require readable YAML or JSON. Editing commands leave the original file unchanged after a failed edit. Online commands require sign-in and network access. Use method authoring recovery for conflicts and interrupted saves.

## browser connect

Select a private browser connection.

Usage:

```sh
method browser connect [--name NAME] [--cdp URL]
```

Arguments and defaults:
NAME defaults to default. --cdp attaches to a Chrome session that permits remote control. Without --cdp, Method runs headless. On macOS it copies your last-used Chrome profile to reuse sign-ins. Use method-browser:NAME for a named browser binding.

Result and changes:
Saves the browser selection on this computer. No browser is started by this command.

Errors:
Invalid name or endpoint. Credentials must not be in the URL.

Example:

```sh
method browser connect
```

## doctor

Check Node and the installed local agents without running a Method.

Usage:

```sh
method doctor
```

Arguments and defaults:
Checks each installed Codex or Claude Code agent and says which one runs the steps that name no model. Use validate FILE for a Method's own dependencies.

Result and changes:
Setup findings; no task execution.

Errors:
An old Node.js.

Example:

```sh
method doctor
```

## inspect

Export saved execution evidence.

Usage:

```sh
method inspect RUN_DIRECTORY --out FILE
```

Arguments and defaults:
Use a new output file. --include-files attaches declared result files.

Result and changes:
Saved inspection JSON.

Errors:
Missing run or existing output.

Example:

```sh
method inspect runs/example --out inspection.json
```

## prompt

Print the Method as plain-text instructions.

Usage:

```sh
method prompt FILE
```

Arguments and defaults:
Current Method file.

Result and changes:
Text; no execution.

Errors:
Invalid document.

Example:

```sh
method prompt task.method
```

## config

Show or change this computer's settings.

Usage:

```sh
method config
method config model-key [--off]
```

Arguments and defaults:
Settings live in ~/.config/method/computer.json (private): bindings (method bind) and model_key_env. model-key imports OPENROUTER_API_KEY from the one nearby key file that holds it, or else opens a private browser form for it (the value stays in this computer's secret store), and then sends every hosted model step and every classify step on this computer to OpenRouter with your key, in place of the account's model credit; the run prints Using your own OpenRouter key. Those requests keep Method's private options: no provider that trains on the data, and zero data retention. --off goes back to the account. Run limits belong to the Method (limits:). Nothing goes into a Method file.

Result and changes:
The settings, or one line.

Errors:
Unknown setting.

Example:

```sh
method config model-key
```

## new-id

Make a copied Method file a new Method.

Usage:

```sh
method new-id FILE
```

Arguments and defaults:
Writes a new id: line. A copy that keeps its id: saves to the same Method.

Result and changes:
JSON with file and method_id.

Errors:
Missing file.

Example:

```sh
method new-id copy.method
```

## bind

Save a named input location or connection.

Usage:

```sh
method bind FILE_OR_ID NAME (--file FOLDER | --connection URL) [--upload]
```

Arguments and defaults:
Default: this computer only, in ~/.config/method/computer.json under the Method's ID (a FILE gets its id: line). A folder named NAME beside the Method needs no binding. --upload saves only the selected input folder or connection URL in the account. It never scans your disk. Keep credentials in the service's normal sign-in store.

Result and changes:
Saved binding and scope.

Errors:
Missing input, invalid name, or unsafe path.

Example:

```sh
method bind METHOD_ID prepared_day --file day-records --upload
```

## state

Read or explicitly enable shared account state.

Usage:

```sh
method state ID [--enable --file state.json | --release RUN_ID]
```

Arguments and defaults:
Accepted state updates use revision checks. Inspect a stopped run's external actions before releasing its ownership.

Result and changes:
Current revision, value, and owner run.

Errors:
Concurrent ownership or stale revision. Existing state is never silently overwritten.

Example:

```sh
method state METHOD_ID --enable --file initial-state.json
```

## wait

Reconnect to a local run, or get what a fix did with a correction.

Usage:

```sh
method wait RUN_DIRECTORY
method wait [JUDGMENT_ID] [--timeout SECONDS] [--json]
```

Arguments and defaults:
With a run directory: reconnects to the same local worker; closing this output connection leaves the worker active. With a judgment ID (from method judge --json), or with nothing: waits for the fix of that correction, or of every correction that this computer is fixing, for up to --timeout seconds (default 100), and prints what it did. A wait that ends first says so in one line; the fix goes on, and method wait can run again.

Result and changes:
For a run: live output, then a final line with the run status (succeeded, unconfirmed, waiting_for_you, or failed), the headline of a failure, and the dashboard link of a synced run. For a fix: one plain line per correction for the person (Fixed, No fix found yet, Could not test a fix safely, a question, ...). After a fix it shows what the fixed agent gives now, from the test; nothing was sent. After a question, one more line says how to send the person's answer. --json prints {outcomes: [{judgment, status, outcome, lines, next?}]}.

Errors:
Stopped process or missing run, or a judgment that this computer is not fixing.

Example:

```sh
method wait .runs/example
method wait
method wait jdg_6f1c…
```

## run-status

Read worker status without waiting.

Usage:

```sh
method run-status RUN_DIRECTORY
```

Arguments and defaults:
Local run directory.

Result and changes:
Worker status and whether its process is active.

Errors:
Unreadable run directory.

Example:

```sh
method run-status .runs/example
```

## cancel

Stop a local run process.

Usage:

```sh
method cancel RUN_DIRECTORY
```

Arguments and defaults:
Inspect uncertain external actions before any explicit retry.

Result and changes:
Cancellation request. The checkpoint remains available.

Errors:
Unreadable run directory.

Example:

```sh
method cancel .runs/example
```

## progress

Report public progress from a running script or relay a child Codex JSON stream.

Usage:

```sh
method progress --message TEXT [--completed N --total N --unit NAME] [--child NAME]
method progress --codex --child NAME
```

Arguments and defaults:
METHOD_PROGRESS_FD is supplied by the executor. --codex reads JSON lines from stdin; --message sends one message. Do not include secrets or source contents.

Result and changes:
Writes to the separate progress pipe. No stdout output. No-op outside a Method process.

Errors:
Invalid arguments. Malformed Codex events are ignored.

Example:

```sh
method progress --message 'Rendered 12 of 40 pages' --completed 12 --total 40 --unit pages
```

## authoring

Read the installed authoring guide. Available offline.

Usage:

```sh
method authoring [start|concepts|execution|examples|recipes|recovery|comparisons|commands|all]
method authoring example EXAMPLE_ID
```

Arguments and defaults:
Default topic: start, with the build steps, prompt rules, a complete example, the field reference, the step types, and the example catalog. concepts, execution, recipes, recovery, and commands hold the rest. Choose examples after choosing the design. A named example prints its complete lesson and installed file paths. all prints every topic except the example lessons.

Result and changes:
Markdown text on stdout. No changes.

Errors:
Unknown topic: lists the valid topics; exit 1.

Example:

```sh
method authoring all > method-guide.md
```

## init

Create a local YAML draft.

Usage:

```sh
method init FILE --name NAME --goal TEXT
```

Arguments and defaults:
File must be new. Name and goal are required. The draft starts with an empty steps map and result map.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
Missing name or goal; the file already exists.

Example:

```sh
method init task.method --name 'Find leads' --goal 'Find qualified leads from the specified sources.'
```

## show

Read a draft or one field.

Usage:

```sh
method show FILE [--path POINTER]
```

Arguments and defaults:
Default: the full document. Pointer example: /steps/search/do.

Result and changes:
Selected value as JSON. No changes.

Errors:
The selected field does not exist.

Example:

```sh
method show task.method --path /steps/search
```

## set

Add or replace one draft field.

Usage:

```sh
method set FILE POINTER (--json JSON|--value-file FILE|--text TEXT|--text-file FILE)
```

Arguments and defaults:
Use exactly one: --json JSON, --value-file FILE (YAML or JSON), --text TEXT, --text-file FILE (UTF-8 text). Prefer files for long text. Parents must exist. An empty pointer replaces the document. Escape / as ~1 and ~ as ~0. Nested values replace in full.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
Invalid pointer, missing parent field, or conflicting value flags.

Example:

```sh
method set task.method /steps/search/do/prompt --text-file search.txt
```

## remove

Remove one draft field.

Usage:

```sh
method remove FILE POINTER
```

Arguments and defaults:
The field must exist. Repair remaining references before saving.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
The selected field does not exist.

Example:

```sh
method remove task.method /steps/search/each
```

## step add

Add a complete operation.

Usage:

```sh
method step add FILE --id ID --value-file STEP.yaml
```

Arguments and defaults:
Supply do or ask and the bindings and outputs needed by the step in STEP.yaml. Give a run step a name and a purpose, and describe its outputs. Checks and limit overrides are optional. Without a value file, use --kind run --runtime python|node --entrypoint FILE, or --kind agent|call|classify --instructions-file FILE; the model is default (the account's hosted model).

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
File commands require readable YAML or JSON. Editing commands leave the original file unchanged after a failed edit. Online commands require sign-in and network access. Use method authoring recovery for conflicts and interrupted saves.

Example:

```sh
method step add task.method --id copy --value-file copy.yaml
```

## step update

Change fields of an existing step.

Usage:

```sh
method step update FILE STEP_ID (--json JSON|--value-file FILE)
```

Arguments and defaults:
Supply an object of fields. Top-level fields merge; nested values replace in full. Use remove to delete a field.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
Unknown step or invalid step fields.

Example:

```sh
method step update task.method search --value-file search.yaml
```

## step remove

Remove an operation.

Usage:

```sh
method step remove FILE STEP_ID
```

Arguments and defaults:
Repair references to its outputs and after constraints before saving.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
The selected step does not exist.

Example:

```sh
method step remove task.method old_search
```

## step move

Change display order.

Usage:

```sh
method step move FILE STEP_ID --before OTHER_ID
```

Arguments and defaults:
Both steps must exist. Data references and after still control execution order.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
The selected step or destination does not exist.

Example:

```sh
method step move task.method search_exa --before search_bookface
```

## check set

Set the operation's independent check.

Usage:

```sh
method check set FILE STEP_ID (--json JSON|--value-file FILE)
```

Arguments and defaults:
When a task check is needed, use an equals/count/present/file object, a run check, or an agent check. Put plain-English criteria in an agent check prompt.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
Unknown step, invalid check, or conflicting value flags.

Example:

```sh
method check set task.method search --value-file check.yaml
```

## check remove

Remove the operation's check.

Usage:

```sh
method check remove FILE STEP_ID
```

Arguments and defaults:
The operation will have no additional task check. Remove unnecessary checks and their supporting tests and instructions. External changes require effects (method effect add), not a check.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
The selected step does not exist.

Example:

```sh
method check remove task.method copy
```

## check

List the Method's issues, or edit an operation's check.

Usage:

```sh
method check FILE [--notes] [--all]
method check set|remove ...
```

Arguments and defaults:
With a Method file: the same issues as validate, without the local setup. Use method check set --help to edit a check.

Result and changes:
JSON with valid, issues, and issue_counts. Exit 1 only on errors.

Errors:
Unknown action. Choose set or remove.

Example:

```sh
method check task.method
```

## validate

Check the definition, its issues, and the local setup without running the work.

Usage:

```sh
method validate FILE [--workspace DIR] [--notes] [--all]
```

Arguments and defaults:
Checks data, names, dependencies, templates, declared files, executables, environment variables, models and connection bindings, then lists issues: errors, warnings, and notes. A file or the Method that contains a secret value of this computer is an error. Warnings are listed only for steps whose text changed since the last validate, at most 5; --all lists every one; --notes adds notes. Model checks run through your Method account for changed steps; validate waits at most 3 seconds and reports the rest as pending. Models come from the Method's models:, bindings from this computer (method bind), runtimes from PATH. --workspace selects the helper folder.

Result and changes:
JSON with valid, definition, local_setup, missing_setup, steps, executed:false, issues (each with level, code, at, message, fix, and for a warning on a step how to accept it), and issue_counts. Exit 1 only on errors. Fix errors. Fix each warning, or accept it with the user's reason. Never add a check only to remove a warning.

Errors:
Each error issue names the field or file and the fix.

Example:

```sh
method validate task.method
```

## models

List the hosted models that work with the private options.

Usage:

```sh
method models [--refresh] [--server URL]
```

Arguments and defaults:
Each listed model has a provider that does not train on requests and keeps no copy (zero data retention). Hosted runs use only those providers. The list comes from your Method account and is kept for a day; --refresh gets it again. validate warns with model_not_private when a step names a model that is not listed.

Result and changes:
JSON with default, checked_at, and models (model IDs).

Errors:
No sign-in, or no network and no saved list.

Example:

```sh
method models
```

## diff

Compare two documents.

Usage:

```sh
method diff FILE OTHER_FILE
```

Arguments and defaults:
Both files required. Values are compared after parsing YAML or JSON.

Result and changes:
JSON array of {path,before?,after?}. Empty means equal; exit 0 either way.

Errors:
Both file paths are required.

Example:

```sh
method diff original.method task.method
```

## schema

Read the format.

Usage:

```sh
method schema [method|config|step|data|environment|check]
```

Arguments and defaults:
Without a name: a short field reference, enough to write a Method. With a name: that JSON schema, for tools.

Result and changes:
Text, or JSON Schema.

Errors:
Unknown schema name.

Example:

```sh
method schema
```

## get

Read an online method; optionally make a local draft for editing.

Usage:

```sh
method get WORKFLOW_ID [--version VERSION_ID] [--out FILE] [--server URL]
```

Arguments and defaults:
Default: latest version. --out must name a new file. Use a version ID to read an exact saved version.

Result and changes:
Without --out: {workflow_id,version_id,version_number,workflow}. With --out: {workflow_id,version_id,version_number,file}; writes the workflow with its id: line and the saved files.

Errors:
Missing method or version; output file already exists.

Example:

```sh
method get wf_example --out edit.method
```

## explain

Explain each script step of the saved version in a script card.

Usage:

```sh
method explain FILE [--step ID] [--no-round-trip] [--server URL]
```

Arguments and defaults:
FILE is a local Method whose current content is a saved version (run or publish it while signed in). For each run step whose script has no card, code analysis finds the hosts, secrets, environment variables, files, and commands the script uses; a hosted model writes a one-sentence summary and 3 to 8 steps; every number, quoted name, and host in that text must appear in the code (one retry). The round trip writes a program from the steps alone and replays up to 3 recorded inputs of the step from local runs through both programs without network access. A script that calls the network is not replayed. --step explains one step. --no-round-trip skips the replay. A signed-in run starts this in the background; publish waits for it.

Result and changes:
One line per step with its summary and check results. Cards upload to the version; the dashboard shows them beside each script. A failed check is shown on the card and never blocks publish.

Errors:
No saved version, local files that differ from the saved version, or no hosted-model credit. Without sign-in it prints one line and makes no card.

Example:

```sh
method explain leads.method --step score
```

## publish

Mark a version as published, for sharing, schedules, and production runs.

Usage:

```sh
method publish FILE [--reason TEXT] [--accept-failing-case ID[,ID]] [--cloud|--workers] [--env NAME] [--server URL]
```

Arguments and defaults:
Runs the Method's cases first; a version that breaks an approved case is refused unless --accept-failing-case names it, and the version records that. Uses the version of the file's current content: it finishes that upload (no time limit while bytes move), checks the cases, then marks it published with the reason (default: Published.). --accept-failing-case needs --reason. The first save of a new file creates the Method. --cloud runs the production runs of the environment on Method Cloud; --workers runs them on your workers again. --env NAME selects the environment (default production).

Result and changes:
JSON with workflow_id, version_id, url, published_at, the cases line, and the open warnings and notes (issues). With --cloud or --workers: placement. Warnings and notes never block a publish.

Errors:
An error issue (nothing is published), failing case, --accept-failing-case without --reason, or no network.

Example:

```sh
method publish task.method --reason 'Shorter introduction'
```

## judge

Record the person's reaction to a run's result. A wrong one starts a fix on this computer and returns at once.

Usage:

```sh
method judge RUN_ID right|wrong [--step STEP_ID] [--note TEXT] [--corrected FILE] [--json] [--server URL]
method judge RUN_ID keep JUDGMENT_ID
```

Arguments and defaults:
RUN_ID is the run_id of the run's start line, or the run ID on the dashboard. right: the person used or approved the result; it is recorded only. wrong: the person corrected it, or asked to change the Method because of it. --note: the person's words (at most 4000 characters), even when they are vague. --corrected FILE: the result that the person says is right; JSON is sent as JSON, other text as text (at most 1 MB). --step: the step whose output was wrong. A wrong judgment starts the fix in its own process, with your own Claude Code or Codex (hosted models only when neither is signed in), and prints one line at once. The fix records the correction as a case in cases/ next to the Method file, judged on what the person saw (the result, the files the run wrote, the messages it sent), and tests changes on a private copy of the run, with every message or change held back. It applies a change only when the change fixes this run reliably and breaks no earlier correction, or adds the note as a learned rule when it cannot test one safely. method wait prints what it did, and so does the next method run of the Method. method undo restores the Method as it was before. The fix starts from the newest version of the Method, as method run does. Two people who judge the same step of a run in opposite ways are held: the output shows both, and method judge RUN_ID keep JUDGMENT_ID keeps one and sets the other aside. For a run whose content stays on this computer (run_data: device), the account gets only the verdict and the step; the note and the corrected result go in .method/judgments.jsonl next to the Method file. Do not ask the person to confirm a judgment, and do not edit the Method yourself for the same correction.

Result and changes:
One line: Working on it. --json prints the judgment and {fix: {status: working, wait}}; method wait JUDGMENT_ID gives the outcome.

Errors:
An unknown run, a run of a Method that is not in your account, or no sign-in.

Example:

```sh
method judge 6f1c… wrong --note "it's not even redlined"
method wait
```

## learned

List the rules that the agent learned from corrections, or remove one.

Usage:

```sh
method learned FILE [--remove NUMBER] [--json]
```

Arguments and defaults:
The rules are in learned.json beside the Method file; a step uses a rule when its condition holds. Each line says the rule in plain words, who taught it, when, and how often it applied in this computer's runs. --remove NUMBER (from the list, or the rule's id from --json) retires one rule and saves a new version; method undo brings it back.

Result and changes:
One line per rule, or the rule that was removed. --json prints {rules: [{id, step, when, then, by, created, applied, text}]}.

Errors:
No such rule, or a learned.json that is not valid.

Example:

```sh
method learned nda.method
method learned nda.method --remove 2
```

## undo

Undo Method's last change to a Method: a fix, a pruning change, or a removed learned rule.

Usage:

```sh
method undo [FILE] [--json]
```

Arguments and defaults:
FILE defaults to the only Method file in this folder, else the Method of the last change on this computer. Restores the Method file and the files the change wrote, and saves that as a new version. A file that changed after Method's change is not overwritten. Run it again to undo the change before.

Result and changes:
One line: what is undone.

Errors:
Nothing to undo, or the file changed after the change.

Example:

```sh
method undo
```

## changes

List the changes that Method applied to a Method.

Usage:

```sh
method changes FILE [--json] [--server URL]
```

Arguments and defaults:
Lists, newest first, the changes that method judge applied on this computer and the changes that Method made in the account. A change made in the account is a new version: the next method run of the file takes it.

Result and changes:
One line per change: its date, its version, and its cause. --json prints {file, method_id, changes: [{id, source, cause, date, version_id, steps}]}. No changes.

Errors:
No id: line and no change made on this computer.

Example:

```sh
method changes task.method
```

## secret

Give this computer the values of a Method's declared secrets.

Usage:

```sh
method secret find [FILE]
method secret import FILE NAME...
method secret set NAME
method secret list [NAME...]
```

Arguments and defaults:
find lists the KEY=VALUE files in this folder (3 levels down) and in the parent folder (2 levels down) with the key names in each, never values; for the Method FILE (or the only Method here) it says which declared secrets each file holds and prints the import command. import copies the named values from a KEY=VALUE file that the user names, without printing them. set opens a private form on 127.0.0.1 in the browser for one value. list shows names and where each value is found (shell, this computer, or missing), never values. Values are kept in ~/.config/method/secrets.json (mode 0600) and are never sent to Method. A value exported in the shell is used first. Every script of the Method receives all of its declared secrets.

Result and changes:
JSON with the saved names, or the list.

Errors:
A name is missing from the file, or no value was entered.

Example:

```sh
method secret find
method secret import ../service/.env ARCHIVE_TOKEN
```

## connect

Connect an app to the Method in this folder, so the app runs it in production.

Usage:

```sh
method connect [APP_FOLDER] [--file METHOD_FILE]
```

Arguments and defaults:
Run it in the Method's folder. APP_FOLDER (default: this folder) is the app's folder. It makes a service key named after the app folder and writes METHOD_API_KEY to the app's .env (a new file, or a new or replaced line); it never prints the key. It adds .env to .gitignore in a git repository. When the Method has no published version, it publishes the current file. It detects Node (package.json) or Python (pyproject.toml, requirements.txt), and prints the install line and the code to add. Run it again: an app with a working key keeps it.

Result and changes:
JSON with the method_id, the published version, where the key is, install, code, secrets_to_set_on_the_host, and next.

Errors:
No or several .method files (give --file), an app folder with no language marker, or a failing case at publish.

Example:

```sh
method connect ../app
```

## answer

Answer the question of a run that waits on an ask step (on this computer or a production run), or the question that a fix asked about a correction.

Usage:

```sh
method answer RUN_ID [--answer JSON]
method answer JUDGMENT_ID "THE PERSON'S WORDS"
```

Arguments and defaults:
With a run ID: without --answer it prints the question and its form (the fields of the answer); with --answer it checks the answer against the form and sends it, and the run continues. A run that keeps its content on devices has a sealed question: run this where the app's METHOD_API_KEY is (the environment, or the .env of this folder), or on the laptop that started the run with its sign-in. A run on this computer (method run FILE) takes its answer the same way: the answer is kept in its run folder, and the run continues in the background, as method run does, from that step. With a judgment ID: send the person's own words, word for word, and the fix starts again with them in its own process; method wait gives what it did. Never answer a fix's question yourself. For a Method whose run content stays on this computer, the answer stays next to the Method file.

Result and changes:
The question and form, or the run after the answer; for a fix, one line.

Errors:
The run is not waiting, the answer does not match the form, the key cannot open a sealed question (wrong_key), or the correction has no open question.

Example:

```sh
method answer 6f1c… --answer '{"approved":true}'
method answer jdg_6f1c… "Every counterparty NDA must come back redlined."
```

## worker

Run production runs that an app started with the runs API.

Usage:

```sh
method worker [--method ID]... [--concurrency N] [--server URL]
```

Arguments and defaults:
Uses METHOD_API_KEY, or the sign-in of this computer. Use the app's key: runs that keep content on devices open only with the key that started them. The worker claims queued runs of the organization (or only of each --method), renews each run's lease, downloads the run's saved version by ID, prepares its dependencies once per version, reads declared secrets from the environment, and sends the run records to the dashboard. An ask step makes the run wait: the worker saves the run folder, reports the question, and lets go of the run; after the answer, a worker continues it and reuses the finished steps. --concurrency runs that many at the same time (default 1). Ctrl+C stops after the current runs; a second Ctrl+C stops them and queues them again. The libraries start a worker in the app's process with method.run(), so this command is for separate worker processes.

Result and changes:
One JSON line for each finished run: {run_id, method_id, version_id, status, run_data, result?, error?, run_dir}, and one for each run that starts to wait: {run_id, status: waiting, question}. A run_data: device result is printed only here.

Errors:
Missing or revoked key. A run whose lease expires goes back to the queue and runs again (at most 3 attempts).

Example:

```sh
METHOD_API_KEY=mk_live_... method worker --method wf_example
```

## keys

Manage the organization's service keys for production runs.

Usage:

```sh
method keys create --name NAME
method keys list
method keys revoke KEY_ID
```

Arguments and defaults:
A service key (mk_live_...) lets an app start runs and lets a worker run them. method connect makes one for an app and writes it to the app's .env. Keep the key in the app's secret store as METHOD_API_KEY; never put it in a Method or in chat.

Result and changes:
create prints the key and its webhook_secret once; the server keeps only a hash of the key. list shows names, prefixes, and last use, never keys.

Errors:
Requires a person's sign-in (method login), not a service key.

Example:

```sh
method keys create --name 'Cuties backend'
```

## status

Check installation and sign-in without listing Methods or starting login.

Usage:

```sh
method status [--server URL]
```

Arguments and defaults:
No required arguments. Checks the selected server with the current credential when one exists.

Result and changes:
JSON {installed:true,server,signed_in}. A missing or expired credential returns signed_in:false. Does not print account details.

Errors:
Network and server errors exit 1; they are not reported as signed out.

Example:

```sh
method status
```

## list

Find your online methods.

Usage:

```sh
method list [--server URL]
```

Arguments and defaults:
No required arguments.

Result and changes:
Server JSON containing methods. No changes.

Example:

```sh
method list
```

## steps

Read all complete step definitions in a saved method.

Usage:

```sh
method steps WORKFLOW_ID [--version VERSION_ID] [--server URL]
```

Arguments and defaults:
Default: latest version. Use step with two IDs to read one saved step.

Result and changes:
JSON {version_id,steps}. No changes.

Errors:
Missing method or version.

Example:

```sh
method steps wf_example
```

## step

Read one online step. For local edits use step add/update/remove/move.

Usage:

```sh
method step WORKFLOW_ID STEP_ID [--version VERSION_ID] [--server URL]
```

Arguments and defaults:
Both IDs required. Default: latest version. Subcommand words add, update, remove, move are reserved for local editing.

Result and changes:
JSON {version_id,step}. No changes.

Errors:
Missing method, version, or step. Use method steps to find step IDs.

Example:

```sh
method step wf_example search
```

## login

Connect this computer with browser approval.

Usage:

```sh
method login [--server URL]
```

Arguments and defaults:
No credentials in chat or command flags. Method opens the sign-in/approval page and waits. Connection is saved per server in ~/.config/method. Sign in again if access expires or is revoked.

Result and changes:
Sign-in instructions and status text. Stores a private local credential after approval. Remote commands also start login when no credential exists.

Errors:
Approval expired, denied, or network unavailable. Repeat login when ready.

Example:

```sh
method login
```

## logout

Disconnect this computer from the selected Method server.

Usage:

```sh
method logout [--server URL]
```

Arguments and defaults:
No required arguments. Select the same server used for login.

Result and changes:
Status text. Revokes remote access, then removes the local credential.

Errors:
If remote revocation fails, the local credential remains. Retry online, or use devices/revoke from another connected computer.

Example:

```sh
method logout
```

## devices

List authorized computers.

Usage:

```sh
method devices [--server URL]
```

Arguments and defaults:
No required arguments.

Result and changes:
JSON list of the computers signed in to your account, with id, name, created_at, revoked_at, and this_computer (true for the computer that asks). Revoke one with method revoke ID. No changes.

Example:

```sh
method devices
```

## revoke

Revoke a computer's Method access.

Usage:

```sh
method revoke DEVICE_ID [--server URL]
```

Arguments and defaults:
Use the exact ID from method devices. This changes account access.

Result and changes:
Server JSON confirmation. The selected device can no longer use that credential.

Errors:
Unknown device ID.

Example:

```sh
method revoke device_example
```

## runs

Read saved run summaries.

Usage:

```sh
method runs [--method WORKFLOW_ID] [--server URL]
```

Arguments and defaults:
Default: all methods. --method filters the list.

Result and changes:
Server JSON containing runs. No changes.

Example:

```sh
method runs --method wf_example
```

## logs

Read saved run evidence before a repair.

Usage:

```sh
method logs RUN_ID [--server URL]
```

Arguments and defaults:
Use a run ID from method runs. Saved logs may be incomplete if upload failed.

Result and changes:
Server JSON containing the run, inputs, outputs, checks and events. No execution or changes.

Errors:
Missing run.

Example:

```sh
method logs run_example > run.json
```

## sync

Retry upload of records from an existing local run.

Usage:

```sh
method sync RUN_DIRECTORY [--server URL]
```

Arguments and defaults:
Directory must contain method-sync.json. Default destination is the saved run's server. Do not use a new business run to repair an upload.

Result and changes:
Upload status text. Updates dashboard records and local sync metadata. Does not execute steps.

Errors:
Missing run/sync records; access or network error. Keep the original run directory and retry.

Example:

```sh
method sync .method-runs/wf_example/saved-run
```

## run

Run a local .method file, or a saved Method by ID or by its name in your workspace. When this computer is signed in, a run of a local file starts at once and saves in the background: the version of the file's content and the run's records go to the dashboard through the outbox (~/.cache/method/outbox), and the last line says Saved as version N, or Will save when online; without sign-in the records stay in .method-runs. Steps whose definition and inputs match an earlier accepted run on this computer are reused.

Usage:

```sh
method run FILE.method [OPTIONS]
method run NAME.compare [OPTIONS]
method run WORKFLOW_ID [--version VERSION_ID] [--server URL] [OPTIONS]
method run NAME [OPTIONS]
```

Arguments and defaults:
Models come from the Method's models: (or the account default). --workspace selects a different helper folder. See method authoring execution. Optional --state FILE initializes state for a new run. Resume with --resume --run-dir DIR; authorize unfinished work with --retry STEP:ITERATION.

--inputs FILE: JSON input values.
--inputs-from RUN_ID: use the inputs of that run; --inputs FILE overrides single values.
--run-dir DIR: the folder for this run's records (new runs too; default .method-runs/ID).
--resume: continue the same saved run with its saved models.

## Comparisons

A NAME.compare file asks one question about two or more agents and answers "ARM is better" or "Can't tell yet". Read method authoring comparisons before writing one. method run NAME.compare checks the file, runs a trial (what each arm received, what happened to each correction, and the noise at the start with 2 learners per arm), and asks to start the full run: pass the person's answer with method answer RUN_ID --answer '{"go": true}'. A later run of the same file does not ask again. The start line and the result link to the comparison's page on the dashboard. A failed run stops with a plain error; run the comparison again and finished runs are reused. A changed measure grades again without running the arms. Events that change the model cannot run yet.
--rerun STEP: run this step again even when an earlier run can be reused. Repeat for more steps.
--fresh: run every step; reuse nothing.
--verbose: print runtime events.
NAME: the name of a Method in your workspace (not case-sensitive), run as method run ID runs it: the newest version. When several Methods have the name, the run does not start; the result lists their names and IDs (exit 2).
Before a signed-in run of a FILE, the file takes the newest version of its Method. When a teammate saved a newer version, an unchanged file takes it, and a changed file combines it step by step and file by file; one line on stderr says whose version it took and which of your changes are kept. When you and a teammate changed the same step or the same script file, nothing runs and no file changes: the result has status needs_you and both texts of each part (exit 2). Combine them in the file, then run again. Offline, the file runs as it is, with one line. --resume does not change the file.
First, the outcomes of fixes of this Method that nobody has seen yet are printed, one line each. Then corrections of the Method that wait (from the dashboard, an answer, or a fix that stopped) start a fix in the background, as method judge does, with one line on stderr; the run does not wait for it. After a run that completed, its output is checked in the background against the corrections that fixes of the last 30 days answered; nothing runs again, and a problem that comes back twice is reported on the next run.
When the same run (the same version and the same inputs) is already going in your workspace, one line says who started it and links to it; this run starts too. To find it, each run record has a sha256 of its inputs; a run whose content stays on devices (run_data: device) sends none, because a hash of short inputs can show them.
A Method that uses shared state (method state) waits while another person's run holds the state, with one line, and starts when it is free. A run that stopped while it held the state stops this run, and the line names the person who must check it.
A Method whose declared secrets are not on this computer stops before the first step with the list of missing keys, each with its method secret set command. A step that stops because a file is not on this computer names the file and who saved this version.
Use method doctor to check the installed Node and configured tools.

Result and changes:
When signed in, the start line and the final result have dashboard: the link to the run's page; give it to the user when the run starts. Progress, then the final result as JSON on stdout; a run that stopped has failure (owner, headline, step, next), and a failed run also prints Failed, Whose problem, and Next lines on stderr. Local result.json and run evidence. The runtime executes the method's declared scripts, calls, agents, and checks. Executes trusted local processes; changes declarations do not enforce permissions. Runs exit 0 on completion, 1 on failure, 2 when human input is needed, and 3 when an observer could not confirm an external change (unconfirmed).

Errors:
Missing inputs/access, failed check, timeout, unsafe resume/version mismatch, upload failure. See recovery. Never retry a business write without inspecting its saved changes.

Example:

```sh
method run wf_example --version v_example --inputs inputs.json
```

## observe

Make the effect observations that are due for finished runs.

Usage:

```sh
method observe [RUN_DIRECTORY...] [--pending ROOT]...
```

Arguments and defaults:
Without directories, checks runs with open effects under .method-runs and the Method cache. Runs only observers and judges; never repeats an action. Schedule it, for example hourly, so late evidence such as a bounce reaches the run.

Result and changes:
JSON with each run's new verdicts, status, and next observation time. A synced run whose status changed is uploaded again.

Errors:
Locked run, changed bundle, or a missing observer credential.

Example:

```sh
method observe --pending .method-runs
```

## test

Replay recorded cases against this version of a Method. Every case must pass.

Usage:

```sh
method test FILE [--case ID]... [--baseline OLD_FILE] [--new ID]... [--cases DIR] [--once | --runs N [--min-pass N]] [--live STEP]... [--no-judge-cache] [--keep-dir DIR]
```

Arguments and defaults:
Cases are in cases/ beside the Method. Unchanged steps return their recorded outputs; changed steps run; each attempt works on its own copy of the files the recorded run read, so a changed step that writes files runs safely; a Method tool that sends or changes something returns a stand-in instead. --baseline also runs each case on the old version, to show what the change fixed or broke, and answers which version is better: the new one when it fixes a case and breaks none, the old one when it breaks a case and fixes none, else can't tell yet. --once runs each case once; --runs N and --min-pass N replace each case's own counts. --live STEP runs that step live even when it matches the recording. --no-judge-cache judges again instead of reusing earlier judgments. --keep-dir keeps each attempt's run folder there.

Result and changes:
JSON report with a verdict per case and passed:true when no case blocks the change; with --baseline also comparison: {answer, reason}. Exit 0 or 1.

Errors:
Unknown case or step, invalid Method, or setup errors.

Example:

```sh
method test task.method --baseline task-before.method --new bounce-reported
```

## case

Keep a correction as a recorded case that every later version must pass.

Usage:

```sh
method case new|retire|list FILE ...
```

Arguments and defaults:
Use method help case new, method help case retire, or method help case list.

Result and changes:
See the subcommand.

Errors:
Unknown action. Choose new, retire, or list.

Example:

```sh
method help case new
```

## case new

Turn a correction into a recorded case.

Usage:

```sh
method case new FILE --id ID --note TEXT (--run BAD_RUN | --passing-run GOOD_RUN | both) (--rubric SENTENCE... | --expect FILE) [--ref outputs.NAME] [--context REF]... [--accept-conflict TEXT]
```

Arguments and defaults:
--run is the run that went wrong; the case must fail on it. --passing-run is the run the person accepted after the fix; the case must pass on it. With only --passing-run, the case pins behaviour that is already right. --rubric is a plain sentence that must be true of the output (repeatable); a model judges it with quotes. --ref selects the output to judge; the default is the Method's result. --context REF gives the judge other values to check against, such as the sources or the person's words (outputs.NAME or inputs.NAME); they are read, not judged. --expect FILE gives exact checks instead: {kind: equals, ref: outputs.NAME, value}, {kind: status, in: [STATUS]}, {kind: effect, effect: STEP/ITERATION/NAME, verdict: [VERDICT]}, or {kind: predicate, runtime: node, entrypoint: check.mjs}. --redact FILE maps recorded text to replacements. --accept-conflict TEXT keeps a case that conflicts with an instruction of the Method, with the person's answer.

Result and changes:
The saved case, with its result on each run. Its author is the signed-in person, so a refusal and the run notice name whose case it is. A case that the bad run already meets is refused: it does not capture the problem, or the note does not match the run. A case that can pass only by breaking an instruction of the Method's model steps is refused (case_conflicts): the error names the rule and the instruction.

Errors:
A case that does not fail on the bad run, or does not pass on the passing run; a case that conflicts with an instruction; an existing ID; an unreadable run.

Example:

```sh
method case new report.method --id sources-named --run .method-runs/bad --passing-run .method-runs/fixed --note 'Say which source backs each point.' --rubric 'Every point names the source file that supports it.'
```

## case retire

Retire a case whose rule no longer applies.

Usage:

```sh
method case retire FILE ID --reason TEXT [--by NEW_ID]
```

Arguments and defaults:
The case stays on disk with its reason and is no longer run. Use it when a policy changed, not to make a failing change pass.

Result and changes:
JSON {retired}.

Errors:
Unknown or already retired case.

Example:

```sh
method case retire task.method old-terms --by new-terms --reason 'Payment terms changed on 1 October.'
```

## case list

List the cases of a Method.

Usage:

```sh
method case list FILE
```

Arguments and defaults:
Reads cases/ beside the Method unless --cases DIR is given.

Result and changes:
JSON list of cases with status and note.

Example:

```sh
method case list task.method
```

## effect

Use a reviewed observer for an external change.

Usage:

```sh
method effect add|list ...
```

Arguments and defaults:
Use method help effect add or method help effect list.

Result and changes:
See the subcommand.

Errors:
Unknown action. Choose add or list.

Example:

```sh
method effect list
```

## effect add

Declare an effect with a reviewed observer.

Usage:

```sh
method effect add FILE STEP NAME --observer OBSERVER [--connection NAME] [--in ALIAS=REF]... [--set KEY=VALUE]... [--intent TEXT] [--horizon DURATION] [--blocking]
```

Arguments and defaults:
Copies the observer, its judge, and its fixtures into observers/ beside the Method, adds the observer connection with role: observer, and sets the effect. --set fills observer settings. For files, SQLite databases and JSON services, write a built-in observer (kind: file, sqlite, or http) in the step instead. The step must already declare the changed connection in changes. Read the printed setup for the observer's credential.

Result and changes:
The edited workflow and the observer's setup instructions. Sets format method/3.4.

Errors:
Unknown observer, missing --in binding, or a step without an external change.

Example:

```sh
method effect add task.method send_summary delivered --observer mail.delivery --in to=inputs.ap_lead
```

## effect list

List the reviewed observers.

Usage:

```sh
method effect list
```

Arguments and defaults:
No arguments.

Result and changes:
JSON list of observers and what they need.

Example:

```sh
method effect list
```
