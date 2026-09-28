// PRODUCTION STEP 1 — Google provider foundation.
// Covers: provider selection (Test B), secret safety (Test C), controlled
// errors + offline fallback, and log redaction. No live Google request is
// made anywhere: the adapters are boundaries only in this step.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../server/config.js';
import { resolveProviderSelection } from '../../server/providers/selection.js';
import { buildProviders, describeProviders } from '../../server/providers/index.js';
import { createGoogleRouteProvider } from '../../server/providers/google/routes.js';
import { createGoogleGeocodingProvider } from '../../server/providers/google/geocoding.js';
import { createGooglePlaceProvider } from '../../server/providers/google/places.js';
import { createGeoPlanner } from '../../shared/engine/geoPlanner.js';
import { createOfflineGeocoder, createOfflineRouter, createCuratedPlaceProvider } from '../../shared/providers/offline.js';
import { chain } from '../../shared/providers/registry.js';
import { createLogger } from '../../server/lib/observability.js';

// Obvious placeholders — NOT real keys (real keys start with "AIza").
const SERVER_KEY = 'TEST_ONLY_SERVER_PLACEHOLDER_not_a_key';
const BROWSER_KEY = 'TEST_ONLY_BROWSER_PLACEHOLDER_not_a_key';
const googleEnv = { ROUTE_PROVIDER: 'google', GEOCODING_PROVIDER: 'google', PLACE_PROVIDER: 'google', GOOGLE_MAPS_SERVER_KEY: SERVER_KEY, GOOGLE_MAPS_BROWSER_KEY: BROWSER_KEY };

test('A/B: no configuration → offline providers, no warnings', () => {
  const config = loadConfig({});
  const sel = resolveProviderSelection(config);
  assert.deepEqual([sel.routing, sel.geocoding, sel.places, sel.warnings], ['offline', 'offline', 'curated', []]);
  const p = buildProviders(config);
  assert.equal(p.summary.mode, 'offline');
  assert.deepEqual(p.summary.routing, ['offline-network']);
  assert.deepEqual(p.summary.geocoding, ['offline-network']);
  assert.deepEqual(p.summary.places, ['curated']);
  assert.deepEqual(p.summary.googleMaps, { serverKeyConfigured: false, browserKeyConfigured: false });
});

test('B: ROUTE_PROVIDER=offline uses offline; =google selects the Google adapter (offline stays as fallback)', () => {
  assert.deepEqual(buildProviders(loadConfig({ ROUTE_PROVIDER: 'offline' })).summary.routing, ['offline-network']);
  const p = buildProviders(loadConfig(googleEnv));
  assert.equal(p.summary.mode, 'live');
  assert.deepEqual(p.summary.routing, ['google-routes', 'offline-network']);
  assert.deepEqual(p.summary.geocoding, ['google-geocoding', 'offline-network']);
  assert.deepEqual(p.summary.places, ['curated', 'google-places']);
  assert.deepEqual(p.summary.googleMaps, { serverKeyConfigured: true, browserKeyConfigured: true });
  // Mixed selection works per provider
  const mixed = buildProviders(loadConfig({ ...googleEnv, GEOCODING_PROVIDER: 'offline', PLACE_PROVIDER: 'curated' })).summary;
  assert.deepEqual([mixed.routing[0], mixed.geocoding[0], mixed.places.length], ['google-routes', 'offline-network', 1]);
});

test('B: Google without a server key, unknown names, OSM without contact → offline + clear warning (no crash)', () => {
  const noKey = resolveProviderSelection(loadConfig({ ROUTE_PROVIDER: 'google', GOOGLE_MAPS_BROWSER_KEY: BROWSER_KEY }));
  assert.equal(noKey.routing, 'offline');
  assert.match(noKey.warnings[0], /needs GOOGLE_MAPS_SERVER_KEY/);
  const typo = resolveProviderSelection(loadConfig({ ROUTE_PROVIDER: 'gogle', PLACE_PROVIDER: 'GOOGLE', GOOGLE_MAPS_SERVER_KEY: SERVER_KEY }));
  assert.equal(typo.routing, 'offline');
  assert.equal(typo.places, 'google', 'case-insensitive');
  assert.match(typo.warnings[0], /Unknown routing provider "gogle"/);
  const osm = resolveProviderSelection(loadConfig({ ROUTE_PROVIDER: 'osrm' }));
  assert.equal(osm.routing, 'offline');
  assert.match(osm.warnings[0], /ROUTE_PLUS_CONTACT/);
  // Legacy switch still works, and explicit settings override it
  const legacy = resolveProviderSelection(loadConfig({ ROUTE_PLUS_LIVE_PROVIDERS: '1', ROUTE_PLUS_CONTACT: 'me@example.com' }));
  assert.deepEqual([legacy.routing, legacy.geocoding, legacy.places, legacy.weather], ['osrm', 'nominatim', 'overpass', true]);
  const override = resolveProviderSelection(loadConfig({ ROUTE_PLUS_LIVE_PROVIDERS: '1', ROUTE_PLUS_CONTACT: 'me@example.com', ROUTE_PROVIDER: 'offline' }));
  assert.equal(override.routing, 'offline');
  assert.ok(!JSON.stringify(noKey).includes(BROWSER_KEY));
});

