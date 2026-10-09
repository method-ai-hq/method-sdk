/** The prompt for agents without the Method plugin. The installed guide holds the rules; this prompt only starts them. */
export const authoringPrompt = `Help me turn repeated work into a Method with the Method CLI.

The work: [describe the task, its inputs, and the result you want]

1. If \`which method\` finds nothing, install Method. I approve this installer: \`curl -fsSL https://app.withmethod.ai/install.sh | sh\`
2. Run \`method login\` and let me approve sign-in in the browser.
3. Run \`method authoring\` and follow it. Make each prompt its own step, so that I can improve it.
4. Run it on a sample, show me the result and the dashboard link, then ask me what to change.`;
