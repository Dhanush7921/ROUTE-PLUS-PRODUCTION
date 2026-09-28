// STEP 8 + 9 — beta deployment readiness and closed-beta validation.
//
// Step 8: the things that make a deployment survive contact with a real server —
// production configuration that refuses to be wrong, storage that must be
// persistent and writable, a health endpoint a monitor can trust, and logs that
// cannot leak a credential.
// Step 9: the signals a closed beta is judged on, and the promise that nothing
// more than those is recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../server/config.js';
import { validateConfig } from '../../server/lib/validateConfig.js';
import { openDatabase } from '../../server/db/database.js';
import { createLogger, redact } from '../../server/lib/observability.js';
import { startServer } from '../../server/index.js';
import { EVENTS } from '../../shared/events.js';

const OFFLINE = async () => { throw new Error('network disabled in tests'); };
const PROD = { NODE_ENV: 'production', PUBLIC_URL: 'https://beta.example.com', TRUST_PROXY: '1', ADMIN_EMAILS: 'deva@example.com', ROUTE_PLUS_DB: '/var/lib/routeplus/routeplus.sqlite' };

// ---------------------------------------------------------------- STEP 8
test('STEP 8: a correct production configuration passes with nothing to review', () => {
  const { errors, warnings } = validateConfig(loadConfig(PROD), PROD);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, [], `unexpected warnings: ${warnings.join(' | ')}`);
});

test('STEP 8: production refuses ephemeral storage and a missing admin', () => {
  const cases = [
    [{ ...PROD, ROUTE_PLUS_DB: '/tmp/routeplus.sqlite' }, /temporary directory/],
    [{ ...PROD, ROUTE_PLUS_DB: '/var/tmp/rp.sqlite' }, /temporary directory/],
    [{ ...PROD, ROUTE_PLUS_DB: '/dev/shm/rp.sqlite' }, /temporary directory/],
    [{ ...PROD, ROUTE_PLUS_DB: ':memory:' }, /nothing would be saved/],
    [{ ...PROD, ADMIN_EMAILS: '' }, /ADMIN_EMAILS is empty/]
  ];
  for (const [env, pattern] of cases) {
    const { errors } = validateConfig(loadConfig(env), env);
    assert.match(errors.join(' | '), pattern, `${JSON.stringify(env.ROUTE_PLUS_DB ?? env.ADMIN_EMAILS)} should block startup in production`);
  }
  // Development is not blocked by either — a beginner can still just run it.
  const dev = { ROUTE_PLUS_DB: '/tmp/rp.sqlite' };
  assert.deepEqual(validateConfig(loadConfig(dev), dev).errors, []);

  // A database inside the app directory is a warning: a redeploy would replace it.
  const inApp = { ...PROD, ROUTE_PLUS_DB: path.join(loadConfig({}).root, 'data', 'rp.sqlite') };
  assert.match(validateConfig(loadConfig(inApp), inApp).warnings.join(), /inside the application directory/);
});

