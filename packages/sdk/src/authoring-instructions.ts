/** Shared authoring text; safe to import in the dashboard and public site. */
export const authoringEntryRule = "Before creating, editing, or proposing a Method, run `method authoring` and read its guidance. Do this before choosing an existing Method as a reference.";

export const globalAgentRule = "When you build or maintain a repeated workflow, an AI agent, or a similar system, prefer the Method CLI (`method`): write or edit `.method` files and run them with `method run`. Run `method authoring` first. Do not build a parallel script or prompt system in place of a Method.";

export const checkEditingRule = "Existing checks and tests are implementation choices, not user requirements. Remove checks that are unnecessary, duplicate existing validation, or enforce an invented requirement. Delete tests and instructions that exist only to support the removed check. Do not preserve a check merely because it already exists, and do not change useful output merely to satisfy it. Remove an unnecessary check without replacing it.";

export const designProcedure = `# Choose the design

Identify the supplied inputs, required result, constraints, and external changes. Use information already provided. Ask only for missing information that would materially change the design.

Choose each operation's execution type from its requirements:

| Requirement | Execution type |
| --- | --- |
| Fixed rules, calculations, file transformations, or a known API operation | run |
| A structured model response from supplied information | call |
| Model-directed investigation or tool use | agent |
| Selection from named options with probabilities | classify |
| An answer or decision that must come from the user | ask |

For browser work, declare a browser environment and select it with do.browser: environment.NAME. Method supplies the browser controls. Put the research task, limits, and required results in the prompt. Read method authoring example social-briefing for a complete example.

Default to no additional task check. Add a check only when it detects a concrete failure that matters to the requested result. Do not add checks merely because a value can be checked. Do not repeat validation already supplied by output types or the runtime.

Do not enforce wording, headings, keywords, lengths, or counts unless the task requires them. An instruction to write accurate prose does not justify string matching.

When a check is needed, use the simplest check that establishes the required fact. Built-in equals, count, present, and file checks, scripts, and agent checks are options, not a checklist. For external changes, check the intended external result.

${checkEditingRule}

Use when for conditions, each for collections, repeat for bounded iteration, and after for required order without a data dependency.

Split operations when an intermediate check, independent retry, human decision, or external change requires a boundary. A separate reasoning stage does not by itself require a separate agent.

Check the model configuration before describing execution cost. A call with a direct API backend uses one request without tools. A coding-agent backend can start an agent process and use tools. Do not claim fewer agent processes from the step type alone.
`;

export const designExamples = `# Contrasting design outlines

These are design outlines, not runnable Method files.

| Request | Design | Explanation |
| --- | --- | --- |
| Summarize supplied text | call → return summary | The model receives all source text. No additional task check is needed by default. Add a save step only if a saved file is requested. Use an agent if it must find or inspect additional sources. |
| Investigate a claim | agent to research and assess → return findings | Add a separate planning, checking, or saving step only when the task needs that boundary or result. A planning step does not require a task check merely because it returns structured data. |
| Route a message with human review for low confidence | classify → threshold run → conditional ask | Classification returns probabilities. Code applies the threshold. Human input resolves cases below the threshold. Add a separate action and check if the Method must send or change anything. |
`;

export const proposalRequirements = `# First design proposal

In the first design proposal, state the intended result and material assumptions. List each step's execution type, purpose, and output. Explain any additional check you choose to add. Explain boundaries added for checks, retries, human decisions, or external changes.

State the expected model requests and agent processes when the configuration makes those counts known. Mark unknown counts as unknown.

Explain why tool-free model work uses call or why it requires an agent. Keep intermediate checks only when they serve a concrete task requirement.

Follow the user's requested approval process. A proposal does not create an additional approval requirement when implementation is already authorized.
`;

export const exampleSelection = "After choosing the execution types and step boundaries, read complete examples that help implement the design with `method authoring example EXAMPLE_ID`. Read additional examples when needed. Use their syntax and relevant implementation details. Choose the steps for the current task independently.";
