// Reads {lines, coded, accounts} on stdin; prints {entry}. Exits 1 when the totals or the accounts do not match.
let text = '';
process.stdin.on('data', chunk => text += chunk).on('end', () => {
  const { lines, coded, accounts } = JSON.parse(text);
  const sum = list => Math.round(list.reduce((total, line) => total + line.amount, 0) * 100) / 100;
  const known = new Set(accounts.map(account => account.gl));
  const unknown = coded.filter(line => !known.has(line.gl));
  if (sum(lines) !== sum(coded)) { console.error(`The coded lines total ${sum(coded)}, the invoice ${sum(lines)}.`); process.exit(1); }
  if (unknown.length) { console.error(`Not in the chart of accounts: ${unknown.map(line => line.gl).join(', ')}.`); process.exit(1); }
  process.stdout.write(JSON.stringify({ entry: { lines: coded, total: sum(coded) } }));
});
