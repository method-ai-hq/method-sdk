import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {route, change} from './triage.mjs';
import {startHelpdesk} from './fake-helpdesk.mjs';

const team = (choice, p) => ({choice, probabilities: {billing: 0, technical: 0, account: 0, unclear: 0, [choice]: p}});
const no = {answer: false, probability: 0.1};
const normal = {level: 'normal', score: 1, probabilities: {low: 0, normal: 1, high: 0, urgent: 0}};

test('a clear team at the threshold gets its own queue', () => {
  const decision = route(team('billing', 0.8), no, normal);
  assert.deepEqual(decision, {priority: 'normal', tags: [], queue: 'billing', needs_person: false, rule: 'team_meets_threshold', reason: 'the classifier chose billing with 80% probability'});
});
test('a team below the threshold goes to triage for a person', () => {
  const decision = route(team('technical', 0.79), no, normal);
  assert.equal(decision.queue, 'triage');
  assert.equal(decision.needs_person, true);
  assert.equal(decision.rule, 'team_below_threshold');
});
test('unclear always goes to triage, whatever its probability', () => {
  const decision = route(team('unclear', 1), no, normal);
  assert.equal(decision.rule, 'team_unclear');
  assert.equal(decision.needs_person, true);
});
test('a refund probability of at least 50% adds the tag, and urgency sets the priority', () => {
  const decision = route(team('billing', 0.95), {answer: true, probability: 0.5}, {...normal, level: 'urgent'});
  assert.deepEqual(decision.tags, ['refund_request']);
  assert.equal(decision.priority, 'urgent');
  assert.deepEqual(route(team('billing', 0.95), {answer: false, probability: 0.49}, normal).tags, []);
});
test('invalid classifier results are refused', () => {
  assert.throws(() => route({choice: 'sales', probabilities: {}}, no, normal));
  assert.throws(() => route(team('billing', 0.9), {answer: 'yes', probability: 0.5}, normal));
  assert.throws(() => route(team('billing', 0.9), no, {level: 'critical'}));
});
test('the move after a person accepts only a team and adds no note', () => {
  assert.deepEqual(change({queue: ' Account ', priority: 'high', tags: []}, true), {queue: 'account', priority: 'high', tags: []});
  assert.throws(() => change({queue: 'triage', priority: 'high', tags: []}, true), /must be one of billing, technical, account/);
  assert.throws(() => change({queue: 'billing', priority: 'high', tags: []}), /reply draft/);
});

const run = promisify(execFile);
const script = (name, input, args = [], token = 'test-token') => {
  const child = run(process.execPath, [fileURLToPath(new URL(name, import.meta.url)), ...args], {env: {...process.env, HELPDESK_TOKEN: token}});
  child.child.stdin.end(JSON.stringify(input));
  return child.then(({stdout}) => JSON.parse(stdout));
};

test('the scripts read and change a ticket with the token, and a repeat sets the same values', async t => {
  const tickets = JSON.parse(readFileSync(new URL('./sample-tickets.json', import.meta.url), 'utf8'));
  const desk = await startHelpdesk({token: 'test-token', tickets});
  t.after(() => desk.close());
  const read = await script('read-ticket.mjs', {ticket_id: 'T-1042', helpdesk: desk.url});
  assert.equal(read.ticket.subject, 'Charged twice this month');
  const input = {ticket_id: 'T-1042', helpdesk: desk.url, queue: 'billing', priority: 'high', tags: ['refund_request'], note: 'Draft reply'};
  const first = await script('set-ticket.mjs', input), second = await script('set-ticket.mjs', input);
  assert.deepEqual(first, {updated: {id: 'T-1042', queue: 'billing', priority: 'high'}});
  assert.deepEqual(second, first);
  assert.deepEqual(desk.store.get('T-1042').notes, ['Draft reply']);
  const moved = await script('set-ticket.mjs', {...input, queue: 'account'}, ['--team-only']);
  assert.deepEqual(moved, {moved: {id: 'T-1042', queue: 'account', priority: 'high'}});
  await assert.rejects(script('set-ticket.mjs', input, [], 'wrong-token'), /401/);
  await assert.rejects(script('read-ticket.mjs', {ticket_id: 'T-9999', helpdesk: desk.url}), /404/);
});
