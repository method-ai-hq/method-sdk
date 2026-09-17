import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { method } from "../fixtures/method.js";
import { askInputs, parseAnswer } from "../../packages/sdk/src/prompts.js";
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
it("parses the six-type inputs and preserves text exactly",async()=>{
 const values=await askInputs({message:{type:"text",description:"Full message"}},{ask:async()=>" hi\n ",write:()=>{},close:()=>{}});expect(values.message).toBe(" hi\n ");expect(parseAnswer("yes",{type:"boolean",description:"Choice"})).toBe(true);expect(()=>parseAnswer("text",{type:"number",description:"Number"})).toThrow();
});
it("runs a YAML method through the installed CLI process interface",()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),"method-cli-v2-")));dirs.push(dir);writeFileSync(join(dir,"task.method"),JSON.stringify(method()));
 const codex=join(dir,"codex");writeFileSync(codex,`#!/usr/bin/env node
const fs=require('node:fs'),a=process.argv.slice(2);if(a[0]==='--version'){console.log('codex-cli 0.153.0');process.exit(0);}if(a[1]==='--help'){console.log('--dangerously-bypass-approvals-and-sandbox');process.exit(0);}let t='';process.stdin.on('data',c=>t+=c);process.stdin.on('end',()=>{const r=JSON.parse(t.slice(t.lastIndexOf('\\n\\n')+2));fs.writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({outputs:{copied_message:r.inputs.message},updates:{},observations:[],note:''}));});`);chmodSync(codex,0o700);
 const output=execFileSync(process.execPath,[resolve("node_modules/tsx/dist/cli.mjs"),resolve("packages/sdk/src/cli.ts"),"run","task.method","--run-dir","run"],{cwd:dir,env:{...process.env,PATH:`${dir}:${process.env.PATH}`},encoding:"utf8"});expect(output).toContain("Run succeeded");expect(JSON.parse(readFileSync(join(dir,"run/result.json"),"utf8")).outputs).toEqual({result:"Hello"});
},15000);
