import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {unzipSync} from 'fflate';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../examples/', import.meta.url));
const files = JSON.parse(readFileSync(new URL('./public-examples.json', import.meta.url), 'utf8'));
export function copyPublicExamples(destination) {
  for (const name of files) {
    if (name.split('/').some(part => ['..', 'sensitive', '.git', 'node_modules', '__pycache__', 'approved-output', '.method-runs'].includes(part)) || /(?:runtime\.sh|\.method\.json|\.env(?:\..*)?)$/.test(name)) throw Error('Not a public example file: ' + name);
    const target = resolve(destination, name);
    mkdirSync(dirname(target), {recursive:true});
    cpSync(resolve(source, name), target);
  }

  const approved=unzipSync(readFileSync(resolve(source,'daily-briefing/approved-output.zip')),{filter:file=>file.name==='approved-output/briefing.md'});
  writeFileSync(resolve(destination,'daily-briefing/approved-report.md'),approved['approved-output/briefing.md']);
  for(const asset of JSON.parse(readFileSync(resolve(source,'daily-briefing/images.json'),'utf8'))) {
    const bytes=readFileSync(resolve(source,'../../../assets/authoring/daily-briefing',asset.sha256+'.png'));
    for(const [index,name] of asset.parts.entries()) {
      if(!/^approved-images\/[a-f0-9]{64}\.part\d+$/.test(name))throw Error('Invalid approved image part');
      const target=resolve(destination,'daily-briefing',name);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes.subarray(index*15000000,(index+1)*15000000));
    }
  }

}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) copyPublicExamples(fileURLToPath(new URL('../dist/packages/sdk/examples/', import.meta.url)));
