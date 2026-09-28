// Integration tests: the real HTTP server + real SQLite (in memory) + real
// engine, exercised through HTTP exactly like the browser does.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDatabase } from '../../server/db/database.js';
import { createApp } from '../../server/app.js';
import { buildProviders } from '../../server/providers/index.js';
import { loadConfig } from '../../server/config.js';
import { createLogger } from '../../server/lib/observability.js';
import { ProviderError } from '../../shared/providers/contracts.js';
import { chain } from '../../shared/providers/registry.js';
import { createOfflineRouter } from '../../shared/providers/offline.js';

async function boot({ providers: override, config: extra = {} } = {}) {
  const config = { ...loadConfig({}), dbPath: ':memory:', adminEmails: ['admin@example.com'], ...extra };
  const db = openDatabase(':memory:');
  const providers = { ...buildProviders(config), ...override };
  const app = createApp({ config, db, providers, logger: createLogger('silent') });
  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, path, body, headers = {}) => {
      const res = await fetch(base + path, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* html */ }
      return { status: res.status, body: json, text, headers: res.headers };
    };
  };
  return { base, db, app, client, close: () => new Promise(r => server.close(r)) };
}

const journeyFrom = plan => ({ plan, tripDays: 2, originalDays: 1, travelerType: 'Family', interests: ['Heritage', 'Food'], selectedStops: [plan.places[0].id], skippedPlaces: [plan.places[1].id], keptOverLimit: false });

