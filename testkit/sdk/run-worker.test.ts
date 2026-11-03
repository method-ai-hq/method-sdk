import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startRunWorker,waitForRun,workerAlive,cancelRun} from '../../packages/sdk/src/run-worker.js';
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
it('links the run to its dashboard page when it starts and when it finishes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'method-worker-link-'));
 const out=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
 const savedArgs=[...process.execArgv];process.execArgv=['--import','tsx'];
 try {
  await startRunWorker(['--version'],root,true,'https://app.example');
  const started=JSON.parse(String(out.mock.calls[0]![0]));
  const runId=JSON.parse(readFileSync(join(root,'run-id.json'),'utf8')).id;
  expect(started).toMatchObject({status:'started',run_id:runId,dashboard:`https://app.example/runs/${runId}`});
  // After the first record is saved, the link names the saved run.
  writeFileSync(join(root,'method-sync.json'),JSON.stringify({schema:'method-sync/1',server:'https://app.example',id:runId,workflow_id:'wf_x',version_id:'v_x',sequence:1,dashboard_id:'run_saved'}));
  expect(await waitForRun(root)).toMatchObject({status:'finished',dashboard:'https://app.example/runs/run_saved'});
 } finally {process.execArgv=savedArgs;out.mockRestore();process.exitCode=0;rmSync(root,{recursive:true,force:true});}
},20000);
it('run-status, wait and cancel take the run ID that method run printed, and a name that no run has is an error, not "not running"',async()=>{
 const cache=mkdtempSync(join(tmpdir(),'method-worker-id-'));
 const {methodMain}=await import('../../packages/sdk/src/method.js');
 const {mkdirSync}=await import('node:fs');
 const out=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
 vi.stubEnv('METHOD_CACHE_DIR',cache);
 // A run of a comparison: its folder is named by its execution ID; method run printed the run ID in run-id.json.
 const dir=join(cache,'runs','880dbfce-e823-42dd-b03f-452fc9120b46'),runId='5d801055-0521-4607-bf6b-c434e6742555';
 mkdirSync(dir,{recursive:true});
 writeFileSync(join(dir,'run-id.json'),JSON.stringify({id:runId}));writeFileSync(join(dir,'method.json'),'{}');
 writeFileSync(join(dir,'worker-request.json'),'{}');writeFileSync(join(dir,'worker.json'),JSON.stringify({status:'finished',pid:process.pid,exit_code:0}));
 try {
  await methodMain(['run-status',runId]);
  expect(JSON.parse(String(out.mock.calls.at(-1)![0]))).toEqual({running:false,status:'finished',pid:process.pid,exit_code:0});
  await expect(methodMain(['run-status','6e0b5f3c-0000-4000-8000-000000000000'])).rejects.toThrow('No run on this computer has the folder or ID 6e0b5f3c-0000-4000-8000-000000000000');
  await expect(methodMain(['cancel','no-such-run'])).rejects.toThrow('No run on this computer');
 } finally {out.mockRestore();vi.unstubAllEnvs();process.exitCode=0;rmSync(cache,{recursive:true,force:true});}
});
