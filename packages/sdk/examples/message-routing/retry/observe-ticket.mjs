// Read the ticket saved for this operation through the read-only lookup connection.
let text = '';
for await (const chunk of process.stdin) text += chunk;
const {token} = JSON.parse(text);
const {ticket_lookup} = JSON.parse(process.env.METHOD_ENVIRONMENT);
const response = await fetch(new URL('/tickets/by-operation/' + encodeURIComponent(token), ticket_lookup), {signal: AbortSignal.timeout(10_000)});
const record = response.ok ? await response.json() : null;
process.stdout.write(JSON.stringify({observations: [{source: 'ticket_service', ref: token, data: {status: response.status, record}}]}) + '\n');
