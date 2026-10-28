// Every line that a fix shows to the person. The words are about the person's work: no Method internals (no case,
// step, criterion, judge, version, IDs, paths or run counts). testkit/sdk/fix-lines.test.ts scans these lines.

/** What the fix loop did with one correction. */
export type OutcomeKind = 'fixed' | 'no_change_needed' | 'no_fix_found' | 'could_not_test' | 'question' | 'held' | 'already_changed' | 'retry' | 'elsewhere';
export type CouldNotTestReason = 'missing_file' | 'can_send' | 'too_large' | 'no_live_step';
/** The output that a tested fix gave, so the agent can show it without running the Method again. */
export type TestedOutput = { result?: unknown; files?: Record<string, string>; held_back?: Array<{ tool: string; args: unknown }> };
export type CorrectionOutcome = {
  id: string; outcome: OutcomeKind;
  /** fixed: what is different now, in the person's words ("replies now include the redline"). */
  summary?: string;
  /** fixed: the change, as a unified diff of the Method's files. For --json and the comparison only; never in a line. */
  diff?: string;
  /** could_not_test: why. */
  reason?: CouldNotTestReason;
  /** question: one question in the person's terms. */
  question?: string;
  /** fixed: how often the fix passed on this result, and on how many earlier results it was checked. */
  tested?: { times: number; earlier: number };
  /** held and already_changed: the other person; held: what they asked for. no_change_needed, no_fix_found, could_not_test: why, in plain words. */
  by?: string; detail?: string;
  /** missing_file: the file that is gone. For --json only; never in a line. */
  path?: string;
  tested_output?: TestedOutput;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sentence = (text: string) => text.trim().replace(/[.\s]+$/, '');
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
export const cameBackLine = (note: string | undefined) => `A problem you corrected came back twice${quoted(note)}. I'll test a new fix. To go back to how it worked before the last change: method undo.`;
export const testedOutputHeading = 'What the fixed agent gives now (tested; nothing was sent):';
export const heldBackHeading = 'What it would send (held back during the test):';

/** The one line for what the loop did with a correction. */
export function outcomeLine(o: CorrectionOutcome): string {
  const why = (text: string | undefined, fallback: string) => text?.trim() ? sentence(text) : fallback;
  switch (o.outcome) {
    case 'fixed': {
      const tested = o.tested ? ` Tested ${plural(o.tested.times, 'time')} on this result${o.tested.earlier ? ` and on ${plural(o.tested.earlier, 'earlier one')}` : ''}.` : '';
      return `Fixed${o.summary?.trim() ? `: ${sentence(o.summary)}` : ''}.${tested} Undo: method undo.`;
    }
    case 'no_change_needed': return `No change needed: ${why(o.detail, 'this result already does what you asked')}. I kept your note as a check for later changes.`;
    case 'no_fix_found': return `No fix found yet: ${why(o.detail, 'no change fixed this result without breaking another')}. I'll keep your note.`;
    case 'could_not_test': {
      const reason = o.reason === 'can_send' ? 'this agent can send or change things outside this computer'
        : o.reason === 'missing_file' ? 'a file that this result came from is no longer on this computer'
        : o.reason === 'too_large' ? 'this result came from more files than I can copy to test with'
        : 'my change did not reach the part of the agent that made this result';
      return `Could not test a fix safely: ${reason}. I'll keep your note.`;
    }
    case 'question': return `I have one question before I change anything: ${o.question?.trim() ?? ''}`;
    case 'held': return `Not changed: ${o.by ?? 'someone else'} wants a different result here${quoted(o.detail)}. Decide with them which one is right.`;
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
