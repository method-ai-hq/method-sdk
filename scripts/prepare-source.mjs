import {readFileSync,mkdirSync,cpSync,rmSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {copyPublicExamples} from '../packages/sdk/scripts/copy-examples.mjs';
const root=resolve(import.meta.dirname,'..'), target=resolve(root,'packages/sdk/source');
rmSync(target,{recursive:true,force:true});
for(const path of ['packages/sdk/src','packages/workflow-language/src','packages/contracts/src','packages/method-document/src','examples','docs']) {
 const out=resolve(target,path);mkdirSync(dirname(out),{recursive:true});cpSync(resolve(root,path),out,{recursive:true});
}
copyPublicExamples(resolve(target,'packages/sdk/examples'));
const config=JSON.parse(readFileSync(resolve(root,'packages/sdk/tsconfig.build.json'),'utf8'));
config.compilerOptions.rootDir='.';config.compilerOptions.outDir='../dist';config.include=['packages/**/*.ts'];
writeFileSync(resolve(target,'tsconfig.json'),JSON.stringify(config,null,2)+'\n');
const version=JSON.parse(readFileSync(resolve(root,'packages/sdk/package.json'),'utf8')).version;
writeFileSync(resolve(target,'README.md'),`# SDK source\n\nThis directory contains the MIT source used by SDK ${version}. For a complete reproducible checkout with the lockfile, tests, and build scripts:\n\n\`\`\`sh\ngit clone --branch v${version} https://github.com/method-ai-hq/method-sdk.git\ncd method-sdk\nnpm ci\nnpm run build\nnpm test\n\`\`\`\n\nUse Node.js 22+ and Python 3.11+. Python and JavaScript release versions match.\n`);
