/** Explicit integration test: real Chrome, local fixture, no model or website account. */
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {openBrowser,browserConfig,browserBinding,browserDirectory} from '../../packages/sdk/src/browser.js';
const root=mkdtempSync(join(tmpdir(),'method-browser-')),name=`test-${randomUUID()}`;
const server=createServer((request,response)=>{
 if(request.url==='/hang')return;
 response.setHeader('Content-Type','text/html');
 response.setHeader('Set-Cookie','method_test=synthetic; Path=/; SameSite=Lax');
 response.end(`<html><title>Browser fixture</title><h1>${request.headers.cookie?.includes('method_test=synthetic')?'Signed in':'First visit'}</h1><a href="/next">Next page</a></html>`);
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
process.env.METHOD_BROWSER_HEADLESS='1';
const url=`http://127.0.0.1:${(server.address() as any).port}`;
const method={steps:{read:{do:{kind:'agent',browser:'environment.browser'}}}};
const config=browserConfig(method,{environment:{browser:`method-browser:${name}`}});
mkdirSync(browserBinding(name),{recursive:true,mode:0o700});
writeFileSync(join(browserBinding(name),'session.json'),JSON.stringify({cookies:[{name:'unrelated',value:'synthetic',domain:'unrelated.test',path:'/',expires:-1,httpOnly:false,secure:false,sameSite:'Lax'}],origins:[]}),{mode:0o600});
let browser:Awaited<ReturnType<typeof openBrowser>>;
try{
 browser=await openBrowser(method,config,join(root,'first'));
 const call=(tool:string,args:any={})=>browser!.connections.browser!.call(tool,args,new AbortController().signal);
 await call('browser_navigate',{url});
 const shot=await call('browser_screenshot');assert(shot.content.some((c:any)=>c.type==='image'&&c.data.length>100));
 await browser!.close();browser=undefined;
 const state=JSON.parse(readFileSync(join(browserDirectory(join(root,'first')),'session.json'),'utf8'));
 assert(state.cookies.some((c:any)=>c.name==='method_test'));assert(state.cookies.every((c:any)=>c.domain==='127.0.0.1'));
 browser=await openBrowser(method,config,join(root,'second'));
 await call('browser_navigate',{url});assert(JSON.stringify(await call('browser_get_html')).includes('Signed in'));
 const abort=new AbortController();const pending=browser!.connections.browser!.call('browser_navigate',{url:url+'/hang'},abort.signal);
 setTimeout(()=>abort.abort(Error('test cancellation')),100);await assert.rejects(pending,/test cancellation/);
 console.log('PASS: direct controls, screenshot, private session export, reuse in a fresh profile, cancellation.');
}finally{
 await browser?.close().catch(()=>{});server.closeAllConnections();server.close();
 for(const path of [browserBinding(name),browserDirectory(join(root,'first')),browserDirectory(join(root,'second')),root])rmSync(path,{recursive:true,force:true});
}
