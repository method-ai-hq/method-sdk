import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {runSaved} from '@withmethod/sdk/run-saved';
const fixture=JSON.parse(readFileSync(process.argv[2],'utf8'));
const before=JSON.stringify(fixture.saved);
const root=mkdtempSync(join(tmpdir(),`method-${process.platform}-`));
const priorCache=process.env.METHOD_CACHE_DIR;process.env.METHOD_CACHE_DIR=join(root,'cache');
try {
 const records=join(root,'local-records');mkdirSync(records);writeFileSync(join(records,'message.txt'),'Portable package\n');
 const config=join(root,'runtime.json');writeFileSync(config,JSON.stringify({allow_local_processes:true,environment:{records}}));
 const client={server:'https://example.test',credentialFile:join(root,'credentials.json'),request:async(path,verb)=>{
  if(path.endsWith('/bindings'))return {};
  if(path.endsWith('/state'))return {enabled:false};
  if(path.startsWith('/api/cli/runs/'))return {id:'run_test'};
  throw Error(`Unexpected API request: ${verb} ${path}`);
 },transfer:async path=>Buffer.from(fixture.blobs[path.split('/').at(-1).split('?')[0]],'base64')};
 const runDir=join(root,'run');const result=await runSaved(fixture.saved,{config,'run-dir':runDir},client);
 assert.equal(result.status,'completed');assert.equal(result.result,'Portable package');
 assert.equal(readFileSync(join(records,'ledger.txt'),'utf8'),'Portable package\n');
 assert.deepEqual(JSON.parse(readFileSync(join(runDir,'state.json'),'utf8')),{count:1});
 assert.equal(JSON.stringify(fixture.saved),before);
 const executor=createRequire(import.meta.url)('@withmethod/runtime/package.json').version;
 assert.equal(JSON.parse(readFileSync(join(runDir,'manifest.json'),'utf8')).executor_version,executor);
 console.log(JSON.stringify({test:'portable-saved-package',platform:process.platform,package_runtime:fixture.saved.package.runtime,executor,binding:records,status:'passed'}));
} finally {rmSync(root,{recursive:true,force:true});if(priorCache===undefined)delete process.env.METHOD_CACHE_DIR;else process.env.METHOD_CACHE_DIR=priorCache;}
