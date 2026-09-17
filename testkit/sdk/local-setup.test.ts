import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { methodMain } from '../../packages/sdk/src/method.js';
import { exampleWorkflow, exampleFiles } from '../../packages/sdk/src/copy-message-example.js';

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(p => rmSync(p, {recursive:true,force:true})); vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; });
function setup() {
 const dir=mkdtempSync(join(tmpdir(),'method-setup-')); dirs.push(dir);
 for(const [name,data] of Object.entries(exampleFiles)) writeFileSync(join(dir,name),data);
 const file=join(dir,'task.method'); writeFileSync(file,exampleWorkflow);
 const stdout=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
 return {dir,file,stdout,result:()=>JSON.parse(stdout.mock.calls.map(c=>c[0]).join(''))};
}
it('validates and runs using the Method folder even from a different working folder',async()=>{
 const s=setup();
 await methodMain(['validate',s.file]);
 expect(s.result()).toMatchObject({valid:true,definition:'valid',local_setup:'valid',executed:false,files:1});
 s.stdout.mockClear();
 await methodMain(['run',s.file,'--inputs',join(s.dir,'inputs.json'),'--run-dir',join(s.dir,'run')]);
 expect(s.result()).toMatchObject({status:'completed',result:'Hello'});
 rmSync(join(s.dir,'copy.cjs'));s.stdout.mockClear();
 await methodMain(['run',s.file,'--run-dir',join(s.dir,'run'),'--resume']);
 expect(s.result()).toMatchObject({status:'completed',result:'Hello'});
});
it('reports missing custom runtimes and helper files without running work',async()=>{
 const s=setup(); rmSync(join(s.dir,'runtime.json'));
 await methodMain(['validate',s.file]); expect(s.result()).toMatchObject({valid:true,definition:'valid',local_setup:'needs_preparation',executed:false});
 writeFileSync(join(s.dir,'runtime.json'),exampleFiles['runtime.json']!);rmSync(join(s.dir,'copy.cjs'));s.stdout.mockClear();
 await methodMain(['validate',s.file]);expect(s.result().error).toContain('copy.cjs');
 writeFileSync(join(s.dir,'copy.cjs'),exampleFiles['copy.cjs']!);
 writeFileSync(join(s.dir,'runtime.json'),JSON.stringify({...JSON.parse(exampleFiles['runtime.json']!),runtimes:{}}));s.stdout.mockClear();
 await methodMain(['validate',s.file]);expect(s.result().local_setup).toBe('needs_preparation');
});
it('uses an explicit config and resolves its executable path from that folder',async()=>{
 const s=setup();const configDir=join(s.dir,'config');mkdirSync(configDir);
 writeFileSync(join(configDir,'node.sh'),'#!/bin/sh\nexec "'+process.execPath+'" "$@"\n',{mode:0o700});
 const config=JSON.parse(exampleFiles['runtime.json']!);config.runtimes.node.command='./node.sh';writeFileSync(join(configDir,'custom.json'),JSON.stringify(config));
 writeFileSync(join(s.dir,'runtime.json'),'{}');
 await methodMain(['validate',s.file,'--config',join(configDir,'custom.json')]);expect(s.result().valid).toBe(true);
 s.stdout.mockClear();await methodMain(['run',s.file,'--config',join(configDir,'custom.json'),'--inputs',join(s.dir,'inputs.json'),'--run-dir',join(s.dir,'run')]);expect(s.result().result).toBe('Hello');
});
it('status does not list Methods, reveal account details, or start login',async()=>{
 const s=setup();const client:any={server:'https://example.test',token:()=>null,login:vi.fn(),request:vi.fn()};
 await methodMain(['status'],()=>client);expect(s.result().signed_in).toBe(false);expect(client.login).not.toHaveBeenCalled();expect(client.request).not.toHaveBeenCalled();
 client.token=()=> 'test-token';client.request.mockResolvedValue({user:{email:'private@example.test'}});s.stdout.mockClear();
 await methodMain(['status'],()=>client);expect(s.result()).toEqual({installed:true,server:client.server,signed_in:true});expect(client.request).toHaveBeenCalledWith('/api/cli/me');
 client.request.mockRejectedValue(Error('401: expired'));s.stdout.mockClear();await methodMain(['status'],()=>client);expect(s.result().signed_in).toBe(false);
 client.request.mockRejectedValue(Error('503: unavailable'));await expect(methodMain(['status'],()=>client)).rejects.toThrow('503');
});
it('leaves a pending save for retry when readback fails or differs, then confirms exact preserved content',async()=>{
 const s=setup();const workflow=JSON.parse(JSON.stringify((await import('../../packages/workflow-language/src/validate.js')).loadWorkflow(exampleWorkflow)));
 workflow.run_prompt='\nRead the saved result.\n';writeFileSync(s.file,JSON.stringify(workflow));
 let bad=true;let pack:any;
 const client:any={server:'https://example.test',token:()=> 'test-token',transfer:vi.fn(),request:vi.fn(async (path:string,verb:string,body:any)=>{if(path==='/api/cli/files/check')return {present:[]};if(verb==='POST'){pack=body.package;return {workflow_id:'wf_test',version_id:'v_test',version_number:1};}return {version_id:'v_test',package:pack,workflow:{...workflow,...(bad?{name:'wrong'}:{})}};})};
 await expect(methodMain(['save',s.file],()=>client)).rejects.toThrow('does not match');
 const pending=JSON.parse(readFileSync(s.file+'.method.json','utf8'));expect(pending.pending.request_id).toBeTruthy();
 bad=false;s.stdout.mockClear();await methodMain(['save',s.file],()=>client);expect(s.result()).toMatchObject({confirmed:true,version_id:'v_test'});expect(s.result().document_sha256).toMatch(/^[a-f0-9]{64}$/);
 expect(JSON.parse(readFileSync(s.file+'.method.json','utf8')).pending).toBeUndefined();
 expect(client.request.mock.calls.filter((c:any[])=>c[1]==='POST'&&c[0]!=='/api/cli/files/check')[1][2].request_id).toBe(pending.pending.request_id);
});

