import {main} from './helpdesk.mjs';
import {route} from './triage.mjs';

await main(async ({team, refund, urgency}) => ({decision: route(team, refund, urgency)}));
