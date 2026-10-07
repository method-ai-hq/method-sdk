// Compare the record read back with the intended values. Deterministic: no network, no model.
import { readFileSync } from 'node:fs';
const { inputs, observations } = JSON.parse(readFileSync(0, 'utf8'));
const read = observations.at(-1);
const expect = inputs.expect ?? {};
const at = (value, path) => path.split('.').reduce((v, k) => v === null || v === undefined ? undefined : Array.isArray(v) ? v[Number(k)] : v[k], value);
let out;
if (!read) out = { verdict: 'no_evidence', reason: 'Nothing was read.', evidence: [] };
else if ([404, 410].includes(read.data.status)) out = { verdict: 'no_evidence', reason: `The record is not there yet (${read.data.status}).`, evidence: [read.ref] };
else if (read.data.status < 200 || read.data.status > 299 || read.data.body === null) out = { verdict: 'unobservable', reason: `The service answered ${read.data.status}${read.data.body === null ? ' without JSON' : ''}.`, evidence: [read.ref] };
else {
  const wrong = Object.entries(expect).filter(([path, value]) => JSON.stringify(at(read.data.body, path)) !== JSON.stringify(value));
  out = wrong.length ? { verdict: 'contradicted', reason: `The stored record differs: ${wrong.map(([path, value]) => `${path} is ${JSON.stringify(at(read.data.body, path))}, intended ${JSON.stringify(value)}`).join('; ')}`, evidence: [read.ref] }
    : { verdict: 'confirmed', reason: `The stored record has the ${Object.keys(expect).length} intended values.`, evidence: [read.ref] };
}
console.log(JSON.stringify(out));
