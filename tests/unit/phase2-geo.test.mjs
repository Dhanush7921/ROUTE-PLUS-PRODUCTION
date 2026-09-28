// Phase 2: geography, offline providers, detour engine, pipeline and scheduler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, projectOntoLine, cumulativeKm, pointAtKm, simplify } from '../../shared/geo.js';
import { createOfflineGeocoder, createOfflineRouter, createCuratedPlaceProvider, localLeg } from '../../shared/providers/offline.js';
import { createGeoPlanner, buildPhases } from '../../shared/engine/geoPlanner.js';
import { buildRouteIndex } from '../../shared/engine/routeIndex.js';
import { computeDetours } from '../../shared/engine/detour.js';
import { normalizePlace, dedupePlaces, parseMonths, runPlacePipeline } from '../../shared/engine/placePipeline.js';
import { scheduleJourney } from '../../shared/engine/schedule.js';
import { chain, createCache } from '../../shared/providers/registry.js';
import { ProviderError } from '../../shared/providers/contracts.js';

const geocoder = createOfflineGeocoder();
const router = createOfflineRouter();
const planner = createGeoPlanner({ geocoder, router, places: createCuratedPlaceProvider(), now: () => new Date('2026-11-10') });

test('haversine: Delhi → Jaipur is ~235 km in a straight line', () => {
  const d = haversineKm([28.6139, 77.2090], [26.9124, 75.7873]);
  assert.ok(d > 230 && d < 240, d);
});

test('projection finds perpendicular distance and position along the line', () => {
  const line = [[0, 0], [0, 1]]; // ~111 km along the equator
  const p = projectOntoLine([0.1, 0.5], line);
  assert.ok(Math.abs(p.distanceKm - 11.1) < 0.2);
  assert.ok(Math.abs(p.routeKm - 55.6) < 0.5);
  const cum = cumulativeKm(line);
  assert.deepEqual(pointAtKm(line, cum, 0), [0, 0]);
  assert.equal(simplify([[0, 0], [0, 0.5], [0, 1]], 0.1).length, 2);
});

test('geocoder: exact, alias, typo suggestion, ambiguity, not found', async () => {
  assert.equal((await geocoder.geocode('Bangalore')).name, 'Bengaluru');
  assert.equal((await geocoder.geocode('  vizag ')).name, 'Visakhapatnam');
  assert.equal((await geocoder.geocode('Coorg')).name, 'Coorg (Madikeri)');
  await assert.rejects(geocoder.geocode('Visakapatnam'), e => e.code === 'PLACE_NOT_FOUND' && /Did you mean Visakhapatnam/.test(e.message));
  await assert.rejects(geocoder.geocode('Bilaspur'), e => e.code === 'AMBIGUOUS_PLACE' && e.details.options.length === 2);
  await assert.rejects(geocoder.geocode('Atlantis'), e => e.code === 'PLACE_NOT_FOUND');
  await assert.rejects(geocoder.geocode(''), e => e.code === 'PLACE_NOT_FOUND');
});

test('router: realistic distances for well-known corridors (±15 %)', async () => {
  const expectations = [['Delhi', 'Jaipur', 280], ['Mumbai', 'Pune', 150], ['Bengaluru', 'Coorg', 265], ['Kolkata', 'Darjeeling', 620], ['Visakhapatnam', 'Manali', 2500]];
  for (const [a, b, km] of expectations) {
    const A = await geocoder.geocode(a);
    const B = await geocoder.geocode(b);
    const r = await router.route([[A.lat, A.lng], [B.lat, B.lng]]);
    assert.ok(Math.abs(r.distanceKm - km) / km < 0.15, `${a}→${b}: ${r.distanceKm.toFixed(0)} km vs ~${km}`);
    assert.ok(r.geometry.length >= 2 && r.durationMin > r.distanceKm * 0.6, 'has geometry and plausible time');
  }
});

