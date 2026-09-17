import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runCurrentFile} from '../../packages/sdk/src/current-runtime.js';
import {resolveAgentProfiles} from '../../packages/sdk/src/capabilities.js';

const roots:string[]=[];
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();process.exitCode=0;for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const method={format:'method/3.1',name:'Agent selection',goal:'Keep the same agent.',steps:{
 confirm:{ask:'Continue?',out:{answer:{type:'text',description:'Confirmation.'}}},
 write:{in:{answer:'answer'},do:{kind:'agent',model:'writer',prompt:'Return {{answer}}.',tools:[]},out:{text:{type:'text',description:'Agent result.'}}},
},result:'text'};
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'method-agent-selection-'));roots.push(root);
 vi.stubEnv('HOME',root);vi.stubEnv('PATH',root);vi.stubEnv('CODEX_THREAD_ID','outer');vi.stubEnv('CLAUDECODE','1');
 const directory=join(root,'.config','method');mkdirSync(directory,{recursive:true});
 const preference=join(directory,'agent.json');writeFileSync(preference,'{"agent":"codex"}');
 for(const agent of ['codex','claude'])writeFileSync(join(root,agent),`#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2);if(args[0]==='auth'||args[0]==='login'){console.log(JSON.stringify({loggedIn:true}));process.exit(0);}fs.appendFileSync(${JSON.stringify(join(root,'calls'))},'${agent}\\n');if('${agent}'==='claude')console.log(JSON.stringify({type:'result',subtype:'success',structured_output:{text:'claude'}}));else fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({text:'codex'}));`,{mode:0o700});
 const file=join(root,'task.method');writeFileSync(file,JSON.stringify(method));
 vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
 return {root,file,preference,runDir:join(root,'run')};
}
it('ignores the old machine preference when both callers and agents are present',async()=>{
 const f=fixture();
 await expect(resolveAgentProfiles(method,{})).rejects.toMatchObject({code:'needs_input'});
 // A malformed obsolete preference must not be read either.
 writeFileSync(f.preference,'invalid JSON');
 await expect(resolveAgentProfiles(method,{},'claude')).resolves.toMatchObject({writer:{backend:'claude'}});
});
it('keeps the chosen agent across an actual pause and resume without changing a shared preference',async()=>{
 const f=fixture();
 const first=await runCurrentFile(f.file,{'run-dir':f.runDir,agent:'claude'});
 expect(first).toMatchObject({status:'needs_input'});
 expect(readFileSync(f.preference,'utf8')).toBe('{"agent":"codex"}');
 const saved=readFileSync(join(f.runDir,'runtime.resolved.json'),'utf8');
 expect(JSON.parse(saved).models.writer.backend).toBe('claude');
 vi.stubEnv('CLAUDECODE','');vi.stubEnv('CODEX_THREAD_ID','another-task');
 const human=join(f.root,'human.json');writeFileSync(human,JSON.stringify({steps:{'confirm:0':{outputs:{answer:'continue'}}}}));
 const result=await runCurrentFile(f.file,{'run-dir':f.runDir,resume:true,agent:'codex',human});
 expect(result).toMatchObject({status:'completed',result:'claude'});
 expect(readFileSync(join(f.root,'calls'),'utf8')).toBe('claude\n');
 expect(readFileSync(join(f.runDir,'runtime.resolved.json'),'utf8')).toBe(saved);
 expect(readFileSync(f.preference,'utf8')).toBe('{"agent":"codex"}');
});
