import {it,expect,afterEach,vi} from 'vitest';
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {browserConfig,browserName,localChromeProfile} from '../../packages/sdk/src/browser.js';
import {validateMethod} from '@withmethod/runtime/validate.js';
const roots:string[]=[];afterEach(()=>{for(const r of roots)rmSync(r,{recursive:true,force:true});roots.length=0;vi.unstubAllEnvs();vi.restoreAllMocks();});
function root(){const r=mkdtempSync(join(tmpdir(),'method-browser-'));roots.push(r);vi.stubEnv('METHOD_CACHE_DIR',join(r,'cache'));return r;}
const browserMethod:any={format:'method/3.1',name:'Browser test',goal:'Read sources',environment:{browser:{type:'browser',description:'Signed-in test site'}},steps:{read:{do:{kind:'agent',model:'default',browser:'environment.browser',prompt:'Read the site.'},changes:['environment.browser'],out:{sources:{type:'list',items:'text'}},check:{count:{value:'sources',min:1}}}},result:'sources'};
it('registers direct browser-use tools, keeps schemas, and requires no author list',()=>{
 validateMethod(browserMethod);const config=browserConfig(browserMethod,{});expect(config.environment.browser).toBe('method-browser:default');
 expect(config.tools.browser_screenshot.parameters).toHaveProperty('type','object');expect(config.tools.browser_screenshot.effects).toEqual([]);expect(config.tools.browser_click.effects).toEqual(['browser']);
 expect(config.tools).not.toHaveProperty('retry_with_browser_use_agent');expect(config.tools).not.toHaveProperty('browser_extract_content');
 expect(()=>browserConfig(browserMethod,{tools:{browser_click:{}}})).toThrow('conflicts');
 expect(()=>browserName({steps:{a:{do:{browser:'environment.a'}},b:{do:{browser:'environment.b'}}}})).toThrow('one browser');
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