test('STEP 8: unwritable storage fails fast, naming the directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-ro-'));
  // When the mode bits do NOT stop the write — Windows ignores them, and so
  // does root — openDatabase succeeds and hands back an OPEN database. It has
  // to be closed, or Windows keeps a lock on the file and the cleanup below
  // fails with EBUSY, turning an inapplicable check into a red suite.
  let db = null;
  let thrown = null;
  try {
    fs.chmodSync(dir, 0o500);                       // readable, not writable
    try { db = openDatabase(path.join(dir, 'nested', 'rp.sqlite')); } catch (error) { thrown = error; }

    if (thrown) {
      // The case that matters: an unprivileged user, as a deployment runs.
      assert.equal(thrown.code, 'DB_NOT_WRITABLE');
      assert.match(thrown.message, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(thrown.message, /ROUTE_PLUS_DB|docs\/DEPLOY\.md/);
    } else {
      // This process can write anywhere (root, or Windows, where chmod does not
      // remove write access), so the permission branch cannot be exercised
      // here. Say so rather than pretending it passed — and still check the
      // half that IS testable: the directory was created and the database opened.
      assert.ok(db, 'openDatabase returned a database');
      assert.ok(fs.existsSync(path.join(dir, 'nested')), 'the directory was created');
      assert.equal(db.prepare('SELECT count(*) AS n FROM places').get().n > 0, true, 'and it is a working ROUTE+ database');
    }
  } finally {
    try { db?.close(); } catch { /* already closed */ }
    fs.chmodSync(dir, 0o700);
    // maxRetries rides out a lingering Windows handle instead of failing the run.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('STEP 8: a storage location SQLite cannot use is named, not left as a driver error', () => {
  // Found on a real machine: the project folder was a mounted (FUSE) drive.
  // The directory was writable, so the permission guard passed, and SQLite then
  // failed at open with a bare "disk I/O error" — which reads like data
  // corruption rather than "this disk cannot do file locking". Here the same
  // class of failure is forced deterministically by handing openDatabase a path
  // that is a DIRECTORY: SQLite cannot open it, and the error must come back
  // named and actionable.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-locking-'));
  let db = null;
  try {
    let thrown = null;
    try { db = openDatabase(dir); } catch (error) { thrown = error; }
    assert.ok(thrown, 'opening a directory as the database must fail');
    assert.equal(thrown.code, 'DB_UNAVAILABLE');
    assert.match(thrown.message, /ROUTE_PLUS_DB/);
    assert.match(thrown.message, /local, persistent disk|file locking/);
    assert.ok(thrown.cause, 'the original driver error is preserved for the logs');
  } finally {
    try { db?.close(); } catch { /* nothing opened */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('STEP 8: every beta package file exists, found the way the tools find it', () => {
  // fileURLToPath, never URL.pathname: on Windows the latter yields "/C:/…",
  // which resolves to an invalid path and made the beta checker report all of
  // these as missing on a perfectly good checkout.
  const root = fileURLToPath(new URL('../..', import.meta.url));
  assert.ok(fs.existsSync(path.join(root, 'package.json')), `project root did not resolve (${root})`);
  assert.ok(!root.includes(`${path.sep}${path.sep}`) && !/^[/\\][A-Za-z]:/.test(root), `root looks malformed: ${root}`);

  for (const file of ['web/index.html', 'web/companion.html', 'web/sw.js', 'web/manifest.webmanifest', 'dist/route-plus-standalone.html']) {
    const full = path.join(root, file);
    assert.ok(fs.existsSync(full), `missing beta package file: ${file}`);
    assert.ok(fs.statSync(full).size > 200, `${file} is suspiciously small`);
  }
  // The PWA manifest has to be valid JSON with the fields a browser needs.
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'web/manifest.webmanifest'), 'utf8'));
  for (const field of ['name', 'short_name', 'start_url', 'display', 'icons']) {
    assert.ok(manifest[field], `manifest is missing ${field}`);
  }
  for (const icon of manifest.icons) {
    assert.ok(fs.existsSync(path.join(root, 'web', icon.src)), `manifest icon missing: ${icon.src}`);
  }
});

test('STEP 8: the health endpoint is usable for monitoring and leaks nothing', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', logLevel: 'silent' },
    { GOOGLE_MAPS_SERVER_KEY: 'TEST_ONLY_KEY', ROUTE_PROVIDER: 'google' }, { fetchImpl: OFFLINE });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/health`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.database, 'ok', 'health touches the database, not just the process');
    assert.ok(Number.isFinite(body.uptimeSec));
    assert.ok(body.providers.routing.includes('google-routes'));
    assert.equal(body.providers.googleMaps.serverKeyConfigured, true, 'reports that a key is set…');
    assert.ok(!JSON.stringify(body).includes('TEST_ONLY_KEY'), '…without revealing it');

    // A broken database must surface as 503, not a cheerful 200.
    srv.db.close();
    const broken = await fetch(`http://127.0.0.1:${srv.port}/api/health`);
    assert.equal(broken.status, 503);
    assert.equal((await broken.json()).database, 'error');
  } finally { await srv.close().catch(() => {}); }
});

