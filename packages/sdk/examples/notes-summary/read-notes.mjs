import {readFileSync, readdirSync} from 'node:fs';
const {notes} = JSON.parse(readFileSync(0, 'utf8'));
const files = readdirSync(notes).filter(name => name.endsWith('.md')).sort();
console.log(JSON.stringify({material: files.map(name => `## ${name}\n${readFileSync(`${notes}/${name}`, 'utf8')}`).join('\n\n')}));
