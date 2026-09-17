import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Json, LegacyWorkflow as Workflow, DataDefinition } from "../../workflow-language/src/schema.js";
import { shapeErrors } from "../../workflow-language/src/validate.js";
import type { Connections } from "./contracts.js";
export type Io = { ask(question: string): Promise<string>; write(text: string): void; close(): void };
export function terminalIo(): Io {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return { ask: question => readline.question(question), write: text => process.stdout.write(text), close: () => readline.close() };
}
export function describeInput(name: string, property: DataDefinition & { default?: Json | undefined }, required = property.default === undefined): string {
  return `${name} (${property.type}, ${required ? "required" : `default ${JSON.stringify(property.default)}`}): ${property.description}`;
}
export function parseAnswer(answer: string, property: DataDefinition): Json {
  let value: Json;
  if (property.type === "text") value = answer;
  else if (property.type === "boolean" && /^(yes|no)$/i.test(answer)) value = answer.toLowerCase() === "yes";
  else { try { value = JSON.parse(answer); } catch { throw Error(`Enter ${property.type === "number" ? "a number" : "a JSON value"}.`); } }
  const errors = shapeErrors(property, value); if (errors.length) throw Error(errors.join("\n")); return value;
}
export async function askInputs(definitions: Workflow["inputs"], io: Io): Promise<Record<string, Json>> {
  const values: Record<string, Json> = {};
  for (const [name, definition] of Object.entries(definitions ?? {})) {
    io.write(describeInput(name, definition) + "\n");
    while (true) {
      const answer = await io.ask(`${name}> `);
      if (!answer && definition.default !== undefined) { values[name] = definition.default; break; }
      try { values[name] = parseAnswer(answer, definition); break; } catch (error) { io.write(String(error) + "\n"); }
    }
  }
  return values;
}
export function missingInputsMessage(workflow: Workflow): string {
  return ["Supply --inputs inputs.json with these named values:", ...Object.entries(workflow.inputs ?? {}).map(([n, d]) => describeInput(n, d)), ""].join("\n");
}
export async function askResources(workflow: Workflow, workspace: string, io: Io | null): Promise<Connections> {
  const resources: Connections = {};
  for (const [id, requirement] of Object.entries(workflow.environment ?? {})) {
    resources[id] = { description: requirement.description };
    if (requirement.type !== "files") continue;
    if (!io) { resources[id]!.path = workspace; continue; }
    while (true) {
      const answer = await io.ask(`${id}: ${requirement.description}. Folder [${workspace}]> `);
      const path = resolve(workspace, answer || workspace);
      if (existsSync(path) && statSync(path).isDirectory()) { resources[id]!.path = path; break; }
      io.write("Choose an existing folder.\n");
    }
  }
  return resources;
}
