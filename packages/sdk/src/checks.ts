import type { LegacyCheck as Check, Json } from "../../workflow-language/src/schema.js";
import type { Decision } from "./contracts.js";
import { readValue, equal } from "./values.js";
import { checkedFile } from "./files.js";
export function assertValue(check: Exclude<Check, string>, values: Record<string, Json>, roots: string[]): Decision {
  try {
    let pass = true, expected = "", observed: unknown;
    if ("equals" in check) { observed = readValue(values, check.equals.actual); const wanted = readValue(values, check.equals.expected); pass = equal(observed, wanted); expected = `${check.equals.actual} equals ${check.equals.expected} (${JSON.stringify(wanted)})`; }
    else if ("count" in check) { const value = readValue(values, check.count.value); if (!Array.isArray(value) && typeof value !== "string") throw Error("Count requires a list or text."); observed = value.length; pass = value.length >= (check.count.min ?? 0) && value.length <= (check.count.max ?? Infinity); expected = `${check.count.value} count between ${check.count.min ?? 0} and ${check.count.max ?? "unbounded"}`; }
    else if ("present" in check) { observed = readValue(values, check.present); pass = observed !== null; expected = `${check.present} is present`; }
    else { const value = readValue(values, check.file); checkedFile(value, roots); observed = value; expected = `${check.file} matches the saved file`; }
    return { result: pass ? "pass" : "fail", summary: `Expected ${expected}. Observed ${JSON.stringify(observed)}.`, evidence: [JSON.stringify(check)] };
  } catch (error) { return { result: "fail", summary: String(error), evidence: [JSON.stringify(check)] }; }
}
