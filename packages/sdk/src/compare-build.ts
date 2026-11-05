import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Hash executable code, not its path, build time, source maps or type declarations. */
export function codeHash(roots: string[]) {
  const hash = createHash('sha256');
  const walk = (root: string, relative: string) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(root, name);
      else if (entry.isFile() && /\.(?:[cm]?js|ts|json)$/.test(name) && !name.endsWith('.d.ts')) {
        hash.update(JSON.stringify([name, readFileSync(join(root, name), 'utf8')]));
      }
    }
  };
  roots.forEach((root, i) => { hash.update(String(i)); walk(root, ''); });
  return hash.digest('hex');
}

/** A changed learner, guide or runtime is a new experiment, even before a release number changes. */
export const comparisonBuild = {
  current: () => codeHash([
    fileURLToPath(new URL('./', import.meta.url)),
    ...['contracts', 'workflow-language', 'method-document'].map(name => fileURLToPath(new URL(`../../${name}/src/`, import.meta.url))),
    dirname(createRequire(import.meta.url).resolve('@withmethod/runtime/runner.js')),
  ]),
};

export function assertComparisonBuild(saved: unknown) {
  if (saved !== comparisonBuild.current()) throw Error('The Method code changed since this comparison was prepared. Run the .compare file again to prepare a new comparison; old results will not be reused.');
}
