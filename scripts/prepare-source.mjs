import { readFileSync, mkdirSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const target = resolve(root, 'packages/sdk/source');
rmSync(target, {recursive:true, force:true});
for (const file of JSON.parse(readFileSync(resolve(root,'exported-files.json'),'utf8'))) {
  if (!(file.startsWith('packages/sdk/src/') || file.startsWith('packages/sdk/examples/') || file.startsWith('packages/workflow-language/') || file.startsWith('packages/contracts/') || file.startsWith('packages/compiler/') || file.startsWith('examples/') || file.startsWith('docs/'))) continue;
  const destination = resolve(target,file);
  mkdirSync(dirname(destination),{recursive:true});
  cpSync(resolve(root,file),destination);
}
const config = JSON.parse(readFileSync(resolve(root,'packages/sdk/tsconfig.build.json'),'utf8'));
config.compilerOptions.rootDir = '.';
config.compilerOptions.outDir = '../dist';
config.include = ['packages/sdk/src/**/*.ts'];
writeFileSync(resolve(target,'tsconfig.json'),JSON.stringify(config,null,2)+'\n');
writeFileSync(resolve(target,'README.md'),'# SDK source\n\nFull source, tests, and build instructions: https://github.com/method-ai-hq/method-sdk\n\nFrom the extracted package root, install development tools with `npm install --save-dev typescript @types/node`, then run `npx tsc -p source/tsconfig.json`. Copy the examples with `mkdir -p dist/packages/sdk/examples && cp -R source/packages/sdk/examples/. dist/packages/sdk/examples/`.\n');
