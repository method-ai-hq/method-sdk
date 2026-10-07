// Compare the saved ticket with the submitted message and destination.
let text = '';
for await (const chunk of process.stdin) text += chunk;
const {token, inputs, observations} = JSON.parse(text);
const read = observations.at(-1);
let result;
if (!read || read.data.status === 404) result = {verdict: 'no_evidence', reason: 'No ticket is saved for this operation yet.', evidence: []};
else if (read.data.status !== 200 || !read.data.record) result = {verdict: 'unobservable', reason: `Ticket lookup returned ${read.data.status}.`, evidence: [read.ref]};
else {
  const record = read.data.record;
  const matches = record.operation_id === token && record.message === inputs.message && record.destination === inputs.destination;
  result = matches ? {verdict: 'confirmed', reason: `Ticket ${record.ticket_id} has the submitted message and destination.`, evidence: [record.ticket_id]}
    : {verdict: 'contradicted', reason: 'The saved ticket differs from the submitted message or destination.', evidence: [record.ticket_id ?? read.ref]};
}
process.stdout.write(JSON.stringify(result) + '\n');
