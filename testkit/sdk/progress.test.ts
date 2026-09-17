import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { executeProcess, readLines } from '@withmethod/runtime/io.js';
import { codexProgress, progressMessage } from '@withmethod/runtime/progress.js';
import { runCurrentMethod } from '../../packages/sdk/src/current-runtime.js';
import { inspectRun } from '../../packages/sdk/src/inspect.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, {recursive:true,force:true})));
function temporary() { const root = mkdtempSync(join(tmpdir(), 'method-progress-')); roots.push(root); return root; }

it('keeps UTF-8 whole and ignores oversized progress lines', async () => {
  const pipe = new PassThrough(), lines: string[] = [];
  const done = readLines(pipe, async (line: string) => { lines.push(line); });
  const bytes = Buffer.from('Read café\n');
  pipe.write(bytes.subarray(0, 9)); pipe.write(bytes.subarray(9));
  pipe.write('x'.repeat(20_000)); pipe.write('\nnext\n'); pipe.end();
  await done; expect(lines).toEqual(['Read café', 'next']);
});
it('only accepts public fields and counts that agree', () => {
  expect(progressMessage({message:'Rendered pages',completed:3,total:2,step:'other',sequence:800,phase:'check'})).toEqual({message:'Rendered pages'});
  expect(progressMessage({message:'Rendered pages',completed:2,total:3,unit:'pages',child:'Renderer'})).toEqual({message:'Rendered pages',completed:2,total:3,unit:'pages',child:'Renderer'});
  expect(codexProgress({type:'item.completed',item:{type:'reasoning',text:'private'}})).toBeNull();
  expect(codexProgress({type:'item.completed',item:{type:'agent_message',text:'{"result":"final"}'}})).toBeNull();
  expect(codexProgress({type:'item.started',item:{type:'command_execution',id:'one',command:'secret command',aggregated_output:'private'}})).toEqual({message:'Running a command.',call_id:'one'});
  expect(codexProgress({type:'item.started',item:{type:'mcp_tool_call',server:'method_step',tool:'read'}})).toBeNull();
});
it('reports a script and its child before exit, keeps final JSON intact, and stamps events in order', async () => {
  const root = temporary(), runDir = join(root,'run'), ack = join(root,'ack');
  const script = `import fs from 'node:fs'; import {spawn} from 'node:child_process';
    const fd=Number(process.env.METHOD_PROGRESS_FD);
    fs.writeSync(fd,'invalid json\\n'+JSON.stringify({message:'Rendered café',completed:1,total:2,step:'spoof',iteration:55,sequence:900})+'\\n');
    const child=spawn(process.execPath,['-e',"require('fs').writeSync(3,JSON.stringify({message:'Child is reading',child:'Writer'})+'\\\\n')"],{stdio:['ignore','ignore','inherit',fd]});
    await new Promise(r=>child.on('exit',r));
    const deadline=Date.now()+4000;while(!fs.existsSync(${JSON.stringify(ack)})){if(Date.now()>deadline)process.exit(7);await new Promise(r=>setTimeout(r,10));}
    console.log(JSON.stringify({text:'done'}));`;
  writeFileSync(join(root,'work.mjs'),script);
  const method={format:'method/3.1',name:'Progress',goal:'Test progress',steps:{work:{purpose:'Run work',do:{kind:'run',runtime:'node',entrypoint:'work.mjs'},out:{text:{type:'text',description:'Result'}},limits:{timeout_ms:8000}}},result:'text'};
  writeFileSync(join(root,'work.method'),JSON.stringify(method));
  const config={allow_local_processes:true,runtimes:{node:{command:process.execPath,version:'test'}},limits:{timeout_ms:10000,max_invocations:2,max_model_requests:0,max_tool_calls:0,max_request_bytes:100000,max_output_bytes:100000}};
  const seen: any[] = [];
  const result=await runCurrentMethod(join(root,'work.method'),config,{runDir,onEvent: async (event:any)=>{
    seen.push(event);
    if(event.event==='progress' && event.child==='Writer') {
      const snapshot=inspectRun(runDir,{activeSnapshot:true});
      expect(snapshot.status).toBe('running');
      expect(snapshot.invocations['work:0']!.events.at(-1)).toMatchObject({type:'progress',child:'Writer'});
      expect(snapshot.invocations['work:0']!.outputs).toBeUndefined();
      writeFileSync(ack,'ready');
    }
  }});
  expect(result.status).toBe('completed'); expect(result.result).toBe('done');
  expect(seen.filter(e=>e.event==='progress')).toMatchObject([{step:'work',iteration:0,phase:'action',message:'Rendered café',completed:1,total:2},{step:'work',child:'Writer'}]);
  expect(seen.map(e=>e.sequence)).toEqual(seen.map((_,i)=>i+1));
  expect(JSON.parse(readFileSync(join(runDir,'checkpoint.json'),'utf8')).sequence).toBe(seen.length);
});
it('streams stdout before close and drains callbacks before returning', async () => {
  const root=temporary(), ack=join(root,'ack'), seen:string[]=[];
  const body=`const fs=require('fs'); console.log('started'); const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ack)})){clearInterval(t); console.log('finished');}},10);`;
  const result=await executeProcess({command:process.execPath,args:['-e',body],cwd:root,input:{},env:process.env,signal:AbortSignal.timeout(4000),maxBytes:10000,onStdoutLine:async(line:string)=>{seen.push(line); if(line==='started'){await new Promise(r=>setTimeout(r,30));writeFileSync(ack,'yes');}}});
  expect(seen).toEqual(['started','finished']); expect(result.output).toBe('started\nfinished\n');
});
it('stops a silent process on cancellation without inventing updates', async () => {
  const root=temporary(), seen:unknown[]=[];
  await expect(executeProcess({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:root,input:{},env:process.env,signal:AbortSignal.timeout(100),maxBytes:10000,onProgress:async(p:unknown)=>seen.push(p)})).rejects.toThrow();
  expect(seen).toEqual([]);
});

it('relays child Codex updates through the CLI without putting them in stdout', async () => {
  const values: unknown[]=[];
  const result=await executeProcess({command:process.execPath,args:['--import',createRequire(import.meta.url).resolve('tsx'),'packages/sdk/src/method.ts','progress','--codex','--child','Researcher'],cwd:process.cwd(),env:process.env,
    input:[{type:'item.completed',item:{type:'reasoning',text:'hidden'}},{type:'item.completed',item:{type:'agent_message',text:'Reading the next document.'}},{type:'item.completed',item:{type:'agent_message',text:'{"answer":"final"}'}}].map(e=>JSON.stringify(e)).join('\n'),rawInput:true,
    signal:AbortSignal.timeout(5000),maxBytes:10000,onProgress:async(value:unknown)=>{values.push(value);}});
  expect(result.output).toBe('');expect(values).toEqual([{message:'Reading the next document.',child:'Researcher'}]);
});
