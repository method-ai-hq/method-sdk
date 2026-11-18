import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { methodMain } from '../../packages/sdk/src/method.js';
import { childrenOf, materialize, writeChildId, mergePatch, provenanceLine, resolveArgs, resolveMethod, resolvedSource } from '../../packages/sdk/src/extends.js';
import { buildPackage } from '../../packages/sdk/src/method-files.js';
import { loadWorkflow } from '../../packages/workflow-language/src/validate.js';
import { methodContent } from '../../packages/sdk/src/versions.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function folder() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'method-extends-'))); roots.push(root);
  vi.stubEnv('METHOD_CACHE_DIR', join(root, 'cache')); vi.stubEnv('METHOD_CONFIG_DIR', join(root, 'config')); vi.stubEnv('METHOD_NO_EXPLAIN', '1');
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const write = (name: string, text: string) => { const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); return path; };
  return { root, write };
}
function output() {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return { json: () => JSON.parse(stdout.mock.calls.map(c => String(c[0])).join('')), text: () => stdout.mock.calls.map(c => String(c[0])).join(''), stderr: () => stderr.mock.calls.map(c => String(c[0])).join(''), clear: () => { stdout.mockClear(); stderr.mockClear(); } };
}

// A script step reads its inputs as JSON on stdin and prints its outputs as JSON.
const echo = (field: string, expression: string) => `let t="";process.stdin.on("data",x=>t+=x);process.stdin.on("end",()=>{const i=JSON.parse(t);console.log(JSON.stringify({${field}:${expression}}))});\n`;
const parent = `format: method/3.4
abstract: true
name: Invoice coding
goal: Code an invoice amount to a GL account.
params:
  client_name:
    type: text
    description: The client's name.
  late_fee_gl:
    type: text
    description: GL account for late fees.
    default: "7190"
  extra_files:
    type: list
    description: Data files of the client.
    default: []
inputs:
  amount:
    type: number
    description: The invoice amount.
files: "{{params.extra_files}}"
steps:
  code:
    name: Code
    purpose: "Pick the GL account for {{params.client_name}}; changes nothing."
    in:
      amount: inputs.amount
    do:
      kind: run
      runtime: node
      entrypoint: code.cjs
      args: ["{{params.late_fee_gl}}"]
    out:
      gl:
        type: text
        description: The GL account and the amount.
  label:
    name: Label
    purpose: Label the coded line; changes nothing.
    in:
      gl: gl
    do:
      kind: run
      runtime: node
      entrypoint: label.cjs
    out:
      line:
        type: text
        description: The labeled line.
result: line
`;
function family() {
  const f = folder();
  f.write('parent/coding.method', parent);
  f.write('parent/code.cjs', echo('gl', '`${process.argv[2]}:${i.amount}`'));
  f.write('parent/label.cjs', echo('line', '`parent ${i.gl}`'));
  return f;
}
const child = (body: string) => `extends: ../../parent/coding.method\nname: Invoice coding for Acme\nparams:\n  client_name: Acme\n${body}`;

