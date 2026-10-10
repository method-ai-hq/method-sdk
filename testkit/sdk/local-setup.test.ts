import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { methodMain } from '../../packages/sdk/src/method.js';
import { exampleWorkflow, exampleFiles } from '../fixtures/copy-message-example.js';

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(p => rmSync(p, {recursive:true,force:true})); vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; });
function setup() {
 const dir=mkdtempSync(join(tmpdir(),'method-setup-')); dirs.push(dir);
 for(const [name,data] of Object.entries(exampleFiles)) writeFileSync(join(dir,name),data);
 const file=join(dir,'task.method'); writeFileSync(file,exampleWorkflow);
 const stdout=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
 return {dir,file,stdout,result:()=>JSON.parse(stdout.mock.calls.map(c=>c[0]).join(''))};
}
it('validates and runs using the Method folder even from a different working folder, and validate names a missing helper',async()=>{
 const s=setup();
 await methodMain(['validate',s.file]);
 // method run prepares node; validate lists the setup that it needs without running work.
 const validated=s.result();
 expect(validated).toMatchObject({valid:true,definition:'valid',local_setup:'needs_preparation',executed:false});
 expect(validated.missing_setup.some((item:string)=>item.includes('node'))).toBe(true);
 s.stdout.mockClear();
 await methodMain(['run',s.file,'--inputs',join(s.dir,'inputs.json'),'--run-dir',join(s.dir,'run')]);
 expect(s.result()).toMatchObject({status:'completed',result:'Hello'});
 rmSync(join(s.dir,'copy.cjs'));s.stdout.mockClear();
 await methodMain(['run',s.file,'--run-dir',join(s.dir,'run'),'--resume']);
 expect(s.result()).toMatchObject({status:'completed',result:'Hello'});
 s.stdout.mockClear();
 await methodMain(['validate',s.file]);expect(s.result().error).toContain('copy.cjs');
});
it('lists each missing setup item once, however many steps need it',async()=>{
 const s=setup();
 // A second node step that copies the first one's output: both need node prepared.
 const second='  again:\n    name: Copy again\n    purpose: Preserve the copied message.\n    in:\n      message: copied_message\n    do:\n      kind: run\n      runtime: node\n      entrypoint: copy.cjs\n    changes: []\n    out:\n      copied_again:\n        type: text\n        description: The message again.\n';
 writeFileSync(s.file,readFileSync(s.file,'utf8').replace('result: copied_message\n',`${second}result: copied_message\n`));
 await methodMain(['validate',s.file]);
 const {missing_setup}=s.result();
 expect(missing_setup.length).toBeGreaterThan(0);expect(new Set(missing_setup).size).toBe(missing_setup.length);
});
it('status does not list Methods, reveal account details, or start login',async()=>{
 const s=setup();const client:any={server:'https://example.test',token:()=>null,login:vi.fn(),request:vi.fn()};
 await methodMain(['status'],()=>client);expect(s.result().signed_in).toBe(false);expect(client.login).not.toHaveBeenCalled();expect(client.request).not.toHaveBeenCalled();
 client.token=()=> 'test-token';client.request.mockResolvedValue({user:{email:'private@example.test'}});s.stdout.mockClear();
 await methodMain(['status'],()=>client);expect(s.result()).toEqual({installed:true,server:client.server,signed_in:true});expect(client.request).toHaveBeenCalledWith('/api/cli/me');
 client.request.mockRejectedValue(Error('401: expired'));s.stdout.mockClear();await methodMain(['status'],()=>client);expect(s.result().signed_in).toBe(false);
 client.request.mockRejectedValue(Error('503: unavailable'));await expect(methodMain(['status'],()=>client)).rejects.toThrow('503');
});
it('validates a simple local-agent Method without a configuration file', async()=>{
 const s=setup();
 // Validation checks the executable exists; it must not need a developer's Codex install.
 writeFileSync(join(s.dir,'codex'), '#!/bin/sh\nexit 91\n', {mode:0o700});
 vi.stubEnv('PATH', s.dir);
 writeFileSync(s.file,JSON.stringify({format:'method/3.1',name:'Reply',goal:'Return supplied text',inputs:{text:{type:'text'}},steps:{reply:{in:{text:'inputs.text'},do:{kind:'agent',model:'default',prompt:'Return {{text}}.',tools:[]},out:{answer:{type:'text'}}}},result:'answer'}));
 await methodMain(['validate',s.file]);expect(s.result().valid).toBe(true);
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
it('gives the runtime the tools that a method/3.4 document declares', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'method-tools-')); dirs.push(dir);
 const { localSetup } = await import('../../packages/sdk/src/local-setup.js');
 const tool = { description: 'Read the notes.', in: {}, out: { notes: { type: 'text', description: 'The notes.' } }, run: { kind: 'run', runtime: 'node', entrypoint: 'notes.mjs' }, effects: [] };
 const file = join(dir, 'task.method');
 writeFileSync(file, JSON.stringify({ format: 'method/3.4', name: 'Notes', goal: 'Read notes.', tools: { read_notes: tool },
  steps: { read: { name: 'Read', purpose: 'Read the notes.', do: { kind: 'agent', model: 'default', prompt: 'Call read_notes.', tools: ['read_notes'] }, out: { answer: { type: 'text', description: 'The notes.' } } } }, result: 'answer' }));
 expect((await localSetup(file, {})).config.tools).toEqual({ read_notes: tool });
});
it('puts this CLI first on the PATH that scripts get, so a script that runs method uses it', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'method-cli-')); dirs.push(dir);
 vi.stubEnv('METHOD_CACHE_DIR', join(dir, 'cache'));
 const { cliBin } = await import('../../packages/sdk/src/prepare.js');
 const { execFileSync } = await import('node:child_process');
 const bin = cliBin();
 expect(cliBin()).toBe(bin);
 const version = JSON.parse(readFileSync('packages/sdk/package.json', 'utf8')).version;
 expect(execFileSync(join(bin, 'method'), ['--version'], { cwd: dir, encoding: 'utf8' })).toContain(`Method SDK ${version}`);
}, 30_000);
