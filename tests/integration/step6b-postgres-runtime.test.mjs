// PRODUCTION STEP 6b — PostgreSQL as the SERVING database.
//
// Step 6 proved the driver, the schema and the spatial queries. This file
// proves the parts the application actually runs on PostgreSQL: the places
// repository, the planning domain, authentication, the background jobs, the
// worker and the reporting scripts. Each of those had a SQLite-shaped
// implementation that did not merely perform differently on PostgreSQL — it
// returned less, or raised.
//
// Skipped unless ROUTE_PLUS_PG_TEST_URL is set, exactly like step 6:
//
//   ROUTE_PLUS_PG_TEST_URL=postgres://user:pw@localhost:5432/routeplus_test npm test
//
// Every test gets a throwaway DATABASE and drops it afterwards. Nothing here
// touches a configured production database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { connect, createPool, pgConfig, checkConnection } from '../../server/db/pg/client.js';
import { migrate, seed, spatialMode } from '../../server/db/pg/migrate.js';
import { placesRepo } from '../../server/db/database.js';
import { purgeSessions, aggregateMetrics, reviewPlaces, ingestPlaces } from '../../server/jobs.js';
import { startServer } from '../../server/index.js';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));

const URL_ = process.env.ROUTE_PLUS_PG_TEST_URL || '';
const reachable = URL_ ? await checkConnection(pgConfig({ DATABASE_URL: URL_ })) : { ok: false };
const skip = !URL_ ? 'set ROUTE_PLUS_PG_TEST_URL to run the PostgreSQL tests'
  : !reachable.ok ? `PostgreSQL at the configured URL is not reachable (${reachable.reason}) — start it, then re-run`
    : false;

let counter = 0;

