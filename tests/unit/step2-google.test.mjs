// PRODUCTION STEP 2 — real Google geocoding + real Google routing.
//
// Every test here uses an INJECTED transport with synthetic, clearly-labelled
// fixtures (tests/fixtures/google-responses.mjs). No test makes a real Google
// request, so nothing in this file proves that the live API works — it proves
// that the adapters send the right request and turn a reply (or a failure) into
// the right ROUTE+ model or error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleGeocodingProvider, normalizeGoogleGeocode } from '../../server/providers/google/geocoding.js';
import { createGoogleRouteProvider, normalizeGoogleRoute } from '../../server/providers/google/routes.js';
import { scrub, durationToMinutes } from '../../server/providers/google/request.js';
import { decodePolyline, haversineKm } from '../../shared/geo.js';
import { createGeoPlanner, routeNotices } from '../../shared/engine/geoPlanner.js';
import { chain } from '../../shared/providers/registry.js';
import { createOfflineGeocoder, createOfflineRouter, createCuratedPlaceProvider } from '../../shared/providers/offline.js';
import {
  fakeFetch, encodePolyline, FIXTURE_LINE, ROUTE_OK, VIZAG, MANALI,
  GEOCODE_VIZAG, GEOCODE_MANALI, GEOCODE_NONE, GEOCODE_AMBIGUOUS
} from '../fixtures/google-responses.mjs';

const KEY = 'TEST_ONLY_SERVER_PLACEHOLDER_not_a_key';

// ---------------------------------------------------------------- polyline
test('polyline decoding matches Google\'s published example and round-trips', () => {
  // The example printed in Google's "Encoded Polyline Algorithm Format" docs.
  assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
  assert.deepEqual(decodePolyline(''), []);
  const back = decodePolyline(encodePolyline(FIXTURE_LINE));
  assert.equal(back.length, FIXTURE_LINE.length);
  back.forEach((p, i) => assert.ok(haversineKm(p, FIXTURE_LINE[i]) < 0.02, 'decoded within a few metres'));
  assert.throws(() => decodePolyline('_p~iF~ps|'), /truncated/);
  assert.equal(durationToMinutes('164700s'), 2745);
});

// ---------------------------------------------------------------- geocoding
test('geocoding: Visakhapatnam and Manali normalise to the ROUTE+ contract', async () => {
  const { fetchImpl, calls } = fakeFetch(url => (url.includes('Manali') ? GEOCODE_MANALI : GEOCODE_VIZAG));
  const geo = createGoogleGeocodingProvider({ apiKey: KEY, fetchImpl });

  const vizag = await geo.geocode('Visakhapatnam');
  assert.deepEqual(Object.keys(vizag).filter(k => ['provider', 'providerPlaceId', 'name', 'latitude', 'longitude', 'formattedAddress'].includes(k)).sort(),
    ['formattedAddress', 'latitude', 'longitude', 'name', 'provider', 'providerPlaceId']);
  assert.equal(vizag.provider, 'google-geocoding');
  assert.equal(vizag.name, 'Visakhapatnam');
  assert.equal(vizag.formattedAddress, 'Visakhapatnam, Andhra Pradesh, India');
  assert.ok(haversineKm([vizag.latitude, vizag.longitude], VIZAG) < 1);
  assert.equal(vizag.lat, vizag.latitude, 'legacy field kept so the engine needs no change');

  const manali = await geo.geocode('Manali');
  assert.equal(manali.state, 'Himachal Pradesh');
  assert.ok(haversineKm([manali.latitude, manali.longitude], MANALI) < 1);

  // Request shape: key in the header, never in the URL; India-biased.
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.method, 'GET');
    assert.ok(c.url.startsWith('https://maps.googleapis.com/maps/api/geocode/json?'));
    assert.ok(!c.url.includes(KEY) && !/[?&]key=/.test(c.url), 'the key is not in the URL');
    assert.equal(c.headers['X-Goog-Api-Key'], KEY);
    assert.match(c.url, /components=country%3AIN/);
    assert.match(c.url, /region=in/);
  }
});

