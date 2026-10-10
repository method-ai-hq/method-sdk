import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync,utimesSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pruneCachedRuns,runFolderDays} from '../../packages/sdk/src/prepare.js';

const roots:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it('deletes old cached run folders that the account has, and keeps newer ones, the only copy of a run, and other files',()=>{
  const root=mkdtempSync(join(tmpdir(),'method-runs-'));roots.push(root);vi.stubEnv('METHOD_CACHE_DIR',root);
  const runs=join(root,'runs'),now=Date.now(),day=86_400_000,old=runFolderDays+1;
  // sync: the run's method-sync.json; a sent run has a dashboard_id.
  const folder=(name:string,age:number,options:{touched?:number;sync?:object|null}={})=>{
    const dir=join(runs,name);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'events.jsonl'),'{}\n');
    const sync=options.sync===undefined?{dashboard_id:'run_1'}:options.sync;
    if(sync)writeFileSync(join(dir,'method-sync.json'),JSON.stringify(sync));
    const at=new Date(now-age*day),touched=options.touched===undefined?at:new Date(now-options.touched*day);
    for(const file of ['events.jsonl',...(sync?['method-sync.json']:[])])utimesSync(join(dir,file),touched,touched);
    utimesSync(dir,at,at);
    return dir;
  };
  const saved=folder('saved',old),recent=folder('recent',runFolderDays-1),touched=folder('old-but-written',old,{touched:2});
  const device=folder('device',old,{sync:{dashboard_id:'run_2',device:true}}),neverSent=folder('never-sent',old,{sync:{}}),local=folder('local',old,{sync:null});
  const waiting=folder('waiting',old);
  mkdirSync(join(root,'outbox'));writeFileSync(join(root,'outbox',`${'a'.repeat(32)}.json`),JSON.stringify({kind:'run',run_dir:waiting}));
  const outside=join(root,'outside');mkdirSync(outside);writeFileSync(join(outside,'keep.txt'),'x');
  symlinkSync(outside,join(runs,'link'));writeFileSync(join(runs,'note.txt'),'x');
  const past=new Date(now-60*day);utimesSync(outside,past,past);
  pruneCachedRuns(runs,now);
  expect(existsSync(saved)).toBe(false);
  for(const kept of [recent,touched,device,neverSent,local,waiting])expect(existsSync(kept),kept).toBe(true);
  expect(existsSync(join(outside,'keep.txt'))).toBe(true);expect(existsSync(join(runs,'note.txt'))).toBe(true);
  pruneCachedRuns(join(root,'missing'),now);
});
