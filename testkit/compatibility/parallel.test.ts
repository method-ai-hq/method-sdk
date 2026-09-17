import { afterEach, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflow } from "../../packages/workflow-language/src/validate.js";
import { runWorkflow } from "../../packages/sdk/src/runtime.js";
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
function options(workflow:any,execute:any){const dir=realpathSync(mkdtempSync(join(tmpdir(),"method-parallel-")));dirs.push(dir);return {workflow:loadWorkflow(workflow),inputs:{},directory:join(dir,"run"),workspace:dir,runtime_revision:"test",executor:{name:"test",execute}};}
const base={format:"method/2",name:"Parallel",goal:"Independent operations",result:{}};
it("runs independent operations together and respects forward data dependencies",async()=>{
 let active=0,max=0;const completed:string[]=[];
 const opts=options({...base,steps:{join:{in:{left:"a",right:"b"},do:"Join values",out:{joined:{type:"text",description:"Both values"}}},left:{do:"Return a",out:{a:{type:"text",description:"Left"}}},right:{do:"Return b",out:{b:{type:"text",description:"Right"}}}},result:"joined"},async(r:any)=>{
 if(r.step.id==="join"){expect(completed.sort()).toEqual(["left","right"]);return {outputs:{joined:r.inputs.left+r.inputs.right}};}
 active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,15));active--;completed.push(r.step.id);return {outputs:{[r.step.id==="left"?"a":"b"]:r.step.id}};
 });const result=await runWorkflow(opts);expect(result.status).toBe("succeeded");expect(max).toBe(2);expect(result.outputs.result).toBe("leftright");
});
it("each returns plain lists, checks every item, and an empty loop completes",async()=>{
 for(const items of [["a","b"],[]]){const opts=options({...base,inputs:{people:{type:"list",items:"text",description:"People",default:items}},steps:{copy:{each:{person:"inputs.people"},do:"Copy {{person}}",out:{copies:{type:"text",description:"One person"}},check:{equals:{actual:"copies",expected:"person"}}}},result:"copies"},async(r:any)=>({outputs:{copies:r.inputs.person}}));const result=await runWorkflow(opts);expect(result.status).toBe("succeeded");expect(result.outputs.result).toEqual(items);expect(Object.keys(result.steps).length).toBe(items.length);}
});
it("false when skips without hanging and stops consumers of absent outputs",async()=>{
 const result=await runWorkflow(options({...base,inputs:{enabled:{type:"boolean",description:"Enabled",default:false}},steps:{optional:{when:"inputs.enabled",do:"Return value",out:{value:{type:"text",description:"Value"}}},consumer:{in:{v:"value"},do:"Read value"}}},async()=>({outputs:{}})));expect(result.status).toBe("failed");expect(result.steps.optional?.status).toBe("skipped");
});
it("serializes access to the same connection",async()=>{
 let active=0,max=0;const opts=options({...base,environment:{files:{type:"files",description:"Working folder"}},steps:{a:{in:{files:"environment.files"},do:"Read files"},b:{in:{files:"environment.files"},do:"Read files"}}},async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,10));active--;return {outputs:{}};});
 const result=await runWorkflow({...opts,resources:{files:{description:"Folder",path:opts.workspace}}});expect(result.status).toBe("succeeded");expect(max).toBe(1);
});
