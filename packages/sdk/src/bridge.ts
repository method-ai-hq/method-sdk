#!/usr/bin/env node
/** Python calls the same current runtime; no callback executor or second interpreter. */
import { createInterface } from "node:readline";
import { z } from "zod";
import { runMethod } from "./run-method.js";
import { authoringPath } from "./authoring.js";
import { loadWorkflow } from "../../workflow-language/src/validate.js";
import { renderPrompt } from "../../compiler/src/conversion-report.js";
const lines = createInterface({input:process.stdin, terminal:false});
const send = (value:unknown) => process.stdout.write(JSON.stringify(value)+"\n");
async function main() {
  const first = await lines[Symbol.asyncIterator]().next();
  if(first.done) throw Error("The bridge needs one JSON request.");
  const message = z.object({op:z.enum(["load","prompt","run_method"]), workflow:z.unknown().optional()}).passthrough().parse(JSON.parse(first.value));
  if(message.op === "load") return loadWorkflow(message.workflow);
  if(message.op === "prompt") return renderPrompt(loadWorkflow(message.workflow));
  const data = z.object({file:z.string(), config:z.record(z.unknown()), options:z.record(z.unknown()).default({})}).parse(message);
  return runMethod(authoringPath(data.file), data.config, {...data.options, onEvent:(event:unknown)=>send({type:"event",event})});
}
main().then(result=>send({type:"result",result}),error=>{send({type:"error",error:error instanceof Error?error.message:String(error)});process.exitCode=1;}).finally(()=>lines.close());