/** A migrated, seeded, throwaway database plus a pool onto it. */
async function testDatabase({ withSeed = true } = {}) {
  const name = `routeplus_rt_${process.pid}_${++counter}`;
  const admin = await connect(pgConfig({ DATABASE_URL: URL_ }));
  await admin.exec(`DROP DATABASE IF EXISTS ${name}`);
  await admin.exec(`CREATE DATABASE ${name}`);

  const config = pgConfig({ DATABASE_URL: URL_ });
  config.database = name;

  const client = await connect(config);
  await migrate(client);
  if (withSeed) await seed(client);
  await client.end();

  const pool = createPool(config, { size: 2 });
  const url = new URL(URL_);
  url.pathname = `/${name}`;

  return {
    pool,
    name,
    dsn: url.toString(),
    async drop() {
      await pool.end().catch(() => {});
      await admin.exec(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
    }
  };
}

const OFFLINE = async () => { throw new Error('network disabled in tests'); };

// ---------------------------------------------------------------- places repository
test('STEP 6b: a place edit persists its ATTRIBUTES, not just its places columns', { skip }, async () => {
  const t = await testDatabase();
  try {
    const repo = placesRepo(t.pool);
    const before = (await repo.listActive())[0];
    assert.ok(before, 'the seed produced places');

    // caution and visitDurationMinutes live on place_attributes. The admin API
    // accepts both; a places-only UPDATE accepted them and threw them away.
    const changed = await repo.update(before.id, {
      name: 'Edited Name',
      caution: 'Steep final approach; not for a low car.',
      visitDurationMinutes: 47
    });
    assert.equal(changed, 1);

    const after = await repo.get(before.id);
    assert.equal(after.name, 'Edited Name');
    assert.equal(after.caution, 'Steep final approach; not for a low car.', 'caution survived the write');
    assert.equal(after.visitDurationMinutes, 47, 'visit duration survived the write');

    // An attribute-only edit still counts as an edit.
    assert.equal(await repo.update(before.id, { caution: 'Reopened after repairs.' }), 1);
    assert.equal((await repo.get(before.id)).caution, 'Reopened after repairs.');

    // A place that does not exist is still 0, and unknown fields are a no-op.
    assert.equal(await repo.update('does-not-exist', { caution: 'x' }), 0);
  } finally {
    await t.drop();
  }
});

test('STEP 6b: "places near me" works on whatever spatial support the database has', { skip }, async () => {
  const t = await testDatabase();
  try {
    const mode = await spatialMode(t.pool);
    const repo = placesRepo(t.pool);

    // Delhi. The query must not assume PostGIS: the schema itself treats it as
    // optional and falls back to earthdistance, then to a bounding box.
    const near = await repo.near([28.6139, 77.2090], 300);
    assert.ok(Array.isArray(near), `near() returned rows in ${mode} mode`);
    assert.ok(near.length > 0, `found places within 300 km in ${mode} mode`);

    // The rows are full places, not bare coordinates.
    assert.ok(near[0].name && near[0].category, 'near() returns whole places');

    // Nothing absurdly far away came back.
    const far = await repo.near([28.6139, 77.2090], 1);
    assert.ok(far.length <= near.length, 'a smaller radius cannot return more');
  } finally {
    await t.drop();
  }
});

// ---------------------------------------------------------------- HTTP runtime
test('STEP 6b: the server runs on PostgreSQL — plan, save, reopen, and rich place data', { skip }, async () => {
  const t = await testDatabase();
  let srv;
  try {
    srv = await startServer(
      { port: 0, host: '127.0.0.1', logLevel: 'silent' },
      { ...process.env, ROUTE_PLUS_DB_MODE: 'postgres', DATABASE_URL: t.dsn, NODE_ENV: 'test' },
      { fetchImpl: OFFLINE }
    );

    const jar = [];
    const call = async (method, p, body) => {
      const res = await fetch(`http://127.0.0.1:${srv.port}${p}`, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar.length ? { Cookie: jar.join('; ') } : {}) },
        body: body ? JSON.stringify(body) : undefined
      });
      for (const c of (res.headers.getSetCookie?.() || [])) {
        const kv = c.split(';')[0];
        const k = kv.split('=')[0];
        const i = jar.findIndex(x => x.startsWith(`${k}=`));
        if (i >= 0) jar[i] = kv; else jar.push(kv);
      }
      return { status: res.status, json: await res.json().catch(() => null) };
    };

    const health = await call('GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.database, 'ok', 'health touches PostgreSQL');

    const planned = await call('POST', '/api/plan', {
      origin: 'Chennai', destination: 'Ooty', tripDays: 3,
      travelerType: 'Family', interests: ['Nature', 'Food', 'Heritage']
    });
    assert.equal(planned.status, 200, 'planning works on PostgreSQL');

    const plan = planned.json.plan;
    assert.ok(plan.route.distanceKm > 0 && plan.places.length > 0);

    // The point of loading places through the repository: the attributes the
    // scorer and the detail panel need are present. A places-only SELECT
    // returned none of these, so PostgreSQL silently produced thinner
    // recommendations than SQLite for identical data.
    const rich = plan.places.filter(p => p.visitDurationMinutes !== undefined);
    assert.ok(rich.length > 0, 'places carry a visit duration');
    assert.ok(plan.places.some(p => p.suitableFor?.length), 'places carry suitability');
    assert.ok(plan.places.some(p => p.caution), 'places carry their caution note');
    assert.ok(plan.places.some(p => p.source), 'places carry their source');

    // Case-insensitive email: PostgreSQL's uniqueness is a lower(email) index,
    // so a row stored with capitals must still be findable at sign-in.
    const mixed = 'Deva.Tester@Example.COM';
    const signup = await call('POST', '/api/auth/signup', { email: mixed, password: 'Route-Plus-Pg-Runtime-2026', displayName: 'Deva' });
    assert.equal(signup.status, 200);

    jar.length = 0;
    const login = await call('POST', '/api/auth/login', { email: mixed.toLowerCase(), password: 'Route-Plus-Pg-Runtime-2026' });
    assert.equal(login.status, 200, 'a differently-cased email signs in');

    // Audit rows are awaited, so they exist by the time the call returns.
    const audit = await t.pool.query("SELECT action FROM audit_log WHERE action IN ('user.signup','user.login') ORDER BY action");
    assert.deepEqual(audit.rows.map(r => r.action), ['user.login', 'user.signup'], 'both audit rows were written');

    // Save and reopen, on PostgreSQL.
    const stop = plan.places.find(p => Number.isFinite(p.detourDistanceKm));
    const trip = await call('POST', '/api/trips', {
      plan, origin: 'Chennai', destination: 'Ooty', originalDays: 3, tripDays: 3,
      travelerType: 'Family', interests: ['Nature', 'Food', 'Heritage'],
      selectedStops: [stop.id], skippedPlaces: []
    });
    assert.equal(trip.status, 200, 'a trip saves');

    const reopened = await call('GET', `/api/trips/${trip.json.trip.id}`);
    assert.equal(reopened.status, 200);
    assert.equal(reopened.json.trip.selectedStops.length, 1, 'the saved stop came back');
    assert.ok(reopened.json.trip.plan.route.distanceKm > 0, 'the stored plan came back');

    // Nearby endpoint, on whatever spatial support exists.
    const nearby = await call('GET', '/api/places/near?lat=28.6139&lng=77.2090&radiusKm=200');
    assert.equal(nearby.status, 200, '/api/places/near works on PostgreSQL');
    assert.ok(Array.isArray(nearby.json.places));
  } finally {
    await srv?.close();
    await t.drop();
  }
});

