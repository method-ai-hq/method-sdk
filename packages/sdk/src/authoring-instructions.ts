/** Shared authoring text; safe to import in the dashboard and public site. */
export const authoringEntryRule = "Before creating, editing, or proposing a Method, run `method authoring` and read its guidance. Do this before choosing an existing Method as a reference.";

export const checkEditingRule = "Existing checks and tests are implementation choices, not user requirements. Remove a check that is unnecessary, repeats other validation, or enforces a requirement that nobody asked for. Delete the tests and instructions that exist only for it, and do not replace it. Do not change useful output only to satisfy a check.";

export const designProcedure = `# Choose the design

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
`;

/** The full check rules; in concepts. */
export const checkRules = `# Checks

Add a check only when it catches a concrete failure that matters to the result. Output types and the runtime already validate shapes; do not repeat them. Do not check wording, headings, keywords, lengths, or counts unless the task requires them: "write accurate prose" is not a reason to match strings.

Use the simplest check that proves the fact: a built-in equals, count, present, or file check, a script, or an agent check. Local file writes need no check: the runtime observes files connections itself. A change to a service, an API, email, or a browser that sends needs an effect that reads the result back, because a receipt or a 200 status shows only that the request was accepted. Use a built-in observer (http, sqlite, file) when one fits. When a change cannot or need not be observed, such as a browser step that only reads, write no_effect_reason instead.

${checkEditingRule}
`;

