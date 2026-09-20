import {expect,it} from 'vitest';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {authoringExamples,exampleDirectory,renderExample} from '../../packages/sdk/src/authoring-example.js';
import {loadWorkflow} from '../../packages/workflow-language/src/validate.js';
import {preflight} from '@withmethod/runtime/preflight.js';
import {authoringPrompt} from '../../packages/sdk/src/authoring-prompt.js';
import {exampleSelection} from '../../packages/sdk/src/method-help.js';
it('ships four complete packages with valid definitions, source descriptions, and every declared helper',async()=>{
 const files=JSON.parse(readFileSync('packages/sdk/examples/files.json','utf8')) as string[];
 for(const example of authoringExamples){
  const {directory}=exampleDirectory(example.id);
  const workflow=loadWorkflow(readFileSync(directory+example.entrypoint,'utf8'));
  expect(workflow.format).toBe('method/3.2');
  const config=existsSync(directory+'runtime.json')?JSON.parse(readFileSync(directory+'runtime.json','utf8')):{allow_local_processes:true};
  const result=await preflight(workflow,config,directory,{allowMissingSetup:true});
  for(const name of [...result.files,...example.lessonFiles]){
   expect(files).toContain(example.directory+'/'+name);
   expect(existsSync(resolve('packages/sdk/dist/packages/sdk/examples',example.directory,name))).toBe(true);
  }
  expect(renderExample(example.id)).toContain('# Request');
 }
 expect(authoringPrompt).toContain(exampleSelection);
 expect(authoringPrompt.indexOf('Wait for my answers')).toBeLessThan(authoringPrompt.indexOf(exampleSelection));
});
