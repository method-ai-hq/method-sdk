// Decide what the delivery reports show. Deterministic: no network, no model.
import { readFileSync } from 'node:fs';
const { token, observations } = JSON.parse(readFileSync(0, 'utf8'));
const daemon = /mailer-daemon|postmaster|mail delivery (sub)?system/i;
const failedSubject = /undeliver|delivery status notification \(failure\)|mail delivery failed|returned mail|delivery has failed|could not be delivered|couldn't be delivered|not delivered|delivery failure/i;
// A report is about this message when it names its token, or names the recipient and comes from a mail system.
const relevant = observations.filter(o => o.data?.mentions_token || (o.data?.mentions_recipient && daemon.test(o.data?.from ?? '')));
const failed = relevant.find(o => o.data.action === 'failed' || /^5\./.test(o.data.status) || (o.data.action !== 'delayed' && !/^4\./.test(o.data.status) && failedSubject.test(o.data.subject ?? '')));
const delivered = relevant.find(o => o.data.action === 'delivered' && o.data.mentions_token);
const out = failed ? { verdict: 'contradicted', reason: `Delivery failed${failed.data.status ? ` (${failed.data.status})` : ''}: ${failed.data.subject}`, evidence: [failed.ref] }
  : delivered ? { verdict: 'confirmed', reason: 'A delivery report names this message as delivered.', evidence: [delivered.ref] }
  : { verdict: 'no_evidence', reason: relevant.length ? `Only delay reports so far (${relevant.length}).` : `No delivery report names ${token} or the recipient.`, evidence: relevant.map(o => o.ref) };
console.log(JSON.stringify(out));
