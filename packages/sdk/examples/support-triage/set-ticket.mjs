import {helpdesk, main, ticketPath} from './helpdesk.mjs';
import {change} from './triage.mjs';

// --team-only: the move after a person's answer. It sets the chosen team's queue and adds no note.
const teamOnly = process.argv.includes('--team-only');
await main(async input => {
  const ticket = await helpdesk(input.helpdesk, ticketPath(input.ticket_id), {method: 'PATCH', body: change(input, teamOnly)});
  return {[teamOnly ? 'moved' : 'updated']: {id: ticket.id, queue: ticket.queue, priority: ticket.priority}};
});
