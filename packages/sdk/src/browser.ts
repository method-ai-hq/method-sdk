import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {createInterface} from 'node:readline';
import {readFileSync,existsSync,mkdirSync,cpSync,chmodSync,openSync,closeSync,unlinkSync,writeFileSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {methodCache,prepareRuntime} from './prepare.js';
import {writePrivateJson} from './files.js';
import {authoringPath} from './authoring.js';

export const browserVersion='0.13.10';
const assets=fileURLToPath(new URL('./browser-runtime/',import.meta.url));
const catalog=JSON.parse(readFileSync(join(assets,'tools.json'),'utf8'));
const observers=new Set(['browser_get_state','browser_get_html','browser_screenshot','browser_list_tabs']);
export function browserName(method:any):string|undefined {
 const names=[...new Set(Object.values(method.steps).flatMap((s:any)=>[s.do,s.check]).filter(e=>e?.browser).map(e=>e.browser.split('.')[1]))] as string[];
 if(names.length>1)throw Error('Use one browser connection per run.');
 return names[0];
}
export function browserConfig(method:any,config:any) {
 const name=browserName(method);if(!name)return config;
 const tools={...config.tools};
 for(const t of catalog){
  const def={description:t.description,connection:name,tool:t.name,parameters:t.inputSchema,effects:observers.has(t.name)?[]:[name]};
  if(tools[t.name]&&JSON.stringify(tools[t.name])!==JSON.stringify(def))throw Error(`Browser tool conflicts with custom tool: ${t.name}`);
  tools[t.name]=def;
 }
 return {...config,environment:{...config.environment,[name]:config.environment?.[name]??'method-browser:default'},tools};
}
export const browserDirectory=(run:string)=>join(methodCache(),'browser','runs',createHash('sha256').update(resolve(run)).digest('hex'));
export function browserBinding(name='default') {
 if(!/^[a-z][a-z0-9_-]*$/.test(name))throw Error('Invalid browser connection name.');
 return join(methodCache(),'browser','bindings',name);
}
export function configureBrowser(name:string,cdp?:string) {
 const root=browserBinding(name);mkdirSync(root,{recursive:true,mode:0o700});
 if(cdp){const url=new URL(cdp);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('Use a browser endpoint without credentials or query parameters.');}
 writePrivateJson(join(root,'connection.json'),{...(cdp?{cdp_url:cdp}:{})});
 return {connection:`method-browser:${name}`,configured:true};
}
export function localChromeProfile(home=homedir(),platform=process.platform) {
 if(platform!=='darwin')return undefined;
 const root=join(home,'Library','Application Support','Google','Chrome');
 const file=join(root,'Local State');if(!existsSync(file))return undefined;
 const state=JSON.parse(readFileSync(file,'utf8'));
 const profile=state.profile?.last_used??'Default';
 if(typeof profile!=='string'||profile!==profile.split(/[\\/]/).pop()||!existsSync(join(root,profile)))throw Error('The selected Chrome profile is unavailable. Open Chrome and select a profile, then retry.');
 return {user_data_dir:root,profile_directory:profile};
}
export function mergeSessions(previous:any,current:any,domains:string[]){
 const selected=(host:string)=>domains.some(d=>d===host.replace(/^\./,'')||d.endsWith('.'+host.replace(/^\./,'')));
 return {cookies:[...(previous.cookies??[]).filter((c:any)=>!selected(c.domain)),...(current.cookies??[])],origins:[...(previous.origins??[]).filter((o:any)=>!selected(new URL(o.origin).hostname)),...(current.origins??[])]};
}
export class BrowserService {
 private id=0; private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();
 private stopped=false; private child; private queue:Promise<any>=Promise.resolve();
 constructor(python:string){
  this.child=spawn(python,[fileURLToPath(new URL('./browser-service.py',import.meta.url))],{stdio:['pipe','pipe','ignore'],env:{...process.env,ANONYMIZED_TELEMETRY:'false'}});
  createInterface({input:this.child.stdout!}).on('line',line=>{try{const r=JSON.parse(line),p=this.pending.get(r.id);if(p){this.pending.delete(r.id);r.error?p.reject(Error(r.error)):p.resolve(r.result);}}catch{this.fail(Error('Invalid browser response'));}});
  this.child.stdin!.on('error',e=>this.fail(e));
  this.child.on('error',e=>{this.stopped=true;this.fail(e);});this.child.on('exit',()=>{this.stopped=true;this.fail(Error('Browser service stopped.'));});
 }
 private fail(e:Error){for(const p of this.pending.values())p.reject(e);this.pending.clear();}
 request(method:string,args:any={},signal?:AbortSignal):Promise<any>{
  const action=async()=>{
   if(this.stopped)throw Error('Browser service stopped.');
   if(signal?.aborted)throw signal.reason;
   const id=++this.id;
   return new Promise((resolve,reject)=>{
    const abort=()=>{clean();this.pending.delete(id);this.child.kill('SIGTERM');reject(signal?.reason??Error('Browser cancelled or timed out'));};
    const timer=setTimeout(abort,120_000);
    const clean=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    this.pending.set(id,{resolve:v=>{clean();resolve(v);},reject:e=>{clean();reject(e);}});
    signal?.addEventListener('abort',abort,{once:true});
    this.child.stdin!.write(JSON.stringify({id,method,args})+'\n');
   });
  };
  const next=this.queue.then(action);this.queue=next.catch(()=>{});return next;
 }
 async close(){if(this.stopped)return;try{await this.request('close');}finally{this.child.kill('SIGTERM');}}
}
export async function openBrowser(method:any,config:any,run:string,signal?:AbortSignal) {
 const name=browserName(method);if(!name)return undefined;
 const root=browserDirectory(run);mkdirSync(root,{recursive:true,mode:0o700});
 const binding=String(config.environment[name]);
 if(!binding.startsWith('method-browser:'))throw Error('Connect the browser with method browser connect, then use its method-browser connection name.');
 const shared=browserBinding(binding.slice('method-browser:'.length));mkdirSync(shared,{recursive:true,mode:0o700});
 const selection=join(root,'connection.json');
 let settings:any=existsSync(selection)?JSON.parse(readFileSync(selection,'utf8')):existsSync(join(shared,'connection.json'))?JSON.parse(readFileSync(join(shared,'connection.json'),'utf8')):{};
 if(!existsSync(selection)&&binding==='method-browser:default'&&!settings.cdp_url&&!settings.user_data_dir){const profile=localChromeProfile();if(profile)settings={...settings,...profile};}
 if(!existsSync(selection))writePrivateJson(selection,settings);
 const state=join(root,'session.json');
 if(!settings.user_data_dir&&!existsSync(state)&&existsSync(join(shared,'session.json')))cpSync(join(shared,'session.json'),state);
 const metadataFile=join(root,'receipt.json');
 const metadata=existsSync(metadataFile)?JSON.parse(readFileSync(metadataFile,'utf8')):{};
 const prepared=await prepareRuntime(assets,{allow_local_processes:true}, {steps:{}});
 let lock:number|undefined;const lockFile=join(shared,'attached.lock');
 if(settings.cdp_url){
  if(existsSync(lockFile)){try{process.kill(Number(readFileSync(lockFile,'utf8')),0);}catch(e:any){if(e.code==='ESRCH')unlinkSync(lockFile);}}
  try{lock=openSync(lockFile,'wx',0o600);writeFileSync(lock,String(process.pid));}catch{throw Object.assign(Error('Another Method run controls this Chrome session. Wait for it to finish, or select a separate browser connection.'),{code:'needs_input'});}
 }
 const release=()=>{if(lock!==undefined){closeSync(lock);lock=undefined;unlinkSync(lockFile);}};
 const service=new BrowserService(prepared.config.runtimes.python.command);
 const executable=process.env.METHOD_BROWSER_EXECUTABLE??['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome'].find(p=>existsSync(p));
 try{
  await service.request('start',{user_data_dir:join(root,'profile'),headless:process.env.METHOD_BROWSER_HEADLESS!=='0',...(executable?{executable_path:authoringPath(executable)}:{}),...settings,...(existsSync(state)?{storage_state:state}:{}),domains:metadata.domains??[]},signal);
 }catch(e){await service.close().catch(()=>{});release();throw Object.assign(Error('Browser could not start. If Chrome is open, close it and retry so Method can copy its sign-ins. Otherwise, install Chrome or select a running browser with method browser connect --cdp URL.'),{code:'needs_input'});}
 writePrivateJson(join(run,'browser-runtime.json'),{provider:'browser-use',version:browserVersion,connection:name,tools:catalog});
 return {connections:{[name]:{call:(tool:string,args:any,signal:AbortSignal)=>service.request('call',{name:tool,arguments:args},signal)}},service,root,
  async close(){try{const receipt=await service.request('export',{path:state});writePrivateJson(metadataFile,{...receipt,version:browserVersion,binding});const prior=existsSync(join(shared,'session.json'))?JSON.parse(readFileSync(join(shared,'session.json'),'utf8')):{};writePrivateJson(join(shared,'session.json'),mergeSessions(prior,JSON.parse(readFileSync(state,'utf8')),receipt.domains));}finally{try{await service.close();}finally{release();}}}
 };
}