test('geocoding errors: not found, ambiguous, quota, denied, bad coordinates, timeout', async () => {
  const geoWith = body => createGoogleGeocodingProvider({ apiKey: KEY, fetchImpl: fakeFetch(() => body).fetchImpl });

  await assert.rejects(geoWith(GEOCODE_NONE).geocode('Nowhereville'),
    e => e.code === 'PLACE_NOT_FOUND' && /couldn't find/.test(e.message));
  await assert.rejects(geoWith(GEOCODE_AMBIGUOUS).geocode('Nagar'),
    e => e.code === 'AMBIGUOUS_PLACE' && e.details.options.length === 2);
  await assert.rejects(geoWith({ status: 'OVER_QUERY_LIMIT' }).geocode('Delhi'), e => e.code === 'RATE_LIMITED');
  await assert.rejects(geoWith({ status: 'REQUEST_DENIED' }).geocode('Delhi'),
    e => e.code === 'PROVIDER_UNAVAILABLE' && !e.message.includes(KEY));
  await assert.rejects(geoWith({ status: 'OK', results: [{ formatted_address: 'x', geometry: { location: { lat: 'abc', lng: null } } }] }).geocode('Delhi'),
    e => e.code === 'PLACE_NOT_FOUND' || e.code === 'BAD_RESPONSE');
  assert.throws(() => normalizeGoogleGeocode({ geometry: { location: { lat: 999, lng: 0 } } }), e => e.code === 'BAD_RESPONSE');

  // HTTP-level failures
  const http = code => createGoogleGeocodingProvider({ apiKey: KEY, fetchImpl: fakeFetch(() => ({ __status: code, __body: { error_message: `secret ${KEY}`, status: 'REQUEST_DENIED' } })).fetchImpl });
  await assert.rejects(http(403).geocode('Delhi'), e => e.code === 'PROVIDER_UNAVAILABLE' && !e.message.includes(KEY) && !JSON.stringify(e.details).includes(KEY));
  await assert.rejects(http(429).geocode('Delhi'), e => e.code === 'RATE_LIMITED');
  await assert.rejects(http(500).geocode('Delhi'), e => e.code === 'PROVIDER_UNAVAILABLE');

  // Timeout: the transport never settles, the adapter aborts.
  const slow = createGoogleGeocodingProvider({ apiKey: KEY, timeoutMs: 20, fetchImpl: (url, init) => new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }) });
  await assert.rejects(slow.geocode('Delhi'), e => e.code === 'TIMEOUT');
});

test('geocoding: a 403 on the header retries ONCE with ?key= and then remembers', async () => {
  // Google\'s classic web services historically wanted the key as a query
  // parameter. The adapter tries the header first and falls back at most once.
  const { fetchImpl, calls } = fakeFetch(url => (/[?&]key=/.test(url) ? GEOCODE_VIZAG : { __status: 403, __body: { status: 'REQUEST_DENIED' } }));
  const geo = createGoogleGeocodingProvider({ apiKey: KEY, fetchImpl });
  assert.equal((await geo.geocode('Visakhapatnam')).name, 'Visakhapatnam');
  assert.equal(calls.length, 2, 'header attempt + one query-parameter retry');
  await geo.geocode('Manali');
  assert.equal(calls.length, 3, 'the working mode is remembered — no repeated probing');
});

