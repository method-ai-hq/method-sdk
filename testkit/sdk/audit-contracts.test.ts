import {it,expect,vi,afterEach} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {startRunWorker,waitForRun} from '../../packages/sdk/src/run-worker.js';
import {methodMain} from '../../packages/sdk/src/method.js';
import {assertImmutableArtifacts} from '../../scripts/release-contract.js';
const dirs:string[]=[];
const base={format:'method/3.1',name:'Test',goal:'Check.',steps:{ask:{ask:'Answer.',out:{answer:{type:'text'}}}},result:'answer'};
const temp=()=>{const path=mkdtempSync(join(tmpdir(),'method-audit-'));dirs.push(path);return path;};
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();process.exitCode=0;for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
it('doctor accepts a computer without an agent',async()=>{
 const dir=temp();mkdirSync(join(dir,'bin'));vi.stubEnv('PATH',join(dir,'bin'));vi.stubEnv('CLAUDECODE','');vi.stubEnv('CODEX_THREAD_ID','');
 const out=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
 await expect(methodMain(['doctor'])).resolves.toBeUndefined();expect(out).toHaveBeenCalled();
});
it('doctor checks an explicitly selected Claude agent',async()=>{
 const dir=temp();const command=join(dir,'claude');writeFileSync(command,`#!${process.execPath}\nconsole.log(JSON.stringify({loggedIn:true}));`,{mode:0o700});vi.stubEnv('PATH',dir);
 vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
 await expect(methodMain(['doctor','--agent','claude'])).resolves.toBeUndefined();
 writeFileSync(command,`#!${process.execPath}\nconsole.log(JSON.stringify({loggedIn:false}));`,{mode:0o700});
 await expect(methodMain(['doctor','--agent','claude'])).rejects.toThrow(/claude access check/);
});
it('a local background run creates a worker that wait can reconnect to, and a second start in its run directory works',async()=>{
 const dir=temp();writeFileSync(join(dir,'task.method'),JSON.stringify({...base,steps:{respond:{name:'Respond',do:{kind:'run',runtime:'node',entrypoint:'script.mjs'},out:{answer:{type:'text'}}}}}));
 writeFileSync(join(dir,'script.mjs'),'for await(const c of process.stdin){};console.log(JSON.stringify({answer:"done"}));');
 const entry=resolve('packages/sdk/src/method.ts'),loader=resolve('node_modules/tsx/dist/loader.mjs'),run=join(dir,'run');
 const call=(args:string[])=>execFileSync(process.execPath,['--import',loader,entry,...args],{cwd:dir,encoding:'utf8',timeout:20000});
 expect(JSON.parse(call(['run','task.method','--background','--run-dir',run])).status).toBe('started');
 expect(call(['wait',run])).toContain('done');
 expect(JSON.parse(readFileSync(join(run,'worker.json'),'utf8'))).toMatchObject({status:'finished',exit_code:0});
 vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
 const savedArgs=[...process.execArgv];process.execArgv=['--import','tsx'];
 try{await startRunWorker(['--version'],run,true);expect(await waitForRun(run)).toMatchObject({status:'finished',exit_code:0});}
 finally{process.execArgv=savedArgs;}
},25000);
it('release checks reject changed versioned wheels and allow alias changes',()=>{
 expect(()=>assertImmutableArtifacts([{name:'withmethod-0.8.0.whl',sha256:'new'}],[{name:'withmethod-0.8.0.whl',sha256:'old'}])).toThrow(/Use a new package version/);
 expect(()=>assertImmutableArtifacts([{name:'cli/latest-linux-x64.txt',sha256:'new'}],[{name:'cli/latest-linux-x64.txt',sha256:'old'}])).not.toThrow();
});
