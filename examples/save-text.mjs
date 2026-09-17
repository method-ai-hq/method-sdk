import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const { text } = JSON.parse(input);
await writeFile(join(process.env.METHOD_OUTPUT_DIR, 'message.txt'), text, { mode: 0o600 });
console.log(JSON.stringify({ file: { path: 'message.txt', sha256: createHash('sha256').update(text).digest('hex') } }));
