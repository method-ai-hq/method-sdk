import type { Json } from "../../workflow-language/src/schema.js";
export function readValue(values: Record<string, Json>, reference: string): Json {
  let value: any = values;
  for (const key of reference.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) throw Error(`Missing value: ${reference}.`);
    value = value[key];
  }
  return value;
}
export function renderInstructions(instructions: string, inputs: Record<string, Json>): string {
  return instructions.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, ref: string) => { const value = readValue(inputs, ref); return typeof value === "string" ? value : JSON.stringify(value); });
}
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && equal((a as any)[k], (b as any)[k]));
}
