import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cached, checkTargets, runChecks, scanDecision, shownChecks } from '../../packages/sdk/src/model-checks.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const run = (entrypoint: string, extra: object = {}) => ({ name: 'S', purpose: 'P.', do: { kind: 'run', runtime: /\.py$/.test(entrypoint) ? 'python' : 'node', entrypoint }, out: { x: { type: 'text', description: 'X.' } }, ...extra });
const python = 'step:\n  do:\n    kind: run\n    entrypoint: send.py\n', node = 'step:\n  do:\n    kind: run\n    entrypoint: send.mjs\n';

it('decides a run step from the script scan: a host or a write is a finding, nothing that can send is none', () => {
  expect(scanDecision(python, 'import json, requests\nrequests.post("https://hooks.slack.com/services/T/B/X", json={})\n')).toBe(true);
  expect(scanDecision(python, 'with open("/Volumes/Team/report.md", "w") as f:\n    f.write("x")\n')).toBe(true);
  expect(scanDecision(python, 'with open("/tmp/scratch.txt", "w") as f:\n    f.write("x")\n')).toBe(false);
  expect(scanDecision(python, 'import json, sys\nprint(json.dumps({"x": json.load(sys.stdin)["a"]}))\n')).toBe(false);
  expect(scanDecision(node, 'console.log(JSON.stringify({ x: 1 }));\n')).toBe(false);
  // The scan cannot tell: a mail library with the host in the environment, a fetch with a built URL, or a subprocess.
  expect(scanDecision(node, "import nodemailer from 'nodemailer';\nnodemailer.createTransport({ host: process.env.SMTP_HOST });\n")).toBeUndefined();
  expect(scanDecision(node, 'await fetch(`${process.env.API}/items`, { method: "POST" });\n')).toBeUndefined();
  expect(scanDecision(python, 'import subprocess\nsubprocess.run(["gh", "issue", "create"])\n')).toBeUndefined();
});

it('applies to run steps and agent steps with tools that declare no change, and stays in shadow mode', () => {
  const method = {
    tools: { send_email: { description: 'Send an email.', run: { kind: 'run', runtime: 'python', entrypoint: 'send.py' } } },
    steps: {
      script: run('send.py'),
      declared: run('send.py', { changes: ['environment.crm'], effects: { saved: { intent: 'Saved.' } } }),
      agent: { do: { kind: 'agent', model: 'default', prompt: 'Email each contact.', tools: ['send_email'] }, out: { sent: { type: 'text' } } },
      writer: { do: { kind: 'call', model: 'default', prompt: 'Write.' }, out: { text: { type: 'text' } } },
    },
  };
  const targets = checkTargets(method, () => 'print(1)\n').filter(target => target.check === 'undeclared_change');
  expect(targets.map(target => target.step)).toEqual(['script', 'agent']);
  expect(targets[1]!.inputs.tools).toContain('Send an email.');
  expect(shownChecks).not.toContain('undeclared_change');
});

it('records a scan answer with no model call and no sign-in', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'method-undeclared-'))); roots.push(root);
  vi.stubEnv('METHOD_CACHE_DIR', root);
  const method = { steps: { post: run('post.py') } };
  const targets = checkTargets(method, () => 'import requests\nrequests.post("https://api.example.com/items", json={})\n').filter(target => target.check === 'undeclared_change');
  const { done, pending } = await runChecks(undefined, targets);
  expect(pending).toEqual([]);
  expect(done).toEqual([expect.objectContaining({ check: 'undeclared_change', step: 'post', answer: true, probability: 1, model: 'script-scan' })]);
  expect(cached(targets[0]!.key)).toMatchObject({ answer: true });
});
