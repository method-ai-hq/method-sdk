let text = '';
for await (const chunk of process.stdin) text += chunk;
const {inputs, outputs} = JSON.parse(text);
let result;
try {
  const operation = outputs.ticket.operation_id;
  const response = await fetch(new URL('/tickets/by-operation/'+encodeURIComponent(operation),inputs.service),{signal:AbortSignal.timeout(10_000)});
  if (!response.ok) throw Error(`Ticket lookup returned ${response.status}.`);
  const record = await response.json();
  const matches = record.ticket_id === outputs.ticket.ticket_id && record.operation_id === operation &&
    record.message === inputs.message && record.destination === inputs.routing.destination;
  result = {status:matches?'pass':'fail',reason:matches?'The saved ticket matches the message, destination, and operation ID.':'The saved ticket differs from the submitted values.',evidence:[operation]};
} catch(error) {result={status:'unknown',reason:error.message,evidence:[]};}
process.stdout.write(JSON.stringify(result)+'\n');
