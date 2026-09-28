// PRODUCTION STEP 5 — real trip impact.
//
// The journey-time arithmetic every traveller decision rests on:
//   main-route driving + real road-network detour time + time at the places
//   → workload → required days → FITS / NEAR LIMIT / EXCEEDS
// Built on the existing tripImpact/schedule engines; these tests check the
// numbers, the cumulative behaviour across several stops, the keep/extend/
// remove paths, and that a figure is never described as road-measured when it
// was estimated, or as live OSM when the curated fallback answered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTripImpact, FIT, suggestRemovals, stopContributions, detourProvenance } from '../../shared/engine/tripImpact.js';
import { scheduleJourney as schedule } from '../../shared/engine/schedule.js';
import { buildRouteIndex } from '../../shared/engine/routeIndex.js';

// A 281 km / 340 min main route (Delhi → Jaipur shaped).
const LINE = Array.from({ length: 61 }, (_, i) => [28.6139 - 1.7 * (i / 60), 77.209 - 1.42 * (i / 60)]);
const ROUTE = { distanceKm: 281, durationMin: 340, geometry: LINE };
const index = buildRouteIndex(ROUTE);

/** A selected stop as Step 3/4 produce it: real source, real detour method. */
const stop = (id, { min, visit, km = 12, source = 'openstreetmap', method = 'road-network', anchorKm = 60, rejoinKm = 80 } = {}) => ({
  id, name: id, category: 'heritage',
  lat: LINE[20][0] + 0.1, lng: LINE[20][1] + 0.1,
  detourDistanceKm: km, detourTimeMinutes: min, visitDurationMinutes: visit,
  source: { provider: source, label: source === 'openstreetmap' ? '© OpenStreetMap contributors (ODbL)' : 'ROUTE+ curated list' },
  detour: { method, strategy: 'through', anchorKm, rejoinKm, baselineKm: 9.7, baselineMin: 12 }
});

const simple = (stops, { originalDays = 3, tripDays = originalDays } = {}) =>
  calculateTripImpact({ originalDays, tripDays, baseTravelMinutes: ROUTE.durationMin, selectedStops: stops });

test('STEP 5: one stop — base driving + road-network detour + visit = the new workload', () => {
  const one = stop('fort', { min: 31, visit: 90 });
  const before = simple([]);
  const after = simple([one]);

  // 1. original route driving time — unchanged by the stop, it is the baseline
  assert.equal(before.baseDrivingMinutes, 340);
  assert.equal(after.baseDrivingMinutes, 340);
  // 2. added road-network detour time   3. visit duration   4. total added
  assert.equal(after.extraDrivingMinutes, 31);
  assert.equal(after.visitMinutes, 90);
  assert.equal(after.addedMinutes, 121);
  // 5. new total workload
  assert.equal(after.workload, before.workload + 121);
  assert.equal(after.breakdown.baseDrivingMinutes + after.breakdown.addedMinutes, after.workload);
  // 6/7. required days and the verdict
  assert.ok(after.requiredDays >= 1 && after.estimatedDays >= after.tripDays);
  assert.ok(Object.values(FIT).includes(after.fit));
  // Truthfulness: the figure carries its provenance.
  assert.equal(after.detourMethod, 'road-network');
  assert.equal(after.roadNetwork, true);
  assert.deepEqual(after.placeSources, { openstreetmap: 1 });
  assert.equal(before.detourMethod, null, 'nothing selected → no detour claim at all');
  assert.equal(before.roadNetwork, false);
});

