import { input, output } from './lib.mjs';
const { decision } = input();
output({ confirmed: decision.proceed, state: { proceed: decision.proceed, outcome: decision.proceed
  ? { status: 'in_progress', message: 'The cause was confirmed.' }
  : { status: 'stopped', message: `The person did not confirm the cause. ${decision.correction}`.trim() } } });
