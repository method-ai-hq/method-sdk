import {helpdesk, main, ticketPath} from './helpdesk.mjs';

await main(async ({ticket_id, helpdesk: base}) => {
  const ticket = await helpdesk(base, ticketPath(ticket_id));
  if (ticket.id !== ticket_id || typeof ticket.subject !== 'string' || typeof ticket.body !== 'string')
    throw Error(`The help desk did not return ticket ${ticket_id} with a subject and a body.`);
  return {ticket: {id: ticket.id, subject: ticket.subject, body: ticket.body}};
});
