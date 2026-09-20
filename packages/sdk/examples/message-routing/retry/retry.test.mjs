import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse,stringify} from 'yaml';
import {runMethod} from '@withmethod/runtime';

test('retry reuses the operation ID after the service commits and before stdout returns', async t => {
  const root=await mkdtemp(join(tmpdir(),'method-ticket-retry-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const records=new Map(), writes=[];
  let committed;
  const saved=new Promise(resolve=>committed=resolve);
  let first=true;
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    res.setHeader('content-type','application/json');
    if(req.url==='/committed') {
      if(first){first=false;committed();return;}
      res.end('{}');return;
    }
    if(req.method==='POST'&&req.url==='/tickets') {
      const key=req.headers['idempotency-key'],payload=JSON.parse(body),prior=records.get(key);
      writes.push(key);
      if(prior&&(prior.message!==payload.message||prior.destination!==payload.destination)){res.statusCode=409;res.end('{}');return;}
      const record=prior??{ticket_id:'ticket-'+(records.size+1),operation_id:key,...payload};
      records.set(key,record);res.end(JSON.stringify({ticket_id:record.ticket_id,operation_id:key}));return;
    }
    const record=records.get(decodeURIComponent(req.url.split('/').at(-1)));
    res.statusCode=record?200:404;res.end(JSON.stringify(record??{}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const url=`http://127.0.0.1:${server.address().port}`;
  await cp(fileURLToPath(new URL('../',import.meta.url)),root,{recursive:true});
  const method=parse(await readFile(join(root,'retry/ticket.method'),'utf8'));
  // The handshake exists only in this test wrapper. The real action has no test hooks.
  method.steps.create_ticket.do.entrypoint='retry/fixture-action.mjs';
  method.files.push('retry/create-ticket.mjs');
  await writeFile(join(root,'retry/fixture-action.mjs'),`const write=process.stdout.write.bind(process.stdout);process.stdout.write=data=>{void fetch(${JSON.stringify(url+'/committed')},{method:'POST'}).then(()=>write(data));return true;};await import('./create-ticket.mjs');`);
  const file=join(root,'task.method');await writeFile(file,stringify(method));
  const config={allow_local_processes:true,runtimes:{node:{command:process.execPath,version:process.version}},environment:{ticket_service:url},classification:{provider:'typesafe',model:'jev-fixture'}};
  let classifications=0;
  const classification={resolve:async()=>config.classification,evaluate:async()=>{classifications++;return {...config.classification,choice:'billing',probabilities:{billing:.94,technical:.04,other:.02},confidence:.8,usage:null};}};
  const runDir=join(root,'run'),controller=new AbortController();
  const running=runMethod(file,config,{runDir,classification,inputs:{message:'Please send my invoice.'},signal:controller.signal});
  await saved;
  controller.abort(Object.assign(Error('Test interruption after service commit'),{code:'interrupted'}));
  assert.notEqual((await running).status,'completed');
  assert.equal(records.size,1);
  const resumed=await runMethod(file,config,{runDir,classification,resume:true,retry:['create_ticket:0']});
  assert.equal(resumed.status,'completed');assert.equal(records.size,1);assert.equal(classifications,1);
  assert.equal(writes.length,2);assert.equal(writes[0],writes[1]);
  assert.equal(resumed.result.operation_id,writes[0]);
  const conflict=await fetch(url+'/tickets',{method:'POST',headers:{'Idempotency-Key':writes[0]},body:JSON.stringify({message:'Different',destination:'billing'})});
  assert.equal(conflict.status,409);
});
