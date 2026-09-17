import { existsSync, readFileSync, readdirSync, lstatSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { sha256 } from '../../contracts/src/identity.js';
import { packagePath } from '../../contracts/src/method-package.js';
import { fileHash } from './method-files.js';
import { writePrivateJson } from './files.js';
import type { MethodClient } from './method-client.js';

const localFile=(client:MethodClient,id:string)=>join(dirname(client.credentialFile),'bindings',`${sha256(client.server+id)}.json`);
export async function bindInput(client:MethodClient,id:string,name:string,path:string,upload=false) {
  if(!/^[a-z][a-z0-9_]*$/.test(name))throw Error('Use the environment binding name.');
  const saved=await client.request<any>(`/api/cli/methods/${encodeURIComponent(id)}`);
  if(saved.workflow.environment?.[name]?.type!=='files')throw Error('Use the name of a declared files binding.');
  const root=realpathSync(resolve(path));if(root.split(/[\\/]/).includes('sensitive'))throw Error('Use a folder outside sensitive/.');
  if(!upload){const file=localFile(client,id),old=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};writePrivateJson(file,{...old,[name]:root});return {saved:true,scope:'this computer',name};}
  const files:Array<{path:string;sha256:string;size:number}>=[];
  async function walk(dir:string,prefix=''){
    for(const entry of readdirSync(dir,{withFileTypes:true})){
      // Do not enumerate protected trees. The upload is only the explicitly chosen folder.
      if(['sensitive','.git','.codex','.claude','node_modules','.venv'].includes(entry.name)||entry.name.startsWith('.env')||entry.name==='secrets.env')continue;
      const name=prefix+entry.name;packagePath(name);const path=join(dir,entry.name);
      if(entry.isSymbolicLink())throw Error(`Input contains a symbolic link: ${name}`);
      if(entry.isDirectory())await walk(path,name+'/');
      else if(entry.isFile()){const bytes=readFileSync(path);if(bytes.length>20_000_000)throw Error(`Input file exceeds 20 MB: ${name}`);const hash=fileHash(bytes);await client.transfer(`/api/cli/files/${hash}`,bytes);files.push({path:name,sha256:hash,size:bytes.length});}
    }
  }
  await walk(root);
  return client.request(`/api/cli/methods/${encodeURIComponent(id)}/bindings/${name}`,'PUT',{kind:'files',files});
}

export async function bindConnection(client:MethodClient,id:string,name:string,value:string,upload=false) {
  const saved=await client.request<any>(`/api/cli/methods/${encodeURIComponent(id)}`);
  if(!saved.workflow.environment?.[name]||saved.workflow.environment[name].type==='files')throw Error('Use a declared service, browser, desktop, or tool binding.');
  // Values identify a connection. Credentials remain in the service's existing login store.
  const url=new URL(value);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('Use a connection URL without credentials, query parameters, or a fragment.');
  if(upload)return client.request(`/api/cli/methods/${encodeURIComponent(id)}/bindings/${name}`,'PUT',{kind:'connection',value:url.href});
  const file=localFile(client,id),old=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
  writePrivateJson(file,{...old,[name]:{kind:'connection',value:url.href}});return {saved:true,scope:'this computer',name};
}

export async function resolveBindings(client:MethodClient,id:string,method:any,config:any,root:string,runDirectory:string) {
  const local=existsSync(localFile(client,id))?JSON.parse(readFileSync(localFile(client,id),'utf8')):{};
  const snapshot=join(runDirectory,'input-bindings.json');
  const remote=existsSync(snapshot)?JSON.parse(readFileSync(snapshot,'utf8')):await client.request<Record<string,any>>(`/api/cli/methods/${encodeURIComponent(id)}/bindings`);
  const environment={...config.environment},missing=[];
  for(const [name,definition] of Object.entries(method.environment??{}) as [string,any][]){
    if(local[name]?.kind==='connection'){environment[name]=local[name].value;continue;}
    if(typeof local[name]==='string'&&existsSync(local[name])){environment[name]=local[name];continue;}
    if(environment[name]){if(definition.type==='files')environment[name]=resolve(root,environment[name]);continue;}
    if(local[name]?.kind==='connection'){environment[name]=local[name].value;continue;}
    if(typeof local[name]==='string'&&existsSync(local[name])){environment[name]=local[name];continue;}
    if(remote[name]?.kind==='connection'){environment[name]=remote[name].value;continue;}
    if(remote[name]?.kind==='files'){
      const folder=join(runDirectory,'inputs',name);mkdirSync(folder,{recursive:true,mode:0o700});
      for(const f of remote[name].files){
        const target=join(folder,packagePath(f.path));mkdirSync(dirname(target),{recursive:true,mode:0o700});
        const parent=relative(realpathSync(folder),realpathSync(dirname(target)));if(parent.startsWith('..')||isAbsolute(parent)||existsSync(target)&&lstatSync(target).isSymbolicLink())throw Error('Input destination leaves the run folder.');
        if(existsSync(target)&&fileHash(readFileSync(target))===f.sha256)continue;
        const bytes=await client.transfer(`/api/cli/methods/${encodeURIComponent(id)}/bindings/${name}/files/${f.sha256}`);
        if(fileHash(bytes)!==f.sha256||bytes.length!==f.size)throw Error(`Input checksum failed: ${f.path}`);
        writeFileSync(target,bytes,{mode:0o600});
      }
      environment[name]=folder;continue;
    }
    missing.push({name,description:definition.description,command:definition.type==='files'?`method bind ${id} ${name} --file PATH`:`method bind ${id} ${name} --connection URL`,...(definition.type==='files'?{account_copy:`Add --upload only to save this selected input folder privately in your Method account.`}:{})});
  }
  if(missing.length)throw Object.assign(new Error('Supply the missing Method inputs or connections.'),{code:'needs_input',missing});
  if(!existsSync(snapshot))writePrivateJson(snapshot,remote);
  return {...config,environment};
}
