// Live provider adapters, tested against recorded response SHAPES (fake fetch).
// These prove the adapters parse vendor responses and map errors correctly.
// They do NOT prove the live services are reachable — run
// `npm run check:live` on a machine with internet for that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOsrmRouter } from '../../server/providers/osrm.js';
import { createNominatimGeocoder } from '../../server/providers/nominatim.js';
import { createOverpassPlaceProvider, tagsToCategory, elementToPlace, corridorPoints, OVERPASS_DEFAULTS } from '../../server/providers/overpass.js';
import { createGeoPlanner } from '../../shared/engine/geoPlanner.js';
import { createCuratedPlaceProvider, createOfflineRouter, createOfflineGeocoder } from '../../shared/providers/offline.js';
import { chain } from '../../shared/providers/registry.js';
import { cumulativeKm, projectOntoLine } from '../../shared/geo.js';

const json = (body, status = 200) => async () => ({ ok: status < 400, status, json: async () => body });

test('OSRM route: metres/seconds → km/min, [lng,lat] → [lat,lng], duration factor', async () => {
  const osrm = createOsrmRouter({ durationFactor: 1.5, fetchImpl: json({ code: 'Ok', routes: [{ distance: 280000, duration: 14400, geometry: { coordinates: [[77.2, 28.6], [75.8, 26.9]] } }] }) });
  const r = await osrm.route([[28.6, 77.2], [26.9, 75.8]]);
  assert.equal(r.distanceKm, 280);
  assert.equal(r.durationMin, 360);
  assert.deepEqual(r.geometry[0], [28.6, 77.2]);
});

test('OSRM table legs read the matrix diagonal, in chunks', async () => {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    const k = new URL(url).searchParams.get('sources').split(';').length;
    const diag = (v) => Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? v * (i + 1) : 999999)));
    return { ok: true, status: 200, json: async () => ({ code: 'Ok', distances: diag(1000), durations: diag(60) }) };
  };
  const osrm = createOsrmRouter({ durationFactor: 1, fetchImpl, chunk: 2 });
  const legs = await osrm.legs([[[0, 0], [0, 1]], [[0, 0], [0, 2]], [[0, 0], [0, 3]]]);
  assert.equal(urls.length, 2, 'three pairs in chunks of two');
  assert.deepEqual(legs.map(l => l.distanceKm), [1, 2, 1]);
  assert.deepEqual(legs.map(l => l.durationMin), [1, 2, 1]);
});

test('OSRM errors become ProviderErrors (NoRoute, 429, 503, timeout)', async () => {
  await assert.rejects(createOsrmRouter({ fetchImpl: json({ code: 'NoRoute', routes: [] }, 400) }).route([[0, 0], [1, 1]]), e => e.code === 'NO_ROUTE');
  await assert.rejects(createOsrmRouter({ fetchImpl: async () => ({ ok: false, status: 403, json: async () => { throw new Error('html'); } }) }).route([[0, 0], [1, 1]]), e => e.code === 'PROVIDER_UNAVAILABLE');
  await assert.rejects(createOsrmRouter({ fetchImpl: json({}, 429) }).route([[0, 0], [1, 1]]), e => e.code === 'RATE_LIMITED');
  await assert.rejects(createOsrmRouter({ fetchImpl: json({}, 503) }).route([[0, 0], [1, 1]]), e => e.code === 'PROVIDER_UNAVAILABLE');
  const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  await assert.rejects(createOsrmRouter({ fetchImpl: hang, timeoutMs: 30 }).route([[0, 0], [1, 1]]), e => e.code === 'TIMEOUT');
});

