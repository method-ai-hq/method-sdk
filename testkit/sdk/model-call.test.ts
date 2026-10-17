import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callModel, methodType, requestMethod } from '../../packages/sdk/src/model-call.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

/** Signed-in fake Claude Code and Codex on PATH; each logs its requests and answers {answer: its name}. */
function agents(signedIn: Record<string, boolean>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'method-model-'))); roots.push(root);
  vi.stubEnv('METHOD_CACHE_DIR', join(root, 'cache')); vi.stubEnv('METHOD_CONFIG_DIR', join(root, 'config'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  for (const [name, ok] of Object.entries(signedIn)) writeFileSync(join(bin, name), `#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);
if(args[0]==='auth'||args[0]==='login'){if(!${ok})process.exit(1);console.log(JSON.stringify({loggedIn:true}));process.exit(0);}
let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{
  fs.appendFileSync(${JSON.stringify(join(root, 'calls'))},'${name}\\n');
  const out={answer:'${name}',items:['a']};
  if('${name}'==='claude')console.log(JSON.stringify({type:'result',subtype:'success',structured_output:out}));else fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(out));
});`, { mode: 0o700 });
  vi.stubEnv('PATH', [bin, '/usr/bin', '/bin'].join(':'));
  vi.stubEnv('CLAUDECODE', ''); vi.stubEnv('CODEX_THREAD_ID', '');
  return () => existsSync(join(root, 'calls')) ? readFileSync(join(root, 'calls'), 'utf8').split('\n').filter(Boolean) : [];
}
const schema = { type: 'object', properties: { answer: { type: 'string', enum: ['claude', 'codex'] }, items: { type: 'array', items: { type: 'string' } } } };

it('turns a JSON schema into Method types and keeps prompt braces out of the prompt', () => {
  expect(methodType({ type: 'object', properties: { better: { type: 'string', enum: ['A', 'B'] }, votes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, pass: { type: 'boolean' } } } }, n: { type: 'integer' } } }))
    .toEqual({ type: 'record', fields: { better: { type: 'text', description: 'One of: A, B.' }, votes: { type: 'list', fields: { id: { type: 'text' }, pass: { type: 'boolean' } } }, n: { type: 'number' } } });
  const plain = requestMethod({ system: 'Answer.', user: 'u', schema });
  expect(plain.steps.answer.do).toEqual({ kind: 'call', model: 'default', prompt: 'Answer.' });
  const braces = requestMethod({ system: 'Keep {{note}} as it is.', user: 'u', schema });
  expect(braces.steps.answer.do.prompt).not.toContain('{{');
  expect(braces.inputs).toHaveProperty('instructions');
  // A step's own model name and the Method's models are kept, so a replay runs on the step's model.
  expect(requestMethod({ system: 's', user: 'u', schema, model: 'writer', models: { writer: 'openai/gpt-x' } })).toMatchObject({ models: { writer: 'openai/gpt-x' }, steps: { answer: { do: { model: 'writer' } } } });
});

it("runs every request on the one agent that the runtime chooses, the caller first, and never on hosted models while an agent is signed in", async () => {
  const calls = agents({ claude: true, codex: true });
  // Signed in to Method: the hosted model would be available, but a local agent is signed in, so it is not asked for.
  vi.stubEnv('METHOD_API_KEY', 'method_test'); vi.stubEnv('METHOD_SERVER', 'http://127.0.0.1:9');
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.stubEnv('CLAUDECODE', '1');
  for (let i = 0; i < 3; i++) expect(await callModel({ system: 'Name yourself.', user: 'Who are you?', schema })).toMatchObject({ value: { answer: 'claude', items: ['a'] }, agent: 'claude', usd: null });
  // Codex is installed and signed in, but it is not the caller: it is never started.
  expect(calls()).toEqual(['claude', 'claude', 'claude']);
  vi.stubEnv('CLAUDECODE', ''); vi.stubEnv('CODEX_THREAD_ID', 'task');
  expect(await callModel({ system: 's', user: 'u', schema })).toMatchObject({ agent: 'codex' });
  expect(stderr.mock.calls.map(c => String(c[0])).join('')).not.toMatch(/Hosted models/);
});