test('STEP 5: multiple stops recalculate cumulatively, in both models', () => {
  const stops = [
    stop('a', { min: 20, visit: 60, km: 8, anchorKm: 40, rejoinKm: 55 }),
    stop('b', { min: 45, visit: 120, km: 26, anchorKm: 120, rejoinKm: 145 }),
    stop('c', { min: 15, visit: 45, km: 6, anchorKm: 200, rejoinKm: 210 })
  ];
  const one = simple(stops.slice(0, 1));
  const two = simple(stops.slice(0, 2));
  const all = simple(stops);

  assert.ok(one.workload < two.workload && two.workload < all.workload, 'each added stop only ever adds time');
  assert.equal(all.extraDrivingMinutes, 20 + 45 + 15);
  assert.equal(all.visitMinutes, 60 + 120 + 45);
  assert.equal(all.addedMinutes, 305);
  assert.equal(all.extraDistanceKm, 40);
  assert.equal(all.remainingMinutes, one.remainingMinutes - (two.addedMinutes - one.addedMinutes) - (all.addedMinutes - two.addedMinutes));

  // Per-stop contributions with running totals — the cumulative impact itself.
  assert.deepEqual(all.contributions.map(c => c.addedMinutes), [80, 165, 60]);
  assert.deepEqual(all.contributions.map(c => c.cumulativeAddedMinutes), [80, 245, 305]);
  assert.equal(all.contributions.at(-1).cumulativeAddedMinutes, all.addedMinutes);
  assert.equal(all.contributions.at(-1).cumulativeExtraDistanceKm, all.extraDistanceKm);
  assert.ok(all.contributions.every(c => c.detourMethod === 'road-network' && c.source === 'openstreetmap'));

  // The day-by-day model reports the same totals and provenance.
  const daily = schedule({ index, stops, originalDays: 3 });
  assert.equal(daily.model, 'daily');
  assert.equal(daily.extraDrivingMinutes, all.extraDrivingMinutes);
  assert.equal(daily.visitMinutes, all.visitMinutes);
  assert.equal(daily.addedMinutes, all.addedMinutes);
  assert.equal(daily.baseDrivingMinutes, Math.round(index.totalMin));
  assert.equal(daily.detourMethod, 'road-network');
  assert.equal(daily.contributions.length, 3);
  assert.equal(daily.breakdown.breakMinutes >= 0, true);
});

test('STEP 5: FITS → NEAR LIMIT → EXCEEDS as stops are added', () => {
  const fits = simple([stop('a', { min: 10, visit: 30 })]);
  assert.equal(fits.fit, FIT.FITS);
  assert.equal(fits.exceedsPlannedDuration, false);
  assert.equal(fits.extraDaysNeeded, 0);

  // Fill the plan until it is tight but still possible: 340 min of main route
  // plus 220 min of stop time is 93 % of a single 600-minute day.
  const near = simple([stop('a', { min: 80, visit: 140 })], { originalDays: 1, tripDays: 1 });
  assert.equal(near.workload, 560);
  assert.equal(near.fit, FIT.NEAR, `ratio ${(near.workload / near.availableMinutes).toFixed(2)}`);
  assert.equal(near.exceedsPlannedDuration, false);
  assert.equal(near.requiredDays, 1, 'still one day — tight, not impossible');

  const exceeds = simple([stop('a', { min: 180, visit: 480 }), stop('b', { min: 180, visit: 480 })], { originalDays: 1, tripDays: 1 });
  assert.equal(exceeds.fit, FIT.EXCEEDS);
  assert.equal(exceeds.exceedsPlannedDuration, true);
  assert.ok(exceeds.requiredDays > exceeds.tripDays);
  assert.equal(exceeds.extraDaysNeeded, exceeds.requiredDays - exceeds.tripDays);
  assert.ok(exceeds.remainingMinutes < 0);
});

