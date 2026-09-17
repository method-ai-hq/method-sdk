import {readFileSync,writeFileSync} from 'node:fs';
const root = new URL('../', import.meta.url);
const sdk = JSON.parse(readFileSync(new URL('packages/sdk/package.json', root))).version;
const python = readFileSync(new URL('packages/sdk-python/pyproject.toml', root),'utf8').match(/^version = "([^"]+)"/m)[1];
if (python !== sdk) throw Error('JavaScript and Python packages must use the same release version.');
for (const name of ['README.md','packages/sdk/README.md','packages/sdk-python/README.md']) {
  const path = new URL(name, root), source = readFileSync(path,'utf8');
  const text = source.replace(/releases\/download\/v[\d.]+\//g,`releases/download/v${sdk}/`)
    .replace(/withmethod-sdk-[\d.]+\.tgz/g,`withmethod-sdk-${sdk}.tgz`)
    .replace(/withmethod-[\d.]+-py3-none-any\.whl/g,`withmethod-${python}-py3-none-any.whl`)
    .replace(/JavaScript SDK [\d.]+\./g,`JavaScript SDK ${sdk}.`);
  if (process.argv.includes('--check')) { if (source !== text) throw Error(`${name} has stale release instructions`); }
  else writeFileSync(path,text);
}
