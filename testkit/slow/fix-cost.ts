/** Live fix benchmark. Input: JSON {snapshot, method, inputFolder, expected, feedbackWriter, correction:{id}, output}.
 * Uses a private snapshot and the real learner and gate. It writes raw stage costs and
 * the actual number of active earlier checks. No judgment is sent to an account.
 * Run with METHOD_CONFIG_DIR set to an empty folder and a source CLI on PATH.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { learnCorrection, learnerAgent } from '../../packages/sdk/src/learner.js';
import { correctionCaseId, learnerModel } from '../../packages/sdk/src/improve.js';
import { runCases, preparedConfig } from '../../packages/sdk/src/quality.js';
import { runCurrentMethod } from '../../packages/sdk/src/current-runtime.js';
import { readDocument } from '../../packages/sdk/src/authoring.js';
import { listCases } from '@withmethod/runtime/cases.js';

const spec = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const output = resolve(spec.output);
if (existsSync(output)) throw Error(`Output already exists: ${output}`);
mkdirSync(output, { recursive: true });
const project = join(output, 'project');
cpSync(spec.snapshot, project, { recursive: true });
const file = join(project, spec.method);
// A fresh source run freezes the actual task input. Borrowing an old run whose files
// have since changed would test another document against the correction's answers.
const sourceStart = Date.now();
{
  rmSync(join(project, 'matter'), { recursive: true, force: true });
  cpSync(spec.inputFolder, join(project, 'matter'), { recursive: true });
  const prepared = await preparedConfig(file, {}, { judge: false });
  const runDir = join(output, 'source-run');
  const ran = await runCurrentMethod(file, prepared.config, { runDir, fresh: true, processPath: prepared.processPath, prepareBundle: prepared.prepareBundle });
  if (ran.status !== 'completed') throw Error(JSON.stringify(ran.failure));
  const feedback = JSON.parse(execFileSync('python3', ['-I', spec.feedbackWriter], { encoding: 'utf8', input: JSON.stringify({
    output: JSON.stringify(ran.result), expected: JSON.parse(readFileSync(spec.expected, 'utf8')),
  }) }));
  spec.correction = { ...spec.correction, run_dir: runDir, note: feedback.correction };
  if (!feedback.correction) {
    writeFileSync(join(output, 'report.json'), JSON.stringify({ earlier_checks: (await listCases(file)).filter((c: any) => c.status === 'active').length, outcomes: [{ outcome: 'was_right' }], seconds: 0, uncached_tokens: 0 }) + '\n');
    console.log('The source run was right; no correction was needed.');
    process.exit(0);
  }
}
const earlier = (await listCases(file)).filter((c: any) => c.status === 'active');
const usage = (folder: string) => {
  const result = { uncached_tokens: 0, cached_tokens: 0 };
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === 'events.jsonl') for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
        const event = JSON.parse(line);
        if (!['codex.completed', 'agent.completed', 'model.response'].includes(event.event)) continue;
        for (const u of Array.isArray(event.usage) ? event.usage : event.usage ? [event.usage] : []) {
          const cached = Number(u.cached_input_tokens ?? u.cache_read_input_tokens ?? 0);
          result.cached_tokens += cached;
          result.uncached_tokens += Number(u.input_tokens ?? u.prompt_tokens ?? 0) - ('cached_input_tokens' in u ? cached : 0)
            + Number(u.output_tokens ?? u.completion_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
        }
      }
    }
  };
  walk(folder);
  return result;
};
const stages: any[] = [], start = Date.now();
const session = learnerAgent.session;
learnerAgent.session = async input => {
  const started = Date.now();
  const result = await session(input);
  stages.push({ kind: 'session', seconds: (Date.now() - started) / 1000, ...usage(input.workDir), status: result.status });
  console.error(JSON.stringify(stages.at(-1)));
  return result;
};
let gate = 0;
const learned = await learnCorrection(file, [spec.correction], {
  earlier: earlier.map((c: any) => ({ id: c.id, note: c.note, noted_by: c.author, created_at: c.created, outcome: 'fixed' })),
  caseIds: [correctionCaseId(spec.correction.id)], model: await learnerModel(readDocument(file)), workDir: join(output, 'work'),
  runCases: async (candidate, flags, options) => {
    const started = Date.now(), keepDir = join(output, 'gate', String(++gate));
    const report = await runCases(candidate, flags, { ...options, keepDir });
    stages.push({ kind: 'gate', seconds: (Date.now() - started) / 1000, cases: options.ids, ...usage(keepDir), counts: report.counts });
    console.error(JSON.stringify(stages.at(-1)));
    return report;
  },
});
const report = { earlier_checks: earlier.length, source_seconds: (start - sourceStart) / 1000, source_usage: usage(join(output, 'source-run')), seconds: (Date.now() - start) / 1000,
  uncached_tokens: stages.reduce((n, s) => n + s.uncached_tokens, 0), cached_tokens: stages.reduce((n, s) => n + s.cached_tokens, 0),
  tries: learned.tries, outcomes: learned.outcomes, changed: learned.changed, stages };
writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, earlier_checks: report.earlier_checks, seconds: report.seconds, uncached_tokens: report.uncached_tokens, outcomes: report.outcomes.map(o => o.outcome) }));
