import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
let input=''; for await(const chunk of process.stdin) input+=chunk;
const {title,update}=JSON.parse(input);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const assets={
  'index.html': ['text/html', '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Project update</title><link rel="stylesheet" href="style.css"></head><body><main><h1>Project update</h1><p id="update">Loading…</p><button id="details">Show details</button><p id="note" hidden>This website was saved as a Method result.</p></main><script src="app.js"></script></body></html>'],
  'style.css':['text/css','body{font:18px/1.6 system-ui;background:#f5f5f2;color:#273541;margin:0}main{max-width:680px;margin:8vh auto;padding:24px}h1{font-size:36px;line-height:1.2}#update{white-space:pre-wrap}button{padding:10px 16px;border-radius:8px;border:1px solid #ccd0d2;background:white;cursor:pointer}'],
  'app.js':['text/javascript',`fetch('./update.json').then(r=>r.json()).then(data=>{document.querySelector('h1').textContent=data.title;document.title=data.title;document.querySelector('#update').textContent=data.update;});document.querySelector('#details').onclick=()=>{document.querySelector('#note').hidden=!document.querySelector('#note').hidden;};`],
  'update.json':['application/json',JSON.stringify({title,update})],
};
const root=join(process.env.METHOD_OUTPUT_DIR,'website');await mkdir(root,{recursive:true});
const files=[];
for(const [path,[media_type,contents]] of Object.entries(assets)){await writeFile(join(root,path),contents);files.push({path,media_type,sha256:sha(contents)});}
const manifest=JSON.stringify({schema:'method-website/1',title,entrypoint:'index.html',files});
await writeFile(join(root,'manifest.json'),manifest);
console.log(JSON.stringify({website:{path:'website/manifest.json',sha256:sha(manifest)}}));