test('all eight example routes plan successfully with discoveries in several phases', async () => {
  const routes = [['Visakhapatnam', 'Manali'], ['Vijayawada', 'Manali'], ['Hyderabad', 'Goa'], ['Chennai', 'Ooty'], ['Delhi', 'Jaipur'], ['Mumbai', 'Goa'], ['Bengaluru', 'Coorg'], ['Kolkata', 'Darjeeling']];
  for (const [origin, destination] of routes) {
    const plan = await planner.plan({ origin, destination });
    assert.equal(plan.mode, 'geo');
    assert.ok(plan.places.length >= 5, `${origin}→${destination} has ${plan.places.length} places`);
    const phasesUsed = new Set(plan.places.map(p => p.routePhase));
    assert.ok(phasesUsed.size >= 2, `${origin}→${destination} phases used: ${phasesUsed.size}`);
    for (const p of plan.places) {
      assert.ok(p.detourDistanceKm >= 0 && p.detourTimeMinutes >= 5, `${p.name} has a detour cost`);
      assert.ok(p.distanceFromRouteKm <= plan.corridorKm + 0.1, `${p.name} inside corridor`);
      assert.ok(plan.phases.some(ph => ph.id === p.routePhase));
    }
  }
});

test('reverse direction works and phases follow travel direction', async () => {
  const plan = await planner.plan({ origin: 'Goa', destination: 'Mumbai' });
  assert.match(plan.phases[0].name, /^Goa/);
  assert.match(plan.phases.at(-1).name, /Mumbai$/);
});

test('detour engine: extra = detour route − baseline, and never straight-line only', async () => {
  // Straight synthetic road along the equator, 0 → 200 km, 50 km/h
  const route = { distanceKm: 222.4, durationMin: 266.9, geometry: [[0, 0], [0, 2]], waypoints: [{ name: 'A', lat: 0, lng: 0 }, { name: 'B', lat: 0, lng: 2 }] };
  const index = buildRouteIndex(route);
  const place = { id: 'x', name: 'X', lat: 0.09, lng: 1, terrain: 'plain' }; // ~10 km off the road
  const [r] = await computeDetours(index, [place], router);
  const off = 0.09 * 111.2;
  assert.ok(Math.abs(r.distanceFromRouteKm - off) < 0.3);
  assert.ok(r.detourDistanceKm > off, 'more than the perpendicular distance');
  assert.ok(r.detourDistanceKm < off * 2 * 1.5, 'less than a naive out-and-back with heavy circuity');
  // verify the arithmetic from the returned numbers
  const d = r.detour;
  if (d.strategy === 'through') {
    assert.ok(Math.abs(d.detourRouteKm - d.baselineKm - r.detourDistanceKm) < 0.2);
  }
  assert.ok(d.anchorKm <= r.routeKm && d.rejoinKm >= r.routeKm);
});

test('detour engine picks out-and-back when that is cheaper (place almost on the road)', async () => {
  const route = { distanceKm: 111.2, durationMin: 120, geometry: [[0, 0], [0, 1]] };
  const index = buildRouteIndex(route);
  const [r] = await computeDetours(index, [{ id: 'y', name: 'Y', lat: 0.001, lng: 0.5 }], router);
  assert.ok(r.detourDistanceKm < 1);
  assert.equal(r.detourTimeMinutes, 5, 'minimum stop overhead');
});

test('place pipeline: defaults, seasonality, dedupe keeps curated and merges sources', () => {
  assert.deepEqual([...parseMonths('Oct–Mar')].sort((a, b) => a - b), [1, 2, 3, 10, 11, 12]);
  assert.deepEqual([...parseMonths('Apr–Jun, Sep–Oct')].sort((a, b) => a - b), [4, 5, 6, 9, 10]);
  assert.equal(parseMonths('anytime'), null);
  const curated = { id: 'curated:a', name: 'Chitrakote Falls', category: 'waterfall', lat: 19.2064, lng: 81.6997, bestMonths: 'Jul–Jan', source: { provider: 'curated' } };
  const osm = { id: 'osm:node/1', name: 'Chitrakote Falls', category: 'waterfall', lat: 19.2070, lng: 81.7000, source: { provider: 'openstreetmap' } };
  const [p, ...rest] = runPlacePipeline([osm, curated], { travelMonth: 4 });
  assert.equal(rest.length, 0);
  assert.equal(p.id, 'curated:a');
  assert.deepEqual(p.sources.sort(), ['curated', 'openstreetmap']);
  assert.equal(p.seasonalFit, false, 'April is outside Jul–Jan');
  assert.ok(p.interests.includes('Waterfalls'));
  assert.ok(p.visitDurationMinutes > 0 && p.suitableFor.length > 0);
  const n = normalizePlace({ id: 'q', name: 'Q', category: 'heritage', lat: 1, lng: 1 });
  assert.ok(n.openingHours.open < n.openingHours.close);
  assert.equal(dedupePlaces([n, { ...n, id: 'q2', lat: 5 }]).length, 2, 'same name far apart is not a duplicate');
});

