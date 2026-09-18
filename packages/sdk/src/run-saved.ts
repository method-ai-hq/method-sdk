import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertCheckpointExecutor } from '@withmethod/runtime/executor-version.js';
import { MethodClient } from './method-client.js';
import { restorePackage, runtimeVersion } from './method-files.js';
import { methodCache } from './prepare.js';
import { resolveBindings } from './bindings.js';
import { runCurrentFile } from './current-runtime.js';
import { MethodSync } from './method-sync.js';
import { writePrivateJson } from './files.js';
import type { parse } from './local-cli.js';
import { readDocument } from './authoring.js';

// Older versions are listed only after their saved-package tests pass.
const supportedPackageRuntimes = new Set([runtimeVersion, '0.7.0', '0.7.1', '0.7.2', '0.8.0', '0.8.1', '0.8.2']);

export async function runSaved(saved:any, flags:ReturnType<typeof parse>['values'], client:MethodClient) {
  const directory=resolve(flags['run-dir']??join(methodCache(),'runs',randomUUID()));
  mkdirSync(directory,{recursive:true,mode:0o700});
  const requestFile=join(directory,'request.json');
  const prior=existsSync(requestFile)?JSON.parse(readFileSync(requestFile,'utf8')):null;
  if(prior && (prior.workflow_id!==saved.workflow_id||prior.version_id!==saved.version_id))throw Error('This run belongs to another saved version.');
  const request=prior??{run_id:randomUUID(),workflow_id:saved.workflow_id,version_id:saved.version_id,server:client.server};
  if(prior&&!flags.resume)throw Error('This run already exists. Use --resume.');
  writePrivateJson(requestFile,request);
  const sync=new MethodSync(client,directory,saved.workflow_id,saved.version_id,request.run_id);
  const completedFile=join(directory,'summary.json');
  if(flags.resume&&existsSync(completedFile)){const completed=JSON.parse(readFileSync(completedFile,'utf8'));if(completed.status==='completed'){
    const statePath=`/api/cli/methods/${encodeURIComponent(saved.workflow_id)}/state`;
    const shared=await client.request<any>(statePath);
    if(shared.enabled&&shared.owner_run===request.run_id){
      const pending=join(directory,'state-pending.json');if(existsSync(pending))await client.request(statePath,'POST',JSON.parse(readFileSync(pending,'utf8')));
      await client.request(statePath,'POST',{action:'release',run_id:request.run_id});
    }
    await MethodSync.retry(directory,client);process.stdout.write(JSON.stringify({...completed,sync:existsSync(join(directory,'method-pending.json'))?'pending':'saved'})+'\n');return completed;}}
  const inputFile=join(directory,'requested-inputs.json');
  const inputs=flags.inputs?JSON.parse(readFileSync(resolve(flags.inputs),'utf8')):existsSync(inputFile)?JSON.parse(readFileSync(inputFile,'utf8')):{};
  writePrivateJson(inputFile,inputs);
  const setupFile=join(directory,'setup.json');
  const setupEvents=existsSync(setupFile)?JSON.parse(readFileSync(setupFile,'utf8')):[];
  setupEvents.push({at:new Date().toISOString(),type:'setup_started'});writePrivateJson(setupFile,setupEvents);
  await sync.start(saved.workflow,inputs,{});
  process.stderr.write(`Local run: ${directory}\n`);
  let acquired=false, started=false, revision=0;
  const statePath=`/api/cli/methods/${encodeURIComponent(saved.workflow_id)}/state`;
  try {
    const resuming = !!flags.resume && existsSync(join(directory,'checkpoint.json'));
    if (resuming) assertCheckpointExecutor(JSON.parse(readFileSync(join(directory,'checkpoint.json'),'utf8')));
    else if(saved.package&&!supportedPackageRuntimes.has(saved.package.runtime))throw Object.assign(new Error(`This package records runtime ${saved.package.runtime}; installed executor: ${runtimeVersion}. Use an SDK release that supports this package runtime.`),{code:'needs_update'});
    if(flags.resume&&existsSync(join(directory,'checkpoint.json'))&&!existsSync(join(directory,'runtime.resolved.json'))){
      const file=join(directory,'saved.method');writePrivateJson(file,saved.workflow);
      return await runCurrentFile(file,{...flags,workspace:flags.workspace??process.cwd(),'run-dir':directory},()=>sync);
    }
    const root=saved.package?join(directory,'source'):resolve(flags.workspace??process.cwd());
    await restorePackage(saved,root,client);
    const file=join(directory,'saved.method');writePrivateJson(file,saved.workflow);
    let config=flags.config?readDocument(resolve(flags.config)):existsSync(join(root,'runtime.json'))?readDocument(join(root,'runtime.json')):{allow_local_processes:true};
    config=await resolveBindings(client,saved.workflow_id,saved.workflow,config,root,directory);
    const missing=Object.entries(saved.workflow.inputs??{}).filter(([key,def]:any)=>!Object.hasOwn(inputs,key)&&!Object.hasOwn(def,'default'));
    if(missing.length&&!existsSync(join(directory,'checkpoint.json')))throw Object.assign(new Error('Supply the required Method inputs with --inputs FILE.'),{code:'needs_input',missing:Object.fromEntries(missing)});
    const configFile=join(directory,'runtime.json');writePrivateJson(configFile,config);
    if(resuming)started=true;
    let stateFile=flags.state;
    const shared=await client.request<any>(statePath);
    if(shared.enabled){
      if(flags.state)throw Error('This Method uses account state. Do not replace it with --state.');
      const state=await client.request<any>(statePath,'POST',{action:'acquire',run_id:request.run_id});acquired=true;revision=state.revision;
      const pendingFile=join(directory,'state-pending.json');
      if(flags.resume&&existsSync(pendingFile)){const pending=JSON.parse(readFileSync(pendingFile,'utf8'));const result=await client.request<any>(statePath,'POST',pending);revision=result.revision;}
      stateFile=join(directory,'initial-state.json');if(!resuming)writePrivateJson(stateFile,state.value);
    }
    const executionFlags={...flags};delete executionFlags.inputs;delete executionFlags.state;
    const result=await runCurrentFile(file,{...executionFlags,...(!resuming?{inputs:inputFile}:{}),resume:resuming,config:configFile,workspace:root,'run-dir':directory,...(stateFile&&!resuming?{state:stateFile}:{})},()=>sync,async event=>{
      if(event.event==='step.started')started=true;
      if(acquired&&event.event==='step.accepted'){
        const commit={action:'commit',run_id:request.run_id,revision,commit_id:`${request.run_id}:${event.sequence}`,value:event.state};
        writePrivateJson(join(directory,'state-pending.json'),commit);
        const result=await client.request<any>(statePath,'POST',commit);revision=result.revision;
      }
    });
    if(acquired&&result.status==='completed'){await client.request(statePath,'POST',{action:'release',run_id:request.run_id});acquired=false;}
    return {run_id:request.run_id,directory,...result};
  } catch(error:any) {
    writePrivateJson(join(directory,'setup-error.json'),{code:error.code??'setup_failed',error:error.message,...(error.missing?{missing:error.missing}:{})});
    setupEvents.push({at:new Date().toISOString(),type:'setup_failed',detail:error.message});writePrivateJson(setupFile,setupEvents);
    await sync.finish(error);
    if(error.code==='needs_input'){process.stdout.write(JSON.stringify({status:'needs_input',run_id:request.run_id,run_dir:directory,message:error.message,missing:error.missing,continue:`method run ${saved.workflow_id} --version ${saved.version_id} --resume --run-dir ${JSON.stringify(directory)}`})+'\n');process.exitCode=2;return;}
    throw error;
  } finally {
    if(acquired&&!started)await client.request(statePath,'POST',{action:'release',run_id:request.run_id});
  }
}
