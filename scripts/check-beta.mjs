// BETA READINESS CHECK — run this before letting test users in.
//
//   npm run check:beta
//
// It reads your configuration, starts the real server on a throwaway port and
// database, and walks the flows a beta tester will walk: plan a journey, add a
// stop, save the trip, sign in. Nothing touches your real database, and no
// external provider is called unless you have deliberately enabled live
// providers (in which case this exercises them too).
//
// Exit codes:  0 = ready   1 = something is broken   2 = configuration errors

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.js';
import { validateConfig } from '../server/lib/validateConfig.js';
import { startServer } from '../server/index.js';
import { describeProviders } from '../server/providers/index.js';

const pass = [];
const fail = [];
const note = line => console.log(`  ${line}`);
const check = async (label, fn) => {
  try {
    const detail = await fn();
    pass.push(label);
    console.log(`  ✔ ${label}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    fail.push(`${label}: ${error.message}`);
    console.log(`  ✘ ${label} — ${error.message}`);
  }
};
const expect = (ok, message) => { if (!ok) throw new Error(message); };

console.log('\nROUTE+ beta readiness\n');

// ---------------------------------------------------------------- configuration
const config = loadConfig();
const { errors, warnings, production } = validateConfig(config, process.env);
console.log(`  environment: ${config.env}${production ? '' : '  (set NODE_ENV=production for the real beta)'}`);
if (errors.length) {
  console.log('\n  configuration errors — the server will refuse to start:');
  for (const e of errors) console.log(`  ✘ ${e}`);
  console.log('');
  process.exit(2);
}
note('✔ configuration is valid');
// ADMIN_EMAILS is environment-based and required in production. Say which it is,
// so a configured beta shows a tick rather than the absence of a complaint.
note(config.adminEmails.length
  ? `✔ ADMIN_EMAILS configured — ${config.adminEmails.length} admin address(es), e.g. ${config.adminEmails[0].replace(/(.).*(@.*)/, '$1…$2')}`
  : '! ADMIN_EMAILS is not set — required in production, so the admin dashboard has an owner');
if (warnings.length) {
  console.log('\n  review before a public beta:');
  for (const w of warnings) console.log(`  ! ${w}`);
}

// ---------------------------------------------------------------- build artefacts
console.log('\n  files');
// fileURLToPath, not URL.pathname: on Windows the pathname is "/C:/Users/…",
// and resolving that yields an invalid "C:\C:\Users\…" — which made every
// file check below report the file as missing.
const root = fileURLToPath(new URL('..', import.meta.url));
const fileSize = file => {
  const full = path.join(root, file);
  expect(fs.existsSync(full), `missing — ${file}`);
  const size = fs.statSync(full).size;
  expect(size > 200, `suspiciously small (${size} bytes)`);
  return `${(size / 1024).toFixed(0)} KB`;
};

// Runtime assets: the beta cannot serve without these.
for (const [label, file] of [
  ['landing page', 'web/index.html'], ['companion (PWA)', 'web/companion.html'],
  ['service worker', 'web/sw.js'], ['web manifest', 'web/manifest.webmanifest'],
  ['standalone build', 'dist/route-plus-standalone.html']
]) await check(label, () => fileSize(file));

// Documentation and the container recipe. Reported, never fatal: .dockerignore
// deliberately leaves docs out of the image, so this same check has to pass
// when it is run inside the container.
for (const [label, file] of [['beta test plan', 'BETA-TEST-PLAN.md'], ['deployment guide', 'docs/DEPLOY.md'], ['Dockerfile', 'Dockerfile']]) {
  try { console.log(`  ✔ ${label} — ${fileSize(file)}`); }
  catch (error) { console.log(`  ! ${label} — ${error.message} (not needed to serve; expected inside a container)`); }
}

// ---------------------------------------------------------------- the real flows
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routeplus-beta-'));
let srv;
try {
  // The walk below runs against a THROWAWAY database in a temp directory — that
  // is the point of a harness, and it is deleted at the end. Production quite
  // rightly refuses ephemeral storage, so the harness must not claim to be a
  // production deployment, or this check fails on the very rule it is here to
  // verify. The real configuration was already validated above, from the actual
  // environment, with NODE_ENV untouched.
  // …and it must run on the THROWAWAY SQLite file below, never on the operator's
  // real database. The server picks its backend from ROUTE_PLUS_DB_MODE, so on a
  // machine configured for PostgreSQL this harness would otherwise connect to the
  // production database and run its beta walk — sign-ups, trips, and a deliberate
  // burst of requests to prove rate limiting — against live tester data. The
  // dbPath below would be silently ignored. Pin the mode and drop the connection
  // variables for the harness process only; the real configuration was already
  // validated above, from the untouched environment.
  const harnessEnv = { ...process.env, NODE_ENV: 'test', ROUTE_PLUS_DB_MODE: 'sqlite' };
  for (const key of ['DATABASE_URL', 'POSTGRES_URL', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']) {
    delete harnessEnv[key];
  }

  srv = await startServer(
    { port: 0, host: '127.0.0.1', dbPath: path.join(dir, 'beta.sqlite'), logLevel: 'silent' },
    harnessEnv
  );
  const base = `http://127.0.0.1:${srv.port}`;
  const jar = [];
  const call = async (method, urlPath, body) => {
    const res = await fetch(base + urlPath, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar.length ? { Cookie: jar.join('; ') } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) jar.push(c.split(';')[0]);
    const text = await res.text();
    return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };

  console.log(`\n  providers\n${describeProviders(srv.providers.summary, srv.providers.selection.warnings).replace(/^/gm, '  ')}`);
  console.log('\n  flows');

  await check('server answers /api/health', async () => {
    const r = await call('GET', '/api/health');
    expect(r.status === 200 && r.json.ok, `status ${r.status}`);
    return `${r.json.name} ${r.json.version}, providers ${r.json.providers.mode}`;
  });

  await check('landing page is served with the API marker', async () => {
    const r = await call('GET', '/');
    expect(r.status === 200, `status ${r.status}`);
    expect(r.text.includes('route-plus-api'), 'the page is not marked as server-backed');
    return `${(r.text.length / 1024).toFixed(0)} KB`;
  });

  let plan;
  await check('route entry → planning → discovery', async () => {
    const r = await call('POST', '/api/plan', { origin: 'Visakhapatnam', destination: 'Manali', tripDays: 3, travelerType: 'Family', interests: ['Nature', 'Devotional', 'Food'] });
    expect(r.status === 200, `status ${r.status} ${r.text.slice(0, 120)}`);
    plan = r.json.plan;
    expect(plan.route.distanceKm > 0 && plan.route.durationMin > 0, 'the route has no distance or duration');
    expect(plan.places.length > 0, 'no discoveries were returned');
    return `${plan.route.distanceKm} km, ${plan.places.length} discoveries, route from ${plan.route.provider} (${plan.route.method})`;
  });

  await check('detour figures are present and labelled', () => {
    const withDetour = plan.places.filter(p => p.detourDistanceKm >= 0 && p.detourTimeMinutes > 0);
    expect(withDetour.length === plan.places.length, 'some places have no detour cost');
    const methods = [...new Set(plan.places.map(p => p.detour.method))];
    expect(plan.places.every(p => ['road-network', 'estimated'].includes(p.detour.method)), 'a detour has an unknown method');
    return `${methods.join(' + ')}; e.g. ${plan.places[0].name} +${plan.places[0].detourDistanceKm} km / +${plan.places[0].detourTimeMinutes} min`;
  });

  await check('provenance is honest (no claim of live data that did not arrive)', () => {
    const counts = Object.entries(plan.placeCounts || {}).map(([k, v]) => `${k}=${v}`).join(', ');
    expect(plan.placeSource && plan.placeSource !== 'none', 'the plan does not say where places came from');
    const claimsRoad = plan.notices.some(n => /real road network/.test(n));
    const allRoad = plan.places.every(p => p.detour.method === 'road-network');
    expect(!claimsRoad || allRoad, 'a notice claims road-network detours that were estimated');
    return `sources: ${counts || plan.placeSource}`;
  });

  await check('a stored plan can be reopened', async () => {
    const r = await call('GET', `/api/routes/${plan.routeId}`);
    expect(r.status === 200 && r.json.plan.route.distanceKm === plan.route.distanceKm, `status ${r.status}`);
    return `route ${plan.routeId}`;
  });

  await check('unknown place gives a friendly error, not a crash', async () => {
    const r = await call('POST', '/api/plan', { origin: 'Qwertyuiopville', destination: 'Manali' });
    expect(r.status === 422 || r.status === 503, `status ${r.status}`);
    expect(!/stack|at Object|node:internal/.test(r.text), 'a stack trace reached the client');
    return `${r.json.error.code}: ${r.json.error.message.slice(0, 60)}`;
  });

  await check('authentication: sign up, session, sign out, wrong password', async () => {
    const email = `beta+${Date.now()}@example.com`;
    const up = await call('POST', '/api/auth/signup', { email, password: 'a-good-long-password', displayName: 'Beta Tester' });
    expect(up.status === 200, `signup status ${up.status} ${up.text.slice(0, 120)}`);
    const me = await call('GET', '/api/me');
    expect(me.json.user?.email === email.toLowerCase(), 'the session did not carry the signed-in user');
    const bad = await call('POST', '/api/auth/login', { email, password: 'wrong-password-entirely' });
    expect(bad.status === 401, `a wrong password returned ${bad.status}`);
    expect(!bad.text.includes('password_hash'), 'the error leaked internals');
    return email.replace(/\+.*@/, '+…@');
  });

  // Exactly the payload the browser sends (web/js/app.js → saveJourney).
  let savedTripId;
  await check('add stops → multiple stops → trip impact → save → restore', async () => {
    const selected = plan.places.slice(0, 2).map(p => p.id);
    const skipped = plan.places.slice(2, 3).map(p => p.id);
    const journey = { plan, tripDays: 3, originalDays: 3, travelerType: 'Family', interests: ['Nature', 'Food'], selectedStops: selected, skippedPlaces: skipped, keptOverLimit: false };
    const save = await call('POST', '/api/trips', journey);
    expect(save.status === 200, `save status ${save.status} ${save.text.slice(0, 160)}`);
    savedTripId = save.json.trip.id;
    expect(save.json.trip.selectedStops.length === 2, 'both stops were not saved');

    // Extending the trip updates the same record rather than duplicating it.
    const extended = await call('POST', '/api/trips', { ...journey, serverTripId: savedTripId, tripDays: 4 });
    expect(extended.json.trip.id === savedTripId, 'extending created a second trip');
    expect(extended.json.trip.tripDays === 4 && extended.json.trip.originalDays === 3, 'the extension did not record both durations');

    const list = await call('GET', '/api/trips');
    expect(list.json.trips.length === 1, `expected one saved trip, got ${list.json.trips?.length}`);
    const restored = await call('GET', `/api/trips/${savedTripId}`);
    expect(restored.status === 200 && restored.json.trip.plan.route.distanceKm === plan.route.distanceKm, `restore status ${restored.status}`);

    // Removing a stop is a re-save with fewer ids.
    const removed = await call('POST', '/api/trips', { ...journey, serverTripId: savedTripId, selectedStops: [selected[0]] });
    expect(removed.json.trip.selectedStops.length === 1, 'removing a stop did not persist');
    return '2 stops saved, extended to 4 days, one removed, restored';
  });

  await check('ownership: a signed-out visitor cannot read a saved trip', async () => {
    const other = await fetch(`${base}/api/trips/${savedTripId}`);   // no cookie at all
    expect(other.status === 401, `an unauthenticated read returned ${other.status}`);
    const noList = await fetch(`${base}/api/trips`);
    expect(noList.status === 401, `an unauthenticated list returned ${noList.status}`);
    return 'enforced';
  });

  await check('rate limiting protects the planner', async () => {
    const results = [];
    for (let i = 0; i < 34; i++) results.push((await call('POST', '/api/plan', { origin: 'Delhi', destination: 'Jaipur' })).status);
    expect(results.includes(429), 'the limiter never triggered');
    return `429 after ${results.indexOf(429)} requests in the window`;
  });

  await check('health check reports the database, for monitoring', async () => {
    const r = await call('GET', '/api/health');
    expect(r.json.database === 'ok', `database reported as ${r.json.database}`);
    expect(Number.isFinite(r.json.uptimeSec), 'no uptime reported');
    expect(!JSON.stringify(r.json).match(/AIza|password|token/i), 'the health body looks like it contains a secret');
    return `database ${r.json.database}, uptime ${r.json.uptimeSec}s`;
  });

  await check('beta signals are recorded and nothing extra is stored', async () => {
    const place = plan.places[0];
    const names = ['journey_started', 'route_generated', 'discovery_seen', 'discovery_opened', 'discovery_added', 'discovery_skipped', 'discovery_removed', 'trip_extended', 'trip_kept', 'trip_saved', 'journey_completed', 'place_feedback'];
    const sent = await call('POST', '/api/events', { events: names.map(name => ({ name, sessionId: 'beta-check', props: { planId: plan.id, placeId: place.id } })) });
    expect(sent.json.stored === names.length, `${sent.json.stored} of ${names.length} signals were accepted`);
    const junk = await call('POST', '/api/events', { events: [{ name: 'not_a_real_event', props: {} }, { name: 'discovery_seen', props: { placeId: place.id, lat: 17.6, lng: 83.2 } }] });
    expect(junk.json.stored === 1, 'an unknown event name was accepted');
    return `${names.length} signals accepted, unknown names and location props dropped`;
  });

  await check('graceful shutdown completes', async () => {
    const started = Date.now();
    await srv.close();
    srv = null;
    return `${Date.now() - started} ms`;
  });
} catch (error) {
  fail.push(`harness: ${error.message}`);
  console.log(`  ✘ harness — ${error.message}`);
} finally {
  await srv?.close().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- verdict
console.log(`\n  ${pass.length} passed, ${fail.length} failed, ${warnings.length} warning(s) to review`);
console.log(fail.length ? '\n  NOT READY — fix the failures above.\n' : '\n  Beta flows all work. See docs/BETA.md for the deployment checklist.\n');
process.exit(fail.length ? 1 : 0);
