import {it,expect,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {lockDependencies} from '../../packages/sdk/src/prepare.js';

const target=`${process.arch==='arm64'?'aarch64':'x86_64'}-${process.platform==='darwin'?'apple-darwin':'unknown-linux-gnu'}`;
/** A stand-in for the managed Python installer: `uv lock --project ROOT` writes ROOT/uv.lock. */
function fakeArchive(root:string){
 const folder=join(root,'archive',`uv-${target}`); mkdirSync(folder,{recursive:true});
 writeFileSync(join(folder,'uv'),'#!/bin/sh\necho "version = 1" > "$3/uv.lock"\n',{mode:0o755});
 execFileSync('tar',['-czf',join(root,'uv.tar.gz'),'-C',join(root,'archive'),`uv-${target}`]);
 return readFileSync(join(root,'uv.tar.gz'));
}

it.skipIf(!['darwin','linux'].includes(process.platform))('runs that start together on a new cache download the managed Python installer once',async()=>{
 const root=mkdtempSync(join(tmpdir(),'method-uv-'));
 vi.stubEnv('METHOD_CACHE_DIR',join(root,'cache'));
 const archive=fakeArchive(root), sum=createHash('sha256').update(archive).digest('hex');
 const fetches:string[]=[];
 vi.stubGlobal('fetch',async(url:string)=>{
  fetches.push(url);
  await new Promise(r=>setTimeout(r,200));
  return new Response(url.endsWith('.sha256')?`${sum}  uv-${target}.tar.gz\n`:archive);
 });
 try{
  const projects=[1,2,3,4,5].map(n=>{const project=join(root,`p${n}`);mkdirSync(project);writeFileSync(join(project,'pyproject.toml'),'[project]\nname="p"\nversion="0"\n');return project;});
  await Promise.all(projects.map(lockDependencies));
  for(const project of projects)expect(existsSync(join(project,'uv.lock'))).toBe(true);
  expect(fetches.length).toBe(2);
 }finally{vi.unstubAllGlobals();vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});}
});

it.skipIf(!['darwin','linux'].includes(process.platform))('a lost network while downloading the managed Python installer is a plain setup error',async()=>{
 const root=mkdtempSync(join(tmpdir(),'method-uv-'));
 vi.stubEnv('METHOD_CACHE_DIR',join(root,'cache'));
 vi.stubGlobal('fetch',async()=>{throw new TypeError('fetch failed');});
 try{
  const project=join(root,'p');mkdirSync(project);writeFileSync(join(project,'pyproject.toml'),'[project]\nname="p"\nversion="0"\n');
  await expect(lockDependencies(project)).rejects.toThrow(/^Could not download the managed Python installer\. Check the internet connection, then run again\.$/);
  const error=await lockDependencies(project).catch(e=>e);
  expect(error.constructor).toBe(Error);
 }finally{vi.unstubAllGlobals();vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});}
});
