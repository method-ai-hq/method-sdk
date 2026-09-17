import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runSaved} from '../../packages/sdk/src/run-saved.js';
import {runCurrentFile} from '../../packages/sdk/src/current-runtime.js';
import {runtimeVersion} from '../../packages/sdk/src/method-files.js';
import {packageDigest} from '../../packages/contracts/src/method-package.js';

const roots:string[]=[];
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();process.exitCode=0;for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(version='0.7.0') {
 const original=JSON.parse(readFileSync(new URL(`../fixtures/runtime-upgrades/${version}.json`,import.meta.url),'utf8'));
 const root=mkdtempSync(join(tmpdir(),'method-upgrade-'));roots.push(root);
 const records=join(root,'records');mkdirSync(records);writeFileSync(join(records,'message.txt'),'Hello from a local binding\n');
 const config=join(root,'config.json');writeFileSync(config,JSON.stringify({allow_local_processes:true,environment:{records}}));
 vi.stubEnv('METHOD_CACHE_DIR',join(root,'cache'));
 vi.spyOn(process.stdout,'write').mockImplementation(()=>true);vi.spyOn(process.stderr,'write').mockImplementation(()=>true);
 const client:any={server:'https://example.test',credentialFile:join(root,'credentials.json'),request:vi.fn(async(path:string)=>{
  if(path.endsWith('/state'))return {enabled:false};
  if(path.endsWith('/bindings'))return {};
  if(path.startsWith('/api/cli/runs/'))return {id:'run_test'};
  if(path.startsWith('/api/workspace/runs/'))return {run:{status:'running'}};
  throw Error(`Unexpected API request: ${path}`);
 }),transfer:vi.fn(async(path:string)=>Buffer.from(original.blobs[path.split('/').at(-1)!.split('?')[0]!],'base64'))};
 const flags={config,'run-dir':join(root,'run')};
 return {root,records,client,flags,saved:original.saved};
}
for(const version of ['0.7.0','0.7.1'])it(`runs a package collected by the published ${version} runtime without saving a new version`,async()=>{
 const f=fixture(version),before=JSON.stringify(f.saved);
 const result=await runSaved(f.saved,f.flags,f.client);
 expect(result).toMatchObject({status:'completed',result:'Hello from a local binding'});
 expect(JSON.stringify(f.saved)).toBe(before);
 expect(JSON.parse(readFileSync(join(f.flags['run-dir'],'manifest.json'),'utf8')).executor_version).toBe(runtimeVersion);
 expect(JSON.parse(readFileSync(join(f.flags['run-dir'],'state.json'),'utf8'))).toEqual({count:1});
 expect(readFileSync(join(f.records,'ledger.txt'),'utf8')).toBe('Hello from a local binding\n');
 expect(f.client.request.mock.calls.some(([path,verb]:any[])=>path.startsWith('/api/cli/methods/')&&['POST','PUT'].includes(verb))).toBe(false);
});
it('rejects an unsupported package before restoring files, resolving connections, or acquiring state',async()=>{
 const f=fixture();f.saved.package.runtime='99.0.0';f.saved.package.digest=packageDigest(f.saved.workflow,f.saved.package);
 await expect(runSaved(f.saved,f.flags,f.client)).rejects.toMatchObject({code:'needs_update',message:expect.stringContaining('99.0.0')});
 expect(f.client.transfer).not.toHaveBeenCalled();
 expect(f.client.request.mock.calls.every(([path]:any[])=>path.startsWith('/api/cli/runs/'))).toBe(true);
 expect(existsSync(join(f.root,'cache'))).toBe(false);
});
for(const version of [undefined,'0.0.0',runtimeVersion])it(`checks the saved executor before SDK setup or state access: ${version}`,async()=>{
 const f=fixture();const inputs=join(f.root,'inputs.json');writeFileSync(inputs,JSON.stringify({pause:true}));
 expect(await runSaved(f.saved,{...f.flags,inputs},f.client)).toMatchObject({status:'needs_input'});
 const checkpoint=join(f.flags['run-dir'],'checkpoint.json');const saved=JSON.parse(readFileSync(checkpoint,'utf8'));saved.executor_version=version;writeFileSync(checkpoint,JSON.stringify(saved));
 const before=readFileSync(checkpoint,'utf8');f.client.request.mockClear();f.client.transfer.mockClear();rmSync(join(f.root,'cache'),{recursive:true});
 const human=join(f.root,'human.json');writeFileSync(human,JSON.stringify({steps:{'confirm:0':{outputs:{answer:'yes'}}}}));
 if(version===runtimeVersion)expect(await runSaved(f.saved,{...f.flags,resume:true,human},f.client)).toMatchObject({status:'completed'});
 else {
  await expect(runSaved(f.saved,{...f.flags,resume:true,human},f.client)).rejects.toMatchObject({code:'resume_mismatch'});
  expect(f.client.transfer).not.toHaveBeenCalled();
  expect(f.client.request.mock.calls.every(([path]:any[])=>path.startsWith('/api/cli/runs/'))).toBe(true);
  await expect(runCurrentFile(join(f.flags['run-dir'],'saved.method'),{...f.flags,resume:true})).rejects.toMatchObject({code:'resume_mismatch'});
  expect(existsSync(join(f.root,'cache'))).toBe(false);
  expect(readFileSync(checkpoint,'utf8')).toBe(before);
 }
 expect(readFileSync(join(f.records,'ledger.txt'),'utf8')).toBe('Hello from a local binding\n');
});
it('uploads completed results despite an unsupported package and a different executor',async()=>{
 const f=fixture();await runSaved(f.saved,f.flags,f.client);
 const checkpoint=join(f.flags['run-dir'],'checkpoint.json');const saved=JSON.parse(readFileSync(checkpoint,'utf8'));saved.executor_version='0.0.0';writeFileSync(checkpoint,JSON.stringify(saved));
 f.saved.package.runtime='99.0.0';f.saved.package.digest=packageDigest(f.saved.workflow,f.saved.package);
 f.client.request.mockClear();f.client.transfer.mockClear();rmSync(join(f.root,'cache'),{recursive:true});
 expect(await runSaved(f.saved,{...f.flags,resume:true},f.client)).toMatchObject({status:'completed'});
 expect(f.client.request.mock.calls.some(([path,verb]:any[])=>path.startsWith('/api/cli/runs/')&&verb==='PUT')).toBe(true);
 expect(f.client.transfer).not.toHaveBeenCalled();
 expect(existsSync(join(f.root,'cache'))).toBe(false);
 expect(readFileSync(join(f.records,'ledger.txt'),'utf8')).toBe('Hello from a local binding\n');
});
