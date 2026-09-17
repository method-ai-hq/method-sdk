vi.mock('../../packages/sdk/src/prepare.js',async importOriginal=>{
 const actual:any=await importOriginal();return {...actual,command:async(program:string,args:string[],...rest:any[])=>program==='docker'?{stdout:'test-engine\n',stderr:''}:actual.command(program,args,...rest)};
});
import {it,expect,afterEach,vi} from 'vitest';
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {browserConfig,browserName,localChromeProfile} from '../../packages/sdk/src/browser.js';
import {prepareDeployment,verifyPlan,planDirectory} from '../../packages/sdk/src/deploy.js';
import {recordDeploymentSource,readJson,inventory} from '../../packages/sdk/src/deployment-source.js';
import {runCurrentFile} from '../../packages/sdk/src/current-runtime.js';
import {connectionCheck} from '../../packages/sdk/src/runner-deploy.js';
import {validateMethod} from '@withmethod/runtime/validate.js';
const roots:string[]=[];afterEach(()=>{for(const r of roots)rmSync(r,{recursive:true,force:true});roots.length=0;vi.unstubAllEnvs();vi.restoreAllMocks();});
function root(){const r=mkdtempSync(join(tmpdir(),'method-deploy-'));roots.push(r);vi.stubEnv('METHOD_CACHE_DIR',join(r,'cache'));return r;}
const browserMethod:any={format:'method/3.1',name:'Browser test',goal:'Read sources',environment:{browser:{type:'browser',description:'Signed-in test site'}},steps:{read:{do:{kind:'agent',model:'default',browser:'environment.browser',prompt:'Read the site.'},changes:['environment.browser'],out:{sources:{type:'list',items:'text'}},check:{count:{value:'sources',min:1}}}},result:'sources'};
it('registers direct browser-use tools, keeps schemas, and requires no author list',()=>{
 validateMethod(browserMethod);const config=browserConfig(browserMethod,{});expect(config.environment.browser).toBe('method-browser:default');
 expect(config.tools.browser_screenshot.parameters).toHaveProperty('type','object');expect(config.tools.browser_screenshot.effects).toEqual([]);expect(config.tools.browser_click.effects).toEqual(['browser']);
 expect(config.tools).not.toHaveProperty('retry_with_browser_use_agent');expect(config.tools).not.toHaveProperty('browser_extract_content');
 expect(()=>browserConfig(browserMethod,{tools:{browser_click:{}}})).toThrow('conflicts');
 expect(()=>browserName({steps:{a:{do:{browser:'environment.a'}},b:{do:{browser:'environment.b'}}}})).toThrow('one browser');
});
it('prepares an exact completed package, detects changed data, and does not start a runner',async()=>{
 const r=root();mkdirSync(join(r,'records'));writeFileSync(join(r,'records','record.txt'),'source');
 writeFileSync(join(r,'copy.cjs'),`process.stdout.write(JSON.stringify({answer:'done'}))`);
 const method={format:'method/3.1',name:'Copy',goal:'Test',environment:{records:{type:'files',description:'Source folder'}},steps:{copy:{do:{kind:'run',runtime:'node',entrypoint:'copy.cjs'},out:{answer:{type:'text'}}}},result:'answer'};
 writeFileSync(join(r,'task.method'),JSON.stringify(method));writeFileSync(join(r,'runtime.json'),JSON.stringify({allow_local_processes:true,environment:{records:join(r,'records')}}));
 vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
 await runCurrentFile(join(r,'task.method'),{'run-dir':join(r,'run')});
 const review=await prepareDeployment(join(r,'run'));expect(review.status).toBe('prepared');expect(review.folders[0].files).toBe(1);expect(review).not.toHaveProperty('selections');
 const plan=readJson(join(planDirectory(review.id),'plan.json'));await verifyPlan(plan);expect(existsSync(join(planDirectory(review.id),'runner'))).toBe(false);
 writeFileSync(join(r,'records','extra.txt'),'new');await expect(verifyPlan(plan)).rejects.toThrow('changed');
});
it('declares a real outcome check for account readiness',()=>{
 const r=root(),id='deployment_00000000-0000-0000-0000-000000000000',p=join(planDirectory(id),'payload');mkdirSync(p,{recursive:true});writeFileSync(join(p,'runtime.json'),JSON.stringify({models:{default:{backend:'codex'}}}));
 const check=connectionCheck({id,browser:{name:'browser',sites:['example.com']}},browserMethod);expect(()=>validateMethod(check)).not.toThrow();expect(check.steps.access.do.browser).toBe('environment.browser');
});
it('does not inspect or package protected and credential folders',()=>{
 const r=root();mkdirSync(join(r,'sensitive'));writeFileSync(join(r,'sensitive','secret'),'private');writeFileSync(join(r,'.env'),'secret');writeFileSync(join(r,'record'),'okay');expect(Object.keys(inventory(r))).toEqual(['record']);
});
it('keeps selected session refreshes separate from unrelated sites',async()=>{
 const {mergeSessions}=await import('../../packages/sdk/src/browser.js');
 const state=mergeSessions({cookies:[{domain:'.example.com',name:'old'},{domain:'other.test',name:'kept'}],origins:[]},{cookies:[{domain:'.example.com',name:'fresh'}],origins:[]},['www.example.com']);
 expect(state.cookies.map((c:any)=>c.name)).toEqual(['kept','fresh']);
});
it('validates a browser Method without starting a browser or installing its libraries',async()=>{
 const r=root();const file=join(r,'task.method');writeFileSync(file,JSON.stringify(browserMethod));
 const {localAuthoring}=await import('../../packages/sdk/src/authoring.js');
 vi.spyOn(process.stdout,'write').mockImplementation(()=>true);await localAuthoring(['validate',file]);
 expect(existsSync(join(r,'cache','browser'))).toBe(false);expect(existsSync(join(r,'cache','environments'))).toBe(false);
});

it('selects the last-used local Chrome profile without reading its sign-ins',()=>{
 const r=root(),chrome=join(r,'Library','Application Support','Google','Chrome');mkdirSync(join(chrome,'Profile 8'),{recursive:true});
 writeFileSync(join(chrome,'Local State'),JSON.stringify({profile:{last_used:'Profile 8'}}));
 expect(localChromeProfile(r,'darwin')).toEqual({user_data_dir:chrome,profile_directory:'Profile 8'});
 expect(localChromeProfile(r,'linux')).toBeUndefined();
 writeFileSync(join(chrome,'Local State'),JSON.stringify({profile:{last_used:'../../bad'}}));expect(()=>localChromeProfile(r,'darwin')).toThrow('unavailable');
});
