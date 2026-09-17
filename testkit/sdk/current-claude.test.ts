import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runCurrentMethod} from '../../packages/sdk/src/current-runtime.js';
const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})));
function fixture(body:string,timeout=5000){
 const root=mkdtempSync(join(tmpdir(),'method-claude-'));roots.push(root);
 const command=join(root,'claude');writeFileSync(command,'#!/usr/bin/env node\n'+body,{mode:0o700});
 const method={format:'method/3.1',name:'Claude bridge',goal:'Echo through a tool',steps:{write:{do:{kind:'agent',model:'writer',prompt:'Use echo.',tools:['echo']},out:{text:{type:'text'}},limits:{timeout_ms:timeout}}},result:'text'};
 writeFileSync(join(root,'task.method'),JSON.stringify(method));
 writeFileSync(join(root,'echo.cjs'),'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>console.log(s));');
 const config={allow_local_processes:true,models:{writer:{backend:'claude',command}},runtimes:{node:{command:process.execPath,version:process.version}},tools:{echo:{description:'Echo',in:{text:{type:'text'}},out:{text:{type:'text'}},run:{kind:'run',runtime:'node',entrypoint:'echo.cjs'},effects:[]}}};
 return {root,run:()=>runCurrentMethod(join(root,'task.method'),config,{runDir:join(root,'run')})};
}
it('passes structured results through the real Method tool bridge without bare mode or an API key flag',async()=>{
 const f=fixture(`(async()=>{const fs=require('node:fs'),a=process.argv.slice(2);if(a.includes('--bare')||!a.includes('--print'))process.exit(8);const cfg=JSON.parse(fs.readFileSync(a[a.indexOf('--mcp-config')+1],'utf8')).mcpServers.method_step;
 const response=await fetch(cfg.url,{method:'POST',headers:cfg.headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'echo',arguments:{text:'hello'}}})});const value=await response.json();
 console.log(JSON.stringify({type:'system',subtype:'init',model:'fixture-model',mcp_servers:[{name:'method_step',status:'connected'}]}));
 console.log(JSON.stringify({type:'result',subtype:'success',structured_output:value.result.structuredContent}));})();`);
 expect(await f.run()).toMatchObject({status:'completed',result:'hello'});
 const events=readFileSync(join(f.root,'run/events.jsonl'),'utf8');expect(events).toContain('tool.completed');expect(events).toContain('fixture-model');expect(events).not.toContain('Bearer');
});
it('preserves a provider error and cancels a stuck child process',async()=>{
 const failed=fixture('console.log(JSON.stringify({type:"result",subtype:"error_during_execution",is_error:true,errors:["Sign in to Claude"]}));');
 expect(await failed.run()).toMatchObject({status:'failed',error:'Sign in to Claude'});
 const stuck=fixture('setInterval(()=>{},1000)',100);const start=Date.now();expect((await stuck.run()).status).toBe('failed');expect(Date.now()-start).toBeLessThan(4000);
});
