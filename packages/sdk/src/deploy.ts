import {existsSync,readFileSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve,basename} from 'node:path';
import {homedir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {methodCache,command} from './prepare.js';
import {writePrivateJson} from './files.js';
import {browserDirectory,browserName,browserVersion} from './browser.js';
import {digest,readJson,privateCopy,inventory,safeFile} from './deployment-source.js';
import {MethodClient} from './method-client.js';
import packageInfo from '../package.json' with {type:'json'};
import runtimeInfo from '@withmethod/runtime/package.json' with {type:'json'};

export const planDirectory=(id:string)=>{if(!/^deployment_[a-f0-9-]{36}$/.test(id))throw Error('Invalid deployment ID.');return join(methodCache(),'deployments',id);};
const missing=(message:string)=>Object.assign(Error(message),{code:'needs_input'});
export function runnerSettings(){
 const file=join(methodCache(),'runner.json');
 if(!existsSync(file)){
  let context=process.env.DOCKER_CONTEXT??'default';try{context=execFileSync('docker',['context','show'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{}
  writePrivateJson(file,{kind:'docker',name:'Method runner',context});
 }
 const target=readJson(file);
 if(target.kind!=='docker'||typeof target.name!=='string'||typeof target.context!=='string')throw missing('Configure a Docker runner in the Method runner settings.');
 return target;
}
function verifiedCopy(from:string,to:string,expected:string){safeFile(from);if(digest(readFileSync(from))!==expected)throw missing('A selected file changed. Run the current Method, then prepare a new deployment.');privateCopy(from,to);}
function portableConfig(config:any){
 const portable=structuredClone(config);
 for(const [name,profile] of Object.entries(portable.runtimes??{}) as [string,any][]){
  if(['node','python'].includes(name)&&!(profile.args?.length))delete portable.runtimes[name];
  else throw missing(`Runtime ${name} needs a supported runner installation before deployment.`);
 }
 for(const profile of Object.values(portable.models??{}) as any[]){
  if(!['codex','claude','openai-responses'].includes(profile.backend)||profile.command)throw missing('This agent command needs a supported runner installation before deployment.');
 }
 for(const tool of Object.values(portable.tools??{}) as any[])if(tool.connection&&!tool.tool?.startsWith('browser_'))throw missing('This custom tool connection needs a runner provider before deployment.');
 return portable;
}
export async function runnerIdentity(target:any){
 try{return (await command('docker',['--context',target.context,'info','--format','{{.ID}}'],process.cwd())).stdout.trim();}
 catch{throw missing('The Method runner is not available. Start Docker Desktop on this computer, then repeat this command.');}
}
export async function prepareDeployment(directory:string){
 const run=safeFile(resolve(directory));
 if(readJson(join(run,'summary.json')).status!=='completed')throw missing('Finish this Method run before deployment.');
 if(!existsSync(join(run,'deployment-source.json')))throw missing('Run this Method with the current SDK to record its deployment files.');
 const source=readJson(join(run,'deployment-source.json')), manifest=readJson(join(run,'manifest.json'));
 if(source.sdk!==packageInfo.version||source.executor!==runtimeInfo.version)throw missing('Prepare deployment with the SDK used for the successful run.');
 const method=readJson(join(run,'method.json')), checkpoint=readJson(join(run,'checkpoint.json'));
 if(digest(method)!==manifest.method_sha256||checkpoint.method_sha256!==manifest.method_sha256)throw Error('The successful run definition does not match its manifest.');
 const recordedConfig=readJson(join(run,'runtime.resolved.json'));
 if(digest(recordedConfig)!==manifest.config_sha256)throw Error('The run configuration changed after execution.');
 const config=portableConfig(recordedConfig);
 const target=runnerSettings(), runner_id=await runnerIdentity(target), id=`deployment_${randomUUID()}`,root=planDirectory(id),payload=join(root,'payload');
 mkdirSync(payload,{recursive:true,mode:0o700});
 const selections:Array<{path:string;sha256:string}>=[];
 const select=(from:string,to:string,hash=digest(readFileSync(safeFile(from))))=>{verifiedCopy(from,join(payload,to),hash);selections.push({path:from,sha256:hash});};
 try{
  writePrivateJson(join(payload,'package','task.method'),method);
  for(const [name,hash] of Object.entries(manifest.files) as [string,string][]){
   if(name.split('/').some(part=>part.startsWith('.env')||['secrets.env','.codex','.claude'].includes(part)))throw missing('Remove credential files from the Method package, then run it again.');
   if(name.startsWith('/')||name.split(/[\\/]/).includes('..'))throw Error('Invalid package path.');
   select(join(run,'bundle',name),join('package',name),hash);
  }
  for(const [name,hash] of Object.entries(source.dependencies) as [string,string][])select(join(run,'deployment-source',name),join('package',name),hash);
  const runtimeEnv=Object.fromEntries(Object.entries<any>(recordedConfig.runtimes??{}).filter(([,p])=>p.env?.length).map(([name,p])=>[name,p.env]));
  writePrivateJson(join(payload,'runtime-environment.json'),runtimeEnv);
  const folders:any[]=[];
  for(const [name,def] of Object.entries(method.environment??{}) as [string,any][]){
   if(def.type==='browser'){if(!browserName(method))throw missing('This browser has no supported session export. Run it with the Method browser connection first.');config.environment[name]='method-browser:default';continue;}
   if(def.type==='files'){
    if(Object.values(method.steps).some((s:any)=>s.changes?.includes(`environment.${name}`)))throw missing(`The writable folder ${name} needs a shared service connection or an explicit move before deployment.`);
    const folder=source.folders[name];if(!folder||folder.error)throw missing(`Record the declared folder ${name} in a successful run before deployment.`);
    mkdirSync(join(payload,'files',name),{recursive:true,mode:0o700});
    const files=inventory(folder.path);if(digest(files)!==digest(folder.files))throw missing(`Folder ${name} changed after the successful run. Run the Method with these files first.`);
    for(const [path,entry] of Object.entries(files) as [string,any][])select(join(folder.path,path),join('files',name,path),entry.sha256);
    folders.push({name,files:Object.keys(files).length,bytes:Object.values(files).reduce((n:number,v:any)=>n+v.bytes,0),sha256:digest(files)});
    config.environment[name]=`/home/node/deployment/files/${name}`;
   }else{
    const value=config.environment?.[name];let url:URL;try{url=new URL(value);}catch{throw missing(`Connection ${name} needs a runner binding.`);}
    if(['localhost','[::1]','0.0.0.0'].includes(url.hostname)||url.hostname.endsWith('.localhost')||url.hostname.startsWith('127.'))throw missing(`Local service ${name} needs a runner connection before deployment.`);
    if(!['https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw missing(`Connection ${name} needs a transferable HTTPS connection without credentials in its URL.`);
   }
  }
  const browser=browserName(method);let browserScope:any;
  if(browser){
   const privateRoot=browserDirectory(run);
   if(!existsSync(join(privateRoot,'receipt.json'))||!existsSync(join(privateRoot,'session.json')))throw missing('This run has no exported browser session. Finish a run with the Method browser connection first.');
   const receipt=readJson(join(privateRoot,'receipt.json'));
   if(receipt.domains?.some((host:string)=>['localhost','127.0.0.1','0.0.0.0','::1'].includes(host)||host.endsWith('.localhost')))throw missing('This browser run used a local website. Supply its runner address and complete a run with that connection before deployment.');
   if(receipt.version!==browserVersion||!receipt.domains?.length)throw missing('This run has no recorded browser sites. Use the browser before deployment.');
   const session=readJson(join(privateRoot,'session.json'));
   const selected=(host:string)=>receipt.domains.some((d:string)=>d===host.replace(/^\./,'')||d.endsWith('.'+host.replace(/^\./,'')));
   if(session.cookies.some((c:any)=>!selected(c.domain))||session.origins.some((o:any)=>!selected(new URL(o.origin).hostname)))throw missing('The browser export contains sites outside this run. Complete a new run with the current SDK before deployment.');
   privateCopy(join(privateRoot,'session.json'),join(payload,'private','browser-session.json'));
   browserScope={name:browser,version:browserVersion,sites:receipt.domains};
  }
  const access:any[]=[];const env:Record<string,string>={};
  for(const provider of new Set(Object.values(config.models??{}).map((p:any)=>p.backend))){
   if(provider==='codex'){
    const file=join(process.env.CODEX_HOME??join(homedir(),'.codex'),'auth.json');
    if(!existsSync(file))throw missing('Codex has no transferable file sign-in. Configure Codex file credential storage, sign in, and prepare again.');
    select(file,'private/codex-auth.json');access.push({provider:'codex',access:'Run the selected coding agent'});
   }else if(provider==='claude'){
    const file=join(process.env.CLAUDE_CONFIG_DIR??join(homedir(),'.claude'),'.credentials.json');
    if(existsSync(file))select(file,'private/claude-credentials.json');
    else if(process.platform==='darwin'){
     let credentials:string;try{credentials=(await command('security',['find-generic-password','-s','Claude Code-credentials','-w'],root)).stdout;}catch{throw missing('Claude has no transferable sign-in. Sign in to Claude, then prepare again.');}
     writePrivateJson(join(payload,'private','claude-credentials.json'),JSON.parse(credentials));
    }else throw missing('Sign in to Claude, then prepare deployment again.');
    access.push({provider:'claude',access:'Run the selected coding agent'});
   }
  }
  for(const profile of [...Object.values(config.models??{}),...Object.values(recordedConfig.runtimes??{})] as any[])
   for(const key of [profile.api_key_env,...(profile.env??[])].filter(Boolean)){
    if(!process.env[key])throw missing(`Runner access needs the environment variable ${key}. Set it locally before preparation.`);
    env[key]=process.env[key]!;
   }
  if(Object.keys(env).length){writePrivateJson(join(payload,'private','environment.json'),env);access.push({provider:'environment',names:Object.keys(env)});}
  const request=existsSync(join(run,'request.json'))?readJson(join(run,'request.json')):source.saved?{workflow_id:source.saved.workflow_id,version_id:source.saved.base_version,server:source.saved.server}:undefined;
  let state:any;
  if(Object.keys(method.state??{}).length){
   if(!existsSync(join(run,'request.json'))||!request?.workflow_id)throw missing('Save this stateful Method first, then run its saved version. Deployment will use the existing account state and lock.');
   const client=new MethodClient(request.server),shared=await client.request<any>(`/api/cli/methods/${encodeURIComponent(request.workflow_id)}/state`);
   if(shared.owner_run)throw missing('Finish or release the run that owns account state before deployment.');
   state={workflow_id:request.workflow_id,server:request.server,enabled:shared.enabled,revision:shared.revision,sha256:digest(shared.enabled?shared.value:checkpoint.root.state)};
   if(!shared.enabled)writePrivateJson(join(payload,'initial-state.json'),checkpoint.root.state);
   select(client.credentialFile,'private/method-auth.json');
   access.push({provider:'Method',server:client.server,access:'Shared state and its run lock'});
  }
  writePrivateJson(join(payload,'runtime.json'),config);
  writePrivateJson(join(payload,'inputs.json'),checkpoint.root.inputs);
  if(request)writePrivateJson(join(payload,'saved-request.json'),request);
  const files=inventory(payload);
  const plan={id,status:'prepared',created_at:new Date().toISOString(),target,runner_id,source_run:run,method:{name:method.name,files:Object.keys(manifest.files),dependency_files:Object.keys(source.dependencies)},sdk:source.sdk,executor:source.executor,package_sha256:digest({method:manifest.method_sha256,files:manifest.files,dependencies:source.dependencies}),folders,browser:browserScope,access,state,inputs:checkpoint.root.inputs,payload_sha256:digest(files),selections};
  writePrivateJson(join(root,'plan.json'),plan);
  return review(plan);
 }catch(e){rmSync(root,{recursive:true,force:true});throw e;}
}
export function review(plan:any){
 const {selections,...safe}=plan;
 return {...safe,approve:`method deploy --approve ${plan.id}`,message:'Review these files, inputs, sign-ins, and runner. Approval transfers this selection and checks access. It does not run the business task.'};
}
export async function verifyPlan(plan:any){
 if(plan.sdk!==packageInfo.version||plan.executor!==runtimeInfo.version)throw missing(`Continue this deployment with Method SDK ${plan.sdk}.`);
 if(plan.runner_id&&plan.runner_id!==await runnerIdentity(plan.target))throw missing('The runner was replaced. Prepare a new deployment.');
 if(digest(plan.target)!==digest(runnerSettings()))throw missing('The selected runner changed. Prepare a new deployment.');
 if(digest(inventory(join(planDirectory(plan.id),'payload')))!==plan.payload_sha256)throw missing('Prepared files changed. Prepare a new deployment.');
 if(plan.status==='prepared'){
  for(const item of plan.selections)if(!existsSync(item.path)||digest(readFileSync(safeFile(item.path)))!==item.sha256)throw missing('A selected file or account changed. Prepare a new deployment.');
  const source=readJson(join(plan.source_run,'deployment-source.json'));
  for(const folder of plan.folders)if(digest(inventory(source.folders[folder.name].path))!==folder.sha256)throw missing(`Folder ${folder.name} changed. Prepare a new deployment.`);
 }
 if(plan.state){
  const client=new MethodClient(plan.state.server),shared=await client.request<any>(`/api/cli/methods/${encodeURIComponent(plan.state.workflow_id)}/state`);
  if(shared.owner_run)throw missing('Shared state is in use. Finish its current run first.');
  if(plan.status==='prepared'&&(shared.enabled!==plan.state.enabled||(shared.enabled&&digest(shared.value)!==plan.state.sha256)))throw missing('Shared state changed. Prepare a new deployment.');
 }
}
export async function approveDeployment(id:string){
 const root=planDirectory(id),plan=readJson(join(root,'plan.json'));
 await verifyPlan(plan);
 if(plan.status==='prepared'){plan.status='approved';plan.approved_at=new Date().toISOString();writePrivateJson(join(root,'plan.json'),plan);}
 if(plan.state&&!plan.state.enabled){
  const client=new MethodClient(plan.state.server),path=`/api/cli/methods/${encodeURIComponent(plan.state.workflow_id)}/state`,shared=await client.request<any>(path);
  if(!shared.enabled)await client.request(path,'POST',{action:'enable',value:readJson(join(root,'payload','initial-state.json'))});
  else if(digest(shared.value)!==plan.state.sha256)throw missing('Shared state changed during setup. Inspect it before continuing.');
  plan.state.enabled=true;writePrivateJson(join(root,'plan.json'),plan);
 }
 const {applyRunner}=await import('./runner-deploy.js');return applyRunner(plan);
}
