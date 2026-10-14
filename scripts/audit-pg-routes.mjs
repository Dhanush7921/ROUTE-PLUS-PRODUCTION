// FINAL AUDIT — exercise EVERY declared API route against PostgreSQL.
//
// The parity risk in a dual-backend server is one unbranched db.prepare() on a
// path nobody tests: it does not degrade on PostgreSQL, it throws
// "db.prepare is not a function" and returns 500. A static scan cannot settle
// this (a SQLite-only module is correct; an unbranched domain call is not), so
// this drives all 27 routes for real and reports any 500.
//
//   ROUTE_PLUS_DB_MODE=postgres DATABASE_URL=... node scripts/audit-pg-routes.mjs
//
// Every route is expected to answer with SOMETHING sane. 4xx is a pass when it
// is the documented answer (401 unauthenticated, 404 unknown id, 400 bad input).
// 500, and any response mentioning prepare/query, is a failure.

import { startServer } from '../server/index.js';

// Whichever backend the environment selects, so the same sweep proves both.
const mode = process.env.ROUTE_PLUS_DB_MODE || 'postgres';
const srv = await startServer(
  { port: 0, host: '127.0.0.1', logLevel: 'silent' },
  { ...process.env, ROUTE_PLUS_DB_MODE: mode, NODE_ENV: 'test', ADMIN_EMAILS: 'audit-admin@routeplus.test' }
);

