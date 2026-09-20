export const exampleWorkflow = `format: method/3.2
name: Copy a message
goal: Preserve every character of a supplied message.
inputs:
  message:
    type: text
    description: The complete message to preserve.
steps:
  copy:
    name: Copy message
    purpose: Preserve the exact message.
    in:
      message: inputs.message
    do:
      kind: run
      runtime: node
      entrypoint: copy.cjs
    limits:
      timeout_ms: 10000
    out:
      copied_message:
        type: text
        description: The complete unchanged message.
    check:
      equals:
        actual: copied_message
        expected: message
result: copied_message
`;
export const exampleFiles: Record<string, string> = {
  "copy.cjs": 'let text="";process.stdin.on("data",x=>text+=x);process.stdin.on("end",()=>console.log(JSON.stringify({copied_message:JSON.parse(text).message})));\n',
  "inputs.yaml": "message:\n  type: text\n  description: The complete message to preserve.\n",
  "copy.yaml": "name: Copy message\npurpose: Preserve the exact message.\nin:\n  message: inputs.message\ndo:\n  kind: run\n  runtime: node\n  entrypoint: copy.cjs\nlimits:\n  timeout_ms: 10000\nout:\n  copied_message:\n    type: text\n    description: The complete unchanged message.\n",
  "check.yaml": "equals:\n  actual: copied_message\n  expected: message\n",
  "inputs.json": '{"message":"Hello"}\n',
  "runtime.json": JSON.stringify({ allow_local_processes: true, runtimes: { node: { command: "node", version: "22+" } }, limits: { timeout_ms: 60000, max_model_requests: 0, max_invocations: 10, max_tool_calls: 0, max_output_bytes: 1000000, max_request_bytes: 1000000 } }, null, 2) + "\n",
};
export const exampleCommands: string[][] = [
  ["init", "message.method", "--name", "Copy a message", "--goal", "Preserve every character of a supplied message."],
  ["set", "message.method", "/inputs", "--value-file", "inputs.yaml"],
  ["step", "add", "message.method", "--id", "copy", "--value-file", "copy.yaml"],
  ["check", "set", "message.method", "copy", "--value-file", "check.yaml"],
  ["set", "message.method", "/result", "--text", "copied_message"],
  ["validate", "message.method"],
];
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export function exampleScript(): string {
  return "set -eu\n" + Object.entries(exampleFiles).map(([path, contents]) => `cat > ${quote(path)} <<'METHOD_EXAMPLE'\n${contents.trimEnd()}\nMETHOD_EXAMPLE`).join("\n\n") + "\n\n" + exampleCommands.map(args => "method " + args.map(quote).join(" ")).join("\n");
}