test('Google adapters: controlled errors, no fake data, key never in a message', async () => {
  // Step 2: geocoding and the main route DO make a request (exercised with an
  // injected transport, never a real one). The matrix (detour legs) and Places
  // are still boundaries and must say so instead of inventing data.
  let fetchCalls = 0;
  const fetchImpl = async () => { fetchCalls++; throw new Error('network down (injected)'); };
  const route = createGoogleRouteProvider({ apiKey: SERVER_KEY, fetchImpl });
  const geo = createGoogleGeocodingProvider({ apiKey: SERVER_KEY, fetchImpl });
  const places = createGooglePlaceProvider({ apiKey: SERVER_KEY, fetchImpl });

  const notReady = [
    () => route.calculateRouteMatrix([]), () => route.legs([]),
    () => places.searchPlaces({}), () => places.getPlaceDetails('x'), () => places.searchCorridor({ geometry: [], bufferKm: 10 })
  ];
  for (const call of notReady) {
    await assert.rejects(call(), e => e.code === 'PROVIDER_NOT_READY' && /not implemented yet/.test(e.message) && !e.message.includes(SERVER_KEY) && !JSON.stringify(e.details).includes(SERVER_KEY));
  }
  // Live adapters: a transport failure is recoverable and leaks nothing.
  for (const call of [() => route.calculateRoute([[28.6, 77.2], [26.9, 75.8]]), () => geo.geocode('Delhi')]) {
    await assert.rejects(call(), e => e.code === 'PROVIDER_UNAVAILABLE' && !e.message.includes(SERVER_KEY) && !JSON.stringify(e.details || {}).includes(SERVER_KEY));
  }
  assert.equal(fetchCalls, 2, 'one request each, no retry loop');

  await assert.rejects(createGoogleRouteProvider({}).calculateRoute([[1, 1], [2, 2]]), e => e.code === 'PROVIDER_NOT_CONFIGURED' && e.message === 'Google route provider not configured.');
  await assert.rejects(createGoogleGeocodingProvider({}).geocode('x'), e => e.code === 'PROVIDER_NOT_CONFIGURED');
  await assert.rejects(createGooglePlaceProvider({}).searchPlaces({}), e => e.code === 'PROVIDER_NOT_CONFIGURED');
  for (const p of [route, geo, places]) assert.ok(!JSON.stringify(p).includes(SERVER_KEY), `${p.name} does not expose the key`);
  assert.equal(route.status, 'live');
});

test('Google selected but unreachable → the planner falls back to offline and still answers', async () => {
  const fetchImpl = async () => { throw new Error('network down (injected)'); };
  const planner = createGeoPlanner({
    geocoder: chain('geocoding', [createGoogleGeocodingProvider({ apiKey: SERVER_KEY, fetchImpl }), createOfflineGeocoder()]),
    router: chain('routing', [createGoogleRouteProvider({ apiKey: SERVER_KEY, fetchImpl }), createOfflineRouter()]),
    places: chain('places', [createCuratedPlaceProvider(), createGooglePlaceProvider({ apiKey: SERVER_KEY, fetchImpl })])
  });
  const plan = await planner.plan({ origin: 'Visakhapatnam', destination: 'Manali' });
  assert.equal(plan.route.provider, 'offline-network');
  assert.ok(plan.places.length > 20);
});

test('C: config and summaries never contain key values', () => {
  const config = loadConfig(googleEnv);
  assert.equal(config.googleMapsServerKey, SERVER_KEY, 'adapter can read it');
  for (const view of [JSON.stringify(config), JSON.stringify({ ...config }), Object.keys(config).join(','), JSON.stringify(buildProviders(config).summary), describeProviders(buildProviders(config).summary)]) {
    assert.ok(!view.includes(SERVER_KEY) && !view.includes(BROWSER_KEY));
  }
});

test('C: logger redacts key-like fields and Google key patterns', () => {
  const lines = [];
  const log = createLogger('info', l => lines.push(l));
  const fakePattern = `AIza${'X'.repeat(35)}`; // shape of a key, built at runtime, not a real key
  log.info('test', { googleMapsServerKey: 'secret-value', apiKey: 'another', nested: { authorization: 'Bearer x' }, note: `oops ${fakePattern}`, serverKeyConfigured: true });
  assert.ok(!lines[0].includes('secret-value') && !lines[0].includes('another') && !lines[0].includes(fakePattern) && !lines[0].includes('Bearer'));
  assert.match(lines[0], /"serverKeyConfigured":true/, 'booleans that only say "configured" stay visible');
});

test('C: no hardcoded Google keys in the source; the server key name never appears in frontend code', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    if (['.git', 'node_modules', 'data'].includes(d.name)) return [];
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : [p];
  });
  const files = walk(root).filter(f => /\.(m?js|html|css|json|md|sql|env\.example|sh)$|\.env\.example$/.test(f));
  const keyShape = /AIza[0-9A-Za-z_-]{35}/;
  for (const f of files) assert.ok(!keyShape.test(fs.readFileSync(f, 'utf8')), `possible API key in ${path.relative(root, f)}`);
  const frontend = files.filter(f => f.includes(`${path.sep}web${path.sep}`) || f.includes(`${path.sep}dist${path.sep}`));
  assert.ok(frontend.length > 10);
  for (const f of frontend) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/GOOGLE_MAPS_SERVER_KEY|googleMapsServerKey/.test(text), `server key referenced in frontend file ${path.relative(root, f)}`);
  }
  assert.ok(!fs.existsSync(path.join(root, '.env')) || fs.readFileSync(path.join(root, '.gitignore'), 'utf8').includes('.env'), '.env is git-ignored');
});
