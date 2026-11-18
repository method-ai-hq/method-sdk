// Reads {invoice} on stdin; prints {property}: the ID of the property whose address the invoice names, else none.
import { readFileSync } from 'node:fs';
let text = '';
process.stdin.on('data', chunk => text += chunk).on('end', () => {
  const { invoice } = JSON.parse(text);
  const properties = JSON.parse(readFileSync('properties.json', 'utf8'));
  const found = properties.find(p => invoice.toLowerCase().includes(p.address.toLowerCase()));
  process.stdout.write(JSON.stringify({ property: found ? found.id : 'none' }));
});
