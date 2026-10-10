// A small help desk for trying support-triage.method on this computer. It keeps tickets in memory.
// Run: HELPDESK_TOKEN=... node fake-helpdesk.mjs [PORT]   (default port 4310; tickets from sample-tickets.json)
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';

/** Starts the help desk. GET /tickets/ID is open, like the read-only observer; PATCH needs the token. */
export function startHelpdesk({token, tickets, port = 0}) {
  const store = new Map(tickets.map(ticket => [ticket.id, structuredClone(ticket)]));
  const patches = [];
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const send = (status, body) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(body)); };
    const id = /^\/tickets\/([A-Za-z0-9_-]+)$/.exec(req.url ?? '')?.[1];
    const ticket = id && store.get(id);
    if (!ticket) return send(404, {error: 'not_found'});
    if (req.method === 'GET') return send(200, ticket);
    if (req.method !== 'PATCH') return send(405, {error: 'method_not_allowed'});
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, {error: 'unauthorized'});
    const {queue, priority, tags, internal_note} = JSON.parse(text || '{}');
    patches.push({id, queue, priority, tags, internal_note});
    Object.assign(ticket, {queue, priority, tags});
    if (internal_note && !ticket.notes.includes(internal_note)) ticket.notes.push(internal_note);
    return send(200, ticket);
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, store, patches,
    close: () => new Promise(done => { server.closeAllConnections(); server.close(done); }),
  })));
}

if (process.argv[1]?.endsWith('fake-helpdesk.mjs')) {
  const token = process.env.HELPDESK_TOKEN;
  if (!token) { console.error('Set HELPDESK_TOKEN to the token that PATCH requests must send.'); process.exit(1); }
  const tickets = JSON.parse(readFileSync(new URL('./sample-tickets.json', import.meta.url), 'utf8'));
  const desk = await startHelpdesk({token, tickets, port: Number(process.argv[2] ?? 4310)});
  console.log(`Help desk at ${desk.url} with tickets ${tickets.map(t => t.id).join(', ')}. Stop it with Ctrl-C.`);
}
