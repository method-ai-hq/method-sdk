import {spawn} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {runtimeVersion} from './method-files.js';
import {command} from './prepare.js';
/** Install beside the active release, then dispatch the original command unchanged. */
export async function useCompatibleRelease(runtime:string,args:string[]):Promise<boolean>{
 if(runtime===runtimeVersion)return false;
 if(!/^\d+\.\d+\.\d+$/.test(runtime))throw Error('Invalid saved runtime release.');
 if(process.env.METHOD_DISPATCH_RUNTIME===runtime)throw Error('The installed CLI does not support the saved runtime.');
 const url='https://app.withmethod.ai/downloads/cli';
 const response=await fetch(`${url}/runtime/${runtime}/${process.platform}-${process.arch}.txt`);
 if(!response.ok)throw Error(`No supported CLI release is available for runtime ${runtime} on this computer.`);
 const version=(await response.text()).match(/^version (\d+\.\d+\.\d+)$/m)?.[1];if(!version)throw Error('Invalid CLI release manifest.');
 const root=process.env.METHOD_INSTALL_ROOT??join(homedir(),'.local/share/method');
 const cli=join(root,'releases',`${version}-${process.platform}-${process.arch}`,'method');
 if(!existsSync(cli)){
  const temp=mkdtempSync(join(tmpdir(),'method-install-'));
  try{const install=await fetch('https://app.withmethod.ai/install.sh');if(!install.ok)throw Error('CLI installer download failed');
   const file=join(temp,'install.sh');writeFileSync(file,await install.text(),{mode:0o700});
   await command('sh',[file,'--runtime',runtime],temp);
  }finally{rmSync(temp,{recursive:true,force:true});}
 }
 process.stderr.write(`Using Method CLI ${version} for saved runtime ${runtime}.\n`);
 const child=spawn(cli,args,{stdio:'inherit',env:{...process.env,METHOD_DISPATCH_RUNTIME:runtime}});
 process.exitCode=await new Promise<number>((yes,no)=>{child.once('error',no);child.once('exit',code=>yes(code??1));});
 return true;
}
