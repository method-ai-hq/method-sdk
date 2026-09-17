/** Build self-contained CLI releases. Node archives are verified before use. */
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync,cpSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..');
const output=join(root,'dist/release/cli');
const cache=join(root,'.tmp/cli-distributions');
const version=JSON.parse(readFileSync(join(root,'packages/sdk/package.json'),'utf8')).version;
const runtime=JSON.parse(readFileSync(join(root,'node_modules/@withmethod/runtime/package.json'),'utf8')).version;
const nodeVersion='22.22.2';
const targets={
 'darwin-arm64':'db4b275b83736df67533529a18cc55de2549a8329ace6c7bcc68f8d22d3c9000',
 'darwin-x64':'12a6abb9c2902cf48a21120da13f87fde1ed1b71a13330712949e8db818708ba',
 'linux-arm64':'b2f3a96f31486bfc365192ad65ced14833ad2a3c2e1bcefec4846902f264fa28',
 'linux-x64':'978978a635eef872fa68beae09f0aad0bbbae6757e444da80b570964a97e62a3',
};
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
mkdirSync(cache,{recursive:true});mkdirSync(output,{recursive:true});
const sdk=join(cache,'sdk');rmSync(sdk,{recursive:true,force:true});mkdirSync(sdk);
writeFileSync(join(sdk,'package.json'),'{"private":true}');
execFileSync('npm',['install','--ignore-scripts','--no-audit','--no-fund',join(root,`dist/release/withmethod-sdk-${version}.tgz`)],{cwd:sdk,stdio:'pipe'});
for(const [target,checksum] of Object.entries(targets)){
 const name=`node-v${nodeVersion}-${target}`, archive=join(cache,`${name}.tar.gz`);
 if(!existsSync(archive)||hash(readFileSync(archive))!==checksum){
  const response=await fetch(`https://nodejs.org/dist/v${nodeVersion}/${name}.tar.gz`);if(!response.ok)throw Error('Node download failed');
  const bytes=Buffer.from(await response.arrayBuffer());if(hash(bytes)!==checksum)throw Error('Node checksum failed');writeFileSync(archive,bytes);
 }
 const stage=join(cache,target);rmSync(stage,{recursive:true,force:true});mkdirSync(stage);
 execFileSync('tar',['-xzf',archive,'--strip-components=1','-C',stage]);
 // Keep Node, npm, and licenses. Headers and documentation are not runtime files.
 for(const name of ['include','share','CHANGELOG.md','README.md'])rmSync(join(stage,name),{recursive:true,force:true});
 cpSync(join(sdk,'node_modules'),join(stage,'sdk/node_modules'),{recursive:true});
 writeFileSync(join(stage,'method'),'#!/bin/sh\nset -eu\nentry="$0"\nwhile [ -L "$entry" ]; do link="$(readlink "$entry")"; case "$link" in /*) entry="$link";; *) entry="$(dirname "$entry")/$link";; esac; done\nbase="$(CDPATH= cd -- "$(dirname -- "$entry")" && pwd)"\nexport METHOD_RELEASE_ROOT="$base"\nexec "$base/bin/node" "$base/sdk/node_modules/@withmethod/sdk/dist/packages/sdk/src/method.js" "$@"\n',{mode:0o755});
 const packed=join(cache,`method-${version}-${target}.tar.gz`);
 execFileSync('tar',['--no-xattrs','-czf',packed,'-C',stage,'.'],{env:{...process.env,COPYFILE_DISABLE:'1'}});
 const data=readFileSync(packed),lines=[`version ${version}`,`runtime ${runtime}`,`sha256 ${hash(data)}`];
 // Keep each static asset below the hosting limit. The installer checks each part and the full archive.
 for(let i=0,part=0;i<data.length;i+=20_000_000,part++){
  const bytes=data.subarray(i,i+20_000_000),name=`method-${version}-${target}.part${part}-${hash(bytes)}`;
  writeFileSync(join(output,name),bytes);lines.push(`part ${name} ${hash(bytes)}`);
 }
 const text=lines.join('\n')+'\n';writeFileSync(join(output,`${version}-${target}.txt`),text);writeFileSync(join(output,`latest-${target}.txt`),text);
 console.log(`CLI ${version}: ${target}, ${data.length} bytes.`);
}
cpSync(join(root,'scripts/install-method.sh'),join(root,'dist/release/install.sh'));
