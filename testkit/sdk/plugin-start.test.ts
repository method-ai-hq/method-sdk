import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('plugins/method/scripts/ensure-method.sh');

/** The plugin's start hook, with a method CLI already installed in HOME, in a project folder with the given files. */
function startContext(files: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'plugin-home-')), project = mkdtempSync(join(tmpdir(), 'plugin-project-'));
  const bin = join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'method'), '#!/bin/sh\necho "Method SDK 99.0.0; runtime 1.0.0"\n');
  chmodSync(join(bin, 'method'), 0o755);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(project, name), text);
  const out = execFileSync('sh', [script], { env: { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_PROJECT_DIR: project, METHOD_INSTALL_URL: 'file:///dev/null' }, encoding: 'utf8' });
  return JSON.parse(out).hookSpecificOutput.additionalContext as string;
}

it('tells the agent at start that repeated work is a Method and corrections go through method judge', () => {
  const context = startContext();
  expect(context).toContain('Method is installed for work the person will repeat');
  expect(context).toContain("`method judge RUN_ID wrong --note 'their words'`");
  expect(context).toContain('/.local/bin/method');
  expect(context).not.toContain('This project has Methods');
  expect(startContext({ 'task.method': 'name: task\n' })).toContain('This project has Methods');
});
