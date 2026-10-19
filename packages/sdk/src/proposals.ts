import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { authoringPath, readDocument, writeDocument } from './authoring.js';
import { DEFAULT_SERVER, type MethodClient } from './method-client.js';
import { writePrivateJson } from './files.js';
import { methodIdPattern } from './versions.js';
import { localMethodFolder } from './local-judgments.js';

/** A change to a Method: from the account (a change Method made there), or from the improvement loop on this computer. */
export type ProposalRecord = {
  id: string;
  source: 'account' | 'local';
  method_id: string | null;
  base_version_id: string | null;
  status: string;
  cause: string;
  evidence: any;
  created_at: string;
  base_workflow: unknown;
  proposed_workflow: unknown | null;
};
/** Write Method content to a file and keep its id: line. A JSON file stays JSON. */
export function writeMethodFile(file: string, id: string | undefined, content: any) {
  const { format, ...rest } = content;
  const document = { ...(format !== undefined ? { format } : {}), ...(id ? { id } : {}), ...rest };
  if (/^\s*\{/.test(readFileSync(file, 'utf8'))) {
    const temporary = `${file}.${process.pid}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(document, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temporary, file); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  } else writeDocument(file, document);
}

export const localProposalFolder = (file: string) => join(dirname(file), '.method', 'proposals');
/** Record what the improvement loop on this computer did (applied, or none) as a private file in the .method folder: it can hold run content. */
export function saveLocalProposal(file: string, record: Omit<ProposalRecord, 'source'> & Record<string, unknown>) {
  localMethodFolder(file);
  const path = join(localProposalFolder(file), `${record.id}.json`);
  writePrivateJson(path, { ...record, source: 'local', file: basename(file) });
  return path;
}
export function localProposals(file: string): (ProposalRecord & { path: string })[] {
  const folder = localProposalFolder(file);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter(name => /^lp_[a-f0-9]{16}\.json$/.test(name)).map(name => {
    const path = join(folder, name), record = JSON.parse(readFileSync(path, 'utf8'));
    return { ...record, proposed_workflow: record.proposed_workflow ?? null, path };
  }).filter(record => record.file === basename(file)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

/** Run folders of this Method on this computer, newest first, with the account run ID of each run that was saved to the account. */
export async function localRuns(file: string) {
  const { recentRuns } = await import('./current-runtime.js');
  const document = readDocument(file), runs: { dir: string; account_run_id: string | null }[] = [];
  for (const dir of recentRuns(file, Infinity)) {
    try {
      const method = JSON.parse(readFileSync(join(dir, 'method.json'), 'utf8'));
      if (typeof document.id === 'string' ? method.id !== document.id : method.name !== document.name) continue;
      const sync = existsSync(join(dir, 'method-sync.json')) ? JSON.parse(readFileSync(join(dir, 'method-sync.json'), 'utf8')) : {};
      runs.push({ dir, account_run_id: typeof sync.dashboard_id === 'string' ? sync.dashboard_id : null });
    } catch { /* not a finished run folder */ }
  }
  return runs;
}

const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
type Change = { id: string; source: 'account' | 'local'; cause: string; date: string; version_id: string | null; steps: string[] };
const changeLine = (change: Change) => `${change.date.slice(0, 10)}  ${change.version_id ?? 'not saved as a version'}  ${change.cause}`;

/** `method changes FILE`: the changes that Method applied in the account and on this computer, newest first. */
async function changesCommand(file: string, target: string, methodId: string | null, client: MethodClient, json: boolean) {
  const local: Change[] = localProposals(file).filter(p => p.status === 'applied').map((p: any) => ({ id: p.id, source: 'local', cause: p.cause, date: String(p.applied_at ?? p.created_at), version_id: p.applied_version_id ?? null, steps: p.evidence?.steps ?? [] }));
  let account: Change[] = [];
  if (methodId) {
    const { proposals } = await client.request<{ proposals: any[] }>(`/api/methods/${encodeURIComponent(methodId)}/proposals?status=accepted`);
    account = (proposals ?? []).map(p => ({ id: p.id, source: 'account', cause: String(p.cause ?? ''), date: String(p.created_at ?? ''), version_id: p.published_version_id ?? null, steps: p.evidence?.steps ?? [] }));
  } else if (!local.length) throw Error(`${target} has no id: line, so Method has not changed it. Run it once while signed in.`);
  const changes = [...account, ...local].sort((a, b) => b.date.localeCompare(a.date));
  if (json) return print({ file, method_id: methodId, changes });
  process.stdout.write(changes.length ? changes.map(changeLine).join('\n') + '\n' : `Method has not changed ${target} yet.\n`);
}

/** `method changes FILE [--json]`. */
export async function changesMain(args: string[], clientFactory: (server: string) => MethodClient) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { server: { type: 'string' }, json: { type: 'boolean' } } });
  const [target] = positionals;
  if (!target || positionals.length !== 1) throw Error('Use method changes FILE [--json].');
  const file = authoringPath(target), id = readDocument(file).id;
  const methodId = typeof id === 'string' && methodIdPattern.test(id) ? id : null;
  const client = clientFactory(values.server ?? DEFAULT_SERVER);
  if (methodId && !client.token()) await client.login();
  return changesCommand(file, target, methodId, client, !!values.json);
}
