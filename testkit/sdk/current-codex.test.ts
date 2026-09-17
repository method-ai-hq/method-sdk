import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCurrentMethod } from '../../packages/sdk/src/current-runtime.js';
import { startMethodTools } from '@withmethod/runtime/codex.js';
import { validateConfig } from '@withmethod/runtime/validate.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture(body: string, timeout = 10000) {
  const root = mkdtempSync(join(tmpdir(), 'method-codex-')); roots.push(root);
  const command = join(root, 'codex');
  writeFileSync(command, '#!/usr/bin/env node\n' + body); chmodSync(command, 0o700);
  const method = { format: 'method/3', name: 'Test', goal: 'Test Codex execution',
    steps: { write: { purpose: 'Call echo and save its answer.', do: { kind: 'agent', model: 'writer', prompt: 'Call echo.', tools: ['echo'] },
      out: { text: { type: 'text', description: 'Answer' } }, limits: { timeout_ms: timeout, max_agent_turns: 5, max_model_requests: 5 } } }, result: 'text' };
  writeFileSync(join(root, 'method.json'), JSON.stringify(method));
  writeFileSync(join(root, 'echo.mjs'), "let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify({text:JSON.parse(s).text}));");
  const config = { allow_local_processes: true, models: { writer: { backend: 'codex', command } },
    runtimes: { node: { command: process.execPath, version: 'test' } },
    tools: { echo: { description: 'Echo text', in: { text: { type: 'text', description: 'Text' } }, out: { text: { type: 'text', description: 'Text' } },
      run: { kind: 'run', runtime: 'node', entrypoint: 'echo.mjs' }, effects: [] } },
    limits: { timeout_ms: timeout, max_invocations: 10, max_model_requests: 5, max_tool_calls: 5, max_request_bytes: 1000000, max_output_bytes: 1000000 } };
  return { root, method, config, run: () => runCurrentMethod(join(root, 'method.json'), config, { runDir: join(root, 'run') }) };
}
const client = `
const fs=require('node:fs');const args=process.argv.slice(2);
if(args[0]!=='exec'||args.includes('--ignore-user-config')||args.includes('--model'))process.exit(8);
const url=JSON.parse(args.find(a=>a.startsWith('mcp_servers.method_step.url=')).split('=').slice(1).join('='));
const rpc=async(method,params={})=>(await fetch(url,{method:'POST',headers:{authorization:'Bearer '+process.env.METHOD_CODEX_TOOL_TOKEN},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json();
`;
it('uses a Codex process with declared tools and checks its returned output', async () => {
  const f = fixture(client + `(async()=>{
    const init=await rpc('initialize');if(!init.result.capabilities.tools)process.exit(9);
    const tools=await rpc('tools/list');if(tools.result.tools[0].name!=='echo')process.exit(10);
    const value=await rpc('tools/call',{name:'echo',arguments:{text:'hello'}});
    fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(value.result.structuredContent));
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
  })();`);
  const result = await f.run();
  expect(result.status).toBe('completed');
  const events = readFileSync(join(f.root, 'run/events.jsonl'), 'utf8');
  expect(events).toContain('tool.completed'); expect(events).toContain('codex.completed');
  expect(events).not.toContain('model.request');
  expect(result.codex).toMatchObject({processes:1,input_tokens:10,output_tokens:2});
});
it('fails on invalid Codex output and preserves the process logs', async () => {
  const f=fixture(client+`fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({wrong:1}));console.error('diagnostic');`);
  expect((await f.run()).status).toBe('failed');
  expect(readFileSync(join(f.root,'run/events.jsonl'),'utf8')).toContain('codex.failed');
});
it('stops a Codex process when its step times out', async () => {
  const f=fixture('setInterval(()=>{},1000);', 150);
  const start=Date.now(); expect((await f.run()).status).toBe('failed');
  expect(Date.now()-start).toBeLessThan(4000);
});
it('requires local process permission for Codex and accepts the explicit API alternative', async () => {
  const f=fixture(''); f.config.allow_local_processes=false;
  await expect(f.run()).rejects.toThrow('Codex requires allow_local_processes');
  expect(()=>validateConfig({ ...f.config, models: { writer: { backend:'openai-responses', model:'example', api_key_env:'TEST_KEY', max_output_tokens:100 } } })).not.toThrow();
});
it('rejects unauthenticated and undeclared tool calls', async () => {
  let calls=0;
  const bridge=await startMethodTools({kind:'agent',tools:['echo']}, {maxRequestBytes:1000, invokeTool:async()=>{calls++;return{};}});
  try {
    expect((await fetch(bridge.url,{method:'POST'})).status).toBe(401);
    const response=await fetch(bridge.url,{method:'POST',headers:{authorization:`Bearer ${bridge.token}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'other'}})});
    expect((await response.json() as any).error.message).toContain('Tool is not allowed'); expect(calls).toBe(0);
  } finally { await bridge.close(); }
});

it('reports the Codex failure message and does not accept an output from a failed process', async () => {
  const f=fixture(`console.log(JSON.stringify({type:'turn.failed',error:{message:'Sign in to Codex'}}));process.exit(1);`);
  const result=await f.run();
  expect(result.status).toBe('failed');
  expect(JSON.stringify(result)).toContain('Sign in to Codex');
});

it('defaults an unconfigured writer to the Codex CLI on PATH', async () => {
  const f=fixture(client+`fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({text:'default'}));`);
  (f.config as any).models = {};
  vi.stubEnv('PATH', f.root + ':' + process.env.PATH);
  expect((await f.run()).status).toBe('completed');
});
it('keeps explicit Responses profiles on the API path', async () => {
  const f=fixture('process.exit(99);');
  (f.config as any).models={writer:{backend:'openai-responses',model:'test',api_key_env:'METHOD_TEST_NO_KEY',max_output_tokens:100}};
  const result=await runCurrentMethod(join(f.root,'method.json'), f.config, {runDir:join(f.root,'run'),transport:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({text:'api'})}]}]})});
  expect(result.status).toBe('completed');
  expect(readFileSync(join(f.root,'run/events.jsonl'),'utf8')).toContain('model.request');
  expect(readFileSync(join(f.root,'run/events.jsonl'),'utf8')).not.toContain('codex.started');
});

it('saves public Codex progress while the process is still running', async () => {
  const f=fixture(client+`(async()=>{
    console.log(JSON.stringify({type:'item.completed',item:{type:'reasoning',text:'private reasoning'}}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Reading the supplied records.'}}));
    const deadline=Date.now()+3000;
    while(!fs.existsSync(process.env.METHOD_OUTPUT_DIR+'/seen-progress')) { if(Date.now()>deadline)process.exit(11); await new Promise(r=>setTimeout(r,10)); }
    fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({text:'done'}));
  })();`);
  const result=await runCurrentMethod(join(f.root,'method.json'),f.config,{runDir:join(f.root,'run'),onEvent: async (event:any)=>{
    if(event.event==='progress') {
      const trace=readFileSync(join(f.root,'run/events.jsonl'),'utf8');
      expect(trace).toContain('Reading the supplied records.');
      expect(trace).not.toContain('codex.completed');
      expect(trace).not.toContain('private reasoning');
      writeFileSync(join(f.root,'run/artifacts/seen-progress'),'yes');
    }
  }});
  expect(result.status).toBe('completed');
});
