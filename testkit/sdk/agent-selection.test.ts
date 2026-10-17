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
// The Method file names its local agent; nothing outside the file changes it.
const declared={...method,format:'method/3.4',models:{writer:{agent:'claude'}}};
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'method-agent-selection-'));roots.push(root);
 vi.stubEnv('HOME',root);vi.stubEnv('PATH',root);vi.stubEnv('CODEX_THREAD_ID','outer');vi.stubEnv('CLAUDECODE','1');
 for(const agent of ['codex','claude'])writeFileSync(join(root,agent),`#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2);if(args[0]==='auth'||args[0]==='login'){console.log(JSON.stringify({loggedIn:true}));process.exit(0);}fs.appendFileSync(${JSON.stringify(join(root,'calls'))},'${agent}\\n');if('${agent}'==='claude')console.log(JSON.stringify({type:'result',subtype:'success',structured_output:{text:'claude'}}));else fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({text:'codex'}));`,{mode:0o700});
 const file=join(root,'task.method');writeFileSync(file,JSON.stringify(method));
 vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
 return {root,file,runDir:join(root,'run')};
}
const events=(runDir:string)=>readFileSync(join(runDir,'events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
it('a step that names no model runs on Claude Code when both agents are installed and no single caller started the run',async()=>{
 fixture();
 await expect(resolveAgentProfiles(method,{})).resolves.toMatchObject({writer:{backend:'claude'}});
 await expect(resolveAgentProfiles(declared,{})).resolves.toMatchObject({writer:{backend:'claude'}});
});
it('a step that names no model runs on the agent that started the run, and the run record names it',async()=>{
 const f=fixture();vi.stubEnv('CLAUDECODE','');
 writeFileSync(f.file,JSON.stringify({...method,steps:{write:{do:{kind:'agent',prompt:'Return text.'},out:{text:{type:'text'}}}}}));
 expect(await runCurrentFile(f.file,{'run-dir':f.runDir})).toMatchObject({status:'completed',result:'codex'});
 expect(events(f.runDir).filter(e=>e.event==='model.used')).toMatchObject([{step:'write',phase:'action',backend:'codex',model:null,message:'Step "write" runs on Codex.'}]);
 const claude=join(f.root,'claude-run');vi.stubEnv('CLAUDECODE','1');vi.stubEnv('CODEX_THREAD_ID','');
 expect(await runCurrentFile(f.file,{'run-dir':claude})).toMatchObject({status:'completed',result:'claude'});
 expect(events(claude).find(e=>e.event==='model.used')).toMatchObject({backend:'claude'});
});
it('hosted models are used only when no local agent is installed and signed in; a named hosted model stays hosted',async()=>{
 const f=fixture();
 // Neither agent is signed in.
 for(const agent of ['codex','claude'])writeFileSync(join(f.root,agent),`#!${process.execPath}\nprocess.exit(1);`,{mode:0o700});
 await expect(resolveAgentProfiles(method,{},'x/hosted')).resolves.toMatchObject({writer:{backend:'method',model:'x/hosted'}});
 await expect(resolveAgentProfiles(method,{})).rejects.toMatchObject({code:'needs_input'});
 fixture();
 await expect(resolveAgentProfiles({...method,format:'method/3.4',models:{writer:'openai/gpt-x'}},{},'x/hosted')).resolves.toMatchObject({writer:{backend:'method',model:'openai/gpt-x'}});
 await expect(resolveAgentProfiles({...method,format:'method/3.4',models:{writer:{agent:'codex',model:'gpt-5'}}},{},'x/hosted')).resolves.toMatchObject({writer:{backend:'codex',model:'gpt-5'}});
});
it('keeps the declared agent across an actual pause and resume, whatever the caller',async()=>{
 const f=fixture();writeFileSync(f.file,JSON.stringify(declared));
 const first=await runCurrentFile(f.file,{'run-dir':f.runDir});
 expect(first).toMatchObject({status:'needs_input'});
 const saved=readFileSync(join(f.runDir,'runtime.resolved.json'),'utf8');
 expect(JSON.parse(saved).models.writer.backend).toBe('claude');
 vi.stubEnv('CLAUDECODE','');vi.stubEnv('CODEX_THREAD_ID','another-task');
 const human=join(f.root,'human.json');writeFileSync(human,JSON.stringify({steps:{'confirm:0':{outputs:{answer:'continue'}}}}));
 const result=await runCurrentFile(f.file,{'run-dir':f.runDir,resume:true,human});
 expect(result).toMatchObject({status:'completed',result:'claude'});
 expect(readFileSync(join(f.root,'calls'),'utf8')).toBe('claude\n');
 expect(readFileSync(join(f.runDir,'runtime.resolved.json'),'utf8')).toBe(saved);
});

it('a run does not accept an agent from outside the Method file',async()=>{
 const f=fixture();vi.stubEnv('CLAUDECODE','');
 writeFileSync(f.file,JSON.stringify({...declared,steps:{write:{do:{kind:'agent',model:'writer',prompt:'Return text.'},out:{text:{type:'text'}}}}}));
 // A computer.json from an earlier version that still names an agent is ignored.
 mkdirSync(join(f.root,'.config','method'),{recursive:true});writeFileSync(join(f.root,'.config','method','computer.json'),JSON.stringify({agent:'codex',bindings:{}}));
 vi.stubEnv('METHOD_CONFIG_DIR',join(f.root,'.config','method'));
 expect(await runCurrentFile(f.file,{'run-dir':f.runDir})).toMatchObject({status:'completed',result:'claude'});
 expect(readFileSync(join(f.root,'calls'),'utf8')).toBe('claude\n');
});
