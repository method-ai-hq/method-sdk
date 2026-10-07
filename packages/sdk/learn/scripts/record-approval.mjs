import { input, output } from './lib.mjs';
const { approval } = input();
output({ approved: approval.approved, state: { approved_change: approval.approved, outcome: approval.approved
  ? { status: 'in_progress', message: 'The change was approved.' }
  : { status: 'stopped', message: `The change was not approved. ${approval.comment}`.trim() } } });