test('Nominatim: top hit, not found, ambiguous, requires User-Agent', async () => {
  assert.throws(() => createNominatimGeocoder({}), /User-Agent/);
  let seenHeaders;
  const ok = createNominatimGeocoder({ userAgent: 'test', fetchImpl: async (url, init) => { seenHeaders = init.headers; return { ok: true, status: 200, json: async () => [{ name: 'Manali', lat: '32.24', lon: '77.19', importance: 0.6, addresstype: 'town', address: { state: 'Himachal Pradesh' } }] }; } });
  const r = await ok.geocode('Manali');
  assert.equal(r.name, 'Manali');
  assert.equal(r.lat, 32.24);
  assert.equal(seenHeaders['User-Agent'], 'test');
  await assert.rejects(createNominatimGeocoder({ userAgent: 't', fetchImpl: json([]) }).geocode('zzz'), e => e.code === 'PLACE_NOT_FOUND');
  const two = [
    { name: 'Aurangabad', lat: '19.87', lon: '75.34', importance: 0.5, addresstype: 'city', address: { city: 'Aurangabad', state: 'Maharashtra' } },
    { name: 'Aurangabad', lat: '24.75', lon: '84.37', importance: 0.49, addresstype: 'city', address: { city: 'Aurangabad', state: 'Bihar' } }
  ];
  await assert.rejects(createNominatimGeocoder({ userAgent: 't', fetchImpl: json(two) }).geocode('Aurangabad'), e => e.code === 'AMBIGUOUS_PLACE' && e.details.options.length === 2);
});

test('Overpass: tag mapping, quality filter and ROUTE+ shape', async () => {
  assert.equal(tagsToCategory({ natural: 'waterfall' }), 'waterfall');
  assert.equal(tagsToCategory({ amenity: 'place_of_worship', religion: 'buddhist' }), 'monastery');
  assert.equal(tagsToCategory({ historic: 'fort' }), 'heritage');
  assert.equal(tagsToCategory({ shop: 'bakery' }), null);
  assert.equal(elementToPlace({ type: 'node', id: 1, lat: 1, lon: 1, tags: { name: 'Random Temple', amenity: 'place_of_worship', religion: 'hindu' } }), null, 'no wikidata → dropped');
  const p = elementToPlace({ type: 'way', id: 2, center: { lat: 25.35, lon: 78.64 }, tags: { name: 'Orchha Fort', historic: 'fort', wikipedia: 'en:Orchha Fort', opening_hours: '09:00-17:00' } });
  assert.equal(p.id, 'osm:way/2');
  assert.equal(p.category, 'heritage');
  assert.deepEqual(p.openingHours, { open: 540, close: 1020 });
  assert.match(p.source.label, /OpenStreetMap/);

  const provider = createOverpassPlaceProvider({ fetchImpl: json({ elements: [{ type: 'node', id: 9, lat: 26.9, lon: 76.3, tags: { name: 'Test Falls', natural: 'waterfall' } }] }) });
  const rows = await provider.searchCorridor({ geometry: [[28.6, 77.2], [26.9, 75.8]], bufferKm: 20 });
  assert.equal(rows[0].name, 'Test Falls');
});

