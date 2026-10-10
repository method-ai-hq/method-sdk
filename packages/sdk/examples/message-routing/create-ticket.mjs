let text = '';
for await (const chunk of process.stdin) text += chunk;
const {message, routing, service} = JSON.parse(text);
const operation = process.env.METHOD_OPERATION_ID;
if (!operation || typeof message !== 'string' || !['billing','technical','manual_review'].includes(routing?.destination))
  throw Error('Expected a message, destination, and Method operation ID.');
const response = await fetch(new URL('/tickets', service), {
  method: 'POST', signal: AbortSignal.timeout(10_000),
  headers: {'content-type':'application/json','Idempotency-Key':operation},
  body: JSON.stringify({message,destination:routing.destination}),
});
if (!response.ok) throw Error(`Ticket service returned ${response.status}. Inspect operation ${operation} before retrying.`);
const ticket = await response.json();
if (typeof ticket.ticket_id !== 'string' || ticket.operation_id !== operation) throw Error('The ticket receipt does not match this operation.');
process.stdout.write(JSON.stringify({ticket:{ticket_id:ticket.ticket_id,operation_id:operation}})+'\n');
