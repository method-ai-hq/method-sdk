import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseDestination } from './routing.mjs';
const classify = (choice, billing, technical, other) =>
  ({choice, probabilities: {billing, technical, other}});
test('accepts the exact threshold', () => {
  const r = chooseDestination(classify('billing', .90, .08, .02)).routing;
  assert.equal(r.destination, 'billing');
  assert.equal(r.rule_applied, 'selected_category_meets_threshold');
});
test('routes below the threshold to manual review', () => {
  const r = chooseDestination(classify('billing', .899, .081, .02)).routing;
  assert.equal(r.destination, 'manual_review');
  assert.equal(r.rule_applied, 'below_threshold');
});
test('other always requires review', () => {
  const r = chooseDestination(classify('other', 0, 0, 1)).routing;
  assert.equal(r.destination, 'manual_review');
  assert.equal(r.rule_applied, 'other_requires_review');
});
test('routes technical support independently', () => {
  assert.equal(chooseDestination(classify('technical', .03, .95, .02)).routing.destination, 'technical');
});
test('rejects missing or invalid input', () => {
  assert.throws(() => chooseDestination(null));
  assert.throws(() => chooseDestination(classify('billing', .9, .9, 0)));
});