test('health, static files, security headers, 404 and path traversal', async () => {
  const s = await boot();
  const c = s.client();
  const h = await c('GET', '/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true);
  const page = await c('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /<meta name="route-plus-api"/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal((await c('GET', '/shared/geo.js')).status, 200);
  assert.equal((await c('GET', '/../server/config.js')).status, 404);
  assert.equal((await c('GET', '/shared/../server/db/schema.sql')).status, 404);
  assert.equal((await c('GET', '/%2e%2e/server/config.js')).status, 404, 'encoded traversal blocked');
  assert.equal((await c('GET', '/shared/%2e%2e/server/db/schema.sql')).status, 404, 'encoded traversal blocked in /shared');
  assert.equal((await c('GET', '/api/nope')).status, 404);
  assert.equal((await c('DELETE', '/api/health')).status, 405);
  await s.close();
});

test('auth: signup, me, logout, login, wrong password, duplicate, weak password', async () => {
  const s = await boot();
  const c = s.client();
  assert.equal((await c('POST', '/api/auth/signup', { email: 'bad', password: 'longenough' })).status, 400);
  assert.equal((await c('POST', '/api/auth/signup', { email: 'a@b.co', password: 'short' })).body.error.code, 'WEAK_PASSWORD');
  const up = await c('POST', '/api/auth/signup', { email: 'Deva@Example.com', password: 'correct horse', displayName: 'Deva' });
  assert.equal(up.status, 200);
  assert.equal(up.body.user.email, 'deva@example.com');
  assert.match(up.headers.get('set-cookie'), /HttpOnly; ?|HttpOnly/);
  assert.match(up.headers.get('set-cookie'), /SameSite=Lax/);
  assert.equal((await c('GET', '/api/me')).body.user.displayName, 'Deva');
  assert.equal((await c('POST', '/api/auth/signup', { email: 'deva@example.com', password: 'another one' })).status, 409);
  await c('POST', '/api/auth/logout', {});
  assert.equal((await c('GET', '/api/me')).body.user, null);
  assert.equal((await c('POST', '/api/auth/login', { email: 'deva@example.com', password: 'wrong password' })).status, 401);
  assert.equal((await c('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'whatever1' })).body.error.message, 'Email or password is incorrect.');
  assert.equal((await c('POST', '/api/auth/login', { email: 'deva@example.com', password: 'correct horse' })).status, 200);
  const row = s.db.prepare('SELECT password_hash FROM users').get();
  assert.match(row.password_hash, /^scrypt\$/);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash LIKE ?').get('%=%').n, 0, 'raw tokens are never stored');
  await s.close();
});

test('plan: success persists route + detours; errors are friendly and field-specific', async () => {
  const s = await boot();
  const c = s.client();
  const ok = await c('POST', '/api/plan', { origin: 'Mumbai', destination: 'Goa' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.plan.routeId);
  assert.ok(ok.body.plan.places.length > 5);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM detour_calculations WHERE route_id = ?').get(ok.body.plan.routeId).n, ok.body.plan.places.length);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM route_segments WHERE route_id = ?').get(ok.body.plan.routeId).n, ok.body.plan.phases.length);
  const notFound = await c('POST', '/api/plan', { origin: 'Mumbai', destination: 'Narnia' });
  assert.equal(notFound.status, 422);
  assert.equal(notFound.body.error.details.field, 'destination');
  const empty = await c('POST', '/api/plan', { origin: '', destination: 'Goa' });
  assert.equal(empty.body.error.details.field, 'origin');
  assert.equal((await c('POST', '/api/plan', '{not json')).status, 400);
  assert.equal((await c('POST', '/api/plan', { origin: 'Mumbai', destination: 'Goa' }, { 'Content-Type': 'text/plain' })).status, 415);
  await s.close();
});

test('provider outage falls back to offline; total outage gives a friendly 503', async () => {
  const down = { name: 'osrm', method: 'road-network', route: async () => { throw new ProviderError('PROVIDER_UNAVAILABLE', 'ECONNREFUSED 10.0.0.1'); }, legs: async () => { throw new ProviderError('PROVIDER_UNAVAILABLE', 'down'); } };
  const s = await boot({ providers: { router: chain('routing', [down, createOfflineRouter()]) } });
  const c = s.client();
  const r = await c('POST', '/api/plan', { origin: 'Delhi', destination: 'Jaipur' });
  assert.equal(r.status, 200);
  assert.equal(r.body.plan.route.provider, 'offline-network');
  await s.close();

  const s2 = await boot({ providers: { router: chain('routing', [down]) } });
  const r2 = await s2.client()('POST', '/api/plan', { origin: 'Delhi', destination: 'Jaipur' });
  assert.equal(r2.status, 503);
  assert.doesNotMatch(r2.body.error.message, /ECONNREFUSED|10\.0\.0\.1/, 'raw provider errors are never shown');
  await s2.close();
});

test('live mode with every external service unreachable still plans (graceful degradation)', async () => {
  const unreachable = async () => { throw new TypeError('fetch failed'); };
  const config = { ...loadConfig({}), liveProviders: true, contact: 'test@example.com', contactConfigured: true };
  const s = await boot({ providers: buildProviders(config, { fetchImpl: unreachable }) });
  const c = s.client();
  assert.deepEqual((await c('GET', '/api/health')).body.providers.routing, ['osrm', 'offline-network']);
  const r = await c('POST', '/api/plan', { origin: 'Delhi', destination: 'Jaipur' });
  assert.equal(r.status, 200);
  assert.equal(r.body.plan.route.provider, 'offline-network');
  assert.ok(r.body.plan.places.length > 3, 'curated places still available when OpenStreetMap is down');
  const ctx = await c('POST', '/api/context', { phases: [{ id: 'x', lat: 27, lng: 76 }] });
  assert.equal(ctx.status, 200, 'weather outage is not an error for the traveller');
  await s.close();
});

test('trips: save, list, restore, update, visited, status/history, and strict ownership', async () => {
  const s = await boot();
  const a = s.client();
  const b = s.client();
  assert.equal((await a('GET', '/api/trips')).status, 401);
  await a('POST', '/api/auth/signup', { email: 'a@example.com', password: 'password-a' });
  await b('POST', '/api/auth/signup', { email: 'b@example.com', password: 'password-b' });
  const plan = (await a('POST', '/api/plan', { origin: 'Delhi', destination: 'Jaipur' })).body.plan;
  const saved = await a('POST', '/api/trips', journeyFrom(plan));
  assert.equal(saved.status, 200);
  const trip = saved.body.trip;
  assert.deepEqual(trip.selectedStops, [plan.places[0].id]);
  assert.deepEqual(trip.skippedPlaces, [plan.places[1].id]);
  assert.equal(trip.tripDays, 2);
  assert.equal(trip.originalDays, 1);
  assert.equal(trip.plan.id, plan.id);

  const updated = await a('POST', '/api/trips', { ...journeyFrom(plan), serverTripId: trip.id, selectedStops: [plan.places[0].id, plan.places[2].id], tripDays: 3 });
  assert.equal(updated.body.trip.id, trip.id, 'same trip updated, not duplicated');
  assert.equal((await a('GET', '/api/trips')).body.trips.length, 1);
  await a('POST', `/api/trips/${trip.id}/visited`, { placeId: plan.places[0].id });
  assert.deepEqual((await a('GET', `/api/trips/${trip.id}`)).body.trip.visitedStops, [plan.places[0].id]);

  // user B cannot read, change or delete A's trip
  assert.equal((await b('GET', `/api/trips/${trip.id}`)).status, 404);
  assert.equal((await b('DELETE', `/api/trips/${trip.id}`)).status, 404);
  const hijack = await b('POST', '/api/trips', { ...journeyFrom(plan), serverTripId: trip.id });
  assert.notEqual(hijack.body.trip.id, trip.id, 'B gets a new trip of their own');
  assert.equal((await a('GET', `/api/trips/${trip.id}`)).body.trip.tripDays, 3, 'A trip untouched');

  await a('POST', `/api/trips/${trip.id}/status`, { status: 'completed' });
  assert.equal((await a('GET', '/api/trips')).body.history.length, 1);
  assert.equal((await a('POST', `/api/trips/${trip.id}/status`, { status: 'teleported' })).status, 400);
  assert.equal((await a('POST', '/api/trips', { ...journeyFrom(plan), travelerType: 'Robot' })).status, 400);
  assert.equal((await a('DELETE', `/api/trips/${trip.id}`)).status, 200);
  assert.equal((await a('GET', `/api/trips/${trip.id}`)).status, 404);
  await s.close();
});

test('preferences are validated and stored', async () => {
  const s = await boot();
  const c = s.client();
  await c('POST', '/api/auth/signup', { email: 'p@example.com', password: 'password-p' });
  const r = await c('PUT', '/api/me/preferences', { travelerType: 'Couple', interests: ['Food', 'Nonsense', 'Food'], locationOptIn: true });
  assert.deepEqual(r.body.preferences, { travelerType: 'Couple', interests: ['Food'], defaultDays: null, locationOptIn: true });
  assert.equal((await c('PUT', '/api/me/preferences', { travelerType: 'Pirate' })).status, 400);
  await s.close();
});

test('events: unknown names and extra fields are dropped; no location stored', async () => {
  const s = await boot();
  const c = s.client();
  const r = await c('POST', '/api/events', { events: [
    { name: 'discovery_added', props: { placeId: 'curated:taj-mahal', category: 'heritage', lat: 27.1, lng: 78.0, email: 'x@y.z' } },
    { name: 'hack_the_planet', props: {} }
  ] });
  assert.equal(r.body.stored, 1);
  const props = JSON.parse(s.db.prepare('SELECT props FROM analytics_events').get().props);
  assert.deepEqual(Object.keys(props).sort(), ['category', 'placeId']);
  await s.close();
});

test('feedback + behaviour produce explainable personalisation', async () => {
  const s = await boot();
  const c = s.client();
  await c('POST', '/api/auth/signup', { email: 'f@example.com', password: 'password-f' });
  const events = Array.from({ length: 4 }, () => ({ name: 'discovery_added', props: { placeId: 'curated:chitrakote', category: 'waterfall' } }))
    .concat(Array.from({ length: 4 }, () => ({ name: 'discovery_skipped', props: { placeId: 'curated:gwalior-fort', category: 'heritage' } })));
  await c('POST', '/api/events', { events });
  for (let i = 0; i < 3; i++) await c('POST', '/api/feedback', { placeId: 'curated:behror-midway', visited: true, worthIt: false });
  const p = (await c('GET', '/api/personalization')).body;
  assert.ok(p.categories.waterfall > 0, 'likes waterfalls');
  assert.ok(p.categories.heritage < 0, 'skips heritage');
  assert.equal(p.places['curated:behror-midway'].points, -10);
  assert.match(p.places['curated:behror-midway'].label, /0% of 3 travellers/);
  await s.close();
});

test('admin: forbidden for travellers; disable removes a place from new plans; audit logged', async () => {
  const s = await boot();
  const t = s.client();
  const admin = s.client();
  await t('POST', '/api/auth/signup', { email: 't@example.com', password: 'password-t' });
  await admin('POST', '/api/auth/signup', { email: 'admin@example.com', password: 'password-admin' });
  assert.equal((await t('GET', '/api/admin/overview')).status, 403);
  assert.equal((await s.client()('GET', '/api/admin/overview')).status, 401);
  const before = (await admin('POST', '/api/plan', { origin: 'Delhi', destination: 'Jaipur' })).body.plan;
  assert.ok(before.places.some(p => p.id === 'curated:amber-fort'));
  assert.equal((await admin('POST', '/api/admin/places/curated:amber-fort/disable', {})).status, 200);
  const after = (await admin('POST', '/api/plan', { origin: 'Delhi', destination: 'Jaipur' })).body.plan;
  assert.ok(!after.places.some(p => p.id === 'curated:amber-fort'));
  const edit = await admin('PATCH', '/api/admin/places/curated:nahargarh', { visitDurationMinutes: 90, quality: 4.9, name: '  Nahargarh Fort  ' });
  assert.equal(edit.body.place.visitDurationMinutes, 90);
  assert.equal(edit.body.place.name, 'Nahargarh Fort');
  const flagged = await admin('POST', '/api/admin/places/curated:nahargarh/flag', { reason: 'Hours changed' });
  assert.equal(flagged.body.place.flagged, true);
  const ov = await admin('GET', '/api/admin/overview');
  assert.ok(ov.body.system.providers.length > 0, 'provider health tracked');
  const auditRows = (await admin('GET', '/api/admin/audit')).body.audit.map(a => a.action);
  assert.ok(auditRows.includes('place.disable') && auditRows.includes('place.update') && auditRows.includes('place.flag'));
  await s.close();
});

test('rate limiting and cross-site request blocking', async () => {
  const s = await boot({ config: { publicUrl: 'https://routeplus.example' } });
  const c = s.client();
  const blocked = await c('POST', '/api/auth/login', { email: 'x@y.zz', password: 'nope' }, { Origin: 'https://evil.example' });
  assert.equal(blocked.status, 403);
  let last;
  for (let i = 0; i < 12; i++) last = await c('POST', '/api/auth/login', { email: 'x@y.zz', password: 'nope' });
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) > 0);
  await s.close();
});

test('places near a GPS point (companion) returns nearest active places', async () => {
  const s = await boot();
  const c = s.client();
  const r = await c('GET', '/api/places/near?lat=26.98&lng=75.85&radiusKm=20');
  assert.equal(r.body.places[0].name, 'Amber Fort');
  assert.ok(r.body.places.every(p => p.distanceKm <= 20));
  assert.equal((await c('GET', '/api/places/near?lat=999&lng=1')).status, 400);
  await s.close();
});
