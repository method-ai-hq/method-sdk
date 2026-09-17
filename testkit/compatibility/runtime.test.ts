import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkflow, type RunOptions } from "../../packages/sdk/src/runtime.js";
import { loadWorkflow, serializeWorkflow, shapeErrors } from "../../packages/workflow-language/src/validate.js";
import { method } from "../fixtures/method.js";
import { inspectRun } from "../../packages/sdk/src/inspect.js";
const dirs:string[]=[];
export function options(workflow=method()):RunOptions { const dir=realpathSync(mkdtempSync(join(tmpdir(),"method-v2-")));dirs.push(dir);return {workflow,inputs:{},directory:join(dir,"run"),workspace:dir,runtime_revision:"test/2",executor:{name:"test",execute:async r=>({outputs:{copied_message:r.inputs.message!}})}}; }
afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
it("parses readable YAML and rejects aliases, duplicate keys, old format",()=>{
 const flow=method();expect(loadWorkflow(serializeWorkflow(flow))).toEqual(flow);
 expect(()=>loadWorkflow("name: a\nname: b")).toThrow();expect(()=>loadWorkflow("a: &a hi\nb: *a")).toThrow();expect(()=>loadWorkflow({schema:"workflow/1"})).toThrow("workflow/1");
});
it("validates names, fields, cycles, templates, conditions and state paths",()=>{
 const flow=method();
 for(const step of [{...flow.steps.copy,in:{message:"inputs.missing"}},{...flow.steps.copy,do:"Ask {{copied_message}}"},{...flow.steps.copy,when:"inputs.message"},{...flow.steps.copy,after:"copy"}]) expect(()=>loadWorkflow({...flow,steps:{copy:step}})).toThrow();
 expect(()=>loadWorkflow({...flow,steps:{copy:flow.steps.copy,other:flow.steps.copy}})).toThrow();
 expect(()=>loadWorkflow({...flow,state:{people:{type:"list",items:"text",description:"People",file:"../people.json"}}})).toThrow();
 expect(shapeErrors({type:"list",fields:{name:"text",active:"boolean"}},[{name:"a",active:"yes"}])).not.toEqual([]);
});
it("runs an action, validates output, checks equality, and exports the same evidence",async()=>{
 const opts=options();const result=await runWorkflow(opts);expect(result.status).toBe("succeeded");expect(result.outputs).toEqual({result:"Hello"});expect(result.steps.copy?.checks[0]?.result).toBe("pass");
 const saved=inspectRun(opts.directory);expect(saved.schema).toBe("workflow-inspection/2");expect(saved.invocations.copy?.outputs).toEqual({copied_message:"Hello"});
});
it("rejects wrong output types and makes unchecked results explicit",async()=>{
 const flow=method();delete flow.steps.copy!.check;const opts=options(flow);expect((await runWorkflow(opts)).steps.copy?.verification).toBe("unchecked");
 const bad=options(flow);bad.executor.execute=async()=>({outputs:{copied_message:12}});const result=await runWorkflow(bad);expect(result.status).toBe("failed");expect(result.failure?.observed).toContain("expected text");
});
it("keeps check context separate, and requires evidence for a pass",async()=>{
 const flow=method();flow.steps.copy!.do="SECRET_ACTION_ONLY {{message}}";flow.steps.copy!.check="Check copied_message against message.";
 const opts=options(flow);opts.verifier={name:"review",verify:vi.fn(async request=>{expect(JSON.stringify(request)).not.toContain("SECRET_ACTION_ONLY");expect(request.inputs).toEqual({message:"Hello"});return {result:"pass" as const,summary:"Looks good",evidence:[]};})};
 const result=await runWorkflow(opts);expect(result.status).toBe("needs_attention");expect(result.failure?.observed).toContain("no evidence");
});
it("requires explicit retry after a failed read and preserves successful work on resume",async()=>{
 const opts=options();const execute=vi.fn(async()=>({outputs:{copied_message:"wrong"}}));opts.executor.execute=execute;
 expect((await runWorkflow(opts)).status).toBe("failed");expect((await runWorkflow({...opts,resume:true})).status).toBe("needs_attention");expect(execute).toHaveBeenCalledTimes(1);
 opts.executor.execute=vi.fn(async()=>({outputs:{copied_message:"Hello"}}));expect((await runWorkflow({...opts,resume:true,retry_invocations:["copy"]})).status).toBe("succeeded");
 expect((await runWorkflow({...opts,resume:true})).status).toBe("succeeded");expect(opts.executor.execute).toHaveBeenCalledTimes(1);
 expect((await runWorkflow({...opts,resume:true,inputs:{message:"Changed"}})).status).toBe("failed");
});
it("saves a human request and accepts only a supplied response on resume",async()=>{
 const flow=method();delete flow.steps.copy!.do;flow.steps.copy!.ask="Ask the user to return the exact message.";
 const opts=options(flow);opts.executor.execute=vi.fn();expect((await runWorkflow(opts)).status).toBe("needs_attention");expect(opts.executor.execute).not.toHaveBeenCalled();
 expect(JSON.parse(readFileSync(join(opts.directory,"steps/copy/request.json"),"utf8")).instructions).toContain("Ask the user");
 const result=await runWorkflow({...opts,resume:true,human:{execute:async()=>({outputs:{copied_message:"Hello"}})}});expect(result.status).toBe("succeeded");
});
it("snapshots state, validates updates, writes it once, and checks the saved target",async()=>{
 const flow=loadWorkflow({format:"method/2",name:"Save count",goal:"Increment the count.",state:{count:{type:"number",description:"Saved count",file:"count.json",default:0}},steps:{increment:{in:{before:"state.count"},do:"Add one to before and save count.",changes:["state.count"],check:"Read the saved count. It equals before plus one."}},result:"state.count"});
 const opts=options(flow);opts.executor.execute=vi.fn(async r=>({outputs:{},updates:{"state.count":Number(r.inputs.before)+1}}));
 let pass=false;opts.verifier={name:"review",verify:async r=>{expect(r.inputs.before).toBe(0);expect(JSON.parse(readFileSync(r.changes["state.count"]!.path!,"utf8"))).toBe(1);return {result:pass?"pass":"fail",summary:"Count observed",evidence:["state.count"]};}};
 expect((await runWorkflow(opts)).status).toBe("needs_attention");pass=true;
 const result=await runWorkflow({...opts,resume:true});expect(result.status).toBe("succeeded");expect(result.outputs).toEqual({result:1});expect(opts.executor.execute).toHaveBeenCalledTimes(1);
 expect(inspectRun(opts.directory).state).toEqual({count:0});
 writeFileSync(join(opts.workspace,".method/data/count.json"),"3");expect((await runWorkflow({...opts,resume:true})).failure?.observed).toContain("changed outside");
});
it("does not dispatch without required state or with an unsafe state link",async()=>{
 const flow=method();flow.state={count:{type:"number",description:"Saved count",file:"count.json"}};const opts=options(flow);opts.executor.execute=vi.fn();expect((await runWorkflow(opts)).status).toBe("failed");expect(opts.executor.execute).not.toHaveBeenCalled();
});
it("does not repeat an external action whose process stopped before a result",async()=>{
 const flow=method();flow.environment={service:{type:"service",description:"A service"}};flow.steps.copy!.changes=["environment.service"];flow.steps.copy!.check="Read the real result.";
 const opts=options(flow);opts.resources={service:{description:"Service"}};opts.verifier={name:"review",verify:async()=>({result:"pass",summary:"Observed",evidence:["source"]})};opts.executor.execute=vi.fn(async()=>{throw Error("Connection lost after dispatch");});
 expect((await runWorkflow(opts)).status).toBe("needs_attention");expect((await runWorkflow({...opts,resume:true})).status).toBe("needs_attention");expect(opts.executor.execute).toHaveBeenCalledTimes(1);
});
it("requires checks for external changes and rejects undeclared state changes",async()=>{
 const flow=method();flow.environment={api:{type:"service",description:"API"}};flow.steps.copy!.changes=["environment.api"];delete flow.steps.copy!.check;expect(()=>loadWorkflow(flow)).toThrow("independent check");
 const opts=options();opts.executor.execute=async()=>({outputs:{copied_message:"Hello"},updates:{"state.other":4}});expect((await runWorkflow(opts)).status).toBe("failed");
});
it("captures file bytes and rejects output paths outside the operation folder",async()=>{
 const flow=loadWorkflow({format:"method/2",name:"Write report",goal:"Save a report",steps:{write:{do:"Save a report",out:{report:{type:"file",description:"Report",format:"markdown"}},check:{file:"report"}}},result:"report"});
 const opts=options(flow);opts.executor.execute=async r=>{mkdirSync(join(r.directory,"files"),{recursive:true});writeFileSync(r.files.report!,"# Report\n");return {outputs:{report:{path:r.files.report!}}};};
 expect((await runWorkflow(opts)).status).toBe("succeeded");expect(Buffer.from(inspectRun(opts.directory,{includeFiles:true}).files?.[0]?.data ?? "", "base64").toString("utf8")).toBe("# Report\n");
 const bad=options(flow);const outside=join(bad.workspace,"outside.md");writeFileSync(outside,"data");bad.executor.execute=async()=>({outputs:{report:{path:outside}}});expect((await runWorkflow(bad)).status).toBe("failed");
});