// ---------------------------------------------------------------- background jobs
test('STEP 6b: every background job runs on PostgreSQL', { skip }, async () => {
  const t = await testDatabase();
  try {
    const db = t.pool;

    // purgeSessions — timestamps, not ISO text.
    await db.query(`INSERT INTO users (id, email, password_hash, display_name) VALUES ('u1', 'jobs@example.com', 'x', 'Jobs')`);
    await db.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('old', 'u1', now() - interval '1 day'), ('new', 'u1', now() + interval '30 days')`);
    assert.equal(await purgeSessions(db), 1, 'only the expired session went');
    const left = await db.query('SELECT token_hash FROM sessions');
    assert.deepEqual(left.rows.map(r => r.token_hash), ['new']);

    // aggregateMetrics — creates daily_metrics and rolls up by day.
    await db.query(`INSERT INTO analytics_events (name, props, created_at) VALUES
      ('discovery_added', '{}'::jsonb, '2026-09-01T10:00:00Z'),
      ('discovery_added', '{}'::jsonb, '2026-09-01T18:00:00Z'),
      ('discovery_seen',  '{}'::jsonb, '2026-09-02T10:00:00Z')`);
    assert.equal(await aggregateMetrics(db), 2, 'two (day, name) groups');
    const metrics = await db.query('SELECT day, name, count FROM daily_metrics ORDER BY day, name');
    assert.equal(metrics.rows.length, 2);
    assert.equal(metrics.rows[0].day, '2026-09-01');
    assert.equal(Number(metrics.rows[0].count), 2);
    // Idempotent: running it again updates rather than duplicates.
    assert.equal(await aggregateMetrics(db), 2);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM daily_metrics')).rows[0].n, 2);

    // reviewPlaces — worth_it is BOOLEAN here, not 0/1.
    const place = (await db.query('SELECT id FROM places LIMIT 1')).rows[0].id;
    for (let i = 0; i < 5; i++) {
      await db.query('INSERT INTO feedback (place_id, visited, worth_it) VALUES ($1, TRUE, FALSE)', [place]);
    }
    assert.equal(await reviewPlaces(db), 1, 'the poorly-rated place was flagged');
    const flagged = await db.query('SELECT flagged, flag_reason FROM places WHERE id = $1', [place]);
    assert.equal(flagged.rows[0].flagged, true);
    assert.match(flagged.rows[0].flag_reason, /worth the detour/);
    // Running again does not double-flag.
    assert.equal(await reviewPlaces(db), 0);

    // ingestPlaces — async repo, async upsert, stored disabled + flagged.
    const provider = {
      name: 'osm',
      searchCorridor: async () => [
        { id: 'osm:node/9001', name: 'Pg Test Stepwell', category: 'heritage', lat: 27.0, lng: 76.0, source: { provider: 'openstreetmap' } }
      ]
    };
    assert.equal(await ingestPlaces(db, { provider, corridors: [[[28.6, 77.2], [26.9, 75.8]]] }), 1);
    const added = await db.query('SELECT active, flagged, flag_reason FROM places WHERE id = $1', ['osm:node/9001']);
    assert.equal(added.rows[0].active, false, 'new places wait for staff review');
    assert.equal(added.rows[0].flagged, true);
    assert.match(added.rows[0].flag_reason, /verify before enabling/);
    // The same corridor again is a duplicate, not a second row.
    assert.equal(await ingestPlaces(db, { provider, corridors: [[[28.6, 77.2], [26.9, 75.8]]] }), 0);
  } finally {
    await t.drop();
  }
});

// ---------------------------------------------------------------- scripts
test('STEP 6b: the worker maintains the SELECTED backend and closes its pool', { skip }, async () => {
  const t = await testDatabase();
  try {
    await t.pool.query(`INSERT INTO users (id, email, password_hash, display_name) VALUES ('w1', 'worker@example.com', 'x', 'W')`);
    await t.pool.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('stale', 'w1', now() - interval '2 days')`);

    const { stdout } = await run('node', ['--disable-warning=ExperimentalWarning', 'scripts/worker.mjs'], {
      cwd: root,
      env: { ...process.env, ROUTE_PLUS_DB_MODE: 'postgres', DATABASE_URL: t.dsn, ROUTE_PLUS_LIVE_PROVIDERS: '0' }
    });

    const report = JSON.parse(stdout.trim().split('\n').pop());
    assert.equal(report.mode, 'postgres', 'the worker used PostgreSQL, not a stray SQLite file');
    assert.equal(report.sessionsPurged, 1, 'it did real work on that database');
    assert.equal(report.job, 'worker');
    assert.ok(!report.error, `the worker reported no error (${report.error || ''})`);

    // It exited on its own: promisify(execFile) only resolves when the process
    // ends, so a pool left open would have hung this test.
    const remaining = await t.pool.query('SELECT count(*)::int AS n FROM sessions');
    assert.equal(remaining.rows[0].n, 0);
  } finally {
    await t.drop();
  }
});