test('STEP 8: logs redact passwords, tokens, cookies and credentials hidden in URLs', () => {
  const lines = [];
  const log = createLogger('debug', l => lines.push(l));
  log.info('request', {
    cookie: 'rp_session=SECRET_COOKIE', authorization: 'Bearer SECRET_BEARER',
    password: 'SECRET_PW', apiKey: 'SECRET_KEY', googleMapsServerKey: 'SECRET_GOOGLE', token: 'SECRET_TOKEN',
    // Field names that look harmless but carry a credential in the value.
    databaseUrl: 'postgres://routeplus:SECRET_DBPW@db:5432/routeplus',
    dsn: 'postgresql://admin:SECRET_DSN@host/db?sslmode=require',
    note: 'GET https://maps.googleapis.com/maps/api/geocode/json?address=x&key=SECRET_QUERY',
    // …and the fields that must survive, or the log is useless.
    user: 'usr_1', status: 200, ms: 12, serverKeyConfigured: true, path: '/api/plan'
  });
  const out = lines.join('');
  for (const secret of ['SECRET_COOKIE', 'SECRET_BEARER', 'SECRET_PW', 'SECRET_KEY', 'SECRET_GOOGLE', 'SECRET_TOKEN', 'SECRET_DBPW', 'SECRET_DSN', 'SECRET_QUERY']) {
    assert.ok(!out.includes(secret), `${secret} reached the log`);
  }
  assert.match(out, /"user":"usr_1"/);
  assert.match(out, /"status":200/);
  assert.match(out, /"serverKeyConfigured":true/, 'booleans that only say "configured" stay readable');
  assert.ok(out.includes('sslmode=require'), 'non-secret parts of a URL survive');
  // Built at runtime so no key-shaped literal ever sits in the source (the
  // Step 1 secret scan looks for exactly that).
  const keyShaped = `AIza${'0123456789'.repeat(4).slice(0, 35)}`;
  assert.equal(redact('note', keyShaped), '[redacted-key]');
});

