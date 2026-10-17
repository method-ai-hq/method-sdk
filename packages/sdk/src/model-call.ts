import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { methodCache } from './prepare.js';

/**
 * One model request that follows the same model rule as a run (the runtime's resolveModels): the model that the
 * request names in `models`, else the user's own signed-in Claude Code or Codex (the calling agent first), else a
 * hosted model on account credit. Each request is a fresh session.
 */
export type ModelRequest = {
  system: string; user: string; schema: JsonSchema;
  /** A model name of `models`, or default. */
  model?: string; models?: Record<string, unknown>;
};
export type ModelAnswer = { value: any; agent: string; usd: number | null; duration_ms: number };
type JsonSchema = { type?: string; properties?: Record<string, JsonSchema>; items?: JsonSchema; enum?: string[]; description?: string };

/** A Method type for a JSON schema: object → record, array → list, string → text. */
export function methodType(schema: JsonSchema): any {
  const described = (value: any) => schema.description || schema.enum ? { ...value, description: [schema.description, schema.enum ? `One of: ${schema.enum.join(', ')}.` : ''].filter(Boolean).join(' ') } : value;
  if (schema.type === 'object') return described({ type: 'record', fields: fieldsOf(schema) });
  if (schema.type === 'array') return described(schema.items?.type === 'object' ? { type: 'list', fields: fieldsOf(schema.items) } : { type: 'list', items: methodType(schema.items ?? { type: 'string' }) });
  if (schema.type === 'number' || schema.type === 'integer') return described({ type: 'number' });
  if (schema.type === 'boolean') return described({ type: 'boolean' });
  return described({ type: 'text' });
}
const fieldsOf = (schema: JsonSchema) => Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, value]) => [name, methodType(value)]));

/** The one-step Method of a request. Instructions with prompt braces go in the inputs, so nothing in them is read as a variable. */
export function requestMethod(request: ModelRequest) {
  if (request.schema.type !== 'object') throw Error('A model request asks for a JSON object.');
  const braces = /\{\{|\}\}/.test(request.system);
  const model = request.model ?? 'default';
  const fields = fieldsOf(request.schema);
  return {
    format: 'method/3.4', name: 'Model request', goal: 'Answer one request.',
    ...(request.models ? { models: request.models } : {}),
    inputs: { request: { type: 'text', description: 'The request.' }, ...(braces ? { instructions: { type: 'text', description: 'The instructions.' } } : {}) },
    steps: { answer: { name: 'Answer', in: { request: 'inputs.request', ...(braces ? { instructions: 'inputs.instructions' } : {}) },
      do: { kind: 'call', model, prompt: braces ? 'Follow the instructions in the step inputs, then answer the request.' : request.system }, out: fields } },
    result: Object.fromEntries(Object.keys(fields).map(name => [name, name])),
  };
}

/** Run one model request through the runtime, with the preparation of method run. */
export async function callModel(request: ModelRequest): Promise<ModelAnswer> {
  const dir = join(methodCache(), 'model-requests', randomUUID());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const file = join(dir, 'request.method');
    writeFileSync(file, JSON.stringify(requestMethod(request)), { mode: 0o600 });
    const { preparedConfig } = await import('./quality.js');
    const { runMethod } = await import('@withmethod/runtime/runner.js');
    const prepared = await preparedConfig(file, {});
    const started = performance.now();
    const result: any = await runMethod(file, prepared.config, { runDir: join(dir, 'run'), inputs: { request: request.user, ...(/\{\{|\}\}/.test(request.system) ? { instructions: request.system } : {}) },
      processPath: prepared.processPath, prepareBundle: prepared.prepareBundle, ...(prepared.hostedModels ? { hostedModels: prepared.hostedModels } : {}) });
    if (result.status !== 'completed') throw Object.assign(Error(result.failure?.headline ?? `The model request ended with status ${result.status}.`), { code: result.failure?.code ?? 'model_failed', owner: result.failure?.owner });
    const profile = prepared.config.models?.[request.model ?? 'default'];
    const hosted = profile?.backend === 'method';
    return { value: result.result, agent: hosted ? `hosted:${profile.model}` : profile?.backend ?? 'unknown', usd: hosted && typeof result.usage?.cost_usd === 'number' ? result.usage.cost_usd : null,
      duration_ms: Math.round(performance.now() - started) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * `method __model`: one model request from a script of a Method (improve.method), as JSON on stdin; the answer as
 * JSON on stdout. A failure prints {error, code, owner} and exits 1.
 */
export async function modelCallCommand() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  try { process.stdout.write(JSON.stringify(await callModel(JSON.parse(Buffer.concat(chunks).toString('utf8')))) + '\n'); }
  catch (error: any) { process.stdout.write(JSON.stringify({ error: error.message, code: error.code ?? 'model_failed', owner: error.owner ?? null }) + '\n'); process.exitCode = 1; }
}
