import { expect, it } from "vitest";
import { keyFileReason } from "../../packages/sdk/src/guard-keys.js";

const bash = (command: string, description = "") => keyFileReason({ tool_name: "Bash", tool_input: { command, description } });

it("asks before a key file is opened, and lets Method's own commands and other files pass", () => {
  expect(keyFileReason({ tool_name: "Read", tool_input: { file_path: "/p/app/.env" } })).toBeDefined();
  expect(keyFileReason({ tool_name: "Grep", tool_input: { pattern: "KEY", path: "app/.env.local" } })).toBeDefined();
  expect(bash("cat ../community-archive/.env")).toBeDefined();
  expect(bash("cat ~/.config/method/secrets.json")).toBeDefined();
  expect(bash('cd "/p/cuties lite" && method secret import ../community-archive/.env ARCHIVE_TOKEN')).toBeUndefined();
  expect(bash('(METHOD=~/.local/bin/method; [ -x "$METHOD" ] || METHOD=method; $METHOD secret import "../a/.env" ARCHIVE_TOKEN)')).toBeUndefined();
  expect(bash('find . -iname "*.env*"', "look for the community-archive .env file")).toBeUndefined();
  expect(keyFileReason({ tool_name: "Read", tool_input: { file_path: "/p/.env.example" } })).toBeUndefined();
  expect(keyFileReason({ tool_name: "Read", tool_input: { file_path: "/p/src/env.ts" } })).toBeUndefined();
});
