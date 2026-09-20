export function chooseDestination(category) {
  const ids = ['billing', 'technical', 'other'];
  if (!category || !ids.includes(category.choice)) {
    throw new Error('Expected a declared category.');
  }
  const probabilities = category.probabilities;
  if (!probabilities || Object.keys(probabilities).length !== ids.length ||
      ids.some(id => !Object.hasOwn(probabilities, id) ||
        !Number.isFinite(probabilities[id]) ||
        probabilities[id] < 0 || probabilities[id] > 1)) {
    throw new Error('Expected one valid probability per category.');
  }
  if (Math.abs(ids.reduce((sum, id) => sum + probabilities[id], 0) - 1) > 1e-6 ||
      probabilities[category.choice] + 1e-6 < Math.max(...ids.map(id => probabilities[id]))) {
    throw new Error('Expected a valid distribution and a maximum-probability choice.');
  }
  const required = 0.90;
  const observed = probabilities[category.choice];
  const automatic = category.choice !== 'other' && observed >= required;
  return {
    routing: {
      destination: automatic ? category.choice : 'manual_review',
      rule_applied: category.choice === 'other' ? 'other_requires_review' :
        automatic ? 'selected_category_meets_threshold' : 'below_threshold',
      selected_probability: observed,
      required_probability: required
    }
  };
}
