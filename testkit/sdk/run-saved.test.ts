import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {runSaved,finishedRun} from '../../packages/sdk/src/run-saved.js';
import {runCurrentFile} from '../../packages/sdk/src/current-runtime.js';
import {saveAnswer} from '../../packages/sdk/src/local-answer.js';
import {runtimeVersion} from '../../packages/sdk/src/method-files.js';
import {packageDigest} from '../../packages/contracts/src/method-package.js';
import {bindConnectionValue} from '../../packages/sdk/src/computer-settings.js';

const roots:string[]=[];
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();process.exitCode=0;for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(version='0.7.0',keep=false) {
 const original=JSON.parse(readFileSync(new URL(`../fixtures/runtime-upgrades/${version}.json`,import.meta.url),'utf8'));
 const root=mkdtempSync(join(tmpdir(),'method-upgrade-'));roots.push(root);
 const records=join(root,'records');mkdirSync(records);writeFileSync(join(records,'message.txt'),'Hello from a local binding\n');
 vi.stubEnv('METHOD_CACHE_DIR',join(root,'cache'));vi.stubEnv('METHOD_CONFIG_DIR',join(root,'config'));
 // The input folder is a binding of this computer.
 bindConnectionValue(original.saved.workflow_id,'records',records);
 vi.spyOn(process.stdout,'write').mockImplementation(()=>true);vi.spyOn(process.stderr,'write').mockImplementation(()=>true);
 const client:any={server:'https://example.test',credentialFile:join(root,'credentials.json'),request:vi.fn(async(path:string)=>{
  if(path==='/api/cli/me')return {user:{id:'user'},organization:{keep_run_content_on_devices:keep}};
  if(path.endsWith('/state'))return {enabled:false};
  if(path.endsWith('/bindings'))return {};
  if(path.startsWith('/api/cli/runs/'))return {id:'run_test'};
  if(path.startsWith('/api/workspace/runs/'))return {run:{status:'running'}};
  throw Error(`Unexpected API request: ${path}`);
 }),transfer:vi.fn(async(path:string)=>Buffer.from(original.blobs[path.split('/').at(-1)!.split('?')[0]!],'base64'))};
 const flags={'run-dir':join(root,'run')};
 return {root,records,client,flags,saved:original.saved};
}
// The oldest and the newest collected fixture.
for(const version of ['0.7.0','0.8.2'])it(`runs a package collected by the published ${version} runtime without saving a new version`,async()=>{
 const f=fixture(version),before=JSON.stringify(f.saved);
 const result=await runSaved(f.saved,f.flags,f.client);
 expect(result).toMatchObject({status:'completed',result:'Hello from a local binding'});
 expect(JSON.stringify(f.saved)).toBe(before);
 expect(JSON.parse(readFileSync(join(f.flags['run-dir'],'manifest.json'),'utf8')).executor_version).toBe(runtimeVersion);
 expect(JSON.parse(readFileSync(join(f.flags['run-dir'],'state.json'),'utf8'))).toEqual({count:1});
 expect(readFileSync(join(f.records,'ledger.txt'),'utf8')).toBe('Hello from a local binding\n');
 expect(f.client.request.mock.calls.some(([path,verb]:any[])=>path.startsWith('/api/cli/methods/')&&['POST','PUT'].includes(verb))).toBe(false);
});
// A Method saved with an earlier SDK release keeps running after an SDK update.
for(const runtime of ['0.9.3'])it(`runs a package saved with runtime ${runtime}`,async()=>{
 const f=fixture();f.saved.package.runtime=runtime;f.saved.package.digest=packageDigest(f.saved.workflow,f.saved.package);
 expect(await runSaved(f.saved,f.flags,f.client)).toMatchObject({status:'completed'});
});
// An older saved version carries runtime.json, and its runtimes may list env names.
it('runs a package whose runtime.json lists environment names for a runtime',async()=>{
 const f=fixture();
 const text=Buffer.from(JSON.stringify({allow_local_processes:true,runtimes:{node:{command:process.execPath,version:process.version,env:['HOME']}}}));
 const sha=createHash('sha256').update(text).digest('hex');
 f.saved.package.files.push({path:'runtime.json',sha256:sha,size:text.length});f.saved.package.digest=packageDigest(f.saved.workflow,f.saved.package);
 const transfer=f.client.transfer.getMockImplementation();f.client.transfer.mockImplementation(async(path:string)=>path.includes(sha)?text:transfer(path));
 expect(await runSaved(f.saved,f.flags,f.client)).toMatchObject({status:'completed'});
 expect(JSON.parse(readFileSync(join(f.flags['run-dir'],'runtime.json'),'utf8')).runtimes.node).toEqual({command:process.execPath,version:process.version});
});
it('rejects an unsupported package before restoring files, resolving connections, or acquiring state',async()=>{
 const f=fixture();f.saved.package.runtime='99.0.0';f.saved.package.digest=packageDigest(f.saved.workflow,f.saved.package);
 await expect(runSaved(f.saved,f.flags,f.client)).rejects.toMatchObject({code:'needs_update',message:expect.stringContaining('99.0.0')});
 expect(f.client.transfer).not.toHaveBeenCalled();
 expect(f.client.request.mock.calls.every(([path]:any[])=>path.startsWith('/api/cli/runs/')||path==='/api/cli/me')).toBe(true);
 expect(existsSync(join(f.root,'cache','environments'))).toBe(false);
});
for(const version of [undefined,'0.0.0',runtimeVersion])it(`checks the saved executor before SDK setup or state access: ${version}`,async()=>{
 const f=fixture();const inputs=join(f.root,'inputs.json');writeFileSync(inputs,JSON.stringify({pause:true}));
 expect(await runSaved(f.saved,{...f.flags,inputs},f.client)).toMatchObject({status:'needs_input'});
 const checkpoint=join(f.flags['run-dir'],'checkpoint.json');const saved=JSON.parse(readFileSync(checkpoint,'utf8'));saved.executor_version=version;writeFileSync(checkpoint,JSON.stringify(saved));
 const before=readFileSync(checkpoint,'utf8');f.client.request.mockClear();f.client.transfer.mockClear();rmSync(join(f.root,'cache'),{recursive:true});
 saveAnswer(f.flags['run-dir'],'confirm:0',{answer:'yes'});
 if(version===runtimeVersion)expect(await runSaved(f.saved,{...f.flags,resume:true},f.client)).toMatchObject({status:'completed'});
 else {
  await expect(runSaved(f.saved,{...f.flags,resume:true},f.client)).rejects.toMatchObject({code:'resume_mismatch'});
  expect(f.client.transfer).not.toHaveBeenCalled();
  expect(f.client.request.mock.calls.every(([path]:any[])=>path.startsWith('/api/cli/runs/')||path==='/api/cli/me')).toBe(true);
  await expect(runCurrentFile(join(f.flags['run-dir'],'saved.method'),{...f.flags,resume:true})).rejects.toMatchObject({code:'resume_mismatch'});
  expect(existsSync(join(f.root,'cache','environments'))).toBe(false);
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
 expect(existsSync(join(f.root,'cache','environments'))).toBe(false);
 expect(readFileSync(join(f.records,'ledger.txt'),'utf8')).toBe('Hello from a local binding\n');
});

it('releases shared state when every step finished, also when an external change was unconfirmed',()=>{
 expect(['completed','unconfirmed','failed','needs_input'].map(finishedRun)).toEqual([true,true,false,false]);
});

it('sends only the device form of the run when the organization keeps run content on devices',async()=>{
 for(const keep of [false,true]){
  const f=fixture('0.7.0',keep);
  expect(await runSaved(f.saved,f.flags,f.client)).toMatchObject({status:'completed'});
  const uploads=f.client.request.mock.calls.filter(([path,verb]:any[])=>path.startsWith('/api/cli/runs/')&&verb==='PUT').map(([,,body]:any[])=>body.inspection);
  expect(uploads.length).toBeGreaterThan(0);
  for(const inspection of uploads){
   if(keep){expect(inspection.content).toBe('device');expect(inspection.inputs).toEqual({});expect(JSON.stringify(inspection)).not.toContain('Hello from a local binding');}
   else expect(inspection.content).toBeUndefined();
  }
  expect(JSON.parse(readFileSync(join(f.flags['run-dir'],'method-sync.json'),'utf8')).device).toBe(keep?true:undefined);
 }
});
// The run worker's start line links to the run with the ID in run-id.json; the run's records use that ID.
it('sends its records with the run ID that the start line linked to',async()=>{
 const f=fixture();mkdirSync(f.flags['run-dir'],{recursive:true});
 writeFileSync(join(f.flags['run-dir'],'run-id.json'),JSON.stringify({id:'5d1f7c3e-8a2b-4c6d-9e0f-1a2b3c4d5e6f'}));
 expect(await runSaved(f.saved,f.flags,f.client)).toMatchObject({status:'completed'});
 expect(f.client.request.mock.calls.some(([path]:any[])=>path==='/api/cli/runs/5d1f7c3e-8a2b-4c6d-9e0f-1a2b3c4d5e6f')).toBe(true);
});
// The start line already linked to the run: a run whose inputs file cannot be read sends a failed record to that link.
it('sends a failed record when its inputs file cannot be read',async()=>{
 const f=fixture();
 await expect(runSaved(f.saved,{...f.flags,inputs:join(f.root,'missing.json')},f.client)).rejects.toMatchObject({code:'ENOENT'});
 const sent=f.client.request.mock.calls.filter(([path,verb]:any[])=>path.startsWith('/api/cli/runs/')&&verb==='PUT').map(([,,body]:any[])=>body.inspection);
 expect(sent.at(-1)).toMatchObject({status:'failed',failure:{owner:'setup',code:'ENOENT'}});
});
