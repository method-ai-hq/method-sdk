import {it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {attachResultFiles} from '../../packages/sdk/src/result-files.js';
import {transferResults} from '../../packages/sdk/src/result-transfer.js';
import {MethodClient} from '../../packages/sdk/src/method-client.js';
import {loadWorkflow} from '../../packages/workflow-language/src/validate.js';
const hash=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
it('keeps every declared file above 20 MB and resumes from server receipts',async()=>{
 const root=mkdtempSync(join(tmpdir(),'result-transfer-'));mkdirSync(join(root,'artifacts'));
 try {
  const bytes=randomBytes(11_000_000), files=[{path:'first.bin',sha256:hash(bytes),media_type:'application/octet-stream'},{path:'index.html',sha256:hash('<h1>Ready</h1>'),media_type:'text/html'},{path:'second.bin',sha256:hash(Buffer.concat([bytes,Buffer.from('2')])),media_type:'application/octet-stream'}];
  writeFileSync(join(root,'artifacts/first.bin'),bytes);writeFileSync(join(root,'artifacts/second.bin'),Buffer.concat([bytes,Buffer.from('2')]));writeFileSync(join(root,'artifacts/index.html'),'<h1>Ready</h1>');
  const manifest=JSON.stringify({schema:'method-website/1',title:'Result',entrypoint:'index.html',files});writeFileSync(join(root,'artifacts/site.json'),manifest);
  const workflow=loadWorkflow({format:'method/3.1',name:'Result',goal:'Save a site.',steps:{save:{do:{kind:'run',runtime:'node',entrypoint:'save.mjs'},out:{site:{type:'file',format:'method-website'}}}},result:'site'});
  const invocations={'save:0':{step_id:'save',status:'passed' as const,checks:[],changes:{},events:[],outputs:{site:{path:'site.json',sha256:hash(manifest)}}}};
  const refs=attachResultFiles(workflow,invocations,[join(root,'artifacts')],join(root,'artifacts'),true);
  expect(refs).toHaveLength(4);expect(refs.every(f=>f.status==='verified' && !f.data)).toBe(true);
  const received=new Set<string>();let fail=true;let puts=0;
  const client={request:async(_p:string,_m:string,b:any)=>({missing:b.files.filter((f:any)=>!received.has(f.sha256)).map((f:any)=>f.sha256)}),transfer:async(p:string,b:Uint8Array)=>{const h=p.split('/').at(-1)!;if(h===files[2]!.sha256 && fail)throw Error('connection lost');expect(hash(b)).toBe(h);received.add(h);puts++;return new Uint8Array();}} as unknown as MethodClient;
  await expect(transferResults(client,root,refs)).rejects.toThrow('connection lost');
  fail=false;const stored=await transferResults(client,root,refs);
  expect(puts).toBe(4);expect(stored.every(f=>f.stored)).toBe(true);
 } finally {rmSync(root,{recursive:true,force:true});}
});
it('uploads an absolute output path inside artifacts and refuses one outside',async()=>{
 const root=mkdtempSync(join(tmpdir(),'result-absolute-'));mkdirSync(join(root,'artifacts'));
 try {
  writeFileSync(join(root,'artifacts/result.md'),'# Ready');writeFileSync(join(root,'outside.md'),'# Outside');
  const workflow=loadWorkflow({format:'method/3.1',name:'Result',goal:'Save a report.',steps:{save:{do:{kind:'run',runtime:'python',entrypoint:'save.py'},out:{inside:{type:'file'},outside:{type:'file'}}}},result:'inside'});
  const invocations={'save:0':{step_id:'save',status:'passed' as const,checks:[],changes:{},events:[],outputs:{inside:{path:join(root,'artifacts/result.md'),sha256:hash('# Ready')},outside:{path:join(root,'outside.md'),sha256:hash('# Outside')}}}};
  const [inside,outside]=attachResultFiles(workflow,invocations,[join(root,'artifacts')],join(root,'artifacts'),true);
  expect(inside).toMatchObject({status:'verified',bytes:7});
  expect(outside).toMatchObject({status:'unavailable',reason:'The output is outside the run artifacts folder.'});
  const sent:string[]=[];
  const client={request:async(_p:string,_m:string,b:any)=>({missing:b.files.map((f:any)=>f.sha256)}),transfer:async(p:string,b:Uint8Array)=>{expect(hash(b)).toBe(p.split('/').at(-1));sent.push(p);return new Uint8Array();}} as unknown as MethodClient;
  const [stored]=await transferResults(client,root,[inside!]);
  expect(sent).toHaveLength(1);expect(stored).toMatchObject({path:join(root,'artifacts/result.md'),stored:true});
 } finally {rmSync(root,{recursive:true,force:true});}
});
it('retains HTTP status and the server reason when an error is HTML',async()=>{
 const client=new MethodClient('https://example.test',async()=>new Response('<title>Worker exceeded resource limits | Cloudflare</title>',{status:503}) as any);
 await expect(client.request('/health','GET',undefined,false)).rejects.toThrow('503: Worker exceeded resource limits');
});
