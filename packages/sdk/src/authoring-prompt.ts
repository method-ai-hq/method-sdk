import { exampleSelection } from "./authoring-instructions.js";

export const authoringPrompt = `I want to turn some repeated work into a method using the Method CLI. Can you help me do that?

First, check that the CLI is installed with \`which method\` and that I am signed in with \`method status\`. If needed, follow the setup instructions at https://withmethod.ai/docs/quickstart.md to install the CLI and sign in. Let me approve sign-in in the browser.

Then read \`method authoring\`. Ask me about the work I want to repeat and what a good result looks like. Wait for my answers before building it.

Apply the Script steps rules, and update affected descriptions when you change script behavior. ${exampleSelection}

Help me write the method and its files, validate them, and save the method to my account. Run an agreed sample of the saved version and inspect the actual result. Use a test destination for external changes, or ask before making a live change. Return the Method and run links with the test result.`;