// ---------------------------------------------------------------- STEP 9
test('STEP 9: every beta signal is accepted, and nothing else is stored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-signals-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dbPath: path.join(dir, 'beta.sqlite'), logLevel: 'silent' }, {}, { fetchImpl: OFFLINE });
  const call = async (method, urlPath, body) => {
    const res = await fetch(`http://127.0.0.1:${srv.port}${urlPath}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    const { json: { plan } } = await call('POST', '/api/plan', { origin: 'Delhi', destination: 'Jaipur' });
    const place = plan.places[0];

    // The nine product signals the beta is judged on, as the browser sends them.
    const signals = ['journey_started', 'route_generated', 'discovery_seen', 'discovery_opened',
      'discovery_added', 'discovery_skipped', 'discovery_removed', 'trip_extended', 'trip_kept',
      'trip_saved', 'journey_completed', 'place_feedback'];
    for (const name of signals) assert.ok(EVENTS.includes(name), `${name} is whitelisted`);

    const sent = await call('POST', '/api/events', {
      events: signals.map(name => ({ name, sessionId: 'beta-session', props: { planId: plan.id, placeId: place.id, category: place.category, extraMin: place.detourTimeMinutes } }))
    });
    assert.equal(sent.json.stored, signals.length, 'every beta signal was accepted');

    // Anything outside the whitelist is dropped — names and properties alike.
    const junk = await call('POST', '/api/events', {
      events: [
        { name: 'password_typed', props: { placeId: place.id } },
        { name: 'discovery_seen', sessionId: 's', props: { placeId: place.id, lat: 17.68, lng: 83.21, homeAddress: '12 Example Street', email: 'deva@example.com', gpsTrail: [[1, 2]] } }
      ]
    });
    assert.equal(junk.json.stored, 1, 'the unknown event name was dropped');

    const rows = srv.db.prepare('SELECT name, props FROM analytics_events').all();
    assert.equal(rows.length, signals.length + 1);
    assert.ok(!rows.some(r => r.name === 'password_typed'));
    const allProps = rows.map(r => r.props).join(' ');
    for (const leak of ['lat', 'lng', 'homeAddress', 'deva@example.com', 'gpsTrail']) {
      assert.ok(!allProps.includes(leak), `${leak} must not be stored`);
    }
    assert.match(allProps, /placeId/, 'the useful properties are kept');

    // Place feedback: the most valuable signal, stored with its comment only.
    const fb = await call('POST', '/api/feedback', { placeId: place.id, visited: true, worthIt: true, rating: 5, comment: 'The +km estimate was accurate.' });
    assert.equal(fb.status, 200);
    const stored = srv.db.prepare('SELECT * FROM feedback').get();
    assert.equal(stored.place_id, place.id);
    assert.equal(stored.worth_it, 1);
    assert.equal(stored.comment, 'The +km estimate was accurate.');

    // A GPS proximity lookup answers without recording where the tester is.
    const near = await call('GET', '/api/places/near?lat=17.6868&lng=83.2185&radiusKm=40');
    assert.equal(near.status, 200);
    assert.ok(near.json.places.length > 0);
    const after = srv.db.prepare('SELECT props FROM analytics_events').all().map(r => r.props).join(' ');
    assert.ok(!after.includes('17.68'), 'the position was used to answer, not stored');
  } finally {
    await srv.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('STEP 9: the beta funnel can be read back from what the app records', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-funnel-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dbPath: path.join(dir, 'beta.sqlite'), logLevel: 'silent' }, {}, { fetchImpl: OFFLINE });
  try {
    const post = (urlPath, body) => fetch(`http://127.0.0.1:${srv.port}${urlPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const { plan } = await (await post('/api/plan', { origin: 'Delhi', destination: 'Jaipur' })).json();
    // Two testers: one adds a stop, one looks and leaves.
    await post('/api/events', { events: [
      { name: 'journey_started', sessionId: 'a', props: {} }, { name: 'route_generated', sessionId: 'a', props: { planId: plan.id } },
      { name: 'discovery_opened', sessionId: 'a', props: { placeId: plan.places[0].id } },
      { name: 'discovery_added', sessionId: 'a', props: { placeId: plan.places[0].id } },
      { name: 'trip_saved', sessionId: 'a', props: {} },
      { name: 'journey_started', sessionId: 'b', props: {} }, { name: 'route_generated', sessionId: 'b', props: { planId: plan.id } },
      { name: 'discovery_opened', sessionId: 'b', props: { placeId: plan.places[1].id } }
    ] });

    const counts = Object.fromEntries(srv.db.prepare('SELECT name, count(*) AS n FROM analytics_events GROUP BY name').all().map(r => [r.name, r.n]));
    assert.equal(counts.journey_started, 2);
    assert.equal(counts.discovery_opened, 2);
    assert.equal(counts.discovery_added, 1);
    // The metric the beta lives on: opened → added.
    assert.equal(counts.discovery_added / counts.discovery_opened, 0.5);
    // Provider honesty is recorded per route, so the funnel can be read in context.
    const route = srv.db.prepare('SELECT provider, method FROM routes').get();
    assert.ok(['offline-network', 'osrm', 'google-routes'].includes(route.provider));
    assert.ok(['estimated', 'road-network'].includes(route.method));
    const detour = srv.db.prepare('SELECT method, count(*) AS n FROM detour_calculations GROUP BY method').all();
    assert.ok(detour.length >= 1 && detour.every(d => ['estimated', 'road-network'].includes(d.method)));
  } finally {
    await srv.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
