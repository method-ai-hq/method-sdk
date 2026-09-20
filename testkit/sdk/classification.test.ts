import {afterEach, expect, it, vi} from 'vitest';
import {mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MethodClient} from '../../packages/sdk/src/method-client.js';
import {managedClassification} from '../../packages/sdk/src/classification-client.js';
import {runCurrentFile} from '../../packages/sdk/src/current-runtime.js';
import {inspectCurrentRun} from '../../packages/sdk/src/current-inspection.js';
import {localAuthoring} from '../../packages/sdk/src/authoring.js';
import {MethodSync} from '../../packages/sdk/src/method-sync.js';
import {writePrivateJson} from '../../packages/sdk/src/files.js';
import {effectiveOutputs} from '../../packages/workflow-language/src/schema.js';
import {referenceShape, loadWorkflow} from '../../packages/workflow-language/src/validate.js';

const roots: string[] = [];
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const definition = {format: 'method/3.2', name: 'Route message', goal: 'Choose the right team.',
  inputs: {message: {type: 'text', default: 'Please send an invoice.'}}, steps: {
    classify: {name: 'Classify message', in: {message: 'inputs.message'}, do: {kind: 'classify', question: 'Which team?', options: {billing: 'Invoices', other: 'Anything else'}}, out: 'category'},
    confirm: {after: 'classify', ask: 'Continue?', out: {answer: {type: 'text'}}},
  }, result: 'category'};
const answer = {provider: 'typesafe', model: 'jev-test', choice: 'billing', probabilities: {billing: .6, other: .4}, confidence: .03, usage: null};
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'method-classification-'))); roots.push(root);
  vi.stubEnv('PATH', root); vi.stubEnv('METHOD_CACHE_DIR', join(root,'cache')); vi.stubEnv('CODEX_THREAD_ID', 'test');
  const file = join(root,'task.method'), runDir = join(root,'run'); writeFileSync(file,JSON.stringify(definition));
  const fetcher = vi.fn(async (url: any, init: any) => {
    expect(init.headers.authorization).toMatch(/^Bearer method_/);
    if (String(url).endsWith('/classifications/model')) return Response.json({provider:'typesafe',model:'jev-test'});
    if (String(url).endsWith('/classifications')) return Response.json(answer);
    if (String(url).includes('/api/cli/runs/')) return Response.json({id:'saved-run'});
    throw Error(`Unexpected request: ${url}`);
  });
  const client = new MethodClient('https://method.example', fetcher as typeof fetch, join(root,'credentials'));
  writePrivateJson(client.credentialFile, {server:client.server,token:'method_'+'a'.repeat(43)});
  vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
  return {root,file,runDir,fetcher,client};
}
it('runs without an installed agent, saves the model once, and reuses accepted classification on resume', async () => {
  const f = fixture();
  expect(await runCurrentFile(f.file,{'run-dir':f.runDir},undefined,undefined,f.client)).toMatchObject({status:'needs_input'});
  const config = readFileSync(join(f.runDir,'runtime.resolved.json'),'utf8');
  expect(JSON.parse(config)).toMatchObject({models:{},classification:{provider:'typesafe',model:'jev-test'}});
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  const inspection = inspectCurrentRun(f.runDir);
  expect(inspection.started_at).toBeTruthy(); expect(inspection.device_name).toBeTruthy();
  expect(inspection.invocations['classify:0']).toMatchObject({status:'passed',verification:'unchecked',outputs:{category:{choice:'billing',probabilities:answer.probabilities}}});
  expect(inspection.invocations['classify:0']?.events.find(e=>e.type==='model_response')).toMatchObject({kind:'classify',model:'jev-test',confidence:.03,usage:null});
  const human = join(f.root,'human.json'); writeFileSync(human,JSON.stringify({steps:{'confirm:0':{outputs:{answer:'yes'}}}}));
  expect(await runCurrentFile(f.file,{'run-dir':f.runDir,resume:true,human},undefined,undefined,f.client)).toMatchObject({status:'completed',result:{choice:'billing'}});
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(readFileSync(join(f.runDir,'runtime.resolved.json'),'utf8')).toBe(config);
  const completed = inspectCurrentRun(f.runDir); expect(completed.started_at).toBe(inspection.started_at);
  const sync = new MethodSync(f.client,f.runDir,'method-one','version-one');
  await sync.start(completed.workflow,completed.inputs,{}); await sync.finish();
  const inference = f.fetcher.mock.calls.filter(([url])=>String(url).endsWith('/classifications'));
  expect(inference).toHaveLength(1);
  const upload = f.fetcher.mock.calls.filter(([url])=>String(url).includes('/api/cli/runs/')).at(-1)!;
  expect(JSON.parse(upload[1].body).inspection.started_at).toBe(completed.started_at);
});
it('validates offline and resolves downstream classifier references from the shared output shape', async () => {
  const f=fixture(); const fetch = vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No network allowed'));
  expect(await localAuthoring(['validate', f.file])).toBe(true); expect(fetch).not.toHaveBeenCalled();
  expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('needs_preparation'));
  const method=loadWorkflow(definition);
  expect(effectiveOutputs(method.steps.classify!)).toHaveProperty('category');
  expect(referenceShape(method,'category.probabilities.billing')).toEqual('number');
});
it('rejects malformed provider data and returns a saved-version error without retry', async () => {
  const f=fixture(); const provider=managedClassification(f.client), signal=new AbortController().signal;
  const request={request_id:crypto.randomUUID(),model:'jev-test',question:'Which?',options:{billing:'Invoices',other:'Else'},inputs:{message:'Invoice'}};
  f.fetcher.mockResolvedValueOnce(Response.json({...answer,model:'changed'}));
  await expect(provider.evaluate(request,signal)).rejects.toThrow('model does not match');
  f.fetcher.mockResolvedValueOnce(Response.json({code:'classification_version_unavailable',message:'Unavailable'},{status:409}));
  await expect(provider.evaluate(request,signal)).rejects.toThrow("This run's classifier version is unavailable. Start a new run to use the current default.");
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it('bounds the response stream and forwards cancellation to the authenticated request', async () => {
  const f=fixture(); const provider=managedClassification(f.client), controller=new AbortController();
  f.fetcher.mockResolvedValueOnce(new Response('x'.repeat(65_537)));
  await expect(provider.resolve(controller.signal)).rejects.toThrow('size limit');
  const signal=f.fetcher.mock.calls[0]![1].signal;
  controller.abort(); expect(signal.aborted).toBe(true);
});