// ---------------------------------------------------------------- routing
test('routing: computeRoutes request shape and normalised route', async () => {
  const { fetchImpl, calls } = fakeFetch(() => ROUTE_OK);
  const router = createGoogleRouteProvider({ apiKey: KEY, fetchImpl });
  const route = await router.route([VIZAG, MANALI]);

  for (const field of ['id', 'provider', 'origin', 'destination', 'distanceKm', 'durationMinutes', 'geometry', 'legs']) {
    assert.ok(route[field] !== undefined, `normalised route has ${field}`);
  }
  assert.equal(route.provider, 'google-routes');
  assert.equal(route.method, 'road-network');
  assert.equal(route.distanceKm, 2690.431);
  assert.equal(route.durationMinutes, 2745);
  assert.equal(route.durationMin, route.durationMinutes, 'legacy field kept for the engine');
  assert.equal(route.legs.length, 1);
  assert.ok(route.geometry.length >= 12);
  assert.ok(haversineKm(route.geometry[0], VIZAG) < 1 && haversineKm(route.geometry.at(-1), MANALI) < 1);
  // Real road routing, not a straight line: the road distance is much longer.
  assert.ok(route.distanceKm > haversineKm(VIZAG, MANALI) * 1.2);

  const [call] = calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://routes.googleapis.com/directions/v2:computeRoutes');
  assert.ok(!call.url.includes(KEY));
  assert.equal(call.headers['X-Goog-Api-Key'], KEY);
  assert.match(call.headers['X-Goog-FieldMask'], /routes\.polyline\.encodedPolyline/);
  assert.equal(call.body.travelMode, 'DRIVE');
  assert.equal(call.body.computeAlternativeRoutes, false);
  assert.deepEqual(call.body.origin.location.latLng, { latitude: VIZAG[0], longitude: VIZAG[1] });
  assert.deepEqual(call.body.destination.location.latLng, { latitude: MANALI[0], longitude: MANALI[1] });
  assert.equal(calls.length, 1, 'one journey = one route request');
});

test('routing errors: no route, malformed distance/duration/geometry, quota, outage', async () => {
  const routerWith = body => createGoogleRouteProvider({ apiKey: KEY, fetchImpl: fakeFetch(() => body).fetchImpl });
  await assert.rejects(routerWith({ routes: [] }).route([VIZAG, MANALI]), e => e.code === 'NO_ROUTE');
  await assert.rejects(routerWith({ routes: [{ duration: '100s', polyline: { encodedPolyline: 'a' } }] }).route([VIZAG, MANALI]), e => e.code === 'BAD_RESPONSE');
  await assert.rejects(routerWith({ routes: [{ distanceMeters: 100, polyline: { encodedPolyline: encodePolyline(FIXTURE_LINE) } }] }).route([VIZAG, MANALI]), e => e.code === 'BAD_RESPONSE');
  await assert.rejects(routerWith({ routes: [{ distanceMeters: 100, duration: '10s', polyline: { encodedPolyline: '!!!!' } }] }).route([VIZAG, MANALI]), e => e.code === 'BAD_RESPONSE');
  assert.throws(() => normalizeGoogleRoute({ distanceMeters: 0, duration: '1s' }, [VIZAG, MANALI]), e => e.code === 'BAD_RESPONSE');

  const status = code => createGoogleRouteProvider({ apiKey: KEY, fetchImpl: fakeFetch(() => ({ __status: code, __body: { error: { status: 'PERMISSION_DENIED', message: `key ${KEY} is bad` } } })).fetchImpl });
  await assert.rejects(status(403).route([VIZAG, MANALI]), e => e.code === 'PROVIDER_UNAVAILABLE' && !JSON.stringify([e.message, e.details]).includes(KEY));
  await assert.rejects(status(429).route([VIZAG, MANALI]), e => e.code === 'RATE_LIMITED');
  await assert.rejects(status(503).route([VIZAG, MANALI]), e => e.code === 'PROVIDER_UNAVAILABLE');
  await assert.rejects(routerWith(ROUTE_OK).route([[999, 0], MANALI]), e => e.code === 'NO_ROUTE');

  // The detour matrix is deliberately NOT implemented in this step.
  await assert.rejects(routerWith(ROUTE_OK).legs([[VIZAG, MANALI]]), e => e.code === 'PROVIDER_NOT_READY');
  assert.ok(!scrub(`url?key=${KEY}`, KEY).includes(KEY));
});

