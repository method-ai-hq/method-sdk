import {readFileSync, writeFileSync} from 'node:fs';
const {summary, out} = JSON.parse(readFileSync(0, 'utf8'));
const lines = ['# Weekly summary', '', '## Decisions', ...summary.decisions.map(d => `- ${d.text} (${d.source})`), '', '## Action items',
  ...summary.actions.map(a => `- ${a.action} — ${a.owner}${a.due ? `, due ${a.due}` : ''} (${a.source})`), ''];
const path = `${out}/weekly.md`;
writeFileSync(path, lines.join('\n'));
console.log(JSON.stringify({path}));
