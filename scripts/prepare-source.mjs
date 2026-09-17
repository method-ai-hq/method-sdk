import {readFileSync,mkdirSync,cpSync,rmSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {copyPublicExamples} from '../packages/sdk/scripts/copy-examples.mjs';
const root=resolve(import.meta.dirname,'..'), target=resolve(root,'packages/sdk/source');
rmSync(target,{recursive:true,force:true});
for(const path of ['packages/sdk/src','packages/workflow-language/src','packages/contracts/src','packages/compiler/src','examples','docs']) {
 const out=resolve(target,path);mkdirSync(dirname(out),{recursive:true});cpSync(resolve(root,path),out,{recursive:true});
}
copyPublicExamples(resolve(target,'packages/sdk/examples'));
const config=JSON.parse(readFileSync(resolve(root,'packages/sdk/tsconfig.build.json'),'utf8'));
config.compilerOptions.rootDir='.';config.compilerOptions.outDir='../dist';config.include=['packages/**/*.ts'];
writeFileSync(resolve(target,'tsconfig.json'),JSON.stringify(config,null,2)+'\n');
writeFileSync(resolve(target,'README.md'),'# SDK source\n\nCanonical source, tests, and releases: https://github.com/method-ai-hq/method-sdk\n');
