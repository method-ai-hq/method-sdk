/**
 * Print check candidates from Method files as JSON lines, with the exact inputs that the SDK sends to Jev.
 * Usage: npx tsx testkit/checks/extract.ts FILE.method... > candidates.jsonl
 * It reads only the Method files and the scripts they name; it never reads .env files.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseDocumentValue } from '../../packages/workflow-language/src/validate.js';
import { checkTargets } from '../../packages/sdk/src/model-checks.js';
import { refused } from '../../packages/sdk/src/method-issues.js';

for (const file of process.argv.slice(2)) {
  const full = realpathSync(resolve(file));
  if (refused(full)) continue;
  let method: any;
  try { method = parseDocumentValue(readFileSync(full, 'utf8')); } catch { continue; }
  if (!method?.steps || typeof method.steps !== 'object') continue;
  const read = (path: string) => {
    const target = resolve(dirname(full), path);
    if (refused(target) || !existsSync(target)) return undefined;
    const real = realpathSync(target);
    return refused(real) ? undefined : readFileSync(real, 'utf8');
  };
  for (const target of checkTargets(method, read))
    process.stdout.write(JSON.stringify({ check: target.check, source: `${full.replace(process.env.HOME ?? '', '~')}#${target.step}`, inputs: target.inputs }) + '\n');
}
