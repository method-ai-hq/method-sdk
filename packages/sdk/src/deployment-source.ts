import {existsSync,readFileSync,writeFileSync,mkdirSync,lstatSync,readdirSync,realpathSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {writePrivateJson} from './files.js';
import packageInfo from '../package.json' with {type:'json'};
import runtimeInfo from '@withmethod/runtime/package.json' with {type:'json'};

export const digest=(value:Buffer|string|object)=>createHash('sha256').update(Buffer.isBuffer(value)||typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export const readJson=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
export function privateCopy(from:string,to:string){mkdirSync(dirname(to),{recursive:true,mode:0o700});writeFileSync(to,readFileSync(from),{mode:0o600});}
export function safeFile(path:string){
 if(resolve(path).split(/[\\/]/).includes('sensitive'))throw Error('Protected files cannot be deployed.');
 if(lstatSync(path).isSymbolicLink())throw Error('Deployment files cannot be symbolic links.');
 const real=realpathSync(path);if(real.split(/[\\/]/).includes('sensitive'))throw Error('Protected files cannot be deployed.');
 return real;
}
export function inventory(root:string):Record<string,{sha256:string;bytes:number}> {
 safeFile(root);const result:Record<string,{sha256:string;bytes:number}>={};let total=0;
 function walk(folder:string,prefix=''){
  for(const name of readdirSync(folder)){
   // These trees are never inspected or included in a transfer.
   if(['sensitive','.git','.codex','.claude','node_modules','.venv'].includes(name)||name.startsWith('.env')||name==='secrets.env')continue;
   const path=join(folder,name);safeFile(path);const stat=lstatSync(path);
   if(stat.isDirectory())walk(path,`${prefix}${name}/`);
   else if(stat.isFile()){
    if(stat.size>100_000_000||(total+=stat.size)>1_000_000_000)throw Error('Deployment files exceed the 1 GB transfer limit or 100 MB file limit.');
    result[prefix+name]={sha256:digest(readFileSync(path)),bytes:stat.size};
   }else throw Error('Deployment requires ordinary files and folders.');
  }
 }
 walk(root);return result;
}
export const writableFolder=(method:any,name:string)=>Object.values(method.steps??{}).some((step:any)=>step.changes?.includes(`environment.${name}`));

export function recordDeploymentSource(run:string,root:string,file:string,method:any,config:any){
 const destination=join(run,'deployment-source');mkdirSync(destination,{recursive:true,mode:0o700});
 const dependencies:Record<string,string>={};
 for(const name of ['package.json','package-lock.json','pyproject.toml','uv.lock'])if(existsSync(join(root,name))){
  safeFile(join(root,name));privateCopy(join(root,name),join(destination,name));dependencies[name]=digest(readFileSync(join(root,name)));
 }
 const folders:Record<string,any>={};
 for(const [name,def] of Object.entries(method.environment??{}) as [string,any][])
  if(def.type==='files'&&config.environment?.[name]){try{folders[name]={path:config.environment[name],writable:writableFolder(method,name),files:inventory(config.environment[name])};}catch{folders[name]={error:'Folder requires preparation before deployment.'};}}
 const sidecar=existsSync(`${file}.method.json`)?readJson(`${file}.method.json`):undefined;
 writePrivateJson(join(run,'deployment-source.json'),{sdk:packageInfo.version,executor:runtimeInfo.version,dependencies,folders,...(sidecar?{saved:sidecar}:{})});
}

/** Record the final working files only after business execution succeeds. */
export function finishDeploymentSource(run:string,method:any,config:any){
 const file=join(run,'deployment-source.json');if(!existsSync(file))return;
 const source=readJson(file);
 for(const [name,def] of Object.entries(method.environment??{}) as [string,any][]){
  if(def.type!=='files'||!writableFolder(method,name))continue;
  try{source.folders[name]={path:config.environment[name],writable:true,completed:true,files:inventory(config.environment[name])};}
  catch{source.folders[name]={error:'The updated folder could not be recorded. Complete a new run before deployment.'};}
 }
 writePrivateJson(file,source);
}
