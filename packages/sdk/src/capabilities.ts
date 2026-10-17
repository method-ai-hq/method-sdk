import {agentSignedIn, resolveModels} from '@withmethod/runtime/agents.js';
import {announceOwnKey, loadOwnKey, ownKeyClassification, ownKeyEnv} from './own-model-key.js';
/** Check supported agent access without starting a model request. Custom commands remain operator-owned. */
export async function checkAgents(profiles:Record<string,any>){
 const checked=new Set<string>();
 for(const profile of Object.values(profiles)){
  if(!['codex','claude'].includes(profile.backend)||profile.command||checked.has(profile.backend))continue;
  checked.add(profile.backend);
  if(!await agentSignedIn(profile.backend))throw Object.assign(Error(`${profile.backend} is not installed or not signed in. Sign in with ${profile.backend}, then continue this run.`),{code:'needs_input'});
 }
}

/**
 * The model profiles of a run, chosen by the runtime (resolveModels): a model that the Method names, else the user's
 * own Claude Code or Codex, else hostedModel on account credit. With this computer's own model key (method config
 * model-key), hosted profiles call OpenRouter with that key, and classify steps call Jev with it (config.classification).
 */
export async function resolveAgentProfiles(method: any, config: any, hostedModel?: string) {
  const profiles = await resolveModels(method, config, {hostedModel});
  const env = ownKeyEnv();
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
/**
 * What a run may need from the Method account: hosted models for call and agent steps that name no model (used only
 * when no local agent can run them), and classification.
 */
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
