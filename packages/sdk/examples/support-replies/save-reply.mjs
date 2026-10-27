import {readFileSync, writeFileSync} from 'node:fs';
const {reply, work} = JSON.parse(readFileSync(0, 'utf8'));
writeFileSync(`${work}/reply.md`, reply);
console.log(JSON.stringify({saved: reply}));
