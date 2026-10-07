// Read the Method folder through the observer connection and compare it with the approved workspace.
import { input, output, hashes, changed, sha256, readFileSync, existsSync, join } from './lib.mjs';
const { inputs } = input();
const folder = JSON.parse(process.env.METHOD_ENVIRONMENT).method_folder_reader;
const files = changed(JSON.parse(inputs.snapshot), hashes(inputs.workspace, []));
const observations = files.map(file => ({ source: 'file', ref: file, data: {
  intended: existsSync(join(inputs.workspace, file)) ? sha256(readFileSync(join(inputs.workspace, file))) : null,
  found: existsSync(join(folder, file)) ? sha256(readFileSync(join(folder, file))) : null } }));
observations.push({ source: 'case', ref: inputs.case_id, data: { intended: true, found: existsSync(join(inputs.cases_dir, inputs.case_id, 'case.json')) } });
output({ observations });
