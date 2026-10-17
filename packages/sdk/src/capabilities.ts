import {resolveModels} from '@withmethod/runtime/agents.js';
import {command} from './prepare.js';
import {announceOwnKey, loadOwnKey, ownKeyClassification, ownKeyEnv} from './own-model-key.js';
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

/**
 * The model profiles of a run. Only the Method's models: choose them; nothing on this computer overrides them. With
 * this computer's own model key (method config model-key), hosted profiles call OpenRouter with that key, and classify
 * steps call Jev with it (config.classification). ownKey false leaves that key out (improve.method).
 */
export async function resolveAgentProfiles(method: any, config: any, hostedModel?: string, ownKey = true) {
  const profiles = await resolveModels(method, config, {hostedModel});
  const env = ownKey ? ownKeyEnv() : undefined;
  if (!env) return profiles;
  const classifies = Object.values(method.steps ?? {}).some((step: any) => [step?.do, step?.check].some(exec => exec?.kind === 'classify'));
  const hosted = Object.values(profiles).some((profile: any) => profile?.backend === 'method');
  if (!hosted && !classifies) return profiles;
  if (classifies && !config.classification?.api_key_env) config.classification = ownKeyClassification(env);
  // Hosted profiles stay hosted: the run sends their requests with the own key (hostedModelsFor).
  loadOwnKey(env);
  announceOwnKey();
  return profiles;
}
/** What a run needs from the Method account: hosted models for unconfigured call and agent steps, and classification. */
export function accountNeeds(method: any, config: any) {
  // Every run asks this first, a resumed one too: the own key's value comes from the device store by name.
  const env = ownKeyEnv();
  if (env) loadOwnKey(env, false);
  const steps = Object.values(method.steps ?? {}) as any[];
  const execs = steps.flatMap(step => [step.do, step.check]).filter(exec => exec?.kind);
  return {
    // A step on a local-agent entry of the Method's models needs no account.
    models: !config.models?.default && execs.some(exec => ['call', 'agent'].includes(exec.kind) && !config.models?.[exec.model] && !method.models?.[exec.model ?? 'default']?.agent),
    classification: execs.some(exec => exec.kind === 'classify') && !config.classification?.api_key_env && !env,
  };
}
