import { authoringEntryRule } from "./authoring-instructions.js";

export const authoringPrompt = `I want to turn some repeated work into a method using the Method CLI. Can you help me do that?

First, check that the CLI is installed with \`which method\`. If needed, follow the setup instructions at https://withmethod.ai/docs/quickstart.md to install the CLI.

${authoringEntryRule}

Use the task and requirements I have already provided. Ask only for missing information that would materially change the design.

Follow the design procedure and proposal requirements in the guide. Apply the Script steps rules and keep descriptions consistent with behavior.

Help me write the method and its files and validate them. Before saving the method to my account, check sign-in with \`method status\` and follow any browser sign-in instructions. Let me approve sign-in in the browser. Run an agreed sample of the saved version and inspect the actual result. Use a test destination for external changes, or ask before making a live change. Return the Method and run links with the test result.`;