/** The rules that make a first Method work quickly. They come before every other part of the guide. */
export const firstMethodRules = `# Build a Method

1. **Sign in first.** Run \`method status\`. If it is not signed in, run \`method login\` and let the user approve in the browser. Signed in, model and classification steps need no keys, each run saves a version when the file changed, and runs appear on the dashboard.
2. **Each model or classifier request is its own step**: \`call\`, \`agent\`, or \`classify\`, with its prompt in the Method, so the user can change one prompt, run again, and compare. A script never calls a model API. When the user already has code that does the work, keep its fixed logic as \`run\` steps and move each prompt and rubric into its own step; do not wrap the code. "The same thing" means the same behavior in steps. If a request cannot become a step because Method lacks a feature, tell the user what is missing.
3. **Show the design, then build it in the same turn.** Show each step with its type, purpose, and output, and a table of the prompts, instructions, and rubrics in the user's existing work, each with the steps that receive it. Do not wait for approval unless the user asked to approve first. Ask only for information that you cannot find and that would change the design.
4. **Run early and often.** Write the first steps, validate, run, then add the next steps. Fix errors. Fix each warning, or accept it with the user's reason. Never add a check only to remove a warning. A new run reuses every step whose definition and inputs did not change, so each run executes only what changed. \`--rerun STEP\` runs a step again anyway; \`--fresh\` runs every step.
5. **Keep the inputs of the existing code.** If the code takes an ID and looks up the record, the Method takes the same ID and looks it up the same way.
6. **Keep the user's rules word for word.** When you convert an agent, a prompt, a playbook, or a guide that the user wrote, copy each of their instruction files unchanged beside the Method and list them in \`files\`. A run step reads them and returns their complete text, and every model step that applies them receives that text in \`in\`. Each step prompt says the step's own task and tells the model to follow every rule in that text. Do not reword, shorten, summarize, or split the user's rules, and do not leave one out as background: a reworded rule can change its meaning, for example when a condition ("only when", "unless", "after") or an exception is lost. In the table of rule 3, list each instruction file with the steps that receive it.
7. **Compare with the old agent before the Method replaces it.** Choose 3 to 5 sample inputs from the user's data, including the hard ones. Run the old agent as the user runs it and run the Method on the same inputs, and show the user every difference side by side. Fix each difference that the user does not accept, and run again. Do not say that the Method replaces the old agent, or does what it did, until the user has seen this comparison.
8. **Use the defaults without asking.** Model steps that name no model run on the user's own Claude Code or Codex subscription when one is signed in (hosted models on account credit only when none is), and \`classify\` uses Method's classifier, so no model or classifier keys are needed. To keep the model that existing code uses, add \`models: {writer: provider/model}\` to the Method and use \`model: writer\` in the steps (or \`model: provider/model\` on the step); it needs no key. Keep the models that the Method or the existing code names: when a model step fails, show the error and ask before you change its model. Run records go to the user's account. Set \`run_data: device\` only when the user explicitly asks for it. If they do ask for it, get confirmation from them and tell them in one line that the dashboard will no longer show inputs or results, and that improvements, Run now and Method Cloud stop working.
9. **Keys stay out of chat.** Declare each key that a script needs under \`secrets:\` with its purpose; every script of the Method receives all of its declared secrets. Run \`method secret find\` in the Method's folder: it lists the key files nearby and the names in each, never the values, and prints the import command. Run that command and tell the user which file each key came from: the key stays on this computer, so there is nothing to ask. If it finds nothing, ask the user to run \`method secret set NAME\`, which opens a private form in their browser. Never open, print, or search a key file (\`cat\`, \`grep\`, an editor), including Method's own secret store, and never ask for a value in chat: the values would go into the chat. When a run says Method's model credit is used up, run \`method config model-key\` yourself: it takes the user's own OpenRouter key from the one nearby key file that holds it, or opens a private form for it. Then run again.
10. **Choose a sample yourself** from the user's data, and check that it has the sources the Method needs. Ask only when there is no good sample.
11. **Iterate.** \`method run\` prints a \`dashboard\` link when the run starts and again with its result. Give the user the link as soon as the run starts. After a good run, show the result and the link, and ask what to change. Change the step and run again. Show only results that a run made: never write or edit a result by hand, and fix a wrong result in the Method, not in the data it reads. If you cannot run, say so.
12. **Publish** with \`method publish FILE --reason TEXT\` when the user wants to share or schedule a version. It runs the Method's cases first.
13. **Talk about the work, not about Method.** Unless the user asks, do not mention Method's versions, formats, settings files, or other internal files, and do not ask the user about them, about models, or about which saved version to use. Method updates itself and converts older Method files when it runs them. When the user asks whether a Method works, or asks you to make it work, run it with the inputs of a recent run (\`--inputs-from RUN_ID\`) and show the result and the dashboard link in a few sentences. Say that it works only after a run completed.
14. **One file for each Method.** Change and run a Method in its own file. Do not copy it to a temporary or other folder to change it: Method does not run or save the copy while the Method's file exists, and names that file.
15. **Questions in a run are for the user.** When a run stops with \`needs_input\`, ask the user its \`question\` in plain words, wait for the answer, and continue the run with it as the output says. Never answer it yourself.
16. **Make each run easy to find and to run again.** Give the Method a \`run_label\` that tells its runs apart, such as \`inputs.topic\`. When an input can be empty and a default picks the value, point \`run_label\` at the step output that holds the resolved value, not at the input. Put the readable output, such as the report text or the message, in \`result\`, not only in files. Write a \`run_prompt\` that says where each input comes from (for example "as_of is today's date in YYYY-MM-DD") and what to show at the end. Leave SDK, runtime, and version details out of it.
17. **Run again from the dashboard.** When the user pastes a "Run again" prompt from the dashboard, run with \`--inputs-from RUN_ID\` and change only what the prompt names: put those values in a file and add \`--inputs FILE\`.

When a run fails, read failure.headline and failure.next, change what they name, and run again.
`;

