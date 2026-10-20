import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { effectCommand, observeCommand, caseCommand, testCommand, observerLibrary, casesPrivacyWarning, caseGate, casesNotice } from '../../packages/sdk/src/quality.js';
import { runMethod } from '@withmethod/runtime';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'method-quality-')); roots.push(root); return root; };
const observers = fileURLToPath(new URL('../../packages/sdk/observers/', import.meta.url));
const captured = () => { const out: string[] = []; vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { out.push(String(chunk)); return true; }); return () => JSON.parse(out.join('')); };

const sendMethod = () => ({
  format: 'method/3.3', name: 'Send', goal: 'Send a summary.',
  inputs: { to: { type: 'text' } },
  environment: { mail: { type: 'service', description: 'Outgoing mail.' } },
  steps: { send: { name: 'Send', purpose: 'Send the summary.', in: { to: 'inputs.to' }, do: { kind: 'run', runtime: 'node', entrypoint: 'send.mjs' },
    out: { receipt: { type: 'text', description: 'Receipt.' } }, changes: ['environment.mail'] } },
  result: 'receipt',
});

it('lists the reviewed observers, and every judge passes its own fixtures', () => {
  const library = observerLibrary();
  expect(library.map(o => o.name)).toContain('mail.delivery');
  for (const observer of library) for (const file of ['fixtures', 'fetch.mjs', 'judge.mjs']) expect(existsSync(join(observers, observer.name, file))).toBe(true);
  for (const observer of library) {
    const dir = join(observers, observer.name, 'fixtures');
    const verdicts = new Set<string>();
    for (const name of require('node:fs').readdirSync(dir)) {
      const fixture = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const result = JSON.parse(execFileSync(process.execPath, [join(observers, observer.name, 'judge.mjs')], { input: JSON.stringify({ token: 'mop_fixture', intent: 'x', inputs: fixture.inputs ?? {}, observations: fixture.observations }) }).toString());
      expect(result.verdict, `${observer.name}/${name}`).toBe(fixture.expect);
      verdicts.add(fixture.observations.length ? fixture.expect : 'empty:' + fixture.expect);
    }
    expect(verdicts.has('contradicted') && verdicts.has('empty:no_evidence')).toBe(true);
  }
});

it('effect add copies a reviewed observer and declares the effect', async () => {
  const root = temp();
  const file = join(root, 'send.method');
  writeFileSync(file, stringify(sendMethod()));
  await expect(effectCommand(['add', file, 'send', 'delivered', '--observer', 'mail.delivery'])).rejects.toThrow('--in to=REFERENCE');
  const read = captured();
  await effectCommand(['add', file, 'send', 'delivered', '--observer', 'mail.delivery', '--in', 'to=inputs.to']);
  const printed = read();
  vi.restoreAllMocks();
  const doc = parse(readFileSync(file, 'utf8'));
  expect(doc.format).toBe('method/3.4');
  expect(doc.environment.bounce_mailbox).toMatchObject({ role: 'observer', type: 'service' });
  expect(doc.steps.send.effects.delivered).toMatchObject({ observe: { entrypoint: 'observers/mail.delivery/fetch.mjs' } });
  expect(printed.setup).toContain('MAIL_OBSERVER_PASSWORD');
  expect(existsSync(join(root, 'observers/mail.delivery/judge.mjs'))).toBe(true);
  const { validateMethod } = await import('@withmethod/runtime');
  expect(() => validateMethod(doc)).not.toThrow();
});

