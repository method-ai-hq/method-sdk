/**
 * A unified diff of two texts, line by line, with 2 lines of context. Texts of more than 4000 lines each are shown as
 * one change, so the diff stays fast.
 */
export function textDiff(before: string, after: string, from = 'before', to = 'after') {
  if (before === after) return '';
  const a = before ? before.split('\n') : [], b = after ? after.split('\n') : [];
  const ops: Array<{ kind: ' ' | '-' | '+'; line: string }> = [];
  if (a.length > 4000 || b.length > 4000) { for (const line of a) ops.push({ kind: '-', line }); for (const line of b) ops.push({ kind: '+', line }); }
  else {
    // The longest common subsequence of lines, from the end.
    const n = a.length, m = b.length, lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { ops.push({ kind: ' ', line: a[i]! }); i++; j++; }
      else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) { ops.push({ kind: '-', line: a[i]! }); i++; }
      else { ops.push({ kind: '+', line: b[j]! }); j++; }
    }
  }
  // Hunks: the changed lines with 2 lines of context around them.
  const context = 2, lines = [`--- ${from}`, `+++ ${to}`];
  let k = 0, oldLine = 1, newLine = 1;
  while (k < ops.length) {
    if (ops[k]!.kind === ' ') { k++; oldLine++; newLine++; continue; }
    const start = Math.max(0, k - context);
    // The hunk goes on while two changes are at most 2 × context lines apart.
    let last = k, x = k + 1;
    for (; x < ops.length; x++) { if (ops[x]!.kind !== ' ') last = x; else if (x - last > context * 2) break; }
    const end = Math.min(ops.length, last + 1 + context);
    const back = k - start, hunk = ops.slice(start, end);
    const oldStart = oldLine - back, newStart = newLine - back;
    const oldCount = hunk.filter(o => o.kind !== '+').length, newCount = hunk.filter(o => o.kind !== '-').length;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...hunk.map(o => `${o.kind}${o.line}`));
    for (const o of ops.slice(k, end)) { if (o.kind !== '+') oldLine++; if (o.kind !== '-') newLine++; }
    k = end;
  }
  return lines.join('\n');
}
