// Retire the earlier cases that the person chose, with their reason.
import { input, output, runtime } from './lib.mjs';
const { retire, method_file, cases_dir, case_id } = input();
const { retireCase } = await runtime();
for (const id of retire.retire_ids) await retireCase(method_file, id, { reason: retire.reason, casesDir: cases_dir });
output({ retired: retire.retire_ids, state: { outcome: retire.retire_ids.length
  ? { status: 'retired', message: `Retired ${retire.retire_ids.join(', ')}. Run method learn again with the same note to add case ${case_id} and repair the Method.` }
  : { status: 'stopped', message: 'No case was retired; the new rule conflicts with an earlier case.' } } });
