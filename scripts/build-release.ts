import {authoringExamples} from '../packages/sdk/src/authoring-example.js';
import {execFileSync} from 'node:child_process';
import {rmSync,mkdirSync,readdirSync,readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {assertImmutableArtifacts} from './release-contract.js';
const root=resolve(import.meta.dirname,'..'), output=join(root,'dist/release'), assets=join(root,'dist/release-assets');
// Only generated release staging is removed. No old artifact can leak into the manifest.
rmSync(output,{recursive:true,force:true});rmSync(assets,{recursive:true,force:true});
mkdirSync(output,{recursive:true});mkdirSync(assets,{recursive:true});
execFileSync('npm',['run','build'],{cwd:root,stdio:'inherit'});
execFileSync('npm',['pack','--workspace','@withmethod/sdk','--ignore-scripts','--pack-destination',output],{cwd:root,stdio:'pipe'});
const packedSdk = readdirSync(output).find(name => name.endsWith('.tgz'))!;
const packedFiles = new Set(execFileSync('tar', ['-tzf', join(output, packedSdk)], {encoding:'utf8'}).trim().split('\n'));
const exampleFiles = JSON.parse(readFileSync(join(root,'packages/sdk/examples/files.json'),'utf8')) as string[];
for (const example of authoringExamples) {
  const files = exampleFiles.filter(name => name.startsWith(example.directory+'/'));
  if (!files.includes(`${example.directory}/${example.entrypoint}`)) throw Error(`Missing example entrypoint: ${example.id}`);
  for(const name of example.lessonFiles) if(!files.includes(`${example.directory}/${name}`)) throw Error(`Missing lesson file: ${example.id}/${name}`);
  for(const name of files) if(!packedFiles.has(`package/dist/packages/sdk/examples/${name}`)) throw Error(`Packed example is missing ${name}`);
}
execFileSync(process.env.PYTHON??'python3',['-m','pip','wheel','./packages/sdk-python','--no-deps','--wheel-dir',output],{cwd:root,stdio:'pipe',env:{...process.env,SOURCE_DATE_EPOCH:'315532800'}});
execFileSync(process.execPath,['--import','tsx','scripts/build-cli-distributions.ts'],{cwd:root,stdio:'inherit'});
const sdk=JSON.parse(readFileSync(join(root,'packages/sdk/package.json'),'utf8')).version;
const runtime=JSON.parse(readFileSync(join(root,'node_modules/@withmethod/runtime/package.json'),'utf8')).version;
const python=readFileSync(join(root,'packages/sdk-python/pyproject.toml'),'utf8').match(/^version = "([^"]+)"/m)![1];
const files:Array<{name:string;asset:string;sha256:string}>=[];
function visit(dir:string,prefix=''){
 for(const entry of readdirSync(dir,{withFileTypes:true})){
  const name=prefix+entry.name,path=join(dir,entry.name);
  if(entry.isDirectory())visit(path,name+'/');
  else {const asset=name.replaceAll('/','--');copyFileSync(path,join(assets,asset));files.push({name,asset,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')});}
 }
}
visit(output);
const priorResponse = await fetch('https://github.com/method-ai-hq/method-sdk/releases/latest/download/manifest.json');
if (!priorResponse.ok) throw Error(`Cannot verify the prior public release: ${priorResponse.status}`);
const prior = await priorResponse.json() as {schema:string;files:Array<{name:string;sha256:string}>};
if(prior.schema !== 'method-release/1' || !Array.isArray(prior.files)) throw Error('Invalid prior release manifest');
assertImmutableArtifacts(files, prior.files);
writeFileSync(join(assets,'manifest.json'),JSON.stringify({schema:'method-release/1',sdk,runtime,python,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),files},null,2)+'\n');
console.log(`Prepared release ${sdk}: ${files.length} verified artifacts.`);