test('scheduler: multi-day split, daily driving cap, closing-time rollover', async () => {
  const plan = await planner.plan({ origin: 'Visakhapatnam', destination: 'Manali' });
  const index = buildRouteIndex(plan.route);
  const base = scheduleJourney({ index, stops: [], originalDays: 3 });
  assert.ok(base.requiredDays >= 5 && base.requiredDays <= 7, `needs ${base.requiredDays} days`);
  assert.equal(base.fit, 'exceeds');
  for (const d of base.days) assert.ok(d.drivingMinutes <= 9 * 60 + 1, `day ${d.day} drives ${d.drivingMinutes}`);

  const short = await planner.plan({ origin: 'Delhi', destination: 'Jaipur' });
  const sIndex = buildRouteIndex(short.route);
  const none = scheduleJourney({ index: sIndex, stops: [], originalDays: 1 });
  assert.equal(none.requiredDays, 1);
  assert.equal(none.fit, 'fits');
  const amber = short.places.find(p => p.name === 'Amber Fort');
  const late = { ...amber, openingHours: { open: 9 * 60, close: 10 * 60 } }; // reached after 10:00
  const moved = scheduleJourney({ index: sIndex, stops: [late], originalDays: 1 });
  assert.equal(moved.requiredDays, 2);
  assert.ok(moved.notes.some(n => /next morning/.test(n)));
});

test('phases cover the route end to end', async () => {
  const plan = await planner.plan({ origin: 'Mumbai', destination: 'Goa' });
  const index = buildRouteIndex(plan.route);
  const phases = buildPhases(index, 't');
  assert.equal(phases[0].startKm, 0);
  assert.equal(Math.round(phases.at(-1).endKm), Math.round(plan.route.distanceKm));
});

test('registry: falls back on outage, not on "not found"; caches results', async () => {
  const events = [];
  let calls = 0;
  const broken = { name: 'broken', geocode: async () => { calls++; throw new ProviderError('PROVIDER_UNAVAILABLE', 'down'); } };
  const cache = createCache();
  const g = chain('geocoding', [broken, geocoder], { onEvent: e => events.push(e), cache });
  assert.equal((await g.geocode('Delhi')).name, 'Delhi');
  assert.ok(events.some(e => e.provider === 'broken' && !e.ok));
  await g.geocode('Delhi');
  assert.equal(calls, 1, 'second call served from cache');
  const strict = { name: 'strict', geocode: async () => { throw new ProviderError('PLACE_NOT_FOUND', 'nope'); } };
  await assert.rejects(chain('geocoding', [strict, geocoder]).geocode('Delhi'), e => e.code === 'PLACE_NOT_FOUND');
  const slow = { name: 'slow', geocode: () => new Promise(r => setTimeout(() => r({ name: 'late' }), 200)) };
  assert.equal((await chain('geocoding', [slow, geocoder], { timeoutMs: 50 }).geocode('Delhi')).name, 'Delhi');
});

test('local leg estimate is longer than a straight line and slower on hills', () => {
  const plain = localLeg([0, 0], [0, 0.1]);
  const hill = localLeg([0, 0], [0, 0.1], 'hill');
  assert.ok(plain.distanceKm > 11.1);
  assert.ok(hill.durationMin > plain.durationMin);
});
