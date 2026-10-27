import {readFileSync, readdirSync} from 'node:fs';
const {policy} = JSON.parse(readFileSync(0, 'utf8'));
const files = readdirSync(policy).filter(name => name.endsWith('.md')).sort();
console.log(JSON.stringify({articles: files.map(name => `## ${name}\n${readFileSync(`${policy}/${name}`, 'utf8')}`).join('\n\n')}));
