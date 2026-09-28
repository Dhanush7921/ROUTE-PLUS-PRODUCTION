// PRODUCTION STEP 1 — the real server in offline mode and in Google mode.
// Test A (no .env), Test C (no key in API responses), Test D (startup log).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../server/index.js';

const SERVER_KEY = 'TEST_ONLY_SERVER_PLACEHOLDER_not_a_key';
const BROWSER_KEY = 'TEST_ONLY_BROWSER_PLACEHOLDER_not_a_key';

/** Start the real server with a given environment and capture its log output. */
// No test ever reaches a real vendor: an injected transport stands in for fetch.
const OFFLINE_TRANSPORT = async () => { throw new Error('network disabled in tests'); };

async function start(env, fetchImpl = OFFLINE_TRANSPORT) {
  const lines = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { lines.push(String(chunk)); return true; };
  let srv;
  try {
    srv = await startServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', logLevel: 'info' }, env, { fetchImpl });
  } finally {
    process.stdout.write = original;
  }
  const base = `http://127.0.0.1:${srv.port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) };
  };
  return { srv, call, log: lines.join('') };
}

test('A: no .env at all → server starts in offline mode and plans the demo journey', async () => {
  const { srv, call, log } = await start({});
  const health = (await call('GET', '/api/health')).json;
  assert.equal(health.providers.mode, 'offline');
  assert.deepEqual(health.providers.routing, ['offline-network']);
  const plan = await call('POST', '/api/plan', { origin: 'Visakhapatnam', destination: 'Manali', tripDays: 3, travelerType: 'Family', interests: ['Nature', 'Devotional', 'Food'] });
  assert.equal(plan.status, 200);
  assert.equal(plan.json.plan.route.provider, 'offline-network');
  assert.notEqual(plan.json.plan.liveFallback, true, 'no fallback notice when offline was chosen');
  assert.match(log, /"mode":"offline"/);
  await srv.close();
});

test('Google mode (placeholder keys): adapters selected, requests fall back to offline with a friendly notice, keys never leave the server', async () => {
  const env = { ROUTE_PROVIDER: 'google', GEOCODING_PROVIDER: 'google', PLACE_PROVIDER: 'google', GOOGLE_MAPS_SERVER_KEY: SERVER_KEY, GOOGLE_MAPS_BROWSER_KEY: BROWSER_KEY };
  const { srv, call, log } = await start(env);
  const health = await call('GET', '/api/health');
  assert.deepEqual(health.json.providers.routing, ['google-routes', 'offline-network']);
  assert.equal(health.json.providers.googleMaps.serverKeyConfigured, true);
  const plan = await call('POST', '/api/plan', { origin: 'Delhi', destination: 'Jaipur' });
  assert.equal(plan.status, 200, 'the app keeps working');
  assert.equal(plan.json.plan.route.provider, 'offline-network');
  assert.equal(plan.json.plan.liveFallback, true);
  assert.equal(plan.json.plan.notices[0], 'Live map services are currently unavailable. ROUTE+ is using offline route data.');
  assert.doesNotMatch(plan.text, /not implemented|PROVIDER_NOT_READY/, 'no raw adapter errors reach the user');
  // Test C: no key in any response or page
  const page = await fetch(`http://127.0.0.1:${srv.port}/`).then(r => r.text());
  for (const text of [health.text, plan.text, page, (await call('GET', '/api/me')).text]) {
    assert.ok(!text.includes(SERVER_KEY) && !text.includes(BROWSER_KEY));
  }
  // Test D: startup log shows the active providers, never the keys
  assert.match(log, /"routing":\["google-routes","offline-network"\]/);
  assert.match(log, /"geocoding":\["google-geocoding","offline-network"\]/);
  assert.match(log, /"places":\["curated","google-places"\]/);
  assert.ok(!log.includes(SERVER_KEY) && !log.includes(BROWSER_KEY));
  // Provider health records the controlled failure
  const snapshot = srv.app.metrics.snapshot();
  assert.ok(snapshot.providers.some(p => p.provider === 'google-routes' && p.failed > 0));
  await srv.close();
});

test('D: Google requested without a server key → server starts, logs a warning, stays offline', async () => {
  const { srv, call, log } = await start({ ROUTE_PROVIDER: 'google' });
  assert.match(log, /needs GOOGLE_MAPS_SERVER_KEY/);
  assert.deepEqual((await call('GET', '/api/health')).json.providers.routing, ['offline-network']);
  assert.equal((await call('POST', '/api/plan', { origin: 'Mumbai', destination: 'Goa' })).status, 200);
  await srv.close();
});
