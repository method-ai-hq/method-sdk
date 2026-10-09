/** The prompt for agents without the Method plugin. The installed guide holds the rules; this prompt only starts them. */
export const authoringPrompt = `Help me turn repeated work into a Method with the Method CLI. Do the setup first, without asking me:

1. If \`which method\` finds nothing, install Method now with \`curl -fsSL https://app.withmethod.ai/install.sh | sh\`. I approve this installer.
2. Run \`method login\` and wait while I approve the sign-in in my browser.
3. Run \`method authoring\` and follow it.

Then ask me what work to turn into a Method. Make each prompt its own step, so that I can improve it. Run it on a sample, show me the result and the dashboard link, and ask me what to change.`;
