import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPrompt, parsePrompt } from '@withmethod/runtime/prompt.js';
import { validateMethod } from '@withmethod/runtime/validate.js';
import { loadWorkflow } from '../../packages/workflow-language/src/validate.js';
import { runCurrentMethod } from '../../packages/sdk/src/current-runtime.js';
import { inspectRun } from '../../packages/sdk/src/inspect.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const text = { type: 'text', description: 'Text' };
function fixture(format = 'method/3.1') {
  const root = mkdtempSync(join(tmpdir(), 'method-prompt-')); roots.push(root);
  const method: any = { format, name: 'Prompt variables', goal: 'Use declared prompt variables',
    inputs: { date: { ...text, default: '2026-05-11' } },
    steps: { write: { purpose: 'Write the date', in: { date: 'inputs.date' },
      do: { kind: 'call', model: 'writer', prompt: 'Date: {{ date }}' },
      out: { answer: text }, limits: { timeout_ms: 10000, max_model_requests: 3, max_agent_turns: 3 } } }, result: 'answer' };
  const config: any = { allow_local_processes: true,
    models: { writer: { backend: 'openai-responses', model: 'test', api_key_env: 'METHOD_PROMPT_TEST', max_output_tokens: 100 } },
    limits: { timeout_ms: 20000, max_invocations: 10, max_model_requests: 10, max_tool_calls: 0, max_request_bytes: 1000000, max_output_bytes: 1000000 } };
  const file = join(root, 'test.method');
  const run = (options: any = {}) => { writeFileSync(file, JSON.stringify(method)); return runCurrentMethod(file, config, { runDir: join(root, 'run'), ...options }); };
  const events = () => readFileSync(join(root, 'run/events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { root, file, method, config, run, events };
}
const response = (value: unknown) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
it('inserts scalar values once and preserves literal braces and ordinary JSON', () => {
  expect(renderPrompt(String.raw`{{name}} / {{count}} / {{ok}} / {{customer.name}} / \{{literal}} / {"a":1}`,
    { name: '{{other}}', count: 0, ok: false, customer: { name: 'A "quoted" name' } }))
    .toBe('{{other}} / 0 / false / A "quoted" name / {{literal}} / {"a":1}');
  expect(renderPrompt('{{name}}', { name: '' })).toBe('');
});
it.each(['{{}}', '{{name', '{{a + b}}', '{{name|upper}}', '{{constructor}}', '{{a.__proto__}}', 'bad }}'])('rejects malformed placeholders: %s', template => {
  expect(() => parsePrompt(template)).toThrow();
});
it('validates declarations and scalar fields in both runtime and server language paths', () => {
  const f = fixture(); f.method.steps.write.do.prompt = '{{missing}}';
  for (const validate of [validateMethod, loadWorkflow]) expect(() => validate(f.method)).toThrow(/write.do.prompt.*Unknown prompt variable/);
  f.method.inputs.customer = { type: 'record', description: 'Customer', fields: { name: text } };
  f.method.steps.write.in.customer = 'inputs.customer';
  f.method.steps.write.do.prompt = '{{customer}}';
  expect(() => validateMethod(f.method)).toThrow('is a record');
  f.method.steps.write.do.prompt = '{{customer.name}}'; expect(() => validateMethod(f.method)).not.toThrow();
});
it('rejects missing runtime values, null, and structured values', () => {
  for (const data of [{}, { x: null }, { x: [] }, { x: {} }, { x: Infinity }]) expect(() => renderPrompt('{{x}}', data)).toThrow();
});
it('expands API action and check prompts and exports their recorded values', async () => {
  const f = fixture();
  f.method.steps.write.check = { kind: 'agent', model: 'writer', tools: [], prompt: 'Check {{outputs.answer}} for {{inputs.date}}.' };
  const prompts: string[] = [];
  const result = await f.run({ transport: async (body: any) => {
    prompts.push(body.instructions); return response(prompts.length === 1 ? { answer: '2026-05-11' } : { status: 'pass', reason: 'Same date', evidence: [] });
  } });
  expect(result.status).toBe('completed'); expect(prompts).toEqual(['Date: 2026-05-11', 'Check 2026-05-11 for 2026-05-11.']);
  const recorded = inspectRun(join(f.root, 'run')).invocations['write:0']!.prompts!;
  expect(recorded.map(p => p.rendered)).toEqual(prompts); expect(recorded.map(p => p.phase)).toEqual(['action', 'check']);
});
it('sends the same expanded instructions to Codex', async () => {
  const f = fixture(); const command = join(f.root, 'codex');
  writeFileSync(command, `#!/usr/bin/env node\nconst fs=require('fs');const p=fs.readFileSync(0,'utf8');if(!p.startsWith('Date: 2026-05-11\\n'))process.exit(9);const a=process.argv;fs.writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({answer:'2026-05-11'}));\n`); chmodSync(command, 0o700);
  f.config.models.writer = { backend: 'codex', command };
  expect((await f.run()).status).toBe('completed');
  expect(f.events().find(e => e.event === 'prompt.rendered').rendered).toBe('Date: 2026-05-11');
  expect(f.events().find(e => e.event === 'codex.started').prompt).toMatch(/^Date: 2026-05-11\n/);
});

it('enforces request size after substitution before starting the model', async () => {
  const f = fixture(); f.method.steps.write.do.prompt = '{{date}}'.repeat(1000); f.config.limits.max_request_bytes = 5000;
  let called = false;
  const result = await f.run({ transport: async () => { called = true; return response({ answer: '' }); } });
  expect(result.status).toBe('failed'); expect(result.error).toContain('Expanded prompt'); expect(called).toBe(false);
});
it('records each iteration and does not replace prior prompts on resume', async () => {
  const f = fixture(); f.method.inputs.dates = { type: 'list', description: 'Dates', items: 'text', default: ['Monday', 'Tuesday'] };
  delete f.method.steps.write.in; f.method.steps.write.each = { date: 'inputs.dates' };
  const prompts: string[] = []; let failed = false;
  const transport = async (body: any) => { prompts.push(body.instructions); if (body.instructions.includes('Tuesday') && !failed) { failed = true; throw Error('Temporary failure'); } return response({ answer: body.instructions }); };
  expect((await f.run({ transport })).status).toBe('failed');
  expect((await f.run({ transport, resume: true, retry: ['write:1'] })).status).toBe('completed');
  expect(prompts).toEqual(['Date: Monday', 'Date: Tuesday', 'Date: Tuesday']);
  expect(f.events().filter(e => e.event === 'prompt.rendered').map(e => e.rendered)).toEqual(prompts);
});
it('expands human questions', async () => {
  const f = fixture(); delete f.method.steps.write.do; f.method.steps.write.ask = 'Confirm {{date}}';
  await f.run(); expect(f.events().find(e => e.event === 'human.required').prompt).toBe('Confirm 2026-05-11');
});