it('mail.delivery reads bounces over IMAP without changing the mailbox', async () => {
  const commands: string[] = [];
  const message = (body: string) => `From: Mail Delivery Subsystem <mailer-daemon@example.net>\r\nSubject: Delivery Status Notification (Failure)\r\nDate: Tue, 7 Oct 2026 08:00:00 +0000\r\n\r\n${body}`;
  const mail: Record<string, string> = {
    '41': message('Action: failed\r\nStatus: 5.1.1\r\nFinal-Recipient: rfc822; dana@vendor.example\r\nMessage-ID: <mop_abc@sender.example>\r\n'),
    '42': message('Action: failed\r\nStatus: 5.1.1\r\nFinal-Recipient: rfc822; other@vendor.example\r\n'),
  };
  const server = createServer(socket => {
    socket.write('* OK fake IMAP ready\r\n');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const [tag, verb, ...rest] = line.split(' ');
        commands.push(`${verb} ${rest.join(' ')}`.trim());
        if (/^UID$/i.test(verb!) && /^SEARCH/i.test(rest[0]!)) socket.write(`* SEARCH 41 42\r\n${tag} OK SEARCH done\r\n`);
        else if (/^UID$/i.test(verb!) && /^FETCH/i.test(rest[0]!)) {
          const uid = rest[1]!, [header, body] = mail[uid]!.split('\r\n\r\n');
          socket.write(`* 1 FETCH (UID ${uid} BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {${Buffer.byteLength(header! + '\r\n')}}\r\n${header}\r\n BODY[TEXT]<0> {${Buffer.byteLength(body!)}}\r\n${body})\r\n${tag} OK FETCH done\r\n`);
        } else if (/^LOGOUT$/i.test(verb!)) { socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`); socket.end(); }
        else socket.write(`${tag} OK ${verb} done\r\n`);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as any).port;
    const child = spawn(process.execPath, [join(observers, 'mail.delivery/fetch.mjs'), '--connection', 'bounce_mailbox'], {
      env: { PATH: process.env.PATH, METHOD_ENVIRONMENT: JSON.stringify({ bounce_mailbox: `imap://observer%40sender.example@127.0.0.1:${port}/INBOX` }), MAIL_OBSERVER_PASSWORD: 'app-password' } });
    let out = '', err = '';
    child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c);
    child.stdin.end(JSON.stringify({ token: 'mop_abc', intent: 'x', inputs: { to: 'dana@vendor.example' }, attempt: 1, action_outcome: 'ok' }));
    const code = await new Promise(resolve => child.on('close', resolve));
    expect(err).toBe(''); expect(code).toBe(0);
    const { observations } = JSON.parse(out);
    expect(observations.map((o: any) => [o.ref, o.data.mentions_token, o.data.mentions_recipient, o.data.status])).toEqual([['INBOX/uid:41', true, true, '5.1.1'], ['INBOX/uid:42', false, false, '5.1.1']]);
    expect(JSON.stringify(observations)).not.toContain('Final-Recipient');
    expect(commands).toContain('EXAMINE "INBOX"');
    expect(commands.filter(c => /^UID FETCH/.test(c)).every(c => c.includes('BODY.PEEK'))).toBe(true);
    expect(commands.some(c => /^(SELECT|STORE)/.test(c))).toBe(false);
    const judged = JSON.parse(execFileSync(process.execPath, [join(observers, 'mail.delivery/judge.mjs')], { input: JSON.stringify({ token: 'mop_abc', intent: 'x', inputs: { to: 'dana@vendor.example' }, observations }) }).toString());
    expect(judged).toMatchObject({ verdict: 'contradicted', evidence: ['INBOX/uid:41'] });
  } finally { server.close(); }
});

it('method case and method test replay a run, and method observe reports runs without open effects', async () => {
  const root = temp();
  const file = join(root, 'report.method');
  const doc = { format: 'method/3.3', name: 'Report', goal: 'Report a total.', inputs: { amounts: { type: 'list', items: 'number' } },
    steps: { report: { name: 'Report', purpose: 'Write the total.', in: { amounts: 'inputs.amounts' }, do: { kind: 'run', runtime: 'node', entrypoint: 'report.mjs' }, out: { report: { type: 'text', description: 'Report.' } }, changes: [] } },
    result: 'report' };
  writeFileSync(file, stringify(doc));
  writeFileSync(join(root, 'report.mjs'), 'let s="";for await(const c of process.stdin)s+=c;const a=JSON.parse(s);console.log(JSON.stringify({report:"Paid "+a.amounts.reduce((x,y)=>x+y,0)}))');
  const config = { allow_local_processes: true, runtimes: { node: { command: process.execPath, version: process.version } } };
  expect((await runMethod(file, config, { runDir: join(root, 'runs/one'), inputs: { amounts: [4, 6] } })).status).toBe('completed');
  writeFileSync(join(root, 'expect.json'), JSON.stringify([{ kind: 'equals', ref: 'outputs.report', value: 'Paid 10 EUR', text: 'The report names the currency.' }]));
  let read = captured();
  await caseCommand(['new', file, '--run', join(root, 'runs/one'), '--id', 'currency', '--note', 'Name the currency.', '--expect', join(root, 'expect.json')]);
  expect(read().id).toBe('currency');
  vi.restoreAllMocks(); read = captured();
  await testCommand([file]);
  expect(read()).toMatchObject({ passed: false, cases: [{ id: 'currency', verdict: 'fail' }] });
  expect(process.exitCode).toBe(1);
  // The flags of the fix loop's real tests (apps/improve lib/method-test.mjs): runs, min-pass, live steps, no judge cache.
  vi.restoreAllMocks(); read = captured();
  await testCommand([file, '--case', 'currency', '--runs', '3', '--min-pass', '2', '--live', 'report', '--no-judge-cache']);
  const forced = read().cases[0].candidate;
  expect(forced).toMatchObject({ status: 'fail', runs: 2, min_pass: 2, target_live: true });
  expect(forced.attempts.every((a: any) => a.live_steps.includes('report') && a.target_live === true)).toBe(true);
  await expect(testCommand([file, '--live', 'nope'])).rejects.toThrow('No step nope');
  await expect(testCommand([file, '--runs', '0'])).rejects.toThrow('--runs must be a number from 1 to 20');
  vi.restoreAllMocks(); read = captured();
  await observeCommand(['--pending', join(root, 'runs')]);
  expect(read().runs).toEqual([]);
});

it('a new case names the signed-in person; the save gate and the run notice name whose correction breaks, in plain words', async () => {
  const root = temp();
  vi.stubEnv('METHOD_CONFIG_DIR', join(root, 'config')); vi.stubEnv('METHOD_CACHE_DIR', join(root, 'cache')); vi.stubEnv('METHOD_API_KEY', 'mk_test');
  vi.stubGlobal('fetch', vi.fn(async (url: any) => new URL(String(url)).pathname === '/api/me' ? Response.json({ user: { id: 'u_2', name: 'Gráinne' } }) : Response.json({ message: 'Not found.' }, { status: 404 })));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const file = join(root, 'report.method');
  writeFileSync(file, stringify({ format: 'method/3.3', name: 'Report', goal: 'Report a total.', steps: { report: { name: 'Report', purpose: 'Write the total.', do: { kind: 'run', runtime: 'node', entrypoint: 'report.mjs' }, out: { report: { type: 'text', description: 'Report.' } }, changes: [] } }, result: 'report' }));
  writeFileSync(join(root, 'report.mjs'), 'console.log(JSON.stringify({report:"Paid 10"}))');
  const config = { allow_local_processes: true, runtimes: { node: { command: process.execPath, version: process.version } } };
  expect((await runMethod(file, config, { runDir: join(root, 'runs/one'), inputs: {} })).status).toBe('completed');
  writeFileSync(join(root, 'expect.json'), JSON.stringify([{ kind: 'equals', ref: 'outputs.report', value: 'Paid 10 EUR', text: 'The report names the currency.' }]));
  const read = captured();
  await caseCommand(['new', file, '--run', join(root, 'runs/one'), '--id', 'currency', '--note', 'Name the currency.', '--expect', join(root, 'expect.json')]);
  expect(read().id).toBe('currency');
  const recorded = join(root, 'cases', 'currency', 'case.json');
  expect(JSON.parse(readFileSync(recorded, 'utf8')).author).toBe('Gráinne');
  expect(await casesNotice(file)).toBe(`1 earlier correction was not checked since this agent changed (Gráinne's correction ("Name the currency")). Check it: method test report.method`);
  await expect(caseGate(file)).rejects.toThrow(/^This change breaks 1 earlier correction: Gráinne's correction \("Name the currency"\)\. Fix the Method/);
  // A case with no author: the same text as before.
  writeFileSync(recorded, JSON.stringify({ ...JSON.parse(readFileSync(recorded, 'utf8')), author: null }));
  expect(await casesNotice(file)).toBe(`1 earlier correction was not checked since this agent changed. Check it: method test report.method`);
  await expect(caseGate(file)).rejects.toThrow(/^This change breaks 1 earlier correction: A correction \("Name the currency"\)\. Fix the Method/);
  vi.unstubAllGlobals();
});

it('warns that cases hold run data when they would be committed to Git, and not when they are ignored', () => {
  const root = temp();
  const file = join(root, 'task.method');
  writeFileSync(file, 'format: method/3.3');
  expect(casesPrivacyWarning(file)).toBeUndefined();
  execFileSync('git', ['init', '-q', root]);
  expect(casesPrivacyWarning(file)).toMatch(/keeps copies of run data .* inside a Git repository/);
  writeFileSync(join(root, '.gitignore'), 'cases/*/recording.json\n');
  expect(casesPrivacyWarning(file)).toBeUndefined();
});

it('judges rubric criteria with the account model when signed in', async () => {
  const root = temp();
  vi.stubEnv('METHOD_CONFIG_DIR', join(root, 'config')); vi.stubEnv('METHOD_CACHE_DIR', join(root, 'cache')); vi.stubEnv('METHOD_API_KEY', 'mk_test');
  vi.stubEnv('CLAUDECODE', ''); vi.stubEnv('CODEX_THREAD_ID', '');
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: any) => { requests.push(new URL(String(url)).pathname); return Response.json({ provider: 'openrouter', model: 'openai/gpt-6-luna' }); }));
  const file = join(root, 'send.method');
  writeFileSync(file, stringify(sendMethod())); writeFileSync(join(root, 'send.mjs'), 'console.log(JSON.stringify({receipt: "ok"}))');
  const { preparedConfig } = await import('../../packages/sdk/src/quality.js');
  const prepared = await preparedConfig(file, {}, { judge: true });
  expect(prepared.config.models.judge).toEqual({ backend: 'method', model: 'openai/gpt-6-luna' });
  expect(prepared.hostedModels).toBeTruthy();
  expect(requests).toContain('/api/cli/models/default');
  vi.unstubAllGlobals();
});
