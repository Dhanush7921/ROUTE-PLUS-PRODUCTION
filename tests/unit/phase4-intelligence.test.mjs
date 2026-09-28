// Phase 4: personalisation, live context, monetisation guard, background jobs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryBoosts, placeFeedbackAdjustments, toScoringContext } from '../../shared/engine/personalize.js';
import { weatherConditions, shouldSuppress, closingSoon } from '../../shared/engine/context.js';
import { calculateRecommendationScore, getRecommendedPlaces, DEFAULT_FILTERS } from '../../shared/engine/recommend.js';
import { normalizePlace } from '../../shared/engine/placePipeline.js';
import { openDatabase, placesRepo } from '../../server/db/database.js';
import { purgeSessions, reviewPlaces, aggregateMetrics, ingestPlaces } from '../../server/jobs.js';

const place = over => ({ ...normalizePlace({ id: 'p1', name: 'Test Falls', category: 'waterfall', lat: 1, lng: 1, quality: 4.6 }), routePhase: 'ph1', distanceFromRouteKm: 3, detourDistanceKm: 10, detourTimeMinutes: 25, ...over });
const profile = { travelerType: 'Family', interests: ['Nature'] };

test('behaviour boosts need enough signal, are capped at ±10 and explain themselves', () => {
  assert.deepEqual(categoryBoosts({ waterfall: { added: 2 } }), {}, 'two clicks are not enough');
  const b = categoryBoosts({ waterfall: { added: 10 }, heritage: { skipped: 6, removed: 4 } });
  assert.equal(b.waterfall, 10);
  assert.ok(b.heritage < 0 && b.heritage >= -10);
  const r = calculateRecommendationScore(place(), profile, {}, { personalBoost: b });
  assert.ok(r.breakdown.some(x => x.label === 'Your past choices' && x.value === 10));
  assert.ok(r.reasons.includes('Similar to stops you added before'));
});

test('crowd feedback adjusts places with a visible reason', () => {
  const adj = placeFeedbackAdjustments({ a: { yes: 9, no: 1 }, b: { yes: 1, no: 4 }, c: { yes: 1, no: 0 } });
  assert.equal(adj.a.points, 5);
  assert.equal(adj.b.points, -10);
  assert.equal(adj.c, undefined);
  const ctx = toScoringContext({ places: adj });
  const r = calculateRecommendationScore(place({ id: 'b' }), profile, {}, ctx);
  assert.ok(r.warnings.some(w => /20% of 5 travellers/.test(w)));
});

test('heavy rain + hill road + large detour → suppressed; moderate rain → caution only', () => {
  const heavy = weatherConditions([{ phaseId: 'ph1', rainMm: 40 }]);
  const hillFalls = place({ terrain: 'hill', detourTimeMinutes: 120 });
  assert.equal(shouldSuppress(hillFalls, heavy), true);
  assert.equal(shouldSuppress(place({ terrain: 'plain', detourTimeMinutes: 120 }), heavy), false, 'plain road is not suppressed');
  const state = { travelerType: 'Family', interests: ['Nature'], selectedStops: [], skippedPlaces: [], currentPhaseId: 'all', filters: { ...DEFAULT_FILTERS } };
  assert.equal(getRecommendedPlaces([hillFalls], state, {}, { conditions: heavy, suppress: p => shouldSuppress(p, heavy) }).length, 0);
  const light = weatherConditions([{ phaseId: 'ph1', rainMm: 10 }]);
  const r = calculateRecommendationScore(place({ terrain: 'ghat' }), profile, {}, { conditions: light });
  assert.ok(r.warnings.some(w => /Rain forecast/.test(w)));
  assert.ok(r.breakdown.some(b => b.value === -10));
  assert.deepEqual(weatherConditions([{ phaseId: 'ph1', rainMm: 1 }]), []);
});

test('closing soon detection', () => {
  const p = { openingHours: { open: 540, close: 1020 } };
  assert.equal(closingSoon(p, 990, 60), true);
  assert.equal(closingSoon(p, 800, 60), false);
  assert.equal(closingSoon(p, 1030, 60), false);
});

test('MONETISATION GUARD: sponsored places score exactly the same as unsponsored', () => {
  const a = calculateRecommendationScore(place({ sponsored: false }), profile, { remainingMinutes: 999 });
  const b = calculateRecommendationScore(place({ sponsored: true }), profile, { remainingMinutes: 999 });
  assert.equal(a.score, b.score);
  assert.deepEqual(a.breakdown, b.breakdown);
});

test('jobs: purge sessions, flag low-value places, aggregate metrics, ingest new places for review', async () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at) VALUES ('u', 'u@x.io', 'x', 'U', 'now', 'now')").run();
  db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('old', 'u', 'x', '2000-01-01T00:00:00Z'), ('new', 'u', 'x', '2999-01-01T00:00:00Z')").run();
  assert.equal(purgeSessions(db), 1);
  for (let i = 0; i < 5; i++) db.prepare("INSERT INTO feedback (place_id, visited, worth_it, created_at) VALUES ('curated:behror-midway', 1, 0, 'now')").run();
  assert.equal(reviewPlaces(db), 1);
  assert.equal(placesRepo(db).get('curated:behror-midway').flagged, true);
  db.prepare("INSERT INTO analytics_events (name, props, created_at) VALUES ('discovery_added', '{}', '2026-09-01T10:00:00Z')").run();
  assert.equal(aggregateMetrics(db), 1);
  const fakeOsm = { name: 'osm', searchCorridor: async () => [
    { id: 'osm:node/1', name: 'Amber Fort', category: 'heritage', lat: 26.9855, lng: 75.8513, source: { provider: 'openstreetmap' } }, // duplicate of curated
    { id: 'osm:node/2', name: 'New Stepwell', category: 'heritage', lat: 27.0, lng: 76.0, source: { provider: 'openstreetmap' } }
  ] };
  assert.equal(await ingestPlaces(db, { provider: fakeOsm, corridors: [[[28.6, 77.2], [26.9, 75.8]]] }), 1);
  const added = placesRepo(db).get('osm:node/2');
  assert.equal(added.active, false, 'new places wait for staff review');
  assert.equal(added.flagged, true);
  db.close();
});