test('STEP 5: a 3-day plan that needs 4 days — keep the duration, or extend to it', () => {
  // Enough stops that three days are no longer enough (six stops, each a
  // 2-hour road detour and a 5-hour visit, on a 340-minute main route).
  const stops = Array.from({ length: 6 }, (_, k) =>
    stop(`s${k}`, { min: 120, visit: 300, anchorKm: 20 + k * 30, rejoinKm: 35 + k * 30 }));
  const planned = schedule({ index, stops, originalDays: 3, tripDays: 3 });
  assert.equal(planned.requiredDays, 4, 'the journey now needs a fourth day');
  assert.equal(planned.fit, FIT.EXCEEDS);
  assert.equal(planned.estimatedDays, 4);
  assert.equal(planned.extraDaysNeeded, 1);
  assert.equal(planned.exceedsOriginalDuration, true);
  assert.equal(planned.days.length, 4, 'the day-by-day plan shows the fourth day');

  // "Extend trip": tripDays becomes requiredDays. originalDays is preserved.
  const extended = schedule({ index, stops, originalDays: 3, tripDays: planned.requiredDays });
  assert.equal(extended.tripDays, 4);
  assert.equal(extended.originalDays, 3, 'what the traveller first asked for is remembered');
  assert.equal(extended.fit, FIT.FITS);
  assert.equal(extended.exceedsPlannedDuration, false);
  assert.equal(extended.exceedsOriginalDuration, true, 'still honest that it grew beyond the original 3 days');
  assert.equal(extended.extraDaysNeeded, 0);
  assert.equal(extended.addedMinutes, planned.addedMinutes, 'extending changes the allowance, never the cost');

  // "Keep original duration": the numbers do not soften.
  const kept = schedule({ index, stops, originalDays: 3, tripDays: 3 });
  assert.equal(kept.fit, FIT.EXCEEDS);
  assert.ok(kept.remainingMinutes < 0);
});

test('STEP 5: removing the costliest stop recovers the most time', () => {
  const stops = [
    stop('cheap', { min: 15, visit: 45 }),
    stop('dear', { min: 120, visit: 240 }),
    stop('middling', { min: 40, visit: 90 })
  ];
  const all = schedule({ index, stops, originalDays: 3, tripDays: 3 });
  const over = Math.max(1, -all.remainingMinutes);
  const [first] = suggestRemovals(stops, over);
  assert.equal(first.id, 'dear', 'the costliest stop is offered first');

  const without = schedule({ index, stops: stops.filter(s => s.id !== 'dear'), originalDays: 3, tripDays: 3 });
  assert.equal(all.addedMinutes - without.addedMinutes, 120 + 240, 'removing it recovers exactly its +min and visit time');
  assert.ok(without.workload < all.workload);
  assert.ok(without.remainingMinutes > all.remainingMinutes);
  assert.equal(without.contributions.length, 2);
  assert.equal(without.contributions.at(-1).cumulativeAddedMinutes, without.addedMinutes);

  // Removing every stop returns the journey to its baseline.
  const none = schedule({ index, stops: [], originalDays: 3, tripDays: 3 });
  assert.equal(none.addedMinutes, 0);
  assert.equal(none.extraDistanceKm, 0);
  assert.equal(none.detourMethod, null);
  assert.deepEqual(none.placeSources, {});
});

test('STEP 5 truthfulness: estimated detours and curated places are never dressed up as real', () => {
  const measured = stop('osm', { min: 30, visit: 60, source: 'openstreetmap', method: 'road-network' });
  const guessed = stop('curated', { min: 25, visit: 60, source: 'curated', method: 'estimated' });

  assert.equal(simple([measured]).detourMethod, 'road-network');
  assert.equal(simple([guessed]).detourMethod, 'estimated');
  assert.equal(simple([guessed]).roadNetwork, false, 'an estimate is never reported as road-measured');

  const mixed = simple([measured, guessed]);
  assert.equal(mixed.detourMethod, 'mixed');
  assert.equal(mixed.roadNetwork, false, 'one estimated stop makes the whole total estimated');
  assert.deepEqual(mixed.placeSources, { openstreetmap: 1, curated: 1 });

  // The curated fallback keeps its own source — no stop claims live OSM.
  const fallbackOnly = simple([guessed, stop('curated2', { min: 10, visit: 30, source: 'curated', method: 'estimated' })]);
  assert.deepEqual(fallbackOnly.placeSources, { curated: 2 });
  assert.equal(fallbackOnly.placeSources.openstreetmap, undefined);
  assert.ok(fallbackOnly.contributions.every(c => c.source === 'curated' && c.detourMethod === 'estimated'));

  // Provenance helpers are pure and agree with the impact objects.
  assert.deepEqual(detourProvenance([]), { detourMethod: null, roadNetwork: false, placeSources: {} });
  assert.equal(stopContributions([measured])[0].detourMethod, 'road-network');
});
