import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { loadWorkflow, parseDocumentValue, serializeWorkflow } from '../../workflow-language/src/validate.js';
import { authoringPath } from './authoring.js';
import { bindConnectionValue } from './computer-settings.js';
import { newMethodId } from './versions.js';

const runLimitKeys = ['timeout_ms', 'max_model_requests', 'max_invocations', 'max_tool_calls', 'max_output_bytes', 'max_request_bytes', 'max_concurrency'];
const stepLimitKeys = ['timeout_ms', 'max_agent_turns', 'max_model_requests'];
const efforts = ['minimal', 'low', 'medium', 'high'];
const pick = (value: any, keys: string[]) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));

/** A runtime.json model profile as a format 3.4 models entry. Direct API profiles become the same model, hosted. */
function modelEntry(profile: any) {
  if (profile.backend === 'codex' || profile.backend === 'claude')
    return { agent: profile.backend, ...pick(profile, ['model', 'reasoning_effort']) };
  const provider = ({ 'openai-responses': 'openai/', 'anthropic-messages': 'anthropic/' } as Record<string, string>)[profile.backend] ?? '';
  const model = String(profile.model).includes('/') ? profile.model : `${provider}${profile.model}`;
  const effort = profile.reasoning_effort ?? profile.effort;
  const options = { ...(profile.max_output_tokens ? { max_output_tokens: profile.max_output_tokens } : {}), ...(efforts.includes(effort) ? { reasoning_effort: effort } : {}) };
  return Object.keys(options).length ? { model, ...options } : model;
}

/**
 * Convert a Method folder of an older format in place: runtime.json moves into the Method (models, limits, tools),
 * its folder paths become this computer's bindings, and FILE.method.json becomes the id: line. Both old files are
 * deleted. Returns true when it changed something. When the result does not validate, every file is left as it was.
 */
export function convertLegacy(file: string): boolean {
  const path = authoringPath(file), folder = dirname(path);
  const runtimeFile = join(folder, 'runtime.json'), sidecarFile = `${path}.method.json`;
  const hasRuntime = existsSync(runtimeFile), hasSidecar = existsSync(sidecarFile);
  if (!hasRuntime && !hasSidecar) return false;
  const original = readFileSync(path, 'utf8');
  const document = parseDocumentValue(original);
  const config = hasRuntime ? JSON.parse(readFileSync(runtimeFile, 'utf8')) : {};
  const sidecar = hasSidecar ? JSON.parse(readFileSync(sidecarFile, 'utf8')) : {};
  const { format: _format, id: oldId, ...content } = document;
  // Folder paths become bindings of this computer, which belong to a Method ID.
  const id = oldId ?? sidecar.workflow_id ?? (Object.keys(config.environment ?? {}).length ? newMethodId() : undefined);
  const models = Object.fromEntries(Object.entries(config.models ?? {}).map(([name, profile]) => [name, modelEntry(profile)]));
  const limits = { ...pick(config.limits, runLimitKeys), ...(config.step_defaults ? { step: pick(config.step_defaults, stepLimitKeys) } : {}) };
  const files = (content.files ?? []).filter((name: string) => name !== 'runtime.json');
  const next = {
    format: 'method/3.4', ...(id ? { id } : {}), ...content,
    ...(Object.keys(models).length ? { models: { ...models, ...content.models } } : {}),
    ...(Object.keys(limits).length ? { limits: { ...limits, ...content.limits, ...(limits.step || content.limits?.step ? { step: { ...limits.step, ...content.limits?.step } } : {}) } } : {}),
    ...(config.tools ? { tools: { ...config.tools, ...content.tools } } : {}),
  };
  if (files.length) next.files = files; else delete next.files;
  const { id: _id, ...checked } = next;
  loadWorkflow(checked);
  writeFileSync(path, /^\s*\{/.test(original) ? JSON.stringify(next, null, 2) + '\n' : serializeWorkflow(next), { mode: 0o600 });
  if (id) for (const [name, value] of Object.entries(config.environment ?? {}))
    bindConnectionValue(id, name, isAbsolute(String(value)) ? String(value) : resolve(folder, String(value)));
  if (hasRuntime) unlinkSync(runtimeFile);
  if (hasSidecar) unlinkSync(sidecarFile);
  return true;
}

/** Convert before a command reads the file. A folder that cannot be converted is a plain error for the agent to fix. */
export function convertLegacyOrThrow(file: string) {
  try { return convertLegacy(file); }
  catch (error) { throw Error(`${basename(authoringPath(file))} uses an older format, and its runtime.json could not be moved into it: ${(error as Error).message}`); }
}