test('Overpass request is acceptable to the public endpoint: identifying User-Agent, Accept, urlencoded data=', async () => {
  // A public Overpass instance answers HTTP 406 when the request does not
  // identify itself or does not say what it can accept.
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ elements: [{ type: 'node', id: 9, lat: 26.9, lon: 76.3, tags: { name: 'Test Falls', natural: 'waterfall' } }] }) };
  };
  const provider = createOverpassPlaceProvider({ fetchImpl, contact: 'traveller@example.com', delayMs: 0 });
  const rows = await provider.searchCorridor({ geometry: [[28.6, 77.2], [26.9, 75.8]], bufferKm: 20 });

  assert.ok(calls.length >= 1);
  for (const c of calls) assert.equal(c.init.headers['User-Agent'], 'ROUTE+/0.2 (traveller@example.com)', 'every request identifies itself');
  const { url, init } = calls[0];
  assert.equal(url, 'https://overpass-api.de/api/interpreter');
  assert.equal(init.method, 'POST');
  assert.match(init.headers['User-Agent'], /^ROUTE\+\/[\d.]+ \(traveller@example\.com\)$/, 'identifies the app and a contact');
  assert.equal(init.headers.Accept, 'application/json');
  assert.match(init.headers['Content-Type'], /^application\/x-www-form-urlencoded/);
  assert.match(init.body, /^data=/, 'query still sent as a urlencoded data field');
  assert.match(decodeURIComponent(init.body.slice(5)), /^\[out:json\]\[timeout:25\];/, 'the Overpass QL query carries the reduced server-side budget');

  // An explicit userAgent (what the server passes) wins over `contact`.
  let mark = calls.length;
  const srv = createOverpassPlaceProvider({ fetchImpl, userAgent: 'ROUTE+/0.2 (ops@example.com)', delayMs: 0 });
  await srv.searchCorridor({ geometry: [[28.6, 77.2], [26.9, 75.8]], bufferKm: 20 });
  assert.equal(calls[mark].init.headers['User-Agent'], 'ROUTE+/0.2 (ops@example.com)');

  // The endpoint stays configurable (OVERPASS_URL → baseUrl), same headers.
  mark = calls.length;
  const mirror = createOverpassPlaceProvider({ fetchImpl, contact: 'traveller@example.com', baseUrl: 'https://overpass.example.org/api/interpreter', delayMs: 0 });
  await mirror.searchCorridor({ geometry: [[28.6, 77.2], [26.9, 75.8]], bufferKm: 20 });
  assert.equal(calls[mark].url, 'https://overpass.example.org/api/interpreter');
  assert.equal(calls[mark].init.headers.Accept, 'application/json');

  // Response parsing is unchanged, and so is the ROUTE+ place shape.
  assert.ok(rows.length >= 1);
  assert.deepEqual([rows[0].id, rows[0].category, rows[0].lat], ['osm:node/9', 'waterfall', 26.9]);
});

// ---------------------------------------------------------------------------
// Making Overpass practical on public infrastructure: shorter stretches of
// road per request, fewer vertices, strictly one request at a time.
// A ~400 km line (Delhi → Jaipur → Udaipur-ish) with realistic wobble.
const LONG_ROUTE = Array.from({ length: 401 }, (_, i) => {
  const t = i / 400;
  const wob = Math.sin(t * Math.PI * 9) * 0.06;
  return [28.6139 - 4.6 * t + wob * 0.5, 77.209 - 3.5 * t + wob];
});

test('Overpass sends fewer vertices per request, and the line still follows the road', () => {
  const radiusKm = 42;
  const sent = corridorPoints(LONG_ROUTE, radiusKm);
  assert.ok(sent.length < LONG_ROUTE.length / 10, `sends ${sent.length} vertices instead of ${LONG_ROUTE.length}`);
  assert.ok(sent.length <= OVERPASS_DEFAULTS.maxVerticesPerQuery, 'respects the vertex ceiling');
  assert.deepEqual(sent[0], LONG_ROUTE[0], 'keeps the ends of the stretch');
  assert.deepEqual(sent.at(-1), LONG_ROUTE.at(-1));
  // Overpass buffers the POLYLINE, so what matters is how far that line strays.
  const cum = cumulativeKm(sent);
  const worst = Math.max(...LONG_ROUTE.map(p => projectOntoLine(p, sent, cum).distanceKm));
  assert.ok(worst < radiusKm * 0.2, `deviation ${worst.toFixed(1)} km is negligible inside a ${radiusKm} km buffer`);
  // A very winding stretch is coarsened further rather than sent whole.
  const winding = Array.from({ length: 600 }, (_, i) => [20 + Math.sin(i) * 0.5 + i * 0.004, 78 + Math.cos(i) * 0.5 + i * 0.004]);
  assert.ok(corridorPoints(winding, 15).length <= OVERPASS_DEFAULTS.maxVerticesPerQuery);
});