/** How to write the prompt inside a call, agent, or classify step. */
export const promptRules = `# Write each prompt

- **One task per prompt.** If a prompt says "then" or has several jobs, make several steps. Split the tasks, not the user's rules: every step that applies them receives all of them, word for word.
- **Say what to do.** Leave out background that does not change the output. The user's own rules and instructions are not background: pass them unchanged as an input, and do not restate them in your own words.
- **Show 1 to 3 examples of good output.** Take them from the user's work: examples in an existing prompt, a past output that the user approved, or the first run that the user accepts. Pass a long example as an input, not as text in the prompt.
- **Put the output shape in \`out\`**, not in the prompt.
- **Say what to do when the input does not have the answer**, for example "leave due empty". For classify, add an option such as \`unclear\`.

Before:

\`\`\`text
You are an expert support analyst with years of experience. Our company values clear
communication. Read the tickets, decide which ones are urgent, write a summary, and
return JSON with a "summary" key. Make it good.
\`\`\`

After (urgency is a classify step before this one; the shape is in \`out\`):

\`\`\`text
Write a five-sentence summary of this week's support tickets for the team.
Start with the high-urgency tickets. Quote no customer names.
Write it in the style of this summary from an earlier week:

{{example}}
\`\`\`
`;

/** Enough of the format to write a Method without reading the JSON schema. */
export const fieldReference = `# Field reference

\`\`\`text
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
\`\`\`

\`method schema method\` prints the complete JSON schema.
`;

export const designExamples = `# Contrasting design outlines

These are design outlines, not runnable Method files.

| Request | Design | Explanation |
| --- | --- | --- |
| Summarize supplied text | call → return summary | The model receives all source text. Add a save step only if a saved file is requested. Use an agent if it must find or inspect additional sources. |
| Investigate a claim | agent to research and assess → return findings | Add a separate planning, checking, or saving step only when the task needs that boundary or result. When the user requires that the findings say only what the sources say, add an agent check on the assess step (method authoring recipes). |
| Route a message with human review for low confidence | classify → threshold run → conditional ask | Classification returns probabilities. Code applies the threshold. Human input resolves cases below the threshold. Add a separate action with an effect if the Method must send or change anything. |
| Send a daily summary email | call to write → run to send, with an effect | The send script puts METHOD_OPERATION_ID in the Message-ID. A mail.delivery effect searches the bounce mailbox through its own read-only connection until a 5-day horizon. A bounce fails the run; no bounce by the horizon is unrefuted, not proven. |
`;


/** Cost rules for a design; in concepts, not in the start of the guide. */
export const costRules = "Before describing execution cost, check how the model steps run. A step that names no model runs on the user's Claude Code or Codex subscription when one is signed in on the computer (one local agent process per step; no account credit); otherwise on the account's hosted model. With hosted models, a call is one request without tools, and an agent step can make several requests and use tools, paid from account credit. A step on a models: entry with agent: codex or claude starts that local agent process. State the expected model requests and agent processes when they are known; mark unknown counts as unknown.";

/** What to watch after a Method works. */
export const watchRules = `# Watch it

- Look at failed and unconfirmed runs on the dashboard. A run that needs attention says which step failed and why.
- For classify, watch how often the choice is \`unclear\` or below your threshold. A rise means the inputs changed.
- For slow effects such as email delivery, schedule \`method observe --pending\`.
`;

/** What to do after a Method works: production, improvement, and script cards. */
export const afterRules = `# After it works

- **Put it in an app:** \`method connect APP_FOLDER\` publishes it and prints the code to add.
- **Record each reaction:** after you show a result, run \`method judge RUN_ID wrong --note "THEIR WORDS"\` (with \`--corrected FILE\` when they gave the right result) when the user corrects it or asks to change the Method because of it, and \`method judge RUN_ID right\` when they use or approve it. Do not ask them to confirm it, and do not edit the Method yourself for the same correction. A wrong judgment returns at once and tests a fix in the background with the user's own Claude Code or Codex. Run \`method wait\` for the result and tell the user its line. After a fix, show the tested output that \`method wait\` prints; never run a Method that sends or changes things again just to show it. When it prints a question, show it to the user word for word, never answer it yourself, and send their words with \`method answer JUDGMENT_ID "THEIR WORDS"\`. \`method learned FILE\` lists what the agent learned from corrections; \`method undo\` restores the Method as it was before Method's last change.
- **Explain the scripts:** \`method explain FILE\` writes a card for each script step.
`;

export const exampleSelection = "After choosing the step types, read the examples that fit the design. Use their syntax; choose the steps for this task yourself.";
