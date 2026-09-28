// PRODUCTION STEP 3 + STEP 4 — real place discovery (OpenStreetMap via
// Overpass) and real road-network detours (OSRM) through the existing
// pipeline. The adapters, planner, place pipeline, route index and detour
// engine are all the real ones; only the network transport is injected, with
// OSM/OSRM-shaped responses. These prove the wiring and the maths, NOT that the
// public services are reachable — `npm run check:live` does that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOsrmRouter } from '../../server/providers/osrm.js';
import { createOverpassPlaceProvider } from '../../server/providers/overpass.js';
import { createGeoPlanner } from '../../shared/engine/geoPlanner.js';
import { chain } from '../../shared/providers/registry.js';
import { createCuratedPlaceProvider, createOfflineRouter } from '../../shared/providers/offline.js';
import { haversineKm } from '../../shared/geo.js';
import { NODES } from '../../shared/data/network.js';

const DELHI = [28.6139, 77.2090];
const JAIPUR = [26.9124, 75.7873];
// An OSRM-shaped Delhi → Jaipur line (281 km of road, mild curvature).
const LINE = Array.from({ length: 121 }, (_, i) => {
  const t = i / 120;
  const wobble = Math.sin(t * Math.PI * 7) * 0.05;
  return [DELHI[0] + (JAIPUR[0] - DELHI[0]) * t + wobble * 0.4, DELHI[1] + (JAIPUR[1] - DELHI[1]) * t + wobble];
});

/** Real OSM tag shapes, including records the quality filter must drop. */
const OSM_ELEMENTS = [
  { type: 'way', id: 101, center: { lat: LINE[40][0] + 0.08, lon: LINE[40][1] + 0.08 }, tags: { name: 'Neemrana Fort', historic: 'fort', wikidata: 'Q1', wikipedia: 'en:Neemrana Fort' } },
  { type: 'node', id: 102, lat: LINE[80][0] - 0.1, lon: LINE[80][1] - 0.1, tags: { name: 'Sambhar Lake Viewpoint', tourism: 'viewpoint' } },
  { type: 'way', id: 103, center: { lat: LINE[20][0] + 0.05, lon: LINE[20][1] - 0.05 }, tags: { name: 'Heritage Museum', tourism: 'museum', wikidata: 'Q2' } },
  { type: 'node', id: 104, lat: LINE[60][0], lon: LINE[60][1] + 0.03, tags: { name: 'Roadside Temple', amenity: 'place_of_worship', religion: 'hindu' } },   // no wikidata → dropped
  { type: 'node', id: 105, lat: LINE[60][0], lon: LINE[60][1], tags: { name: 'Corner Bakery', shop: 'bakery' } },                                            // not a ROUTE+ category
  { type: 'node', id: 106, lat: 19.0, lon: 73.0, tags: { name: 'Far Away Fort', historic: 'fort', wikidata: 'Q3' } }                                          // ~700 km off-corridor
];

/** OSRM table answers: a fixed road cost per leg, so the maths is checkable. */
function transport({ elements = OSM_ELEMENTS, legMetres = 9000, legSeconds = 600, overpassFails = false } = {}) {
  const counts = { overpass: 0, route: 0, table: 0, pairs: 0 };
  const fetchImpl = async url => {
    const u = String(url);
    if (u.includes('interpreter')) {
      counts.overpass++;
      if (overpassFails) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return { ok: true, status: 200, json: async () => ({ elements }) };
    }
    if (u.includes('/route/')) {
      counts.route++;
      return { ok: true, status: 200, json: async () => ({ code: 'Ok', routes: [{ distance: 281000, duration: 17000, geometry: { coordinates: LINE.map(([a, b]) => [b, a]) } }] }) };
    }
    counts.table++;
    const k = new URL(u).searchParams.get('sources').split(';').length;
    counts.pairs += k;
    const grid = v => Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? v : 9e6)));
    return { ok: true, status: 200, json: async () => ({ code: 'Ok', distances: grid(legMetres), durations: grid(legSeconds) }) };
  };
  return { fetchImpl, counts };
}

