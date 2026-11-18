// Reads {invoice} on stdin; prints {lines, accounts}. The chart of accounts file is the first argument.
import { readFileSync } from 'node:fs';
let text = '';
process.stdin.on('data', chunk => text += chunk).on('end', () => {
  const { invoice } = JSON.parse(text);
  const lines = invoice.split('\n').map(line => line.trim()).filter(Boolean).flatMap(line => {
    const match = /^(.*?)\s+\$?(-?[\d,]+(?:\.\d+)?)$/.exec(line);
    return match ? [{ text: match[1], amount: Number(match[2].replaceAll(',', '')) }] : [];
  });
  const accounts = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  process.stdout.write(JSON.stringify({ lines, accounts }));
});
