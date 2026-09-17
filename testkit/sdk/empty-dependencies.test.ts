import {it,expect,vi} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareRuntime} from '../../packages/sdk/src/prepare.js';
it('prepares and reuses an empty Node package without reporting cache damage',async()=>{
 const root=mkdtempSync(join(tmpdir(),'method-empty-deps-'));
 vi.stubEnv('METHOD_CACHE_DIR',join(root,'cache'));
 writeFileSync(join(root,'package.json'),JSON.stringify({name:'empty',private:true}));
 writeFileSync(join(root,'package-lock.json'),JSON.stringify({name:'empty',lockfileVersion:3,requires:true,packages:{'':{name:'empty'}}}));
 try{
  for(let i=0;i<2;i++)expect((await prepareRuntime(root,{}, {steps:{run:{do:{kind:'run',runtime:'node'}}}})).config.runtimes.node.command).toBe(process.execPath);
 }finally{vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});}
});
