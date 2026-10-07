import { input, output, readFileSync, existsSync, join } from './lib.mjs';
const { inputs } = input();
const observations = [{ source: 'request', ref: 'retire_ids', data: { count: inputs.ids.length } },
  ...inputs.ids.map(id => { const file = join(inputs.cases_dir, id, 'case.json'); return { source: 'case', ref: id, data: { status: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).status : null } }; })];
output({ observations });