// ---------------------------------------------------------------- planner
test('planner: Google geocoding + Google routing produce a real-provider plan', async () => {
  const { fetchImpl, calls } = fakeFetch(url => {
    if (url.includes('geocode')) return url.includes('Manali') ? GEOCODE_MANALI : GEOCODE_VIZAG;
    return ROUTE_OK;
  });
  const planner = createGeoPlanner({
    geocoder: chain('geocoding', [createGoogleGeocodingProvider({ apiKey: KEY, fetchImpl }), createOfflineGeocoder()]),
    router: chain('routing', [createGoogleRouteProvider({ apiKey: KEY, fetchImpl }), createOfflineRouter()]),
    places: chain('places', [createCuratedPlaceProvider()])
  });
  const plan = await planner.plan({ origin: 'Visakhapatnam', destination: 'Manali' });

  assert.equal(plan.route.provider, 'google-routes');
  assert.equal(plan.route.method, 'road-network');
  assert.equal(plan.route.distanceKm, 2690.4);
  assert.equal(plan.route.durationMin, 2745);
  assert.ok(plan.route.geometry.length >= 2);
  assert.equal(plan.origin.provider, 'google-geocoding');
  assert.equal(plan.origin.formattedAddress, 'Visakhapatnam, Andhra Pradesh, India');
  assert.ok(plan.places.length > 0, 'discovery still works on a Google route');
  // Honesty: the main route is real, the detour figures are still estimates.
  assert.equal(plan.places[0].detour.method, 'estimated');
  assert.match(plan.notices[0], /Detour \(\+km \/ \+min\) figures are still ROUTE\+ estimates/);
  assert.equal(calls.length, 3, 'exactly two geocodes and one route call for one journey');
});

test('planner: Google unavailable → offline plan, and the notices stay truthful', async () => {
  const { fetchImpl, calls } = fakeFetch(() => { throw new Error('network down (injected)'); });
  const planner = createGeoPlanner({
    geocoder: chain('geocoding', [createGoogleGeocodingProvider({ apiKey: KEY, fetchImpl }), createOfflineGeocoder()]),
    router: chain('routing', [createGoogleRouteProvider({ apiKey: KEY, fetchImpl }), createOfflineRouter()]),
    places: chain('places', [createCuratedPlaceProvider()])
  });
  const plan = await planner.plan({ origin: 'Visakhapatnam', destination: 'Manali' });
  assert.equal(plan.route.provider, 'offline-network');
  assert.equal(plan.origin.provider, 'offline-network');
  assert.match(plan.notices[0], /estimated from a simplified road network/);
  assert.ok(calls.length <= 3, 'a failing provider is tried once per call, never in a loop');

  assert.deepEqual(routeNotices('road-network', 'road-network')[0], 'Route and detours calculated on the real road network.');
  assert.match(routeNotices('road-network', 'estimated')[0], /Main route distance and driving time come from real road routing/);
});

test('registry: identical concurrent requests are de-duplicated and cached', async () => {
  let hits = 0;
  const fetchImpl = async url => { hits++; return { ok: true, status: 200, json: async () => (url.includes('geocode') ? GEOCODE_VIZAG : ROUTE_OK) }; };
  const geocoder = chain('geocoding', [createGoogleGeocodingProvider({ apiKey: KEY, fetchImpl }), createOfflineGeocoder()], { cache: (await import('../../shared/providers/registry.js')).createCache({ max: 10, ttlMs: 60000 }) });
  const [a, b, c] = await Promise.all([geocoder.geocode('Visakhapatnam'), geocoder.geocode('Visakhapatnam'), geocoder.geocode('visakhapatnam ')]);
  assert.equal(hits, 1, 'three identical lookups → one Google request');
  assert.equal(a.name, b.name);
  assert.equal(c.name, 'Visakhapatnam');
  await geocoder.geocode('Visakhapatnam');
  assert.equal(hits, 1, 'served from cache afterwards');
});
