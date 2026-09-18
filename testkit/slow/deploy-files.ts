/** Real Docker deployment: isolated files, no browser, account, or model work. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runCurrentFile} from '../../packages/sdk/src/current-runtime.js';
import {prepareDeployment,approveDeployment,planDirectory} from '../../packages/sdk/src/deploy.js';
import {runDeployment,docker} from '../../packages/sdk/src/runner-deploy.js';
import {readJson} from '../../packages/sdk/src/deployment-source.js';
const root=mkdtempSync(join(tmpdir(),'method-deploy-files-')),previousCache=process.env.METHOD_CACHE_DIR;
process.env.METHOD_CACHE_DIR=join(root,'cache');
let plan:any;
try{
 const crm=join(root,'crm');mkdirSync(crm);writeFileSync(join(crm,'count.json'),'0');
 writeFileSync(join(root,'update.cjs'),`const fs=require('node:fs'),path=require('node:path');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const file=path.join(JSON.parse(s).crm,'count.json');const count=JSON.parse(fs.readFileSync(file))+1;fs.writeFileSync(file,JSON.stringify(count));console.log(JSON.stringify({count,saved:JSON.parse(fs.readFileSync(file))===count}));});`);
 const method={format:'method/3.1',name:'Check deployed working files',goal:'Increment and read back a persistent count.',inputs:{expected:{type:'boolean',default:true}},environment:{crm:{type:'files',description:'Persistent counter'}},steps:{update:{changes:['environment.crm'],in:{crm:'environment.crm',expected:'inputs.expected'},do:{kind:'run',runtime:'node',entrypoint:'update.cjs'},out:{count:{type:'number'},saved:{type:'boolean'}},check:{equals:{actual:'saved',expected:'expected'}}}},result:'count'};
 writeFileSync(join(root,'task.method'),JSON.stringify(method));
 writeFileSync(join(root,'runtime.json'),JSON.stringify({allow_local_processes:true,environment:{crm}}));
 await runCurrentFile(join(root,'task.method'),{'run-dir':join(root,'local-run')});
 assert.equal(readJson(join(crm,'count.json')),1);
 const review=await prepareDeployment(join(root,'local-run'));
 plan=readJson(join(planDirectory(review.id),'plan.json'));
 console.log('Approving isolated test files only:',review.id);
 const ready=await approveDeployment(review.id);assert.equal(ready.status,'ready');
 plan=readJson(join(planDirectory(review.id),'plan.json'));
 const file=join(planDirectory(plan.id),'runner','deployment','data','crm','count.json');
 assert.equal(readJson(file),1);
 for(const count of [2,3]){
  const result=await runDeployment(plan.id);assert.equal(result.status,'completed');assert.equal(readJson(file),count);
 }
 await docker(plan,['restart',plan.container]);
 await approveDeployment(plan.id);assert.equal(readJson(file),3);
 assert.equal((await runDeployment(plan.id)).status,'completed');assert.equal(readJson(file),4);
 await docker(plan,['rm','--force',plan.container]);
 assert.equal((await runDeployment(plan.id)).status,'completed');assert.equal(readJson(file),5);
 assert.equal(readJson(join(crm,'count.json')),1);
 console.log('PASS: post-run transfer, two runs, repeated approval, restart, container recreation, unchanged original.');
}finally{
 if(plan)await docker(plan,['rm','--force',`method-${plan.id}`]).catch(()=>{});
 rmSync(root,{recursive:true,force:true});
 if(previousCache===undefined)delete process.env.METHOD_CACHE_DIR;else process.env.METHOD_CACHE_DIR=previousCache;
}
