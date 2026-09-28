// PRODUCTION STEP 2 — the real ROUTE+ server with Google selected.
//
// The server, the database, the planner and the API are real; only the network
// transport is replaced by an injected stand-in returning SYNTHETIC fixtures
// (tests/fixtures/google-responses.mjs). Nothing here proves the live Google
// API works — it proves the app behaves correctly with the answers Google's
// documented response shapes would give, and degrades safely when it cannot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../server/index.js';
import { LIVE_FALLBACK_MESSAGE } from '../../server/domains/journeys.js';
import { haversineKm } from '../../shared/geo.js';
import { fakeFetch, ROUTE_OK, GEOCODE_VIZAG, GEOCODE_MANALI, GEOCODE_NONE, VIZAG, MANALI } from '../fixtures/google-responses.mjs';

const SERVER_KEY = 'TEST_ONLY_SERVER_PLACEHOLDER_not_a_key';
const GOOGLE_ENV = { ROUTE_PROVIDER: 'google', GEOCODING_PROVIDER: 'google', PLACE_PROVIDER: 'curated', GOOGLE_MAPS_SERVER_KEY: SERVER_KEY };

async function start(fetchImpl, env = GOOGLE_ENV) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', logLevel: 'silent' }, env, { fetchImpl });
  const call = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${srv.port}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) };
  };
  return { srv, call };
}

/** The transport a healthy Google account would look like. */
const healthy = () => fakeFetch(url => {
  if (url.includes('/geocode/')) return url.includes('Manali') ? GEOCODE_MANALI : GEOCODE_VIZAG;
  return ROUTE_OK;
});

test('Google mode: the demo journey is planned from Google geocoding + Google routing', async () => {
  const { fetchImpl, calls } = healthy();
  const { srv, call } = await start(fetchImpl);
  try {
    const health = await call('GET', '/api/health');
    assert.deepEqual(health.json.providers.routing, ['google-routes', 'offline-network']);

    const res = await call('POST', '/api/plan', { origin: 'Visakhapatnam', destination: 'Manali', tripDays: 3, travelerType: 'Family', interests: ['Nature', 'Devotional', 'Food'] });
    assert.equal(res.status, 200);
    const plan = res.json.plan;

    // Real origin / destination / route / distance / duration reach the UI contract.
    assert.equal(plan.origin.name, 'Visakhapatnam');
    assert.equal(plan.destination.name, 'Manali');
    assert.ok(haversineKm([plan.origin.lat, plan.origin.lng], VIZAG) < 1);
    assert.ok(haversineKm([plan.destination.lat, plan.destination.lng], MANALI) < 1);
    assert.equal(plan.route.provider, 'google-routes');
    assert.equal(plan.route.method, 'road-network');
    assert.equal(plan.route.distanceKm, 2690.4);
    assert.equal(plan.route.durationMin, 2745);
    assert.ok(plan.route.geometry.length >= 2, 'the map gets road geometry');
    assert.notEqual(plan.liveFallback, true);
    assert.equal(plan.providerStatus.geocodingUsed, 'google-geocoding');
    assert.equal(plan.providerStatus.detourMethod, 'estimated', 'detours are still offline estimates — and say so');

    // Cost control: one journey = two geocodes + one route request. Nothing else.
    assert.equal(calls.filter(c => c.url.includes('/geocode/')).length, 2);
    assert.equal(calls.filter(c => c.url.includes('computeRoutes')).length, 1);
    assert.equal(calls.length, 3);
    assert.equal(calls.filter(c => c.url.includes('places.googleapis')).length, 0, 'no Places request in this step');

    // The key never leaves the server.
    const page = await fetch(`http://127.0.0.1:${srv.port}/`).then(r => r.text());
    for (const text of [res.text, health.text, page]) assert.ok(!text.includes(SERVER_KEY));

    // The real route is persisted and can be read back with its geometry.
    const saved = await call('GET', `/api/routes/${plan.routeId}`);
    assert.equal(saved.json.plan.route.provider, 'google-routes');
    assert.equal(saved.json.plan.route.distanceKm, 2690.4);
    assert.ok(saved.json.plan.route.geometry.length >= 2);
  } finally { await srv.close(); }
});

test('Google mode: a second identical journey reuses the cached answers (no extra billing)', async () => {
  const { fetchImpl, calls } = healthy();
  const { srv, call } = await start(fetchImpl);
  try {
    await call('POST', '/api/plan', { origin: 'Visakhapatnam', destination: 'Manali' });
    const first = calls.length;
    await call('POST', '/api/plan', { origin: 'Visakhapatnam', destination: 'Manali' });
    assert.equal(calls.length, first, 'the same journey costs nothing the second time');
  } finally { await srv.close(); }
});

test('Google mode: an unknown place gives a friendly 422, not a fake route', async () => {
  const { fetchImpl } = fakeFetch(url => (url.includes('/geocode/') ? GEOCODE_NONE : ROUTE_OK));
  const { srv, call } = await start(fetchImpl);
  try {
    const res = await call('POST', '/api/plan', { origin: 'Qwertyville', destination: 'Manali' });
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, 'PLACE_NOT_FOUND');
    assert.match(res.json.error.message, /couldn't find/);
    assert.doesNotMatch(res.text, /google|api|http/i, 'no vendor detail reaches the traveller');
    // The server is still healthy afterwards.
    assert.equal((await call('GET', '/api/health')).status, 200);
  } finally { await srv.close(); }
});

test('Google mode: Google down → the journey still plans, from offline data, and says so', async () => {
  const { fetchImpl, calls } = fakeFetch(() => { throw new Error('network down (injected)'); });
  const { srv, call } = await start(fetchImpl);
  try {
    const res = await call('POST', '/api/plan', { origin: 'Visakhapatnam', destination: 'Manali' });
    assert.equal(res.status, 200, 'the app must not crash when Google fails');
    assert.equal(res.json.plan.route.provider, 'offline-network');
    assert.equal(res.json.plan.liveFallback, true);
    assert.equal(res.json.plan.notices[0], LIVE_FALLBACK_MESSAGE);
    assert.ok(calls.length <= 4, 'failures are not retried in a loop');
    assert.doesNotMatch(res.text, /PROVIDER_UNAVAILABLE|network down/, 'no raw provider error reaches the traveller');
  } finally { await srv.close(); }
});

test('Google selected for routing only: Google route + offline geocoding still works', async () => {
  const { fetchImpl, calls } = healthy();
  const { srv, call } = await start(fetchImpl, { ...GOOGLE_ENV, GEOCODING_PROVIDER: 'offline' });
  try {
    const plan = (await call('POST', '/api/plan', { origin: 'Visakhapatnam', destination: 'Manali' })).json.plan;
    assert.equal(plan.route.provider, 'google-routes');
    assert.equal(plan.providerStatus.geocodingUsed, 'offline-network');
    assert.equal(calls.filter(c => c.url.includes('/geocode/')).length, 0, 'offline geocoding costs nothing');
    assert.match(plan.notices[0], /Main route distance and driving time come from real road routing/);
  } finally { await srv.close(); }
});
