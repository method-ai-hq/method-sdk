import { input, output } from './lib.mjs';
const { observations } = input();
const wrong = observations.filter(o => o.data.intended !== o.data.found);
output(!observations.length ? { verdict: 'no_evidence', reason: 'Nothing was read.', evidence: [] }
  : wrong.length ? { verdict: 'contradicted', reason: `Not as approved: ${wrong.map(o => o.ref).join(', ')}`, evidence: wrong.map(o => o.ref) }
  : { verdict: 'confirmed', reason: `${observations.length} files and the case are as approved.`, evidence: observations.map(o => o.ref) });
