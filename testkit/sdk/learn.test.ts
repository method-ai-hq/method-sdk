import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { learnCommand } from '../../packages/sdk/src/quality.js';
import { runCurrentFile } from '../../packages/sdk/src/current-runtime.js';
import { runMethod, testSuite } from '@withmethod/runtime';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

// A fake Codex answers each learn agent by its prompt. The repair edits the workspace copy like a coding agent would.
const fakeCodex = (repair: string) => `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);
if(args[0]==='login')process.exit(0);
let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{
  const out=args[args.indexOf('--output-last-message')+1];
  const write=v=>{fs.writeFileSync(out,JSON.stringify(v));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));};
  if(prompt.includes('Find the cause in the recorded run'))return write({locate:{result:'wrong_step',step:'report',explanation:'The report step leaves out the currency.',evidence:[{step:'report',iteration:0,output:'report',quoted:'Paid 10'}]}});
  if(prompt.includes('Write one test case'))return write({draft:{id:'currency-named',text:'The report names the currency.',expect_json:JSON.stringify([{kind:'equals',ref:'outputs.report',value:'Paid 10 EUR',text:'The report names the currency.'}]),predicate_source:'',examples:'This run: Paid 10 now; Paid 10 EUR required.'}});
  if(prompt.includes('Repair a Method')){
    const [,workspace,file]=/Edit only files in (\\S+)\\. The Method file is (\\S+)\\./.exec(prompt);
    ${repair}
    return write({repair:{result:'repaired',summary:'The report step now receives the currency and names it.',conflicting_cases:[]}});
  }
  process.exit(7);
});`;
const fixRule = `const doc=JSON.parse(fs.readFileSync(file,'utf8'));doc.steps.report.in.currency='inputs.currency';fs.writeFileSync(file,JSON.stringify(doc,null,2));
    fs.writeFileSync(path.join(workspace,'report.mjs'),'let s="";for await(const c of process.stdin)s+=c;const a=JSON.parse(s);console.log(JSON.stringify({report:"Paid "+a.amounts.reduce((x,y)=>x+y,0)+" "+a.currency}))');`;
const dropTotal = `fs.writeFileSync(path.join(workspace,'report.mjs'),'console.log(JSON.stringify({report:"Paid in EUR"}))');`;

async function setup(repair: string) {
  const root = mkdtempSync(join(tmpdir(), 'method-learn-')); roots.push(root);
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), fakeCodex(repair)); chmodSync(join(bin, 'codex'), 0o700);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  vi.stubEnv('METHOD_CACHE_DIR', join(root, 'cache'));
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const folder = join(root, 'invoices'); mkdirSync(folder);
  const file = join(folder, 'report.method');
  writeFileSync(file, JSON.stringify({ format: 'method/3.3', name: 'Report', goal: 'Report the total paid.',
    inputs: { amounts: { type: 'list', items: 'number' }, currency: { type: 'text' } },
    steps: { report: { name: 'Report', purpose: 'Write the total paid.', in: { amounts: 'inputs.amounts' }, do: { kind: 'run', runtime: 'node', entrypoint: 'report.mjs' }, out: { report: { type: 'text', description: 'The report.' } }, changes: [] } },
    result: 'report' }, null, 2));
  writeFileSync(join(folder, 'report.mjs'), 'let s="";for await(const c of process.stdin)s+=c;const a=JSON.parse(s);console.log(JSON.stringify({report:"Paid "+a.amounts.reduce((x,y)=>x+y,0)}))');
  const config = { allow_local_processes: true, runtimes: { node: { command: process.execPath, version: process.version } } };
  const source = join(root, 'runs/morning');
  expect((await runMethod(file, config, { runDir: source, inputs: { amounts: [4, 6], currency: 'EUR' } })).result).toBe('Paid 10');
  const run = (file: string, flags: any) => runCurrentFile(file, flags);
  const learnDir = join(root, 'learn-run');
  const answer = async (step: string, outputs: any) => {
    const human = join(root, `${step}.json`);
    writeFileSync(human, JSON.stringify({ steps: { [`${step}:0`]: { outputs } } }));
    return learnCommand(['--resume', '--run-dir', learnDir, '--human', human, '--agent', 'codex'], run);
  };
  const start = () => learnCommand([file, '--run', source, '--note', 'The report must name the currency.', '--run-dir', learnDir, '--agent', 'codex', '--no-git'], run);
  return { root, folder, file, config, learnDir, start, answer };
}

it('learns from a correction: approved cause, case, and change, with a gate in between', async () => {
  const f = await setup(fixRule);
  let result = await f.start();
  expect(result.status, JSON.stringify(result)).toBe('needs_input');
  const asked = readFileSync(join(f.learnDir, 'events.jsonl'), 'utf8');
  expect(asked).toContain('Evidence check: every cited value is in the recorded run.');
  result = await f.answer('confirm', { decision: { proceed: true, correction: '' } });
  expect(result.status).toBe('needs_input');
  result = await f.answer('label', { labels: { approved: true, comment: '' } });
  expect(result.status).toBe('needs_input');
  const events = readFileSync(join(f.learnDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const gate = events.find(e => e.event === 'check.completed' && e.step === 'repair');
  expect(gate.check).toMatchObject({ status: 'pass' });
  expect(gate.check.reason).toContain('Case currency-named is fixed');
  const review = events.find(e => e.event === 'step.accepted' && e.step === 'review').outputs.review;
  expect(review).toMatch(/\+\s+"currency": "inputs.currency"/);
  expect(review).toContain('report: Paid 10 → Paid 10 EUR');
  // Nothing changed in the Method folder before the last approval.
  expect(readFileSync(join(f.folder, 'report.mjs'), 'utf8')).not.toContain('currency');
  result = await f.answer('approve', { approval: { approved: true, comment: '' } });
  expect(result.status).toBe('completed');
  expect(result.result.status).toBe('learned');
  expect(result.effects).toMatchObject({ confirmed: 1, contradicted: 0 });
  expect(readFileSync(join(f.folder, 'report.mjs'), 'utf8')).toContain('a.currency');
  const record = JSON.parse(readFileSync(join(f.folder, 'cases/currency-named/learn.json'), 'utf8'));
  expect(record).toMatchObject({ note: 'The report must name the currency.', files: ['report.method', 'report.mjs'] });
  const suite = await testSuite(f.file, f.config);
  expect(suite).toMatchObject({ passed: true, counts: { pass: 1 } });
}, 60_000);

it('stops when the repair fails the gate, and leaves the Method unchanged', async () => {
  const f = await setup(dropTotal);
  await f.start();
  await f.answer('confirm', { decision: { proceed: true, correction: '' } });
  const result = await f.answer('label', { labels: { approved: true, comment: '' } });
  expect(result.status).toBe('failed');
  expect(result.code).toBe('check_failed');
  const report = JSON.parse(readFileSync(join(f.learnDir, 'artifacts/gate-report.json'), 'utf8'));
  expect(report.reason).toContain('currency-named not_fixed');
  expect(readFileSync(join(f.folder, 'report.mjs'), 'utf8')).toContain('reduce');
  expect(existsSync(join(f.folder, 'cases'))).toBe(false);
}, 60_000);

it('stops without a change when the person rejects the cause', async () => {
  const f = await setup(fixRule);
  await f.start();
  const result = await f.answer('confirm', { decision: { proceed: false, correction: 'The currency is in the header.' } });
  expect(result.status).toBe('completed');
  expect(result.result).toEqual({ status: 'stopped', message: 'The person did not confirm the cause. The currency is in the header.' });
  expect(existsSync(join(f.folder, 'cases'))).toBe(false);
}, 60_000);
