import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const exampleDirectory = fileURLToPath(new URL("../examples/daily-briefing/", import.meta.url));
export const approvedMethod = readFileSync(new URL("../examples/daily-briefing/daily-briefing.method", import.meta.url), "utf8");
export const approvedTask = readFileSync(new URL("../examples/daily-briefing/TASK.md", import.meta.url), "utf8");

export const approvedReport = readFileSync(new URL("../examples/daily-briefing/approved-report.md", import.meta.url), "utf8");
