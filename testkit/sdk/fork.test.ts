import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runCurrentFile} from '../../packages/sdk/src/current-runtime.js';
import {parse} from '../../packages/sdk/src/local-cli.js';
import {inspectRun} from '../../packages/sdk/src/inspect.js';

const roots:string[]=[];
afterEach(()=>{process.exitCode=0;for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const method={format:'method/3.2',name:'Fork',goal:'Reuse accepted work after a later fix.',steps:{
 slow:{name:'Slow work',purpose:'Counts its calls and returns 41.',do:{kind:'run',runtime:'node',entrypoint:'slow.mjs'},out:{value:{type:'number',description:'The slow result.'}}},
 finish:{name:'Finish',purpose:'Adds one.',in:{value:'value'},do:{kind:'run',runtime:'node',entrypoint:'finish.mjs'},out:{total:{type:'number',description:'The total.'}}},
},result:'total'};

it('method run --from-run --reuse reuses accepted steps after a fix to a later script',async()=>{
 const root=mkdtempSync(join(tmpdir(),'method-fork-'));roots.push(root);
 const calls=join(root,'calls');
 writeFileSync(join(root,'fork.method'),JSON.stringify(method));
 writeFileSync(join(root,'slow.mjs'),`import{appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(calls)},'x');console.log(JSON.stringify({value:41}))`);
 writeFileSync(join(root,'finish.mjs'),'console.log(JSON.stringify({wrong:1}))');
 const parent=join(root,'parent');
 const failed=await runCurrentFile(join(root,'fork.method'),{'run-dir':parent});
 expect(failed).toMatchObject({status:'failed',code:'invalid_output'});
 expect(failed.status==='failed'&&failed.recovery).toContain(`--from-run ${parent} --reuse slow.`);
 writeFileSync(join(root,'finish.mjs'),`import{readFileSync}from'node:fs';const a=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({total:a.value+1}))`);
 const flags=parse(['run',join(root,'fork.method'),'--run-dir',join(root,'fork'),'--from-run',parent,'--reuse','slow']).values;
 const result=await runCurrentFile(join(root,'fork.method'),flags);
 expect(result).toMatchObject({status:'completed',result:42,forked_from:{run_dir:parent,changed_files:[{file:'finish.mjs',change:'changed'}],file_evidence:'entrypoints'}});
 expect(readFileSync(calls,'utf8')).toBe('x');
 const inspection=inspectRun(join(root,'fork'),{includeFiles:false});
 expect(inspection.status).toBe('succeeded');
 expect(inspection.invocations['slow:0']).toMatchObject({status:'passed',outputs:{value:41}});
 expect(inspection.invocations['slow:0']!.events.map(e=>e.type)).toEqual(['step_imported']);
 expect(inspection.invocations['slow:0']!.events[0]!.detail).toContain(parent);
 expect(inspection.events?.find(e=>e.type==='run_started')?.detail).toContain('Changed files: finish.mjs (changed)');
},60_000);