test('Overpass chunks a long route, sends the requests STRICTLY one at a time, and pauses between them', async () => {
  let inFlight = 0, maxInFlight = 0;
  const starts = [];
  const fetchImpl = async () => {
    starts.push(Date.now());
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 5));
    inFlight--;
    return { ok: true, status: 200, json: async () => ({ elements: [] }) };
  };
  const provider = createOverpassPlaceProvider({ fetchImpl, contact: 'traveller@example.com', chunkKm: 100, delayMs: 40 });
  await provider.searchCorridor({ geometry: LONG_ROUTE, bufferKm: 20 });

  assert.ok(starts.length >= 4, `a ~400 km route is split into ${starts.length} requests of at most 100 km`);
  assert.equal(maxInFlight, 1, 'never more than one Overpass request in flight');
  for (let i = 1; i < starts.length; i++) {
    assert.ok(starts[i] - starts[i - 1] >= 35, `request ${i + 1} waited after the previous one (${starts[i] - starts[i - 1]} ms)`);
  }
  // Chunk size is configurable: a bigger chunk means fewer requests.
  const fewer = [];
  const provider2 = createOverpassPlaceProvider({ fetchImpl: async () => { fewer.push(1); return { ok: true, status: 200, json: async () => ({ elements: [] }) }; }, chunkKm: 400, delayMs: 0 });
  await provider2.searchCorridor({ geometry: LONG_ROUTE, bufferKm: 20 });
  assert.ok(fewer.length < starts.length, `OVERPASS_CHUNK_KM changes the split (${fewer.length} vs ${starts.length})`);
});

test('Overpass timeout is a recoverable ProviderError, and the cache stops repeat requests', async () => {
  const abort = async () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); };
  const slow = createOverpassPlaceProvider({ fetchImpl: abort, delayMs: 0 });
  await assert.rejects(slow.searchCorridor({ geometry: LONG_ROUTE, bufferKm: 20 }), e => e.code === 'TIMEOUT');

  // The client timeout went DOWN, not up — the fix is a cheaper query.
  assert.ok(OVERPASS_DEFAULTS.timeoutMs < 45000 && OVERPASS_DEFAULTS.queryTimeoutS < 40);

  let calls = 0;
  const store = new Map();
  const cache = { get: k => store.get(k), set: (k, v) => store.set(k, v) };
  const counting = createOverpassPlaceProvider({ cache, delayMs: 0, fetchImpl: async () => { calls++; return { ok: true, status: 200, json: async () => ({ elements: [] }) }; } });
  await counting.searchCorridor({ geometry: LONG_ROUTE, bufferKm: 20 });
  const first = calls;
  await counting.searchCorridor({ geometry: LONG_ROUTE, bufferKm: 20 });
  assert.equal(calls, first, 'the second identical corridor search costs Overpass nothing');
});

test('Overpass fallback endpoint is tried only AFTER the primary fails, never alongside it', async () => {
  const seen = [];
  let inFlight = 0, maxInFlight = 0;
  const fetchImpl = async url => {
    seen.push(url);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 3));
    inFlight--;
    if (url.includes('primary')) throw Object.assign(new Error('gateway'), { name: 'AbortError' });
    return { ok: true, status: 200, json: async () => ({ elements: [{ type: 'node', id: 9, lat: 26.9, lon: 76.3, tags: { name: 'Mirror Falls', natural: 'waterfall' } }] }) };
  };
  const provider = createOverpassPlaceProvider({
    baseUrl: 'https://primary.example/api/interpreter',
    fallbackUrl: 'https://mirror.example/api/interpreter',
    fetchImpl, chunkKm: 400, delayMs: 0
  });
  const rows = await provider.searchCorridor({ geometry: LONG_ROUTE, bufferKm: 20 });
  assert.equal(maxInFlight, 1, 'the two endpoints are never queried simultaneously');
  assert.match(seen[0], /primary/);
  assert.match(seen[1], /mirror/);
  assert.ok(rows.some(r => r.name === 'Mirror Falls'));
  // With no fallback configured (the default) nothing extra is tried.
  assert.deepEqual(createOverpassPlaceProvider({}).endpoints.length, 1);
});

