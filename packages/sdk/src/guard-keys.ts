import { basename } from "node:path";

/**
 * The Method plugin's check before Claude Code reads a file or runs a command. A key file's values would go into the
 * chat, so opening one needs the person's approval. Only the tool's own input is read; Method's own commands
 * (`method secret import` reads key files without showing values) pass.
 */
const keyFile = (path: string) => {
  const name = basename(path.replace(/["']/g, ""));
  return /^\.env(\.[\w-]+)?$/.test(name) && !/^\.env\.(example|sample|template)$/.test(name)
    || name === "secrets.env" || /(^|\/)\.config\/method\/secrets\.json$/.test(path);
};
// One shell segment: `cd DIR`, or a run of Method's own CLI.
const ownCommand = (segment: string) => /^(cd\s+\S.*|(\S*\/)?method(\s.*)?)$/.test(segment.trim());

export function keyFileReason(input: { tool_name?: string; tool_input?: Record<string, unknown> }): string | undefined {
  const tool = input.tool_input ?? {};
  const reason = "This opens a key file, so its values would go into the chat. To give a key to a Method, run method secret import FILE NAME as its own command.";
  if (input.tool_name === "Bash") {
    const command = String(tool.command ?? "");
    const segments = command.split(/&&|\|\||[;|\n]/);
    if (segments.every(ownCommand)) return undefined;
    return segments.some(segment => segment.split(/\s+/).some(word => word && keyFile(word))) ? reason : undefined;
  }
  const path = String(tool.file_path ?? tool.path ?? "");
  return path && keyFile(path) ? reason : undefined;
}

export async function guardKeysCommand() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  let input: Parameters<typeof keyFileReason>[0] = {};
  try { input = JSON.parse(text); } catch { return; }
  const reason = keyFileReason(input);
  if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason } }) + "\n");
}
