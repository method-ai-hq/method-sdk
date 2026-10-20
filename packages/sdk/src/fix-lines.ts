// Every line that a fix shows to the person. The words are about the person's work: no Method internals (no case,
// step, criterion, judge, version, IDs, paths or run counts). testkit/sdk/fix-lines.test.ts scans these lines.

/** What the fix loop did with one correction. */
export type OutcomeKind = 'fixed' | 'no_fix_found' | 'could_not_test' | 'question' | 'held' | 'not_reproduced' | 'not_fixable_here' | 'already_changed' | 'retry' | 'elsewhere';
export type CouldNotTestReason = 'missing_file' | 'can_send' | 'too_large' | 'no_live_step';
/** The output that a tested fix gave, so the agent can show it without running the Method again. */
export type TestedOutput = { result?: unknown; files?: Record<string, string>; held_back?: Array<{ tool: string; args: unknown }> };
export type CorrectionOutcome = {
  id: string; outcome: OutcomeKind;
  /** fixed: what is different now, in the person's words ("replies now include the redline"). */
  summary?: string;
  /** could_not_test: why. */
  reason?: CouldNotTestReason;
  /** question: one question in the person's terms. */
  question?: string;
  /** no_fix_found: how many changes were tried. */
  tried?: number;
  /** fixed: how often the fix passed on this result, and on how many earlier results it was checked. */
  tested?: { times: number; earlier: number };
  /** The thing the Method works on, as a plain noun ("NDA", "reply"); the lines say "result" without it. */
  subject?: string;
  /** could_not_test can_send: what the agent can send ("email"). */
  sends?: string;
  /** could_not_test: the note was added as a learned rule that later runs check. */
  rule_added?: boolean;
  /** held and already_changed: the other person; held: what they asked for. */
  by?: string; detail?: string;
  /** missing_file: the file that is gone. For --json only; never in a line. */
  path?: string;
  tested_output?: TestedOutput;
  /** retry: another correction's fix changed the same part, so this one is fixed again on the new file in the next pass. */
  again?: boolean;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const thing = (o: Pick<CorrectionOutcome, 'subject'>) => o.subject?.trim() ? `this ${o.subject.trim()}` : 'this result';
const sentence = (text: string) => text.trim().replace(/[.\s]+$/, '');
const kept = (o: CorrectionOutcome) => o.rule_added ? 'I added your note as a rule and will check it on the next runs.' : "I'll keep your note.";
const quoted = (text: string | undefined) => text?.trim() ? ` ("${sentence(text).slice(0, 200)}")` : '';

/** The line after method judge: the fix runs in the background. */
export const workingLine = 'Working on it. I\'ll test a fix on this run.';
export const workingAnswerLine = 'Thanks. Working on it with your answer. I\'ll test a fix on this run.';
export const waitingLine = (n: number) => n === 1 ? 'Working on a correction that was waiting. I\'ll test a fix for it.' : `Working on ${n} corrections that were waiting. I'll test a fix for each.`;
export const stillWorkingLine = 'Still working on it. Run method wait again.';
export const nothingWaitingLine = 'Nothing is being fixed on this computer.';
export const notHereLine = 'Noted. The agent is not on this computer, so the next time it runs on a computer I\'ll test a fix there.';
export const approvedLine = 'Noted: this result is right.';
export const stoppedLine = 'The fix stopped before it finished. I\'ll try again on the next run.';
export const errorLine = (message: string) => `The fix stopped: ${sentence(message)}. I'll try again on the next run.`;
export const undoneLine = (what?: string) => what?.trim() ? `Undone: ${sentence(what)}. The agent works as it did before.` : 'Undone. The agent works as it did before the last change.';
export const removedRuleLine = (rule: string) => `Removed: "${sentence(rule)}". Undo: method undo.`;
/** The line after a pruning change: what the sweep says it did (improve.method's summary), and how to undo it. */
export const prunedLine = (summary: string) => `${sentence(summary)}. Undo: method undo.`;
/** A fix that broke an earlier result in the later check is undone, and its correction waits for a new fix. */
export const fixUndoneLine = (note: string | undefined) => `I undid the fix for your correction${quoted(note)}: it changed a result that was right before. I'll try a new fix on the next run.`;
/** A rule that a pruning change removed came back because its problem came back. */
export const ruleBackLine = (rule: string) => `I put back the rule "${sentence(rule)}": without it, a problem you corrected came back.`;
export const cameBackLine = (note: string | undefined) => `A problem you corrected came back twice${quoted(note)}. I'll test a new fix. To go back to how it worked before the last change: method undo.`;
export const testedOutputHeading = 'What the fixed agent gives now (tested; nothing was sent):';
export const heldBackHeading = 'What it would send (held back during the test):';

/** The one line for what the loop did with a correction. */
export function outcomeLine(o: CorrectionOutcome): string {
  switch (o.outcome) {
    case 'fixed': {
      const tested = o.tested ? ` Tested ${plural(o.tested.times, 'time')} on ${thing(o)}${o.tested.earlier ? ` and on ${plural(o.tested.earlier, 'earlier one')}` : ''}.` : '';
      return `Fixed${o.summary?.trim() ? `: ${sentence(o.summary)}` : ''}.${tested} Undo: method undo.`;
    }
    case 'no_fix_found':
      return `No fix found yet: I tried ${o.tried ? plural(o.tried, 'change') : 'several changes'}; none fixed ${thing(o)} reliably. ${kept(o)}`;
    case 'could_not_test': {
      const why = o.reason === 'can_send' ? `this agent can send ${o.sends?.trim() || 'messages'}`
        : o.reason === 'missing_file' ? `a file that ${thing(o)} came from is no longer on this computer`
        : o.reason === 'too_large' ? `${thing(o)} came from more files than I can copy to test with`
        : 'my change did not reach the part of the agent that made this result';
      return `Could not test a fix safely: ${why}. ${kept(o)}`;
    }
    case 'question': return `I have one question before I change anything: ${o.question?.trim() ?? ''}`;
    case 'held': return `Not changed: ${o.by ?? 'someone else'} wants a different result here${quoted(o.detail)}. Decide with them which one is right.`;
    case 'not_reproduced': return `This mistake happens only sometimes, and I could not make it happen again. ${kept(o)} Tell me if you see it again.`;
    case 'not_fixable_here': return 'This does not come from how the agent works: it likely comes from the input, the data, or a tool it uses. I\'ll keep your note.';
    case 'already_changed': return `Not changed: ${o.by ? `${o.by} changed` : 'someone changed'} this part of the agent after this result, which may already fix it.`;
    case 'retry': return 'Not changed yet: the agent changed while I tested a fix. I\'ll try again on the next run.';
    case 'elsewhere': return 'Another computer is testing a fix for this.';
  }
}

/** The line for the agent after a question: it shows the question and sends the answer. Not for the person. */
export const answerNext = (judgmentId: string) => `Show this question to the person word for word, and do not answer it yourself. Send their answer with: method answer ${judgmentId} "THEIR WORDS"`;

/** Two people judged the same result in opposite ways. */
export type HeldPerson = { verdict: string; noted_by: string | null; note: string | null };
export function heldPairLine(people: HeldPerson[]) {
  const said = (j: HeldPerson) => `${j.noted_by ?? 'Someone'} says it is ${j.verdict}${quoted(j.note ?? undefined)}`;
  return `Two people disagree about this result: ${people.map(said).join('; ')}. Nothing changes until one is kept.`;
}

/** A correction as a person reads it: "Gráinne's correction ("the note")", or "A correction ("the note")". */
export const correctionName = (c: { author?: string | null; note?: unknown }) => `${c.author ? `${c.author}'s correction` : 'A correction'}${quoted(String(c.note ?? ''))}`;
/** The run notice when the Method changed since its earlier corrections were checked. */
export const uncheckedLine = (count: number, named: string[], command: string) =>
  `${plural(count, 'earlier correction')} ${count === 1 ? 'was' : 'were'} not checked since this agent changed${named.length ? ` (${named.join('; ')})` : ''}. Check ${count === 1 ? "it" : "them"}: ${command}`;
