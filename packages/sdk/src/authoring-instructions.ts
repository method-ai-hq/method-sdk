/** Shared authoring text; safe to import in the dashboard and public site. */
export const authoringEntryRule = "Before creating, editing, or proposing a Method, run `method authoring` and read its guidance. Do this before choosing an existing Method as a reference.";

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

Use built-in equals, count, present, and file checks where sufficient. Use a script check for rules those checks cannot express. Use an agent check when the check requires judgment.

Use when for conditions, each for collections, repeat for bounded iteration, and after for required order without a data dependency.

Split operations when an intermediate check, independent retry, human decision, or external change requires a boundary. A separate reasoning stage does not by itself require a separate agent.

Check the model configuration before describing execution cost. A call with a direct API backend uses one request without tools. A coding-agent backend can start an agent process and use tools. Do not claim fewer agent processes from the step type alone.
`;

export const designExamples = `# Contrasting design outlines

These are design outlines, not runnable Method files.

| Request | Design | Explanation |
| --- | --- | --- |
| Summarize supplied text | call → run to save → file check | The model receives all source text. Use an agent if it must find or inspect additional sources. The file check confirms the saved file, not factual accuracy. |
| Investigate a claim | call to plan, with a script check → agent to research and assess → run to save | The checked plan creates a useful boundary before tool use. The plan check verifies required fields and references, not the quality of the research. |
| Route a message with human review for low confidence | classify → threshold run → conditional ask | Classification returns probabilities. Code applies the threshold. Human input resolves cases below the threshold. Add a separate action and check if the Method must send or change anything. |
`;

export const proposalRequirements = `# First design proposal

In the first design proposal, state the intended result and material assumptions. List each step's execution type, purpose, output, and check. Explain boundaries added for checks, retries, human decisions, or external changes.

State the expected model requests and agent processes when the configuration makes those counts known. Mark unknown counts as unknown.

Explain why tool-free model work uses call or why it requires an agent. Preserve useful intermediate checks when reducing model work.

Follow the user's requested approval process. A proposal does not create an additional approval requirement when implementation is already authorized.
`;

export const exampleSelection = "After choosing the execution types and step boundaries, read complete examples that help implement the design with `method authoring example EXAMPLE_ID`. Read additional examples when needed. Use their syntax and relevant implementation details. Choose the steps for the current task independently.";
