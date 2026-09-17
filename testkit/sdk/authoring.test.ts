import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localAuthoring, readDocument, change, authoringPath } from "../../packages/sdk/src/authoring.js";
import { loadWorkflow } from "../../packages/workflow-language/src/validate.js";
import { method } from "../fixtures/method.js";
const dirs:string[]=[];afterEach(()=>{dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true}));vi.restoreAllMocks();process.exitCode=0;});
function setup(){const dir=mkdtempSync(join(tmpdir(),"method-author-"));dirs.push(dir);vi.spyOn(process.stdout,"write").mockImplementation(()=>true);return {dir,file:join(dir,"test.method")};}
it("edits stable named steps and preserves the file after invalid changes",async()=>{
 const {file}=setup();writeFileSync(file,JSON.stringify(method()));await localAuthoring(["step","update",file,"copy","--json",JSON.stringify({do:"Return message unchanged."})]);expect(loadWorkflow(readDocument(file)).steps.copy?.do).toBe("Return message unchanged.");
 const before=readFileSync(file,"utf8");await expect(localAuthoring(["step","update",file,"copy","--json",'{"actor":"agent"}'])).rejects.toThrow();expect(readFileSync(file,"utf8")).toBe(before);
 await localAuthoring(["check","set",file,"copy","--text","Compare copied_message and message."]);expect(readDocument(file).steps.copy.check).toBe("Compare copied_message and message.");
 await localAuthoring(["step","remove",file,"copy"]);await localAuthoring(["validate",file]);expect(process.exitCode).toBe(1);
});
it("does not mutate prototypes and blocks sensitive symlink parents",()=>{
 expect(()=>change({},"/__proto__/polluted",true)).toThrow();expect(({} as any).polluted).toBeUndefined();expect(()=>change([],"/02",true)).toThrow();
 const {dir}=setup();mkdirSync(join(dir,"sensitive"));symlinkSync(join(dir,"sensitive"),join(dir,"alias"));expect(()=>authoringPath(join(dir,"alias","new.method"))).toThrow();
});
it("moving a step changes display order without changing dependencies",async()=>{
 const {file}=setup();const flow=method();flow.steps.later={in:{text:"copied_message"},do:"Read text."};writeFileSync(file,JSON.stringify(flow));await localAuthoring(["step","move",file,"later","--before","copy"]);const saved=loadWorkflow(readDocument(file));expect(Object.keys(saved.steps)).toEqual(["later","copy"]);expect(saved.steps.later?.in?.text).toBe("copied_message");
});
