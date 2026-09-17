import {it,expect,vi,afterEach} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadWorkflow,outputSchema} from '../../packages/workflow-language/src/validate.js';
import {validateMethod} from '@withmethod/runtime/document.js';
import {outputSchema as runtimeSchema} from '@withmethod/runtime/semantics.js';
import {methodMain} from '../../packages/sdk/src/method.js';
import {assertImmutableArtifacts} from '../../scripts/release-contract.js';
const dirs:string[]=[];
const base={format:'method/3.1',name:'Test',goal:'Check.',steps:{ask:{ask:'Answer.',out:{answer:{type:'text'}}}},result:'answer'};
const temp=()=>{const path=mkdtempSync(join(tmpdir(),'method-audit-'));dirs.push(path);return path;};
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();process.exitCode=0;for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
it('uses the same document and file contract as the runtime',()=>{
 for(const value of [{path:'x'},{path:'x',sha256:'0'.repeat(64)}]){
  const doc={...base,inputs:{file:{type:'file',default:value}}};
  if('sha256' in value)expect(loadWorkflow(doc)).toEqual(validateMethod(doc).method);
  else {expect(()=>loadWorkflow(doc)).toThrow(/sha256/);expect(()=>validateMethod(doc)).toThrow(/sha256/);}
 }
 expect(outputSchema({file:'file'})).toEqual(runtimeSchema({file:'file'}));
 const doc={...base,run_prompt:'  Keep spaces.  '};expect(loadWorkflow(doc)).toEqual(validateMethod(doc).method);
});
it('doctor accepts script-only configuration without an agent',async()=>{
 const dir=temp();mkdirSync(join(dir,'bin'));vi.stubEnv('PATH',join(dir,'bin'));
 const file=join(dir,'runtime.json');writeFileSync(file,JSON.stringify({runtimes:{node:{command:process.execPath,version:process.versions.node}}}));
 const out=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
 await methodMain(['doctor','--config',file]);expect(out.mock.calls.flat().join('')).toContain('No method was run');
});
it('doctor checks an explicitly selected Claude agent',async()=>{
 const dir=temp();const command=join(dir,'claude');writeFileSync(command,`#!${process.execPath}\nconsole.log(JSON.stringify({loggedIn:true}));`,{mode:0o700});vi.stubEnv('PATH',dir);
 vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
 await expect(methodMain(['doctor','--agent','claude'])).resolves.toBeUndefined();
 writeFileSync(command,`#!${process.execPath}\nconsole.log(JSON.stringify({loggedIn:false}));`,{mode:0o700});
 await expect(methodMain(['doctor','--agent','claude'])).rejects.toThrow(/claude access check/);
});
it('a local background run creates a worker that wait can reconnect to',()=>{
 const dir=temp();writeFileSync(join(dir,'task.method'),JSON.stringify({...base,steps:{respond:{do:{kind:'run',runtime:'node',entrypoint:'script.mjs'},out:{answer:{type:'text'}}}}}));
 writeFileSync(join(dir,'script.mjs'),'for await(const c of process.stdin){};console.log(JSON.stringify({answer:"done"}));');
 writeFileSync(join(dir,'runtime.json'),JSON.stringify({allow_local_processes:true,runtimes:{node:{command:process.execPath,version:process.versions.node}}}));
 const entry=resolve('packages/sdk/src/method.ts'),loader=resolve('node_modules/tsx/dist/loader.mjs'),run=join(dir,'run');
 const call=(args:string[])=>execFileSync(process.execPath,['--import',loader,entry,...args],{cwd:dir,encoding:'utf8',timeout:20000});
 expect(JSON.parse(call(['run','task.method','--background','--run-dir',run])).status).toBe('started');
 expect(call(['wait',run])).toContain('done');
 expect(JSON.parse(readFileSync(join(run,'worker.json'),'utf8'))).toMatchObject({status:'finished',exit_code:0});
},25000);
it('release checks reject changed versioned wheels and allow alias changes',()=>{
 expect(()=>assertImmutableArtifacts([{name:'withmethod-0.8.0.whl',sha256:'new'}],[{name:'withmethod-0.8.0.whl',sha256:'old'}])).toThrow(/Use a new package version/);
 expect(()=>assertImmutableArtifacts([{name:'cli/latest-linux-x64.txt',sha256:'new'}],[{name:'cli/latest-linux-x64.txt',sha256:'old'}])).not.toThrow();
});
