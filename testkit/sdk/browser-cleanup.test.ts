import {it,expect,vi,afterEach} from 'vitest';
const mocks=vi.hoisted(()=>({execute:vi.fn(),close:vi.fn()}));
vi.mock('../../packages/sdk/src/local-setup.js',()=>({localSetup:async()=>({config:{},sourceRoot:'/tmp'})}));
vi.mock('../../packages/sdk/src/authoring.js',()=>({authoringPath:(v:string)=>v,readDocument:()=>({steps:{}})}));
vi.mock('../../packages/sdk/src/capabilities.js',()=>({checkAgents:async()=>{},resolveAgentProfiles:async()=>({})}));
vi.mock('../../packages/sdk/src/prepare.js',()=>({prepareRuntime:async()=>({config:{},processPath:'',prepareBundle:async()=>{}})}));
vi.mock('../../packages/sdk/src/deployment-source.js',()=>({recordDeploymentSource:()=>{}}));
vi.mock('../../packages/sdk/src/browser.js',()=>({openBrowser:async()=>({connections:{},close:mocks.close})}));
vi.mock('@withmethod/runtime/runner.js',()=>({runMethod:mocks.execute}));
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runCurrentFile} from '../../packages/sdk/src/current-runtime.js';
afterEach(()=>{vi.restoreAllMocks();process.exitCode=0;});
it('keeps the failed run result when browser cleanup also fails',async()=>{
 const root=mkdtempSync(join(tmpdir(),'method-cleanup-'));
 const result={status:'failed',code:'connection_failed',error:'Browser connection lost'};
 mocks.execute.mockResolvedValue(result);mocks.close.mockRejectedValue(Error('Cookie export failed'));
 vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
 try {expect(await runCurrentFile('/tmp/task.method',{'run-dir':root})).toEqual(result);expect(mocks.close).toHaveBeenCalled();}
 finally {rmSync(root,{recursive:true,force:true});}
});
