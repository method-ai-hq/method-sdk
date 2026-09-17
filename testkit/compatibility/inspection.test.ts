import { expect, it } from "vitest";
import { inspectCatalog, observedValue, copyInstructions, InspectionSchema } from "../../packages/workflow-language/src/inspection.js";
import { method } from "../fixtures/method.js";
it("derives data descriptions and producer, consumer and check links",()=>{
 const flow=method();flow.steps.use={in:{text:"copied_message"},do:"Read text"};const catalog=inspectCatalog(flow);
 expect(catalog.itemFor("copied_message")).toMatchObject({description:"The complete message.",createdBy:["copy"],usedBy:["use"],checkedBy:["copy"]});
 expect(catalog.itemFor("inputs.message").usedBy).toEqual(["copy"]);
});
it("keeps plan data separate from observed run values",()=>{
 const flow=method();const run=InspectionSchema.parse({schema:"workflow-inspection/2",workflow:flow,run_id:"test",status:"succeeded",inputs:{message:"Hello"},resources:{},invocations:{copy:{step_id:"copy",status:"passed",outputs:{copied_message:"Hello"},checks:[],changes:{},events:[]}}});
 expect(observedValue(inspectCatalog(flow).itemFor("copied_message"),run)).toBe("Hello");
 expect(copyInstructions(flow.steps.copy!,{message:"Hello"})).toContain('"message": "Hello"');
});
