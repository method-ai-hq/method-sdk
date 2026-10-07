// Write the approved repair and its case into the Method folder, then commit them when the folder is a Git repository.
import { mkdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { input, output, hashes, changed, copyTree, sha256, readFileSync, existsSync, join, dirname } from './lib.mjs';
const { method_file, workspace, snapshot, cases_dir, cases_copy, case_id, note, decision, repair, locate, git, author } = input();
const folder = dirname(method_file), before = JSON.parse(snapshot);
const files = changed(before, hashes(workspace, []));
const now = hashes(folder, [cases_dir]);
const moved = files.filter(file => now[file] !== before[file]);
if (moved.length) throw Error(`These files changed in the Method folder after learn started: ${moved.join(', ')}. Run method learn again.`);
const methodBefore = sha256(readFileSync(method_file));
for (const file of files) {
  if (existsSync(join(workspace, file))) { mkdirSync(dirname(join(folder, file)), { recursive: true }); copyFileSync(join(workspace, file), join(folder, file)); }
  else rmSync(join(folder, file), { force: true });
}
const caseTarget = join(cases_dir, case_id);
copyTree(join(cases_copy, case_id), caseTarget, []);
writeFileSync(join(caseTarget, 'learn.json'), JSON.stringify({ note, correction: decision.correction, locate: { result: locate.result, step: locate.step, explanation: locate.explanation },
  change: repair.summary, files, method_sha256: { before: methodBefore, after: sha256(readFileSync(method_file)) }, author: author || null, at: new Date().toISOString() }, null, 2) + '\n');
let commit = '';
const inRepo = (() => { try { return execFileSync('git', ['-C', folder, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim() === 'true'; } catch { return false; } })();
if (git && inRepo) {
  const paths = [...files.map(file => join(folder, file)), caseTarget];
  execFileSync('git', ['-C', folder, 'add', '--', ...paths.filter(existsSync)]);
  const message = [`Learn: ${note.split('\n')[0].slice(0, 60)}`, '', repair.summary, '', `Learn-Note: ${note.replace(/\s+/g, ' ')}`, `Learn-Case: ${case_id}`].join('\n');
  // Commit only these paths, so other staged work stays as it is.
  execFileSync('git', ['-C', folder, 'commit', '-m', message, '--', ...paths], { stdio: ['ignore', 'pipe', 'pipe'] });
  commit = execFileSync('git', ['-C', folder, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}
output({ changed_files: files, commit, state: { outcome: { status: 'learned', message: `Saved case ${case_id} and changed ${files.join(', ')}${commit ? ` in commit ${commit}` : ''}.` } } });
