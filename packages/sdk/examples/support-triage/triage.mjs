// The rules of support-triage.method: the routing rule and the ticket change. No requests; the tests import them.
export const TEAM_THRESHOLD = 0.8;
export const REFUND_THRESHOLD = 0.5;
export const TEAMS = ['billing', 'technical', 'account'];
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

const probability = value => Number.isFinite(value) && value >= 0 && value <= 1;

/** Chooses the queue, priority, and tags from the three classifier results. */
export function route(team, refund, urgency) {
  const options = [...TEAMS, 'unclear'];
  if (!options.includes(team?.choice) || !options.every(id => probability(team.probabilities?.[id])))
    throw Error('Expected a team choice with one probability per option.');
  if (typeof refund?.answer !== 'boolean' || !probability(refund.probability))
    throw Error('Expected a yes or no (true or false) refund answer with the probability of yes.');
  if (!PRIORITIES.includes(urgency?.level)) throw Error('Expected an urgency level.');

  const chosen = team.probabilities[team.choice];
  const base = {priority: urgency.level, tags: refund.probability >= REFUND_THRESHOLD ? ['refund_request'] : []};
  const percent = `${Math.round(chosen * 100)}% probability`;
  if (team.choice === 'unclear')
    return {...base, queue: 'triage', needs_person: true, rule: 'team_unclear', reason: 'the classifier could not choose a team'};
  if (chosen < TEAM_THRESHOLD)
    return {...base, queue: 'triage', needs_person: true, rule: 'team_below_threshold', reason: `the classifier chose ${team.choice} with only ${percent}`};
  return {...base, queue: team.choice, needs_person: false, rule: 'team_meets_threshold', reason: `the classifier chose ${team.choice} with ${percent}`};
}

/** The PATCH body. After a person's answer (teamOnly), the queue must be a team and no note is added. */
export function change({queue, priority, tags, note}, teamOnly = false) {
  const queues = teamOnly ? TEAMS : [...TEAMS, 'triage'];
  const target = teamOnly ? String(queue ?? '').trim().toLowerCase() : queue;
  if (!queues.includes(target)) throw Error(`The queue must be one of ${queues.join(', ')}, not "${queue}".`);
  if (!PRIORITIES.includes(priority)) throw Error(`Unknown priority "${priority}".`);
  if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string')) throw Error('Expected a list of tags.');
  if (teamOnly) return {queue: target, priority, tags};
  if (typeof note !== 'string') throw Error('Expected the reply draft as the note.');
  return {queue: target, priority, tags, internal_note: note};
}