function planner(fetchImpl, { maxCandidates } = {}) {
  return createGeoPlanner({
    geocoder: { name: 'nominatim', geocode: async q => (/delhi/i.test(q) ? { name: 'Delhi', lat: DELHI[0], lng: DELHI[1] } : { name: 'Jaipur', lat: JAIPUR[0], lng: JAIPUR[1] }) },
    router: chain('routing', [createOsrmRouter({ fetchImpl, durationFactor: 1.2 }), createOfflineRouter()]),
    places: chain('places', [createCuratedPlaceProvider(), createOverpassPlaceProvider({ fetchImpl, userAgent: 'ROUTE+/0.2 (test@example.com)', delayMs: 0 })]),
    knownTowns: NODES,
    maxCandidates
  });
}

test('STEP 3: real OSM places enter the pipeline, keep their provenance, and the quality filter still applies', async () => {
  const { fetchImpl, counts } = transport();
  const plan = await planner(fetchImpl).plan({ origin: 'Delhi', destination: 'Jaipur' });

  const osm = plan.places.filter(p => p.source.provider === 'openstreetmap');
  assert.ok(osm.length >= 3, `OSM places reached the plan (${osm.length})`);
  assert.ok(osm.some(p => p.name === 'Neemrana Fort' && p.category === 'heritage'));
  assert.ok(osm.some(p => p.category === 'viewpoint'), 'naturally notable types are kept without a wikidata tag');

  // The existing quality filter and corridor still decide what is usable.
  assert.ok(!plan.places.some(p => p.name === 'Roadside Temple'), 'no wikidata → dropped by the existing filter');
  assert.ok(!plan.places.some(p => p.name === 'Corner Bakery'), 'not a ROUTE+ category');
  assert.ok(!plan.places.some(p => p.name === 'Far Away Fort'), 'outside the route corridor');

  // The pipeline filled every field the app needs — nothing fabricated.
  const fort = osm.find(p => p.name === 'Neemrana Fort');
  assert.ok(fort.visitDurationMinutes > 0 && fort.interests.length > 0 && fort.rating > 0);
  assert.match(fort.id, /^osm:way\/101$/);
  assert.match(fort.source.label, /OpenStreetMap/);
  assert.equal(fort.source.verified, false);

  // The plan states exactly what came from where.
  assert.match(plan.placeSource, /openstreetmap/);
  assert.ok(plan.placeCounts.openstreetmap >= 3);
  assert.ok(plan.placeCounts.curated >= 0);
  assert.equal(Object.values(plan.placeCounts).reduce((a, b) => a + b, 0), plan.places.length);
  assert.equal(counts.overpass >= 1, true);
});

test('STEP 4: +km and +min for an OSM place come from the road network, not a straight line', async () => {
  const legKm = 9, legMin = 10 * 1.2; // OSRM 9,000 m / 600 s, scaled by durationFactor
  const { fetchImpl } = transport({ legMetres: legKm * 1000, legSeconds: 600 });
  const plan = await planner(fetchImpl).plan({ origin: 'Delhi', destination: 'Jaipur' });
  const fort = plan.places.find(p => p.name === 'Neemrana Fort');

  assert.equal(fort.detour.method, 'road-network', 'the legs were answered by the road-network router');
  assert.ok(fort.detourDistanceKm > 0 && fort.detourTimeMinutes > 0);
  assert.ok(fort.distanceFromRouteKm > 0);
  assert.ok(['through', 'out-and-back'].includes(fort.detour.strategy));

  // Entry / rejoin positions on the main route, and the baseline it subtracts.
  for (const field of ['anchor', 'rejoin', 'anchorKm', 'rejoinKm', 'detourRouteKm', 'baselineKm', 'baselineMin']) {
    assert.ok(fort.detour[field] !== undefined, `detour contract keeps ${field}`);
  }
  assert.ok(fort.detour.rejoinKm >= fort.detour.anchorKm);

  // The figure is the ROUTER's answer, not the geometric distance to the place.
  const straight = haversineKm([fort.lat, fort.lng], fort.detour.anchor);
  assert.notEqual(Math.round(fort.detourDistanceKm), Math.round(straight * 2));
  assert.ok(Math.abs(fort.detour.detourRouteKm - legKm * 2) < 0.2 || Math.abs(fort.detour.detourRouteKm - legKm) < 0.2,
    `detour distance ${fort.detour.detourRouteKm} km is built from the ${legKm} km road legs`);

  // Change only the router's answer: the detour figures must follow it.
  const dearer = transport({ legMetres: 20000, legSeconds: 600 });
  const plan2 = await planner(dearer.fetchImpl).plan({ origin: 'Delhi', destination: 'Jaipur' });
  const fort2 = plan2.places.find(p => p.name === 'Neemrana Fort');
  assert.ok(fort2.detourDistanceKm > fort.detourDistanceKm, 'longer road legs → a bigger +km');
  assert.equal(Math.round(fort.detourTimeMinutes), Math.round(fort2.detourTimeMinutes), 'unchanged road time → unchanged +min');
  assert.ok(Math.round(legMin) > 0);
  assert.match(plan.notices[0], /real road network/);
});

