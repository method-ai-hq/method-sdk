import {existsSync,mkdirSync,readFileSync,writeFileSync,cpSync,chmodSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {command} from './prepare.js';
import {writePrivateJson} from './files.js';
import {planDirectory} from './deploy.js';
import {digest,readJson,privateCopy,inventory} from './deployment-source.js';
import {MethodClient} from './method-client.js';

const base='node@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d';
let packageRoot=fileURLToPath(new URL('../',import.meta.url));
while(!existsSync(join(packageRoot,'package.json'))||readJson(join(packageRoot,'package.json')).name!=='@withmethod/sdk')packageRoot=dirname(packageRoot);
const home='/home/node';
export async function docker(plan:any,args:string[]){
 // The configured context uses Docker's local socket or authenticated transport.
 // Never include credentials or browser state in args or error text.
 try{return await command('docker',['--context',plan.target.context,...args],planDirectory(plan.id));}
 catch(error:any){throw Object.assign(Error(args[0]==='build'?`Runner image build failed: ${error.message}`:`Runner operation failed (${args[0]}). Check the configured runner and continue this deployment.`),{code:'needs_input'});}
}
export function connectionCheck(plan:any,method:any){
 const browser=plan.browser?.name;
 const profiles=readJson(join(planDirectory(plan.id),'payload','runtime.json')).models??{};
 const model=Object.keys(profiles)[0];
 if(!model)return undefined;
 const sites=plan.browser?.sites??[];
 return {format:'method/3.1',name:'Check runner access',goal:'Confirm the selected agent and required browser accounts work on this runner.',
  inputs:{expected:{type:'boolean',default:true}},...(browser?{environment:{[browser]:method.environment[browser]}}:{}),steps:{access:{in:{expected:'inputs.expected'},
   ...(browser?{changes:[`environment.${browser}`]}:{}),
   do:{kind:profiles[model].backend==='openai-responses'?'call':'agent',model,...(browser?{browser:`environment.${browser}`} : {}),prompt:browser?
    `Open each of these sites in the browser: ${sites.map((s:string)=>`https://${s}`).join(', ')}. Check the account access needed for this Method: ${method.goal}. Confirm the signed-in account label where sign-in is required. A public page alone does not prove account access. If access is missing, leave its sign-in page open. Do not perform the Method's business task. Return ready=true only when all required connections work; otherwise return ready=false and state the missing access. Return short observations and account labels, never cookies, tokens, or passwords.`:
    'Confirm this coding agent can respond on the runner. Return ready=true and a short observation.',
   },out:{ready:{type:'boolean'},observations:{type:'text'}},check:{equals:{actual:'ready',expected:'expected'}}}},result:{ready:'ready',observations:'observations'}};
}
async function image(plan:any){
 if(plan.image){await docker(plan,['image','inspect',plan.image]);return plan.image;}
 const root=planDirectory(plan.id),context=join(root,'image');mkdirSync(context,{recursive:true,mode:0o700});
  const packed=JSON.parse((await command('npm',['pack','--ignore-scripts','--json','--pack-destination',context],packageRoot)).stdout);
 const tarball=packed[0].filename;
 const tag=`method-runner:${plan.sdk}-${digest(readFileSync(join(context,tarball))).slice(0,12)}`;
 try{plan.image=JSON.parse((await docker(plan,['image','inspect',tag])).stdout)[0].Id;writePrivateJson(join(root,'plan.json'),plan);return plan.image;}catch{}
 writeFileSync(join(context,'Dockerfile'),`FROM ${base}\nRUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && apt-get update && apt-get install -y --no-install-recommends chromium xvfb x11vnc novnc websockify ca-certificates && rm -rf /var/lib/apt/lists/*\nCOPY ${tarball} /tmp/sdk.tgz\nRUN npm install --global /tmp/sdk.tgz @openai/codex@0.153.4 @anthropic-ai/claude-code@2.1.274 && rm /tmp/sdk.tgz\nENV DISPLAY=:99 METHOD_BROWSER_EXECUTABLE=/usr/bin/chromium METHOD_BROWSER_HEADLESS=1 METHOD_RUN_WORKER=1\nUSER node\nWORKDIR /home/node\nCMD ["sh", "-c", "Xvfb :99 -screen 0 1440x1000x24 -nolisten tcp & x11vnc -display :99 -forever -shared -localhost -nopw -rfbport 5900 -quiet & chromium --no-sandbox --disable-dev-shm-usage --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=/home/node/login-profile about:blank >/dev/null 2>&1 & websockify --web=/usr/share/novnc/ 6080 localhost:5900 & wait"]\n`,{mode:0o600});
 // This build context contains only released code. Private files are mounted later.
 await docker(plan,['build','--tag',tag,context]);plan.image=JSON.parse((await docker(plan,['image','inspect',tag])).stdout)[0].Id;writePrivateJson(join(root,'plan.json'),plan);return plan.image;
}
async function initializeHome(plan:any){
 const root=planDirectory(plan.id),runnerHome=join(root,'runner'),payload=join(root,'payload');
 mkdirSync(runnerHome,{recursive:true,mode:0o700});
 if(existsSync(join(runnerHome,'.prepared')))return runnerHome;
 cpSync(join(payload,'package'),join(runnerHome,'deployment','package'),{recursive:true});
 if(existsSync(join(payload,'files')))cpSync(join(payload,'files'),join(runnerHome,'deployment','files'),{recursive:true});
 for(const file of ['inputs.json','runtime.json','runtime-environment.json','saved-request.json'])if(existsSync(join(payload,file)))privateCopy(join(payload,file),join(runnerHome,'deployment',file));
 const privateRoot=join(payload,'private');
 if(existsSync(join(privateRoot,'codex-auth.json')))privateCopy(join(privateRoot,'codex-auth.json'),join(runnerHome,'.codex','auth.json'));
 if(existsSync(join(privateRoot,'claude-credentials.json'))){
  privateCopy(join(privateRoot,'claude-credentials.json'),join(runnerHome,'.claude','.credentials.json'));
  writePrivateJson(join(runnerHome,'.claude.json'),{hasCompletedOnboarding:true});
 }
 if(existsSync(join(privateRoot,'environment.json')))privateCopy(join(privateRoot,'environment.json'),join(runnerHome,'deployment','private-environment.json'));
 if(existsSync(join(privateRoot,'browser-session.json')))for(const binding of ['default','setup'])privateCopy(join(privateRoot,'browser-session.json'),join(runnerHome,'.cache','method','browser','bindings',binding,'session.json'));
 if(plan.state){const client=new MethodClient(plan.state.server);privateCopy(join(privateRoot,'method-auth.json'),join(runnerHome,'.config','method',client.credentialFile.split('/').pop()!));}
 // Runs go through the normal SDK. Private env values stay out of the command line.
 writeFileSync(join(runnerHome,'invoke.mjs'),`import{readFileSync,existsSync,realpathSync}from'node:fs';import{spawn}from'node:child_process';import{pathToFileURL}from'node:url';import{createHash}from'node:crypto';
const root='/home/node/deployment',json=p=>JSON.parse(readFileSync(p,'utf8')),p=root+'/private-environment.json';Object.assign(process.env,existsSync(p)?json(p):{});
for(const[name,hash]of Object.entries(json(root+'/package-manifest.json')))if(createHash('sha256').update(readFileSync(root+'/package/'+name)).digest('hex')!==hash)throw Error('Deployed package changed. Prepare a new deployment.');
const cli=pathToFileURL(realpathSync('/usr/local/bin/method'));const{prepareRuntime}=await import(new URL('./prepare.js',cli));const{writePrivateJson}=await import(new URL('./files.js',cli));
const configPath=root+'/runtime.json';let config=json(configPath);const prepared=await prepareRuntime(root+'/package',config,json(root+'/package/task.method'));config=prepared.config;
for(const[name,names]of Object.entries(json(root+'/runtime-environment.json')))if(config.runtimes[name])config.runtimes[name].env=names;
writePrivateJson(configPath,config);
const child=spawn('method',process.argv.slice(2),{env:process.env,stdio:'inherit'});child.on('exit',c=>process.exit(c??1));child.on('error',()=>process.exit(1));`,{mode:0o600});
 writePrivateJson(join(runnerHome,'.cache','method','browser','bindings','setup','connection.json'),{cdp_url:'http://127.0.0.1:9222'});
 writePrivateJson(join(runnerHome,'deployment','package-manifest.json'),Object.fromEntries(Object.entries(inventory(join(payload,'package'))).map(([name,file])=>[name,file.sha256])));
 writePrivateJson(join(runnerHome,'.prepared'),{payload_sha256:plan.payload_sha256});return runnerHome;
}
async function ensureContainer(plan:any){
 const tag=await image(plan),runnerHome=await initializeHome(plan),name=`method-${plan.id}`;
 let found:any;
 try{found=JSON.parse((await docker(plan,['inspect',name])).stdout)[0];}catch{}
 if(found){
  if(found.Config.Labels?.['ai.withmethod.deployment']!==plan.id||found.Config.Labels?.['ai.withmethod.payload']!==plan.payload_sha256)throw Error('Runner identity does not match this deployment.');
  if(!found.State.Running)await docker(plan,['start',name]);
 }else{
  await docker(plan,['run','--detach','--name',name,'--label',`ai.withmethod.deployment=${plan.id}`,'--label',`ai.withmethod.payload=${plan.payload_sha256}`,'--publish','127.0.0.1::6080','--mount',`type=bind,src=${runnerHome},dst=${home}`,'--shm-size','1g',tag]);
 }
 const port=(await docker(plan,['port',name,'6080/tcp'])).stdout.trim();
 if(!/^127\.0\.0\.1:\d+$/.test(port))throw Error('Runner viewer must bind only to this computer.');
 plan.container=name;plan.viewer=`http://${port}/vnc.html?autoconnect=1`;writePrivateJson(join(planDirectory(plan.id),'plan.json'),plan);
 return name;
}
export async function applyRunner(plan:any){
 const root=planDirectory(plan.id),lock=join(root,'apply.lock');let fd:number;
 if(existsSync(lock)){try{process.kill(Number(readFileSync(lock,'utf8')),0);}catch(e:any){if(e.code==='ESRCH')unlinkSync(lock);}}
 try{fd=openSync(lock,'wx',0o600);writeFileSync(fd,String(process.pid));}catch{throw Error('Deployment setup is already running.');}
 try{
  if(plan.status==='ready')return {id:plan.id,status:'ready',connections:plan.readiness?.result,run:`method deploy --run ${plan.id} --inputs inputs.json`};
  const name=await ensureContainer(plan),runnerHome=join(root,'runner');
  for(const account of plan.access.filter((a:any)=>['codex','claude'].includes(a.provider))){
   let signedIn=false;
   try{const status=await docker(plan,['exec',name,account.provider,...(account.provider==='codex'?['login','status']:['auth','status'])]);signedIn=account.provider==='codex'||JSON.parse(status.stdout).loggedIn===true;}catch{}
   if(!signedIn){plan.status='needs_input';plan.next=`method deploy --login ${plan.id} --agent ${account.provider}`;writePrivateJson(join(root,'plan.json'),plan);return {id:plan.id,status:plan.status,connection:account.provider,next:plan.next};}
  }
  const method=readJson(join(root,'payload','package','task.method'));
  const check=connectionCheck(plan,method);
  // Dependency preparation and model access use the same SDK checks as a normal run.
  const readiness=check??{format:'method/3.1',name:'Check runner files',goal:'Check required files and runtime setup.',steps:{files:{do:{kind:'run',runtime:'node',entrypoint:'ready.cjs'},out:{ready:{type:'boolean'}}}},result:{ready:'ready'}};
  writePrivateJson(join(runnerHome,'deployment','readiness.method'),readiness);
  const readinessConfig=readJson(join(root,'payload','runtime.json'));
  if(plan.browser)readinessConfig.environment[plan.browser.name]='method-browser:setup';
  writePrivateJson(join(runnerHome,'deployment','readiness-runtime.json'),readinessConfig);
  if(!check)writeFileSync(join(runnerHome,'deployment','package','ready.cjs'),'process.stdout.write(JSON.stringify({ready:true}))',{mode:0o600});
  const checkId=randomUUID(),checkRun=`${home}/checks/${checkId}`;
  try{
   await docker(plan,['exec',name,'node',`${home}/invoke.mjs`,'run',`${home}/deployment/readiness.method`,'--workspace',`${home}/deployment/package`,'--config',`${home}/deployment/readiness-runtime.json`,'--run-dir',checkRun]);
   const summary=readJson(join(runnerHome,'checks',checkId,'summary.json'));
   if(summary.status!=='completed')throw Error('Access check did not pass.');
   if(plan.browser)privateCopy(join(runnerHome,'.cache','method','browser','bindings','setup','session.json'),join(runnerHome,'.cache','method','browser','bindings','default','session.json'));
   plan.status='ready';plan.ready_at=new Date().toISOString();plan.readiness={run:checkRun,result:summary.result};
  }catch{
   plan.status='needs_input';plan.next=`Open ${plan.viewer} to complete sign-in. Then run method deploy --approve ${plan.id}.`;
  }
  writePrivateJson(join(root,'plan.json'),plan);
  return {id:plan.id,status:plan.status,viewer:plan.viewer,...(plan.status==='ready'?{connections:plan.readiness?.result,run:`method deploy --run ${plan.id} --inputs inputs.json`}:{next:plan.next,check_run:checkRun})};
 }finally{closeSync(fd);unlinkSync(lock);}
}
export async function runDeployment(id:string,inputs?:string,resume?:string){
 const root=planDirectory(id),plan=readJson(join(root,'plan.json'));
 if(plan.status!=='ready')throw Error('Finish deployment setup before running this Method.');
 await ensureContainer(plan);
 const runId=resume??randomUUID();if(!/^[a-f0-9-]{36}$/.test(runId))throw Error('Use the runner run ID for resume.');
 const request=join(root,'runner','requests',`${runId}.json`);
 if(inputs){if(resume)throw Error('Resume retains its inputs.');safeInput(inputs,request);}
 else if(!resume)privateCopy(join(root,'payload','inputs.json'),request);
 const args=['exec',plan.container,'node',`${home}/invoke.mjs`,'run'];
 if(plan.state){const saved=readJson(join(root,'payload','saved-request.json'));args.push(saved.workflow_id,'--version',saved.version_id,'--server',saved.server);}
 else args.push(`${home}/deployment/package/task.method`,'--workspace',`${home}/deployment/package`);
 args.push('--config',`${home}/deployment/runtime.json`,'--run-dir',`${home}/runs/${runId}`);
 if(resume)args.push('--resume');else args.push('--inputs',`${home}/requests/${runId}.json`);
 const directory=join(root,'runner','runs',runId);
 // A business run may take the Method's full time limit. Do not impose the setup timeout.
 const exitCode=await new Promise<number>((resolve,reject)=>{const child=spawn('docker',['--context',plan.target.context,...args],{stdio:'inherit'});child.once('error',reject);child.once('exit',code=>resolve(code??1));});
 const summary=existsSync(join(directory,'summary.json'))?readJson(join(directory,'summary.json')):undefined;
 if(exitCode!==0)process.exitCode=exitCode;
 return {deployment:id,run_id:runId,run_directory:directory,status:summary?.status??'needs_input',...(summary?{result:summary.result,error:summary.error}:{message:'Inspect the runner setup and continue this run.'}),...(exitCode?{continue:`method deploy --run ${id} --resume ${runId}`}:{})};
}
function safeInput(from:string,to:string){const value=readJson(from);writePrivateJson(to,value);}

export async function loginRunner(id:string,agent?:string){
 const root=planDirectory(id),plan=readJson(join(root,'plan.json'));
 if(plan.status==='prepared')throw Error('Approve the deployment before connecting a runner account.');
 const providers=plan.access.map((a:any)=>a.provider).filter((p:string)=>['codex','claude'].includes(p));
 agent=agent??(providers.length===1?providers[0]:undefined);
 if(!agent||!providers.includes(agent))throw Error('Select the agent in this deployment with --agent codex or --agent claude.');
 const name=await ensureContainer(plan);
 const args=['--context',plan.target.context,'exec','-i',...(process.stdin.isTTY?['-t']:[]),name,agent,...(agent==='codex'?['login','--device-auth']:['auth','login'])];
 const code=await new Promise<number>((resolve,reject)=>{const child=spawn('docker',args,{stdio:'inherit'});child.once('error',reject);child.once('exit',c=>resolve(c??1));});
 if(code)throw Error('Agent sign-in did not finish. Continue the same runner login.');
 return {id,next:`method deploy --approve ${id}`};
}
