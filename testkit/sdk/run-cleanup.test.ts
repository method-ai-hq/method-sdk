import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync,utimesSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pruneCachedRuns} from '../../packages/sdk/src/prepare.js';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it('deletes cached run folders unchanged for 30 days and keeps newer ones and other files',()=>{
  const root=mkdtempSync(join(tmpdir(),'method-runs-'));roots.push(root);
  const runs=join(root,'runs'),now=Date.now(),day=86_400_000;
  const folder=(name:string,age:number,touched?:number)=>{
    const dir=join(runs,name);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'events.jsonl'),'{}\n');
    const at=new Date(now-age*day);utimesSync(join(dir,'events.jsonl'),touched===undefined?at:new Date(now-touched*day),touched===undefined?at:new Date(now-touched*day));utimesSync(dir,at,at);
    return dir;
  };
  const old=folder('old',31),recent=folder('recent',29),touched=folder('old-but-written',40,2);
  const outside=join(root,'outside');mkdirSync(outside);writeFileSync(join(outside,'keep.txt'),'x');
  symlinkSync(outside,join(runs,'link'));writeFileSync(join(runs,'note.txt'),'x');
  const past=new Date(now-60*day);utimesSync(outside,past,past);
  pruneCachedRuns(runs,now);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(recent)).toBe(true);expect(existsSync(touched)).toBe(true);
  expect(existsSync(join(outside,'keep.txt'))).toBe(true);expect(existsSync(join(runs,'note.txt'))).toBe(true);
  pruneCachedRuns(join(root,'missing'),now);
});
