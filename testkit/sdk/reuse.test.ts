import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runCurrentFile} from '../../packages/sdk/src/current-runtime.js';
import {parse} from '../../packages/sdk/src/local-cli.js';
import {inspectRun} from '../../packages/sdk/src/inspect.js';

const roots:string[]=[];
afterEach(()=>{process.exitCode=0;for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const method={format:'method/3.2',name:'Reuse',goal:'Reuse accepted work after a later fix.',steps:{
 slow:{name:'Slow work',purpose:'Counts its calls and returns 41.',do:{kind:'run',runtime:'node',entrypoint:'slow.mjs'},out:{value:{type:'number',description:'The slow result.'}}},
 finish:{name:'Finish',purpose:'Adds one.',in:{value:'value'},do:{kind:'run',runtime:'node',entrypoint:'finish.mjs'},out:{total:{type:'number',description:'The total.'}}},
},result:'total'};

it('method run reuses unchanged accepted steps of an earlier run after a fix to a later script',async()=>{
 const root=mkdtempSync(join(tmpdir(),'method-reuse-'));roots.push(root);
 const calls=join(root,'calls'), runs=join(root,'.method-runs');
 writeFileSync(join(root,'task.method'),JSON.stringify(method));
 writeFileSync(join(root,'slow.mjs'),`import{appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(calls)},'x');console.log(JSON.stringify({value:41}))`);
 writeFileSync(join(root,'finish.mjs'),'console.log(JSON.stringify({wrong:1}))');
 const failed=await runCurrentFile(join(root,'task.method'),{'run-dir':join(runs,'first')});
 expect(failed).toMatchObject({status:'failed',failure:{code:'invalid_output',step:'finish'}});
 writeFileSync(join(root,'finish.mjs'),`import{readFileSync}from'node:fs';const a=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({total:a.value+1}))`);
 const result=await runCurrentFile(join(root,'task.method'),parse(['run',join(root,'task.method'),'--run-dir',join(runs,'second')]).values);
 expect(result).toMatchObject({status:'completed',result:42,reused:{slow:1}});
 expect(readFileSync(calls,'utf8')).toBe('x');
 expect(inspectRun(join(runs,'second'),{includeFiles:false}).invocations['slow:0']).toMatchObject({status:'passed',outputs:{value:41}});
 const again=await runCurrentFile(join(root,'task.method'),parse(['run',join(root,'task.method'),'--run-dir',join(runs,'third'),'--rerun','slow']).values);
 expect(again).toMatchObject({status:'completed',reused:{finish:1}});
 expect(readFileSync(calls,'utf8')).toBe('xx');
},60_000);

it('the run record gives each step only the state values that it changed, not the whole state once per item of a list',async()=>{
 const root=mkdtempSync(join(tmpdir(),'method-changes-'));roots.push(root);
 const big='x'.repeat(100_000);
 writeFileSync(join(root,'task.method'),JSON.stringify({format:'method/3.4',name:'Changes',goal:'Keep a large state value, then work on a list.',
  state:{notes:{type:'text',description:'A large value.',default:''}},
  steps:{
   keep:{name:'Keep',purpose:'Writes the large state value and lists three items.',do:{kind:'run',runtime:'node',entrypoint:'keep.mjs'},changes:['state.notes'],out:{items:{type:'list',items:{type:'text'}}}},
   each:{name:'Each',purpose:'Works on one item.',each:{item:'items'},do:{kind:'run',runtime:'node',entrypoint:'each.mjs'},out:{done:{type:'text'}}},
  },result:'done'}));
 writeFileSync(join(root,'keep.mjs'),`console.log(JSON.stringify({items:['a','b','c'],state:{notes:${JSON.stringify(big)}}}))`);
 writeFileSync(join(root,'each.mjs'),`import{readFileSync}from'node:fs';const{item}=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({done:item}))`);
 const result=await runCurrentFile(join(root,'task.method'),{'run-dir':join(root,'run')});
 expect(result).toMatchObject({status:'completed'});
 const inspection=inspectRun(join(root,'run'),{includeFiles:false});
 expect(inspection.invocations['keep:0']!.changes).toEqual({notes:big});
 for(const i of [0,1,2])expect(inspection.invocations[`each:${i}`]!.changes).toEqual({});
 expect(JSON.stringify(inspection).length).toBeLessThan(3*big.length);
},60_000);