it('treats harmless whitespace consistently after checking out an older saved document', async()=>{
 const s=setup();const workflow=(await import('../../packages/workflow-language/src/validate.js')).loadWorkflow(exampleWorkflow);
 const stored={workflow_id:'wf_test',version_id:'v_test',version_number:1,workflow:{...workflow,run_prompt:'Read the report.'}};
 const client:any={server:'https://example.test',token:()=> 'test-token',transfer:vi.fn(),request:vi.fn(async()=>stored)};
 const {collectPackage}=await import('../../packages/sdk/src/method-files.js');
 Object.assign(stored,{package:await collectPackage(s.file,(await import('../../packages/workflow-language/src/validate.js')).loadWorkflow(stored.workflow),client)});
 const checkout=join(s.dir,'checkout.method');await methodMain(['get','wf_test','--out',checkout],()=>client);
 writeFileSync(checkout,readFileSync(checkout,'utf8').replace('Read the report.', 'Read the report.'));
 s.stdout.mockClear();await methodMain(['save',checkout],()=>client);
 expect(s.result()).toMatchObject({confirmed:true,unchanged:true,version_id:'v_test'});
 expect(client.request.mock.calls.filter((c:any[])=>c[0]!=='/api/cli/files/check').every((c:any[])=>c[1]===undefined)).toBe(true);
});

it('validates a simple local-agent Method without a configuration file', async()=>{
 const s=setup(); rmSync(join(s.dir,'runtime.json'));
 // Validation checks the executable exists; it must not need a developer's Codex install.
 writeFileSync(join(s.dir,'codex'), '#!/bin/sh\nexit 91\n', {mode:0o700});
 vi.stubEnv('PATH', s.dir);
 writeFileSync(s.file,JSON.stringify({format:'method/3.1',name:'Reply',goal:'Return supplied text',inputs:{text:{type:'text'}},steps:{reply:{in:{text:'inputs.text'},do:{kind:'agent',model:'default',prompt:'Return {{text}}.',tools:[]},out:{answer:{type:'text'}}}},result:'answer'}));
 await methodMain(['validate',s.file]);expect(s.result().valid).toBe(true);
});

it('resumes a direct executor checkpoint from the same release without adding SDK setup fields',async()=>{
 const s=setup();
 const {runCurrentMethod}=await import('../../packages/sdk/src/current-runtime.js');
 const config=JSON.parse(exampleFiles['runtime.json']!);
 const directory=join(s.dir,'old-run');
 expect((await runCurrentMethod(s.file,config,{runDir:directory,inputs:{message:'direct'}})).status).toBe('completed');
 s.stdout.mockClear();
 await methodMain(['run',s.file,'--resume','--run-dir',directory]);
 expect(s.result()).toMatchObject({status:'completed',result:'direct'});
});


it('keeps resolved setup for a local run that did not specify a directory',async()=>{
 const s=setup();
 await methodMain(['run',s.file,'--inputs',join(s.dir,'inputs.json')]);
 const directory=s.result().run_dir;dirs.push(directory);
 expect(JSON.parse(readFileSync(join(directory,'runtime.resolved.json'),'utf8')).runtimes.node).toBeTruthy();
 s.stdout.mockClear();
 await methodMain(['run',s.file,'--resume','--run-dir',directory]);
 expect(s.result()).toMatchObject({status:'completed',result:'Hello'});
});