test('Overpass 406 stays a recoverable ProviderError and the curated fallback still answers', async () => {
  const refuse = async () => ({ ok: false, status: 406, json: async () => { throw new Error('not JSON'); } });
  const provider = createOverpassPlaceProvider({ fetchImpl: refuse });
  await assert.rejects(provider.searchCorridor({ geometry: [[28.6, 77.2], [26.9, 75.8]], bufferKm: 20 }),
    e => e.code === 'PROVIDER_UNAVAILABLE' && /406/.test(e.message));
  // Chained behind the curated provider, discovery keeps working.
  const places = chain('places', [createCuratedPlaceProvider(), provider]);
  const rows = await places.searchCorridor({ geometry: [[28.6, 77.2], [26.9, 75.8]], bufferKm: 30 });
  assert.ok(rows.length > 0, 'curated places still answer when Overpass refuses');
});

test('a timed-out Overpass never lets the plan claim OpenStreetMap places were used', async () => {
  const timeout = createOverpassPlaceProvider({ delayMs: 0, fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } });
  const planner = createGeoPlanner({
    geocoder: createOfflineGeocoder(),
    router: chain('routing', [createOfflineRouter()]),
    places: chain('places', [createCuratedPlaceProvider(), timeout])
  });
  const plan = await planner.plan({ origin: 'Delhi', destination: 'Jaipur' });
  assert.ok(plan.places.length > 0, 'the journey still has discoveries');
  assert.equal(plan.placeSource, 'curated', 'the plan says curated — not OpenStreetMap');
  assert.ok(!plan.places.some(p => p.sources.includes('openstreetmap')), 'no place claims an OSM origin');
  assert.ok(plan.places.every(p => p.source.provider === 'curated'));
});

test('planner with a live-style router + places merges sources and computes detours', async () => {
  // A fake "OSRM" answering like the real one for any request.
  const fakeOsrm = createOsrmRouter({
    durationFactor: 1,
    fetchImpl: async url => {
      if (url.includes('/route/')) return { ok: true, status: 200, json: async () => ({ code: 'Ok', routes: [{ distance: 281000, duration: 17000, geometry: { coordinates: [[77.209, 28.6139], [76.9380, 28.357], [76.2849, 27.8876], [75.9590, 27.389], [75.7873, 26.9124]] } }] }) };
      const k = new URL(url).searchParams.get('sources').split(';').length;
      const m = Array.from({ length: k }, () => Array(k).fill(12000));
      const t = Array.from({ length: k }, () => Array(k).fill(900));
      return { ok: true, status: 200, json: async () => ({ code: 'Ok', distances: m, durations: t }) };
    }
  });
  const planner = createGeoPlanner({
    geocoder: { name: 'fake', geocode: async q => (q === 'Delhi' ? { name: 'Delhi', lat: 28.6139, lng: 77.209 } : { name: 'Jaipur', lat: 26.9124, lng: 75.7873 }) },
    router: chain('routing', [fakeOsrm, createOfflineRouter()]),
    places: createCuratedPlaceProvider(),
    knownTowns: [{ name: 'Behror', lat: 27.8876, lng: 76.2849 }]
  });
  const plan = await planner.plan({ origin: 'Delhi', destination: 'Jaipur' });
  assert.equal(plan.route.distanceKm, 281);
  assert.equal(plan.route.method, 'road-network');
  assert.ok(plan.places.length > 3);
  assert.ok(plan.places.every(p => p.detour.method === 'road-network'));
  assert.ok(plan.route.waypoints.some(w => w.name === 'Behror'), 'live route labelled with known towns');
});
