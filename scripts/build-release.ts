import {execFileSync} from 'node:child_process';
import {mkdirSync,readdirSync,readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..'), output=join(root,'dist/release'), assets=join(root,'dist/release-assets');
mkdirSync(output,{recursive:true});mkdirSync(assets,{recursive:true});
execFileSync('npm',['run','build'],{cwd:root,stdio:'inherit'});
execFileSync('npm',['pack','--workspace','@withmethod/sdk','--ignore-scripts','--pack-destination',output],{cwd:root,stdio:'pipe'});
execFileSync(process.env.PYTHON??'python3',['-m','pip','wheel','./packages/sdk-python','--no-deps','--wheel-dir',output],{cwd:root,stdio:'pipe'});
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
writeFileSync(join(assets,'manifest.json'),JSON.stringify({schema:'method-release/1',sdk,runtime,python,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),files},null,2)+'\n');
console.log(`Prepared release ${sdk}: ${files.length} verified artifacts.`);
