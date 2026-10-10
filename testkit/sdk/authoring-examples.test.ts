import {expect,it} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import {authoringExamples,exampleDirectory,renderExample} from '../../packages/sdk/src/authoring-example.js';
import {loadWorkflow} from '../../packages/workflow-language/src/validate.js';
import {preflight} from '@withmethod/runtime/preflight.js';
it('ships every catalog example as a complete package: each Method in it loads with the current loader and has every declared helper',async()=>{
 const files=JSON.parse(readFileSync('packages/sdk/examples/files.json','utf8')) as string[];
 for(const example of authoringExamples){
  const {directory}=exampleDirectory(example.id);
  const methods=readdirSync(directory).filter(name=>name.endsWith('.method'));
  expect(methods).toContain(example.entrypoint);
  const declared:string[]=[];
  for(const name of methods){
   const workflow=loadWorkflow(readFileSync(directory+name,'utf8'));
   expect((workflow as any).id).toBeUndefined();
   declared.push(...(await preflight(workflow,{allow_local_processes:true},directory,{allowMissingSetup:true})).files);
  }
  for(const name of [...declared,...example.lessonFiles]){
   expect(files).toContain(example.directory+'/'+name);
  }
  expect(renderExample(example.id)).toContain('# Request');
 }
});
