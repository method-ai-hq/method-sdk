import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../examples/', import.meta.url));
const files = JSON.parse(readFileSync(new URL('./public-examples.json', import.meta.url), 'utf8'));
export function copyPublicExamples(destination) {
  for (const name of files) {
    if (name.split('/').some(part => ['..', 'sensitive', '.git', 'node_modules', '__pycache__', 'approved-output', '.method-runs'].includes(part)) || /(?:runtime\.json|runtime\.sh|\.method\.json|\.env(?:\..*)?)$/.test(name)) throw Error('Not a public example file: ' + name);
    const target = resolve(destination, name);
    mkdirSync(dirname(target), {recursive:true});
    cpSync(resolve(source, name), target);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) copyPublicExamples(fileURLToPath(new URL('../dist/packages/sdk/examples/', import.meta.url)));
