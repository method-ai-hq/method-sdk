import {it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startRunWorker,waitForRun} from '../../packages/sdk/src/run-worker.js';
it('detaches and reconnects to the same worker, including a second start in its run directory',async()=>{
 const root=mkdtempSync(join(tmpdir(),'method-worker-'));
 const out=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
 const savedArgs=[...process.execArgv];process.execArgv=['--import','tsx'];
 try{
  for(let i=0;i<2;i++){
   await startRunWorker(['--version'],root,true);
   expect(await waitForRun(root)).toMatchObject({status:'finished',exit_code:0});
  }
  expect(readFileSync(join(root,'worker.stdout.log'),'utf8').match(/Method SDK/g)).toHaveLength(2);
 }finally{process.execArgv=savedArgs;process.exitCode=0;out.mockRestore();rmSync(root,{recursive:true,force:true});}
},15000);
