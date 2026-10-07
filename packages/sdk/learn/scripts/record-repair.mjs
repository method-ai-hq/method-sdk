import { input, output } from './lib.mjs';
const { repair } = input();
const repaired = repair.result === 'repaired', conflict = repair.result === 'spec_conflict';
output({ repaired, state: { repaired, conflict, outcome: repaired
  ? { status: 'in_progress', message: `Repair passed the gate: ${repair.summary}` }
  : { status: 'conflict', message: `The new case conflicts with ${repair.conflicting_cases.join(', ')}: ${repair.summary}` } } });
