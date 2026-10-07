import { input, output } from './lib.mjs';
const { observations } = input();
const request = observations.find(o => o.source === 'request'), cases = observations.filter(o => o.source === 'case');
const open = cases.filter(o => o.data.status !== 'retired');
output(!request ? { verdict: 'no_evidence', reason: 'Nothing was read.', evidence: [] }
  : open.length ? { verdict: 'contradicted', reason: `Not retired: ${open.map(o => o.ref).join(', ')}`, evidence: open.map(o => o.ref) }
  : { verdict: 'confirmed', reason: cases.length ? `Retired: ${cases.map(o => o.ref).join(', ')}` : 'Nothing was to be retired.', evidence: cases.map(o => o.ref) });