test('STEP 4: only corridor candidates get a road-network detour, nearest first, and the count is capped', async () => {
  // Many OSM candidates, some far outside the corridor.
  const many = Array.from({ length: 300 }, (_, i) => {
    const anchor = LINE[i % LINE.length];
    const far = i % 5 === 0;
    return {
      type: 'node', id: 1000 + i,
      lat: anchor[0] + (far ? 6 : 0.02 + (i % 20) * 0.01),
      lon: anchor[1] + (far ? 6 : 0.02),
      tags: { name: `OSM ${i}`, historic: 'fort', wikidata: `Q${i}` }
    };
  });
  const { fetchImpl, counts } = transport({ elements: many });
  const plan = await planner(fetchImpl, { maxCandidates: 40 }).plan({ origin: 'Delhi', destination: 'Jaipur' });

  assert.ok(plan.candidatesConsidered <= 40, `capped at ${plan.candidatesConsidered} candidates`);
  assert.ok(plan.places.length <= 40);
  assert.equal(counts.pairs, plan.candidatesConsidered * 3, 'exactly three road legs per candidate — no extra router traffic');
  assert.ok(plan.places.every(p => p.distanceFromRouteKm <= plan.corridorKm + 1), 'nothing outside the corridor was costed');
  assert.ok(plan.places.every(p => p.detour.method === 'road-network'));

  // A smaller cap means strictly fewer router calls.
  const small = transport({ elements: many });
  const plan2 = await planner(small.fetchImpl, { maxCandidates: 10 }).plan({ origin: 'Delhi', destination: 'Jaipur' });
  assert.ok(small.counts.pairs < counts.pairs);
  assert.equal(plan2.candidatesConsidered, 10);
});

test('FALLBACK: Overpass down → curated only, and the plan never claims OSM discovery', async () => {
  const { fetchImpl, counts } = transport({ overpassFails: true });
  const plan = await planner(fetchImpl).plan({ origin: 'Delhi', destination: 'Jaipur' });

  assert.ok(plan.places.length > 0, 'the journey still has discoveries');
  assert.equal(plan.placeSource, 'curated');
  assert.equal(plan.placeCounts.openstreetmap, undefined, 'no OSM count is reported');
  assert.ok(plan.places.every(p => p.source.provider === 'curated'));
  assert.ok(!plan.places.some(p => p.sources.includes('openstreetmap')));
  assert.ok(counts.overpass > 0, 'Overpass was genuinely attempted');
  // Routing and detours are unaffected by a place-provider outage.
  assert.equal(plan.route.provider, 'osrm');
  assert.ok(plan.places.every(p => p.detour.method === 'road-network'));
});

test('FALLBACK: road-network router down for the legs → figures are labelled estimated, never road-network', async () => {
  const fetchImpl = async url => {
    const u = String(url);
    if (u.includes('interpreter')) return { ok: true, status: 200, json: async () => ({ elements: OSM_ELEMENTS }) };
    if (u.includes('/route/')) return { ok: true, status: 200, json: async () => ({ code: 'Ok', routes: [{ distance: 281000, duration: 17000, geometry: { coordinates: LINE.map(([a, b]) => [b, a]) } }] }) };
    throw Object.assign(new Error('table unavailable'), { name: 'AbortError' }); // only the table service fails
  };
  const plan = await planner(fetchImpl).plan({ origin: 'Delhi', destination: 'Jaipur' });
  assert.equal(plan.route.provider, 'osrm', 'the main route is still real');
  assert.ok(plan.places.every(p => p.detour.method === 'estimated'), 'detours fell back to the offline estimator and say so');
  assert.match(plan.notices[0], /Detour \(\+km \/ \+min\) figures are still ROUTE\+ estimates/);
});
