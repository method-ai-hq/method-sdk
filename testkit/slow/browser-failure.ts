/** Real Chrome disconnection; local page, isolated profile, no accounts or model. */
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {BrowserService} from '../../packages/sdk/src/browser.js';
const root=mkdtempSync(join(tmpdir(),'method-disconnect-'));
const chrome=spawn(process.env.METHOD_BROWSER_EXECUTABLE??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--disable-extensions','--remote-debugging-port=0',`--user-data-dir=${root}`,'about:blank'],{stdio:'ignore'});
const service=new BrowserService(process.env.PYTHON!);
try {
 const portFile=join(root,'DevToolsActivePort');
 for(let i=0;i<100&&!existsSync(portFile);i++)await new Promise(r=>setTimeout(r,100));
 const [port,path]=readFileSync(portFile,'utf8').trim().split('\n');
 console.log('Starting browser connection');
 await service.request('start',{cdp_url:`ws://127.0.0.1:${port}${path}`});
 console.log('Checking missing tab');
 const missing=await service.request('call',{name:'browser_switch_tab',arguments:{tab_id:'missing-tab'}});
 assert.equal(missing.isError,true);
 assert((await service.request('call',{name:'browser_list_tabs'})).content.length);
 console.log('Closing Chrome');
 const exited=once(chrome,'exit');chrome.kill('SIGKILL');await exited;
 await assert.rejects(service.request('call',{name:'browser_list_tabs'}),{code:'connection_failed',message:'Browser connection lost. Chrome closed or disconnected.'});
 console.log('PASS: action error is recoverable; closed Chrome throws a connection failure.');
} finally {
 await service.close().catch(()=>{});chrome.kill('SIGKILL');rmSync(root,{recursive:true,force:true});
}
