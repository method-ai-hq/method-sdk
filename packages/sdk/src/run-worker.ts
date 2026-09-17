import {randomUUID} from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePrivateJson } from './files.js';

export async function startRunWorker(args:string[], directory:string, background=false) {
  directory=resolve(directory);mkdirSync(directory,{recursive:true,mode:0o700});
  const file=join(directory,'worker-request.json'),status=join(directory,'worker.json');
  const lock=join(directory,'worker-start.lock');let lockFd:number;
  try{lockFd=openSync(lock,'wx',0o600);}catch{
    const owner=Number(readFileSync(lock,'utf8'));
    if(!Number.isSafeInteger(owner)||owner<=0)throw Error('The worker start record is incomplete. Inspect the run before removing worker-start.lock.');
    try{process.kill(owner,0);throw Error('This run is already starting. Wait for its worker status.');}catch(error:any){if(error.code!=='ESRCH')throw error;}
    rmSync(lock);lockFd=openSync(lock,'wx',0o600);
  }
  writeFileSync(lockFd,String(process.pid));
  try {
  if(existsSync(status)&&workerAlive(directory))throw Error('This run is active. Use method wait RUN_DIRECTORY.');
  rmSync(status,{force:true});
  const identity=join(directory,'run-id.json');if(!existsSync(identity))writePrivateJson(identity,{id:randomUUID()});
  const runId=JSON.parse(readFileSync(identity,'utf8')).id;
  writePrivateJson(file,{args});
  const out=openSync(join(directory,'worker.stdout.log'),'a',0o600),err=openSync(join(directory,'worker.stderr.log'),'a',0o600);
  const suffix=import.meta.url.endsWith('.ts')?'.ts':'.js';
  const entry=fileURLToPath(new URL(`./method${suffix}`,import.meta.url));
  const child=spawn(process.execPath,[...process.execArgv,entry,'__worker',file],{detached:true,stdio:['ignore',out,err],env:{...process.env,METHOD_RUN_WORKER:'1'}});
  closeSync(out);closeSync(err);
  await new Promise<void>((yes,no)=>{child.once('spawn',yes);child.once('error',no);});
  child.unref();
  // The child owns its status record after startup. Do not overwrite a fast completion.
  process.stdout.write(JSON.stringify({status:'started',run_id:runId,run_dir:directory,wait:`method wait ${JSON.stringify(directory)}`,cancel:`method cancel ${JSON.stringify(directory)}`})+'\n');
  const startupDeadline=Date.now()+30_000;
  while(!existsSync(status)){if(Date.now()>startupDeadline)throw Error('The worker did not write its status. Inspect its error log.');await new Promise(r=>setTimeout(r,50));}
  } finally {closeSync(lockFd);rmSync(lock,{force:true});}
  if(!background)await waitForRun(directory);
}
export function workerAlive(directory:string) {
  const path=join(resolve(directory),'worker.json');if(!existsSync(path))return false;
  const state=JSON.parse(readFileSync(path,'utf8'));if(state.status!=='running')return false;
  try {const args=execFileSync('ps',['-p',String(state.pid),'-o','args='],{encoding:'utf8'});return args.includes(join(resolve(directory),'worker-request.json'));}catch{return false;}
}
export async function waitForRun(directory:string) {
  directory=resolve(directory);let offsets={out:0,err:0}; const deadline=Date.now()+30_000;
  for(;;){
    for(const [key,name,stream] of [['out','worker.stdout.log',process.stdout],['err','worker.stderr.log',process.stderr]] as const){
      const file=join(directory,name);if(existsSync(file)){const data=readFileSync(file);stream.write(data.subarray(offsets[key]));offsets[key]=data.length;}
    }
    const file=join(directory,'worker.json');
    if(existsSync(file)){
      const status=JSON.parse(readFileSync(file,'utf8'));
      if(status.status!=='running'){process.exitCode=status.exit_code??1;return status;}
      if(!workerAlive(directory)){process.exitCode=1;return {status:'interrupted',run_dir:directory,message:'The worker stopped. Inspect its run record before resuming.'};}
    }
    if(!existsSync(file)&&Date.now()>deadline)throw Error('The run worker did not start. Inspect worker.stderr.log in the run folder.');
    await new Promise(r=>setTimeout(r,500));
  }
}
export function cancelRun(directory:string){
  directory=resolve(directory);if(!workerAlive(directory))return {status:'not_running'};
  const state=JSON.parse(readFileSync(join(directory,'worker.json'),'utf8'));process.kill(-state.pid,'SIGTERM');return {status:'cancellation_requested'};
}