describe('resolution', () => {
  it('fills params in text, in whole values and from defaults, and takes the child identity', () => {
    const f = family();
    const file = f.write('clients/acme/acme.method', child('id: wf_0123456789abcdef0123456789abcdef\n'));
    const resolved = resolveMethod(file);
    expect(resolved.abstract).toBe(false);
    expect(resolved.params).toEqual({ client_name: 'Acme', late_fee_gl: '7190', extra_files: [] });
    expect(resolved.document).toMatchObject({ format: 'method/3.4', id: 'wf_0123456789abcdef0123456789abcdef', name: 'Invoice coding for Acme', goal: 'Code an invoice amount to a GL account.', files: [] });
    expect(resolved.document.steps.code.purpose).toBe('Pick the GL account for Acme; changes nothing.');
    expect(resolved.document.steps.code.do.args).toEqual(['7190']);
    for (const key of ['extends', 'params', 'abstract']) expect(resolved.document).not.toHaveProperty(key);
    expect(() => loadWorkflow(methodContent(resolved.document))).not.toThrow();
    expect(resolved.chain.map(l => l.file)).toEqual([file, join(f.root, 'parent/coding.method')]);
  });

  it('reads a text param from a file beside the file that gives it', () => {
    const f = family();
    f.write('clients/acme/rules.md', 'Freight goes with the parts.\n');
    const file = f.write('clients/acme/acme.method', `extends: ../../parent/coding.method\nparams:\n  client_name: {file: rules.md}\n`);
    expect(resolveMethod(file).document.steps.code.purpose).toBe('Pick the GL account for Freight goes with the parts.\n; changes nothing.');
  });

  it('patches a step, replaces a step, adds steps in place and removes a step', () => {
    const f = family();
    f.write('parent/coding.method', parent.replace('result: line', `  review:
    name: Review
    in: {line: line}
    do: {kind: call, model: default, prompt: "Review {{params.client_name}}'s line."}
    out:
      note: {type: text, description: A note.}
result: line`));
    const file = f.write('clients/acme/acme.method', child(`remove_steps: [label]
result: gl
steps:
  review:
    prompt: Check the line for {{params.client_name}}.
    in: {line: gl}
  code:
    purpose: Acme's own coding; changes nothing.
  first:
    insert_before: code
    name: First
    purpose: Start; changes nothing.
    do: {kind: run, runtime: node, entrypoint: first.cjs}
    out:
      started: {type: text, description: Started.}
  after_code:
    insert_after: code
    replace: false
    name: After code
    purpose: After; changes nothing.
    in: {gl: gl}
    do: {kind: run, runtime: node, entrypoint: after.cjs}
    out:
      after: {type: text, description: After.}
`));
    const document = resolveMethod(file).document;
    expect(Object.keys(document.steps)).toEqual(['first', 'code', 'after_code', 'review']);
    expect(document.steps.review.do).toEqual({ kind: 'call', model: 'default', prompt: 'Check the line for Acme.' });
    expect(document.steps.review.in).toEqual({ line: 'gl' });
    expect(document.steps.code.purpose).toBe("Acme's own coding; changes nothing.");
    expect(document.steps.code.do.entrypoint).toBe('code.cjs');
    const replaced = f.write('clients/acme/replace.method', child(`steps:\n  label:\n    replace: true\n    name: Plain\n    purpose: Plain; changes nothing.\n    in: {gl: gl}\n    do: {kind: run, runtime: node, entrypoint: plain.cjs}\n    out:\n      line: {type: text, description: Plain.}\n`));
    expect(resolveMethod(replaced).document.steps.label).toEqual({ name: 'Plain', purpose: 'Plain; changes nothing.', in: { gl: 'gl' }, do: { kind: 'run', runtime: 'node', entrypoint: 'plain.cjs' }, out: { line: { type: 'text', description: 'Plain.' } } });
  });

  it('merges maps key by key, replaces lists, appends with {append}, and removes with null', () => {
    expect(mergePatch({ a: 1, b: { c: 2, d: 3 }, l: [1] }, { b: { d: null, e: 4 }, l: [2] })).toEqual({ a: 1, b: { c: 2, e: 4 }, l: [2] });
    expect(mergePatch(['a.json'], { append: ['b.json'] })).toEqual(['a.json', 'b.json']);
    expect(mergePatch(undefined, { append: ['b.json'] })).toEqual(['b.json']);
    const f = family();
    f.write('parent/coding.method', parent.replace('files: "{{params.extra_files}}"', 'files: [shared.json]'));
    const file = f.write('clients/acme/acme.method', child('files: {append: [acme.json]}\ninputs:\n  amount:\n    description: The amount in dollars.\n  memo:\n    type: text\n    description: A memo.\n    default: none\n'));
    const document = resolveMethod(file).document;
    expect(document.files).toEqual(['shared.json', 'acme.json']);
    expect(document.inputs).toEqual({ amount: { type: 'number', description: 'The amount in dollars.' }, memo: { type: 'text', description: 'A memo.', default: 'none' } });
  });

  it('resolves a chain: a grandchild overrides a value that its parent filled', () => {
    const f = family();
    f.write('clients/base/base.method', `extends: ../../parent/coding.method\nabstract: true\nparams:\n  late_fee_gl: "8000"\n  region:\n    type: text\n    description: The region.\n    default: east\nsteps:\n  label:\n    purpose: "Label for {{params.region}}; changes nothing."\n`);
    const file = f.write('clients/base/acme/acme.method', `extends: ../base.method\nparams:\n  client_name: Acme\n  region: west\n`);
    const resolved = resolveMethod(file);
    expect(resolved.params).toMatchObject({ client_name: 'Acme', late_fee_gl: '8000', region: 'west' });
    expect(resolved.document.steps.label.purpose).toBe('Label for west; changes nothing.');
    expect(resolved.chain).toHaveLength(3);
    expect(childrenOf(join(f.root, 'parent/coding.method'), f.root).map(c => [c.file, c.depth, c.abstract])).toEqual([[join(f.root, 'clients/base/acme/acme.method'), 2, false], [join(f.root, 'clients/base/base.method'), 1, true]]);
  });

  it('says what is wrong, naming the file, the key and what to do', () => {
    const f = family();
    const at = (body: string, name = 'clients/acme/acme.method') => () => resolveMethod(f.write(name, body));
    expect(at(child('steps:\n  lable:\n    purpose: Typo; changes nothing.\n'))).toThrow(/clients\/acme\/acme\.method: steps\.lable names a step that parent\/coding\.method does not have \(its steps: code, label\)\. .*insert_after/);
    expect(at('extends: ../../parent/coding.method\n')).toThrow(/clients\/acme\/acme\.method leaves params\.client_name without a value \(The client's name\.\); parent\/coding\.method declares it with no default\. Add it under params: in clients\/acme\/acme\.method/);
    expect(at(child('params:\n  clinet_name: Acme\n').replace('params:\n  client_name: Acme\n', ''))).toThrow(/params\.clinet_name is not a param of parent\/coding\.method \(its params: client_name, late_fee_gl, extra_files\)/);
    expect(at(child('remove_steps: [notify]\n'))).toThrow(/remove_steps names notify, which parent\/coding\.method does not have/);
    expect(at('extends: ../nowhere/parent.method\nname: X\n')).toThrow(`clients/acme/acme.method extends ../nowhere/parent.method, which does not exist (looked for ${join(f.root, 'clients/nowhere/parent.method')}). Fix the extends: path in clients/acme/acme.method.`);
    expect(at(child('steps:\n  code:\n    purpose: "{{params.nope}}"\n'))).toThrow(/steps\.code\.purpose uses \{\{params\.nope\}\}, but no file in the chain declares params\.nope/);
    expect(at('extends: ../../parent/coding.method\nparams:\n  client_name: Acme\n  late_fee_gl: 7190\n')).toThrow(/clients\/acme\/acme\.method: params\.late_fee_gl must be text \(or \{file: PATH\}\) \(GL account for late fees\.\)/);
    f.write('loop/a.method', 'extends: b.method\nname: A\n');
    f.write('loop/b.method', 'extends: a.method\nname: B\n');
    expect(() => resolveMethod(join(f.root, 'loop/a.method'))).toThrow('The extends: lines make a cycle: loop/a.method extends loop/b.method extends loop/a.method. A Method cannot extend itself; remove one extends: line.');
  });
});

describe('files and folders', () => {
  it('takes each file from the nearest folder that has it, the child first, and links the child cases', async () => {
    const f = family();
    f.write('parent/shared.json', '{"from":"parent"}');
    f.write('parent/package.json', '{"name":"parent","private":true}');
    f.write('clients/acme/label.cjs', echo('line', '`acme ${i.gl}`'));
    f.write('clients/acme/acme.json', '{"from":"acme"}');
    f.write('clients/acme/cases/c1/case.json', '{}');
    f.write('clients/acme/learned.json', '{"format":"method-learned/1","steps":{}}');
    const file = f.write('clients/acme/acme.method', child('params:\n  extra_files: [shared.json, acme.json]\n').replace('params:\n  client_name: Acme\nparams:\n', 'params:\n  client_name: Acme\n'));
    const { file: target } = materialize(file);
    const at = dirname(target);
    expect(target).toBe(join(at, 'acme.method'));
    expect(readFileSync(join(at, 'label.cjs'), 'utf8')).toContain('acme ');
    expect(readFileSync(join(at, 'code.cjs'), 'utf8')).toBe(readFileSync(join(f.root, 'parent/code.cjs'), 'utf8'));
    expect(readFileSync(join(at, 'shared.json'), 'utf8')).toBe('{"from":"parent"}');
    expect(readFileSync(join(at, 'acme.json'), 'utf8')).toBe('{"from":"acme"}');
    expect(existsSync(join(at, 'package.json'))).toBe(true);
    expect(readdirSync(join(at, 'cases'))).toEqual(['c1']);
    expect(readFileSync(target, 'utf8')).toMatch(/^# Resolved by method from /);
    const source = resolvedSource(target)!;
    expect(source.source).toBe(file);
    expect(provenanceLine(source)).toMatch(/^Resolved from acme\.method extends coding\.method \(sha256 [0-9a-f]{12}\)\.$/);
    // A saved version holds the parent's scripts, the child's files and the child's cases.
    const { pack } = await buildPackage(target, loadWorkflow(methodContent(resolveMethod(file).document)));
    expect(pack.files.map(x => x.path)).toEqual(['acme.json', 'cases/c1/case.json', 'code.cjs', 'label.cjs', 'learned.json', 'package-lock.json', 'package.json', 'shared.json']);
    expect(resolvedSource(join(f.root, 'parent/coding.method'))).toBeUndefined();
  }, 60_000);

  it('names the folders it looked in when a file is missing', () => {
    const f = family();
    const file = f.write('clients/acme/acme.method', child('files: [missing.json]\n'));
    expect(() => materialize(file)).toThrow(/needs the file missing\.json, and none of these folders has it: clients\/acme, parent\./);
  });
});

describe('commands', () => {
  it('leaves an ordinary Method file and its arguments as they are', async () => {
    const f = folder();
    const file = f.write('plain.method', parent.replace(/abstract: true\n/, '').replace(/params:[\s\S]*?inputs:/, 'inputs:').replace('files: "{{params.extra_files}}"\n', '').replaceAll('{{params.client_name}}', 'Acme').replace('"{{params.late_fee_gl}}"', '"7190"'));
    const args = ['validate', file, '--notes'];
    expect(await resolveArgs(args)).toBe(args);
    expect(await resolveArgs(['run', file])).toEqual(['run', file]);
    expect(existsSync(join(f.root, 'cache', 'resolved'))).toBe(false);
  });

  it('refuses to run, test or publish a template, and says why in validate', async () => {
    const f = family();
    const o = output();
    await expect(methodMain(['run', join(f.root, 'parent/coding.method')])).rejects.toThrow('parent/coding.method is a template (abstract: true): it cannot run, be tested or be published by itself.');
    await expect(methodMain(['publish', join(f.root, 'parent/coding.method')])).rejects.toThrow(/is a template/);
    await expect(methodMain(['test', join(f.root, 'parent/coding.method')])).rejects.toThrow(/is a template/);
    await methodMain(['validate', join(f.root, 'parent/coding.method')]);
    expect(o.json()).toMatchObject({ valid: false, issues: [{ code: 'abstract_method' }] });
    expect(process.exitCode).toBe(1);
    // A template still resolves for reading, with its unfilled params as written.
    o.clear();
    await methodMain(['resolve', join(f.root, 'parent/coding.method')]);
    expect(o.text()).toContain('{{params.client_name}}');
  });

  it('shows and compares resolved children', async () => {
    const f = family();
    const acme = f.write('clients/acme/acme.method', child(''));
    const other = f.write('clients/beta/beta.method', 'extends: ../../parent/coding.method\nname: Invoice coding for Beta\nparams:\n  client_name: Beta\n  late_fee_gl: "8040"\n');
    const o = output();
    await methodMain(['show', acme, '--resolved', '--path', '/steps/code/do/args']);
    expect(o.json()).toEqual(['7190']);
    o.clear();
    await methodMain(['show', acme, '--path', '/params']);
    expect(o.json()).toEqual({ client_name: 'Acme' });
    o.clear();
    await methodMain(['diff', acme, other]);
    expect(o.json().map((d: any) => d.path)).toEqual(['/name', '/steps/code/purpose', '/steps/code/do/args']);
  });
});

it('writes the id: line of a child into the child file, keeping its text', () => {
  const f = family();
  const file = f.write('clients/acme/acme.method', child('# Acme only\n'));
  writeChildId(file, 'wf_0123456789abcdef0123456789abcdef');
  expect(readFileSync(file, 'utf8')).toBe('extends: ../../parent/coding.method\nid: wf_0123456789abcdef0123456789abcdef\nname: Invoice coding for Acme\nparams:\n  client_name: Acme\n# Acme only\n');
  expect(resolveMethod(file).document.id).toBe('wf_0123456789abcdef0123456789abcdef');
});

describe('a parent and child, end to end', () => {
  it('validates and runs a child, records its case, and gates a parent change with each child case', async () => {
    const f = family();
    f.write('clients/acme/label.cjs', echo('line', '`Acme ${i.gl}`'));
    const acme = f.write('clients/acme/acme.method', child(''));
    f.write('clients/beta/beta.method', 'extends: ../../parent/coding.method\nname: Invoice coding for Beta\nparams:\n  client_name: Beta\n  late_fee_gl: "8040"\n');
    f.write('inputs.json', '{"amount": 12}');
    const o = output();

    await methodMain(['validate', acme]);
    expect(o.json()).toMatchObject({ valid: true, steps: [{ id: 'code', runs: 'node code.cjs' }, { id: 'label', runs: 'node label.cjs' }] });
    o.clear();
    await methodMain(['run', acme, '--inputs', join(f.root, 'inputs.json'), '--run-dir', join(f.root, 'runs/acme')]);
    expect(o.json()).toMatchObject({ status: 'completed', result: 'Acme 7190:12' });
    expect(o.stderr()).toContain('clients/acme/acme.method extends parent/coding.method; using the resolved Method');
    // A run of a child saves no id: line when this computer is not signed in, and never changes the child file.
    expect(readFileSync(acme, 'utf8')).toBe(child(''));

    o.clear();
    await methodMain(['run', join(f.root, 'clients/beta/beta.method'), '--inputs', join(f.root, 'inputs.json'), '--run-dir', join(f.root, 'runs/beta')]);
    expect(o.json()).toMatchObject({ status: 'completed', result: 'parent 8040:12' });

    // Each child records a case in its own cases/ folder.
    for (const [name, line] of [['acme', 'Acme 7190:12'], ['beta', 'parent 8040:12']]) {
      f.write(`expect-${name}.json`, JSON.stringify([{ kind: 'equals', ref: 'result', value: line }]));
      o.clear();
      await methodMain(['case', 'new', join(f.root, `clients/${name}/${name}.method`), '--passing-run', join(f.root, `runs/${name}`), '--id', `${name}-line`, '--note', 'the right line', '--expect', join(f.root, `expect-${name}.json`)]);
      expect(existsSync(join(f.root, `clients/${name}/cases/${name}-line/case.json`))).toBe(true);
    }

    o.clear();
    await methodMain(['children', join(f.root, 'parent/coding.method')]);
    expect(o.json().children.map((c: any) => c.file)).toEqual([acme, join(f.root, 'clients/beta/beta.method')]);

    o.clear();
    await methodMain(['test', join(f.root, 'parent/coding.method'), '--children']);
    expect(o.json()).toMatchObject({ passed: true, children: [{ status: 'passed' }, { status: 'passed' }] });
    expect(process.exitCode).toBe(0);

    // A parent change that breaks one child's case fails the gate and names that child.
    f.write('parent/code.cjs', echo('gl', '`${process.argv[2]}:${i.amount + (process.argv[2] === "8040" ? 1 : 0)}`'));
    o.clear();
    await methodMain(['test', join(f.root, 'parent/coding.method'), '--children']);
    const report = o.json();
    expect(report).toMatchObject({ passed: false, children: [{ status: 'passed' }, { status: 'failed' }] });
    expect(report.line).toBe('1 of 2 children fail with this parent: beta.method.');
    expect(process.exitCode).toBe(1);

    // A parent change that removes a step a child patches stops that child from resolving.
    f.write('clients/acme/acme.method', child('steps:\n  label:\n    purpose: Acme label; changes nothing.\n'));
    f.write('parent/coding.method', parent.replace(/  label:[\s\S]*?result: line/, 'result: gl'));
    o.clear();
    await methodMain(['test', join(f.root, 'parent/coding.method'), '--children']);
    expect(o.json().children[0]).toMatchObject({ status: 'does_not_resolve', error: expect.stringContaining('steps.label names a step that parent/coding.method does not have') });
  }, 120_000);
});

describe('the examples', () => {
  it('resolve into valid Methods', () => {
    const root = join(process.cwd(), 'examples', 'invoice-coding');
    for (const name of ['acme/acme-invoice-coding.method', 'brightside/brightside-invoice-coding.method']) {
      const resolved = resolveMethod(join(root, 'clients', name));
      expect(() => loadWorkflow(methodContent(resolved.document))).not.toThrow();
      expect(resolved.document.steps.code_lines.do.prompt).toContain(name.startsWith('acme') ? 'Acme' : 'Brightside');
    }
    expect(resolveMethod(join(root, 'invoice-coding.method')).abstract).toBe(true);
  });
});
