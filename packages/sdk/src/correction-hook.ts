import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { removeTree } from './files.js';

// The person's correction reaches Method directly, in their words. The Method plugin's hook runs this when the person
// sends a message in Claude Code or Codex. When a Method ran in the project during this chat, one classify step
// (Method's classifier: a model's decision, with its probability) decides whether the message corrects or approves the
// result of the newest run. A correction is recorded against that run with the whole message, word for word, as its
// note (method judge RUN wrong --note MESSAGE), and its fix starts; an approval is recorded right. The task agent does not
// choose whether to record it or which run: the hook tells it what Method recorded. When the classifier cannot run
// (signed out, offline), the agent is told the run and the command, as before.

/** What the hook reads on stdin: the person's message, the project folder, and the chat's transcript. */
type HookInput = { prompt?: string; cwd?: string; transcript_path?: string };
export type Decision = { choice: 'correction' | 'approval' | 'other'; probability: number };

const QUESTION = 'A person ran a workflow and read its result, shown first. Then they sent the message shown second. What does the message do?';
const OPTIONS = {
  correction: 'Correction: it says that the result, or a part of it, is wrong, missing something, or should be different, or it gives a rule for such results.',
  approval: 'Approval: it accepts the result or says that it is right, and asks for no change.',
  other: 'Other: it is about something else, such as a new task, a question, or another topic.',
};

/** The classify step of the hook; tests replace decide. */
export const correctionClassifier = {
  async decide(result: string, message: string): Promise<Decision | undefined> {
    const dir = mkdtempSync(join(tmpdir(), 'method-correction-'));
    try {
      const file = join(dir, 'correction.method');
      writeFileSync(file, JSON.stringify({ format: 'method/3.4', name: 'Correction or not', goal: 'Decide whether a message corrects the result of a run.',
        inputs: { result: { type: 'text', description: 'The result of the run.' }, message: { type: 'text', description: 'The person\'s message.' } },
        steps: { decide: { name: 'Decide', in: { result: 'inputs.result', message: 'inputs.message' }, do: { kind: 'classify', question: QUESTION, options: OPTIONS }, out: 'decision' } },
        result: 'decision' }, null, 2));
      const { preparedConfig } = await import('./quality.js');
      const prepared: any = await preparedConfig(file, {});
      if (!prepared.config.classification) return undefined;
      const { runMethod } = await import('@withmethod/runtime/runner.js');
      const run: any = await runMethod(file, prepared.config, { runDir: join(dir, 'run'), inputs: { result, message }, fresh: true, ...(prepared.classification ? { classification: prepared.classification } : {}) } as any);
      const value = run.status === 'completed' ? run.result : undefined;
      const choice = value?.choice;
      return choice === 'correction' || choice === 'approval' || choice === 'other' ? { choice, probability: Number(value.probabilities?.[choice] ?? 0) } : undefined;
    } catch { return undefined; } finally { removeTree(dir); }
  },
};

/** The text of a run's result for the classifier: its result value, cut to 8000 characters. */
function resultText(runDir: string) {
  try {
    const value = JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8'));
    const result = value?.result ?? value;
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return text.length > 8000 ? `${text.slice(0, 8000)}…` : text;
  } catch { return ''; }
}

/** The newest run of the Methods in a folder (up to 3 levels down), with its Method file. */
export async function newestRun(dir: string) {
  const { newestRunOf } = await import('./local-judgments.js');
  const files: string[] = [];
  const walk = (sub: string, depth: number) => {
    let entries: import('node:fs').Dirent[] = [];
    try { entries = readdirSync(sub, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (['.method', '.method-runs', 'node_modules', 'cases', '.git', '.fix'].includes(e.name)) continue;
      const path = join(sub, e.name);
      if (e.isDirectory() && depth < 3) walk(path, depth + 1); else if (e.isFile() && e.name.endsWith('.method')) files.push(path);
    }
  };
  walk(resolve(dir), 0);
  return files.map(file => ({ file, run: newestRunOf(file) })).filter(r => r.run).sort((a, b) => b.run!.at - a.run!.at)[0] as { file: string; run: { dir: string; id: string; at: number } } | undefined;
}

/** The hook's answer: context for the agent, in the shape that Claude Code and Codex read. */
const context = (text: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } });

/**
 * `method __correction [DIR]` with the hook's JSON on stdin: decide whether the person's message corrects or approves
 * the newest run, record it, and print what the agent should know. Prints nothing when no Method ran in this chat.
 * record: what records a judgment (method judge); tests replace it.
 */
export async function correctionHook(input: HookInput, dir: string, record: (args: string[]) => Promise<{ ok: boolean; text: string }>): Promise<string | undefined> {
  const message = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!message) return undefined;
  const newest = await newestRun(dir);
  if (!newest) return undefined;
  // Only a run of this chat: it started after the chat's transcript was made.
  if (input.transcript_path) { try { if (newest.run.at < statSync(input.transcript_path).birthtimeMs) return undefined; } catch { /* no transcript: every run counts */ } }
  const { run, file } = newest, name = basename(file);
  const { maxNoteLength } = await import('./judge.js');
  const ask = `The newest run of a Method in this project is ${run.id} (${name}). If this message corrects or approves its result, record it before anything else: method judge ${run.id} wrong --note "THEIR WORDS" (or method judge ${run.id} right).`;
  if (message.length > maxNoteLength) return context(ask);
  const decision = await correctionClassifier.decide(resultText(run.dir), message);
  if (!decision) return context(ask);
  const percent = `${Math.round(decision.probability * 100)}%`;
  if (decision.choice === 'other') return undefined;
  const done = await record(decision.choice === 'correction' ? [run.id, 'wrong', '--note', message] : [run.id, 'right']);
  if (!done.ok) return context(`Method's classifier read this message as ${decision.choice === 'correction' ? 'a correction' : 'an approval'} of run ${run.id} (${name}), ${percent} sure, but could not record it: ${done.text} ${ask}`);
  return context(decision.choice === 'correction'
    ? `Method recorded this message, word for word, as a correction of run ${run.id} of ${name} (its classifier's reading, ${percent} sure), and is testing a fix of the Method in the background: ${done.text} Do not run method judge for this message, and do not edit the Method for it yourself. If the person wants the corrected result now, run method wait and show its line. If they did not mean to correct that run, tell them, and run method undo after the fix if they ask.`
    : `Method recorded this message as an approval of run ${run.id} of ${name} (its classifier's reading, ${percent} sure). Do not run method judge for it.`);
}

/** `method __correction [DIR]`: the hook's command. */
export async function correctionHookCommand(args: string[]) {
  let input: HookInput = {};
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { return; }
  const dir = args[0] ?? input.cwd ?? process.cwd();
  const { spawnSync } = await import('node:child_process');
  // method judge in its own process, as the agent would run it, so its fix starts the same way.
  const record = async (judge: string[]) => {
    const done = spawnSync(process.execPath, [...process.execArgv, process.argv[1]!, 'judge', ...judge], { cwd: dir, encoding: 'utf8', env: process.env, timeout: 60_000 });
    const text = `${done.stdout ?? ''}`.trim() || `${done.stderr ?? ''}`.trim().split('\n').at(-1) || '';
    return { ok: done.status === 0, text };
  };
  const out = await correctionHook(input, dir, record);
  if (out) process.stdout.write(out + '\n');
}
