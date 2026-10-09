/** Shared authoring text; safe to import in the dashboard and public site. */
export const authoringEntryRule = "Before creating, editing, or proposing a Method, run `method authoring` and read its guidance. Do this before choosing an existing Method as a reference.";

export const checkEditingRule = "Existing checks and tests are implementation choices, not user requirements. Remove checks that are unnecessary, duplicate existing validation, or enforce an invented requirement. Delete tests and instructions that exist only to support the removed check. Do not preserve a check merely because it already exists, and do not change useful output merely to satisfy it. Remove an unnecessary check without replacing it.";

export const designProcedure = `# Choose the design

Identify the supplied inputs, required result, constraints, and external changes. Use information already provided. Ask only for missing information that would materially change the design.

Choose each operation's execution type from its requirements:

| Requirement | Execution type |
| --- | --- |
| Fixed rules, calculations, file transformations, or a known API operation that is not a model | run |
| A structured model response from supplied information | call |
| Model-directed investigation or tool use | agent |
| Selection from named options with probabilities | classify |
| An answer or decision that must come from the user | ask |

For browser work, declare a browser environment and select it with do.browser: environment.NAME. Method supplies the browser controls. Put the research task, limits, and required results in the prompt. Read method authoring example social-briefing for a complete example.

Default to no additional task check. Add a check only when it detects a concrete failure that matters to the requested result. Do not add checks merely because a value can be checked. Do not repeat validation already supplied by output types or the runtime.

Do not enforce wording, headings, keywords, lengths, or counts unless the task requires them. An instruction to write accurate prose does not justify string matching.

When a check is needed, use the simplest check that establishes the required fact. Built-in equals, count, present, and file checks, scripts, and agent checks are options, not a checklist. Local file writes need no check: the runtime observes files connections itself. A change to a service, an API, email, or a browser that sends needs an effect that reads the result back, because a receipt or a 200 status shows only that the request was accepted. Use a built-in observer (http, sqlite, file) when one fits. When a change cannot or need not be observed, such as a browser step that only reads, write no_effect_reason instead.

${checkEditingRule}

Use when for conditions, each for collections (add concurrency: N to run read-only items at once), repeat for bounded iteration, and after for required order without a data dependency.

Split operations when an intermediate check, independent retry, human decision, or external change requires a boundary. A separate reasoning stage does not by itself require a separate agent.

Check the model configuration before describing execution cost. A call with a direct API backend uses one request without tools. A coding-agent backend can start an agent process and use tools. Do not claim fewer agent processes from the step type alone.
`;

/** The rules that make a first Method work quickly. They come before every other part of the guide. */
export const firstMethodRules = `# Build a Method

1. **Sign in first.** Run \`method status\`. If it is not signed in, run \`method login\` and let the user approve in the browser. Signed in, model and classification steps need no keys, each run saves a version when the file changed, and runs appear on the dashboard.
2. **Each model or classifier request is its own step**: \`call\`, \`agent\`, or \`classify\`, with its prompt in the Method. Then the user can change one prompt, run again, and compare. A script never calls a model API; \`validate\` and \`run\` refuse it (\`model_call_in_script\`). When the user already has code that does the work, keep its fixed logic as \`run\` steps and move each prompt and rubric into its own step. "The same thing" means the same behavior with steps, not a wrapper around the code. If a request cannot become a step because Method lacks a feature, tell the user what is missing. Do not wrap the code.
3. **Show the design, then build it in the same turn.** Show each step with its type, purpose, and output, and the table of prompts and rubrics in the user's work with the step that holds each one. Do not wait for approval unless the user asked to approve first. Ask only for information that you cannot find and that would change the design.
4. **Run early and often.** Write the first steps, validate, run, then add the next steps. A new run reuses every step whose definition and inputs did not change, so each run executes only what changed. \`--rerun STEP\` runs a step again anyway; \`--fresh\` runs every step.
5. **Use the defaults without asking.** Model steps use the account's hosted models and \`classify\` uses Method's classifier, so the user's model and classifier keys are not needed. To keep the model that existing code uses, add \`models: {writer: {backend: method, model: "provider/model"}}\` to runtime.json and use \`model: writer\` in the steps; it needs no key. Run content goes to the user's account; set \`run_data: device\` only when the user asks to keep it on this computer. Say these defaults in one line and continue.
6. **Keys stay out of chat.** Declare each key that a script needs under \`secrets:\` with its purpose. To supply values, run \`method secret import FILE NAME...\` with a file that the user names, or ask the user to run \`method secret set NAME\`, which opens a private form in their browser. Values stay on this computer. Never ask for a value in chat and never print one.
7. **Choose a sample yourself** from the user's data, and check that it has the sources the Method needs. Ask only when there is no good sample.
8. **Iterate.** After a good run, show the result and the dashboard link, and ask what to change. Change the step and run again.
9. **Publish** with \`method publish FILE --reason TEXT\` when the user wants to share or schedule a version. It runs the Method's cases first.

When a run fails, read its \`fix\` and \`diagnostics\`, change the step, and run again.
`;

export const designExamples = `# Contrasting design outlines

These are design outlines, not runnable Method files.

| Request | Design | Explanation |
| --- | --- | --- |
| Summarize supplied text | call → return summary | The model receives all source text. No additional task check is needed by default. Add a save step only if a saved file is requested. Use an agent if it must find or inspect additional sources. |
| Investigate a claim | agent to research and assess → return findings | Add a separate planning, checking, or saving step only when the task needs that boundary or result. A planning step does not require a task check merely because it returns structured data. When the user requires that the findings say only what the sources say, add an agent check on the assess step (method authoring recipes). |
| Route a message with human review for low confidence | classify → threshold run → conditional ask | Classification returns probabilities. Code applies the threshold. Human input resolves cases below the threshold. Add a separate action with an effect if the Method must send or change anything. |
| Send a daily summary email | call to write → run to send, with an effect | The send script puts METHOD_OPERATION_ID in the Message-ID. A mail.delivery effect searches the bounce mailbox through its own read-only connection until a 5-day horizon. A bounce fails the run; no bounce by the horizon is unrefuted, not proven. |
`;

export const proposalRequirements = `# First design proposal

In the first design proposal, state the intended result and material assumptions. List each step's execution type, purpose, and output. When the user has existing prompts, rubrics, or code that calls a model, list each one and the step that holds it. Explain any additional check you choose to add. Explain boundaries added for checks, retries, human decisions, or external changes.

State the expected model requests and agent processes when the configuration makes those counts known. Mark unknown counts as unknown.

Explain why tool-free model work uses call or why it requires an agent. Keep intermediate checks only when they serve a concrete task requirement.

Follow the user's requested approval process. A proposal does not create an additional approval requirement when implementation is already authorized.
`;

export const exampleSelection = "After choosing the execution types and step boundaries, read complete examples that help implement the design with `method authoring example EXAMPLE_ID`. Read additional examples when needed. Use their syntax and relevant implementation details. Choose the steps for the current task independently.";