it("supplies the requirement and local setup to access checks, actions, validators, and saved inspection", async () => {
 const flow = method();
 flow.environment = { browser: { type: "browser", description: "Browser with access to the source." } };
 flow.steps.copy!.in = { ...flow.steps.copy!.in, browser: "environment.browser" };
 flow.steps.copy!.check = "Confirm the message matches.";
 const opts = options(flow);
 opts.resources = { browser: { description: "Use Arc through its native app connection." } };
 const expected = { description: flow.environment.browser!.description, setup: opts.resources.browser!.description };
 const seen: string[] = [];
 opts.verifier = { name: "review", verify: async request => {
   seen.push(request.invocation); expect(request.resources.browser).toEqual(expected);
   return { result: "pass", summary: "Verified.", evidence: ["Observed the source."] };
 } };
 opts.executor.execute = async request => {
   expect(request.resources.browser).toEqual(expected);
   expect(request.inputs.browser).toEqual(expected);
   return { outputs: { copied_message: request.inputs.message! } };
 };
 expect((await runWorkflow(opts)).status).toBe("succeeded");
 expect(seen).toEqual(["environment/browser", "copy"]);
 const saved = inspectRun(opts.directory);
 expect(saved.resources.browser).toEqual(expected);
 expect((await runWorkflow({ ...opts, resume: true, resources: saved.resources })).status).toBe("succeeded");
});