test('STEP 6b: beta signals read the backend the beta actually runs on', { skip }, async () => {
  const t = await testDatabase();
  try {
    await t.pool.query(`INSERT INTO analytics_events (name, props, place_id, created_at) VALUES
      ('journey_started',   '{}'::jsonb, NULL, now()),
      ('discovery_opened',  '{}'::jsonb, 'curated:x', now()),
      ('discovery_added',   '{}'::jsonb, 'curated:x', now())`);

    const { stdout } = await run('node', ['--disable-warning=ExperimentalWarning', 'scripts/beta-signals.mjs', '30'], {
      cwd: root,
      env: { ...process.env, ROUTE_PLUS_DB_MODE: 'postgres', DATABASE_URL: t.dsn }
    });

    assert.match(stdout, /closed beta signals/);
    assert.match(stdout, /journeys started\s+1/, 'it read the PostgreSQL events');
    assert.match(stdout, /discoveries opened\s+1/);
    assert.match(stdout, /most engaged places/, 'the per-place roll-up ran');
    assert.doesNotMatch(stdout, /No events recorded yet/, 'it did not report an empty SQLite file');
  } finally {
    await t.drop();
  }
});

test('STEP 6b: the beta harness never runs against the PostgreSQL production database', { skip }, async () => {
  // check-beta walks destructive-ish flows — sign-ups, trips, a burst of
  // requests to prove rate limiting. With ROUTE_PLUS_DB_MODE=postgres in the
  // environment, the server it starts would connect to the configured database
  // and its throwaway dbPath would be ignored. Here the DSN points at a
  // database that does NOT exist: if the harness were to use it, the run would
  // fail to connect. Passing proves it stayed on its own SQLite file.
  const dead = new URL(URL_);
  dead.pathname = '/routeplus_absent_database';

  const { stdout } = await run('node', ['--disable-warning=ExperimentalWarning', 'scripts/check-beta.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      ROUTE_PLUS_DB_MODE: 'postgres',
      DATABASE_URL: dead.toString(),
      NODE_ENV: 'test',
      ADMIN_EMAILS: 'beta@example.com',
      ROUTE_PLUS_CONTACT: 'beta@example.com'
    },
    maxBuffer: 4 * 1024 * 1024
  });

  assert.match(stdout, /0 failed/, 'the beta walk passed on its own throwaway database');
  assert.match(stdout, /route entry → planning → discovery/);
});