const jar = [];
const call = async (method, p, body) => {
  const res = await fetch(`http://127.0.0.1:${srv.port}${p}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar.length ? { Cookie: jar.join('; ') } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  for (const c of (res.headers.getSetCookie?.() || [])) {
    const kv = c.split(';')[0], k = kv.split('=')[0];
    const i = jar.findIndex(x => x.startsWith(`${k}=`));
    if (i >= 0) jar[i] = kv; else jar.push(kv);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
};

let failures = 0;
const results = [];
const hit = async (label, method, p, body, allowed = [200]) => {
  let r;
  try {
    r = await call(method, p, body);
  } catch (error) {
    results.push({ label, method, p, status: 'THREW', detail: error.message });
    failures++;
    return null;
  }
  const backendLeak = /is not a function|db\.prepare|\.query is not|prepare\(/i.test(r.text);
  const ok = allowed.includes(r.status) && !backendLeak;
  if (!ok) failures++;
  results.push({
    label, method, p, status: r.status, ok,
    detail: backendLeak ? `BACKEND LEAK: ${r.text.slice(0, 160)}`
      : ok ? (r.json?.error?.code || '')
        : `expected ${allowed.join('/')} — ${(r.json?.error?.message || r.text).slice(0, 140)}`
  });
  return r;
};

// ---- unauthenticated surface -------------------------------------------------
await hit('health', 'GET', '/api/health');
await hit('me (signed out)', 'GET', '/api/me', null, [200, 401]);
await hit('places/near', 'GET', '/api/places/near?lat=28.6139&lng=77.2090&radiusKm=200');
await hit('personalization (signed out)', 'GET', '/api/personalization');
await hit('context', 'POST', '/api/context', { phases: [{ id: 'p1', lat: 28.6, lng: 77.2 }] });
await hit('events (signed out)', 'POST', '/api/events', { events: [{ name: 'journey_started', sessionId: 's1', props: {} }] });
await hit('trips (signed out)', 'GET', '/api/trips', null, [200, 401]);
await hit('unknown route id', 'GET', '/api/routes/rte_does_not_exist', null, [404, 400]);

// ---- plan, then the authenticated surface -----------------------------------
const planned = await hit('plan', 'POST', '/api/plan', {
  origin: 'Chennai', destination: 'Ooty', tripDays: 3,
  travelerType: 'Family', interests: ['Nature', 'Food', 'Heritage']
});
const plan = planned?.json?.plan;
if (plan?.routeId) await hit('routes/:id', 'GET', `/api/routes/${plan.routeId}`);

const admin = { email: 'audit-admin@routeplus.test', password: 'Route-Plus-Audit-2026', displayName: 'Audit Admin' };
const signup = await hit('auth/signup', 'POST', '/api/auth/signup', admin, [200, 409]);
if (signup?.status === 409) {
  jar.length = 0;
  await hit('auth/login (existing account)', 'POST', '/api/auth/login', { email: admin.email, password: admin.password });
}

await hit('me', 'GET', '/api/me');
await hit('me PATCH', 'PATCH', '/api/me', { displayName: 'Audit Admin Renamed' });
await hit('me/preferences', 'PUT', '/api/me/preferences', {
  travelerType: 'Family', interests: ['Nature', 'Food'], defaultDays: 4, locationOptIn: true
});
await hit('me (after preferences)', 'GET', '/api/me');

const stop = plan?.places?.find(p => Number.isFinite(p.detourDistanceKm)) || plan?.places?.[0];
const saved = await hit('trips POST', 'POST', '/api/trips', {
  plan, origin: 'Chennai', destination: 'Ooty', originalDays: 3, tripDays: 3,
  travelerType: 'Family', interests: ['Nature', 'Food', 'Heritage'],
  selectedStops: stop ? [stop.id] : [], skippedPlaces: []
});
const tripId = saved?.json?.trip?.id;

await hit('trips GET', 'GET', '/api/trips');
await hit('trips/history', 'GET', '/api/trips?history=1');
if (tripId) {
  await hit('trips/:id', 'GET', `/api/trips/${tripId}`);
  await hit('trips/:id/status', 'POST', `/api/trips/${tripId}/status`, { status: 'active' });
  if (stop) await hit('trips/:id/visited', 'POST', `/api/trips/${tripId}/visited`, { placeId: stop.id });
}
await hit('trips/:id (unknown)', 'GET', '/api/trips/trp_does_not_exist', null, [404, 400]);

if (stop) await hit('feedback', 'POST', '/api/feedback', { placeId: stop.id, visited: true, worthIt: true, rating: 4, comment: 'Audit run.' });
await hit('personalization (signed in)', 'GET', '/api/personalization');

// ---- admin surface ----------------------------------------------------------
await hit('admin/overview', 'GET', '/api/admin/overview');
const places = await hit('admin/places', 'GET', '/api/admin/places?q=');
const placeId = places?.json?.places?.[0]?.id;
if (placeId) {
  await hit('admin/places/:id PATCH', 'PATCH', `/api/admin/places/${placeId}`, {
    caution: 'Audit note — steep final approach.', visitDurationMinutes: 45
  });
  for (const action of ['flag', 'unflag', 'disable', 'enable']) {
    await hit(`admin/places/:id/${action}`, 'POST', `/api/admin/places/${placeId}/${action}`, {}, [200, 400, 404]);
  }
}
await hit('admin/performance', 'GET', '/api/admin/performance');
await hit('admin/feedback', 'GET', '/api/admin/feedback');
await hit('admin/audit', 'GET', '/api/admin/audit');

// ---- and finally sign out ---------------------------------------------------
if (tripId) await hit('trips/:id DELETE', 'DELETE', `/api/trips/${tripId}`, null, [200, 204, 404]);
await hit('auth/logout', 'POST', '/api/auth/logout');
await hit('trips after logout', 'GET', '/api/trips', null, [200, 401]);

await srv.close();

const pad = s => String(s).padEnd(30);
console.log(`\n  ROUTE SWEEP — ${mode} mode\n`);
for (const r of results) {
  console.log(`  ${r.ok === false ? 'FAIL' : 'ok  '}  ${String(r.status).padStart(5)}  ${r.method.padEnd(6)} ${pad(r.label)}${r.detail ? ` ${r.detail}` : ''}`);
}
console.log(`\n  ${results.length} calls · ${failures === 0 ? 'NO 500s, NO BACKEND LEAKS' : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
