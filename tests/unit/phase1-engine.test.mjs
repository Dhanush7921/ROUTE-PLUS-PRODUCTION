// Unit tests for the Phase 1 engine: scoring, trip impact and sample planner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRecommendationScore, getRecommendedPlaces, DEFAULT_FILTERS } from '../../shared/engine/recommend.js';
import { calculateTripImpact, suggestRemovals } from '../../shared/engine/tripImpact.js';
import { createMockPlanner } from '../../shared/engine/mockPlanner.js';

const planner = createMockPlanner();
const baseState = over => ({ travelerType: 'Family', interests: ['Nature', 'Devotional', 'Food'], selectedStops: [], skippedPlaces: [], currentPhaseId: 'all', filters: { ...DEFAULT_FILTERS }, ...over });

test('score breakdown adds up and reasons come from data', async () => {
  const plan = await planner.plan({ origin: 'visakhapatnam', destination: 'MANALI' });
  const waterfall = plan.places.find(p => p.name === 'Forest waterfall');
  const r = calculateRecommendationScore(waterfall, { travelerType: 'Family', interests: ['Nature'] }, { remainingMinutes: 1000 });
  assert.equal(r.score, r.breakdown.reduce((n, b) => n + b.value, 0));
  assert.ok(r.reasons.some(x => x.startsWith('Matches Nature')));
  assert.ok(r.reasons.includes('Suitable for Family'));
  assert.ok(r.meaningful);
});

test('closed places are never recommended; poor fit is penalised', async () => {
  const plan = await planner.plan({ origin: 'Delhi', destination: 'Jaipur' });
  const closed = plan.places.find(p => p.openNow === false);
  const recs = getRecommendedPlaces(plan.places, baseState({ interests: ['Adventure', 'Hidden Gems'], travelerType: 'Adventure' }), { remainingMinutes: 5000 });
  assert.ok(!recs.some(p => p.id === closed.id));
  const fort = plan.places.find(p => p.name === 'Old fort walk');
  const r = calculateRecommendationScore(fort, { travelerType: 'Family', interests: ['Heritage'] }, {});
  assert.ok(r.breakdown.some(b => b.value === -20 && /fit/i.test(b.label)));
});

test('skipped and selected places leave the recommendation list without mutating data', async () => {
  const plan = await planner.plan({ origin: 'Delhi', destination: 'Jaipur' });
  const count = plan.places.length;
  const recs = getRecommendedPlaces(plan.places, baseState({ skippedPlaces: ['delhi-jaipur-place-1'], selectedStops: ['delhi-jaipur-place-3'] }), { remainingMinutes: 5000 });
  assert.ok(!recs.some(p => ['delhi-jaipur-place-1', 'delhi-jaipur-place-3'].includes(p.id)));
  assert.equal(plan.places.length, count);
});

test('trip impact: FITS → NEAR → EXCEEDS and 4-day estimate for the demo', () => {
  const stop = { detourDistanceKm: 12, detourTimeMinutes: 25, visitDurationMinutes: 60 };
  const none = calculateTripImpact({ originalDays: 3, baseTravelMinutes: 300 });
  assert.equal(none.fit, 'fits');
  const near = calculateTripImpact({ originalDays: 3, baseTravelMinutes: 1740 });
  assert.equal(near.fit, 'near');
  const over = calculateTripImpact({ originalDays: 3, baseTravelMinutes: 1740, selectedStops: [stop] });
  assert.equal(over.fit, 'exceeds');
  assert.equal(over.estimatedDays, 4);
  assert.equal(over.extraDistanceKm, 12);
  const extended = calculateTripImpact({ originalDays: 3, tripDays: 4, baseTravelMinutes: 1740, selectedStops: [stop] });
  assert.equal(extended.fit, 'fits');
  assert.equal(extended.exceedsOriginalDuration, true);
  assert.equal(extended.exceedsPlannedDuration, false);
});

test('suggestRemovals picks the costliest stops first until enough time is recovered', () => {
  const a = { id: 'a', detourTimeMinutes: 10, visitDurationMinutes: 20 };
  const b = { id: 'b', detourTimeMinutes: 60, visitDurationMinutes: 90 };
  assert.deepEqual(suggestRemovals([a, b], 40).map(p => p.id), ['b']);
});

test('unknown route gives a coded error with suggestions', async () => {
  await assert.rejects(planner.plan({ origin: 'Pune', destination: 'Mars' }), e => e.code === 'ROUTE_NOT_SUPPORTED' && e.details.suggestions.length === 5);
});
