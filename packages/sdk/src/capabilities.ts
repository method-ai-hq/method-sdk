import {resolveModels} from '@withmethod/runtime/agents.js';
import {executable} from '@withmethod/runtime/io.js';
import {directBackends} from '@withmethod/runtime/model.js';
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

export async function resolveAgentProfiles(method: any, config: any, agent?: string, hostedModel?: string) {
  return resolveModels(method, config, {agent, hostedModel});
}
/** What a run needs from the Method account: hosted models for unconfigured call and agent steps, and classification. */
export function accountNeeds(method: any, config: any, agent?: string) {
  const steps = Object.values(method.steps ?? {}) as any[];
  const execs = steps.flatMap(step => [step.do, step.check]).filter(exec => exec?.kind);
  return {
    models: !agent && !config.models?.default && execs.some(exec => ['call', 'agent'].includes(exec.kind) && !config.models?.[exec.model]),
    classification: execs.some(exec => exec.kind === 'classify') && !config.classification?.api_key_env,
  };
}
export async function checkConfiguration(config: any) {
  for (const profile of Object.values(config.runtimes ?? {}) as any[]) await executable(profile.command);
  for (const profile of Object.values(config.models ?? {}) as any[]) {
    if (directBackends.includes(profile.backend) && profile.backend !== 'method' && !process.env[profile.api_key_env]) throw Error(`Missing environment variable: ${profile.api_key_env}`);
    if (['codex','claude'].includes(profile.backend)) await executable(profile.command ?? profile.backend);
  }
  await checkAgents(config.models ?? {});
}
