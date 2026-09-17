import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const { inputs, outputs } = JSON.parse(input);
const text = await readFile(join(process.env.METHOD_OUTPUT_DIR, outputs.file.path), 'utf8');
console.log(JSON.stringify({ status: text === inputs.text ? 'pass' : 'fail', reason: 'Compared the full saved text with the input.', evidence: [outputs.file.path] }));
