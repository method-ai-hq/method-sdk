import {command} from './prepare.js';
/** Check supported agent access without starting a model request. Custom commands remain operator-owned. */
export async function checkAgents(profiles:Record<string,any>){
 const checked=new Set<string>();
 for(const profile of Object.values(profiles)){
  if(!['codex','claude'].includes(profile.backend)||profile.command||checked.has(profile.backend))continue;
  checked.add(profile.backend);
  try{
   const result=await command(profile.backend,profile.backend==='codex'?['login','status']:['auth','status'],process.cwd());
   if(profile.backend==='claude'&&JSON.parse(result.stdout).loggedIn!==true)throw Error('Not signed in.');
  }catch(error:any){throw Object.assign(Error(`${profile.backend} access check failed. Sign in with ${profile.backend}, then continue this run. ${error.message}`),{code:'needs_input'});}
 }
}
