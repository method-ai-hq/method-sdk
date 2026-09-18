import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startRunWorker,waitForRun,workerAlive,cancelRun} from '../../packages/sdk/src/run-worker.js';
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

it('waits and cancels a live worker without PATH tools, and rejects a duplicate start',async()=>{
 const root=mkdtempSync(join(tmpdir(),'method-worker-no-ps-'));
 const request=join(root,'worker-request.json'),status=join(root,'worker.json');
 writeFileSync(request,`const fs=require('fs');
 process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(status)},JSON.stringify({status:'finished',pid:process.pid,exit_code:0}));process.exit(0)});
 fs.writeFileSync(${JSON.stringify(status)},JSON.stringify({status:'running',pid:process.pid}));
 setInterval(()=>{},1000);`);
 const child=spawn(process.execPath,['-e',readFileSync(request,'utf8'),request],{detached:true,stdio:'ignore'});
 const closed=once(child,'exit');const path=process.env.PATH;process.env.PATH='';
 const out=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
 try {
  await vi.waitFor(()=>expect(workerAlive(root)).toBe(true));
  await expect(startRunWorker(['--version'],root,true)).rejects.toThrow('This run is active');
  const waiting=waitForRun(root);
  expect(cancelRun(root)).toEqual({status:'cancellation_requested'});
  expect(await waiting).toMatchObject({status:'finished',exit_code:0});
  await closed;
  expect(workerAlive(root)).toBe(false);
  // A reused PID must not make this run own an unrelated live process.
  writeFileSync(status,JSON.stringify({status:'running',pid:process.pid}));
  expect(cancelRun(root)).toEqual({status:'not_running'});
 } finally {
  if(path===undefined)delete process.env.PATH;else process.env.PATH=path;
  try{process.kill(-child.pid!,'SIGKILL')}catch{}
  out.mockRestore();process.exitCode=0;rmSync(root,{recursive:true,force:true});
 }
},10000);
