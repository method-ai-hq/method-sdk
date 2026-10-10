import { expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { configRoot } from '../../packages/sdk/src/computer-settings.js';
import { methodCache } from '../../packages/sdk/src/prepare.js';

it('runs every test with a temporary HOME and refuses writes under the real one', async () => {
  const real = process.env.METHOD_TEST_REAL_HOME!;
  expect(homedir()).not.toBe(real);
  expect(configRoot().startsWith(real)).toBe(false);
  expect(methodCache().startsWith(real)).toBe(false);
  const target = join(real, '.config', 'method', 'computer.json');
  expect(() => writeFileSync(target, '{}')).toThrow('A test wrote under the real home folder');
  expect(() => mkdirSync(join(real, '.cache', 'method', 'outbox'), { recursive: true })).toThrow('real home folder');
  await expect(writeFile(target, '{}')).rejects.toThrow('real home folder');
});