it("scopes resumed access checks to unfinished operations on a shared connection", async () => {
 const flow = loadWorkflow({ format: "method/2", name: "Research", goal: "Search, then verify public evidence.",
   environment: { browser: { type: "browser", description: "Private search and public websites." }, archive: { type: "service", description: "Source archive." } },
   steps: {
     search: { in: { browser: "environment.browser", archive: "environment.archive" }, do: "Search the private service.", out: { people: { type: "text", description: "Saved people." } } },
     verify: { in: { browser: "environment.browser", people: "people" }, do: "Read public websites for people.", out: { verified: { type: "text", description: "Verified people." } } }
   }, result: "verified" });
 const opts = options(flow);
 opts.resources = { browser: { description: "Shared browser." }, archive: { description: "Archive connection." } };
 const probes: Record<string, unknown>[] = [];
 opts.verifier = { name: "access", verify: async request => {
   probes.push({ invocation: request.invocation, inputs: request.inputs });
   return { result: "pass", summary: "Observed required access.", evidence: ["Public source response."] };
 } };
 let fail = true;
 const execute = vi.fn(async request => {
   if (request.step.id === "search") return { outputs: { people: "Saved person" } };
   if (fail) throw Error("Temporary failure.");
   return { outputs: { verified: "Checked person" } };
 });
 opts.executor.execute = execute;
 expect((await runWorkflow(opts)).status).toBe("failed");
 probes.length = 0; fail = false;
 expect((await runWorkflow({ ...opts, resume: true, retry_invocations: ["verify"] })).status).toBe("succeeded");
 expect(probes).toEqual([{ invocation: "environment/browser", inputs: { pending_operations: [
   { step_id: "verify", action: "Read public websites for people.", check: null, changes: [] }
 ] } }]);
 expect(execute.mock.calls.filter(([request]) => request.step.id === "search")).toHaveLength(1);
 probes.length = 0;
 expect((await runWorkflow({ ...opts, resume: true })).status).toBe("succeeded");
 expect(probes).toEqual([]);
});

it("still blocks a pending external write when resumed access is unavailable", async () => {
 const flow = method();
 flow.environment = { service: { type: "service", description: "Destination service." } };
 flow.steps.copy!.changes = ["environment.service"];
 flow.steps.copy!.check = "Read back the saved message.";
 const opts = options(flow);
 opts.resources = { service: { description: "Destination connection." } };
 const execute = vi.fn(); opts.executor.execute = execute;
 const verify = vi.fn(async () => ({ result: "ambiguous" as const, summary: "Destination unavailable.", evidence: [] }));
 opts.verifier = { name: "access", verify };
 expect((await runWorkflow(opts)).status).toBe("needs_attention");
 expect((await runWorkflow({ ...opts, resume: true })).status).toBe("needs_attention");
 expect(verify).toHaveBeenCalledTimes(2);
 expect(execute).not.toHaveBeenCalled();
});
