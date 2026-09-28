// PRODUCTION STEP 6 — PostgreSQL + PostGIS.
//
// These tests need a real PostgreSQL server. They are SKIPPED unless
// ROUTE_PLUS_PG_TEST_URL is set, so `npm test` stays a zero-setup command:
//
//   ROUTE_PLUS_PG_TEST_URL=postgres://user:pw@localhost:5432/routeplus_test npm test
//
// The test database is left as it was found: everything happens inside a
// schema of its own, which is dropped afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, connectWithRetry, createPool, pgConfig, describeConnection, checkConnection, scrubDsn, PgError } from '../../server/db/pg/client.js';
import { migrate, seed, importFromSqlite, placesNear, placesAlongRoute, spatialMode, insertRoute, appliedVersions } from '../../server/db/pg/migrate.js';
import { createScram, decodeValue, encodeParam, readFields } from '../../server/db/pg/protocol.js';
import { openDatabase, placesRepo } from '../../server/db/database.js';
import { loadConfig } from '../../server/config.js';

const URL_ = process.env.ROUTE_PLUS_PG_TEST_URL || '';
// Not configured → skip. Configured but unreachable → ALSO skip, with the
// reason, rather than reporting failures that say nothing about this code: a
// database that is not running is a missing prerequisite, not a broken driver.
// (`npm run db:pg -- status` is the command that should fail in that case.)
const reachable = URL_ ? await checkConnection(pgConfig({ DATABASE_URL: URL_ })) : { ok: false };
const skip = !URL_ ? 'set ROUTE_PLUS_PG_TEST_URL to run the PostgreSQL tests'
  : !reachable.ok ? `PostgreSQL at the configured URL is not reachable (${reachable.reason}) — start it, then re-run`
    : false;
let counter = 0;

/**
 * Each test gets its own throwaway DATABASE — the same isolation production
 * has, so extensions, search paths and indexes behave exactly as they will
 * there. The configured database is only used to create and drop it.
 */
async function testDatabase() {
  const name = `routeplus_test_${process.pid}_${++counter}`;
  const admin = await connect(pgConfig({ DATABASE_URL: URL_ }));
  await admin.exec(`DROP DATABASE IF EXISTS ${name}`);
  await admin.exec(`CREATE DATABASE ${name}`);
  const config = pgConfig({ DATABASE_URL: URL_ });
  config.database = name;
  const client = await connect(config);
  return {
    client,
    name,
    async drop() {
      await client.end();
      await admin.exec(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
    }
  };
}

// ---------------------------------------------------------------- no server needed
test('STEP 6: configuration reads the environment and never exposes the password', () => {
  const config = pgConfig({ DATABASE_URL: 'postgres://alice:s3cret@db.example.com:6543/routeplus?sslmode=require' });
  assert.deepEqual(
    [config.host, config.port, config.database, config.user, config.sslmode, config.configured],
    ['db.example.com', 6543, 'routeplus', 'alice', 'require', true]);
  assert.equal(config.password, 's3cret', 'the driver can read it');
  for (const view of [JSON.stringify(config), JSON.stringify({ ...config }), Object.keys(config).join(','), describeConnection(config)]) {
    assert.ok(!view.includes('s3cret'), 'the password is not in any serialisable view');
  }
  assert.match(describeConnection(config), /postgres:\/\/alice@db\.example\.com:6543\/routeplus/);
  assert.ok(!scrubDsn('psql postgres://alice:s3cret@db.example.com/x failed').includes('s3cret'));
  assert.ok(!scrubDsn('PGPASSWORD=s3cret psql').includes('s3cret'));

  // Separate PG* variables work too, and no configuration means SQLite only.
  const split = pgConfig({ PGHOST: 'localhost', PGDATABASE: 'rp', PGUSER: 'u', PGPASSWORD: 'p' });
  assert.deepEqual([split.host, split.database, split.user, split.configured], ['localhost', 'rp', 'u', true]);
  assert.equal(pgConfig({}).configured, false, 'no configuration → PostgreSQL is simply off');
});

test('STEP 6: the wire protocol encodes parameters and decodes types correctly', () => {
  assert.equal(encodeParam(true), 't');
  assert.equal(encodeParam({ a: 1 }), '{"a":1}');
  assert.equal(encodeParam(new Date('2026-01-02T03:04:05Z')), '2026-01-02T03:04:05.000Z');
  assert.equal(decodeValue('t', 16), true);
  assert.equal(decodeValue('42', 23), 42);
  assert.equal(decodeValue('2.5', 701), 2.5);
  assert.deepEqual(decodeValue('{"a":1}', 3802), { a: 1 });
  assert.equal(decodeValue('2026-01-02 03:04:05+00', 1184), '2026-01-02T03:04:05.000Z');
  assert.equal(decodeValue('anything', 25), 'anything');
  assert.deepEqual(readFields(Buffer.from('CXX000\0MBoom\0\0', 'utf8')), { C: 'XX000', M: 'Boom' });

  // SCRAM-SHA-256, checked against a second, independent transcription of
  // RFC 5802 written here in the test. (The authoritative proof is the live
  // handshake below: PostgreSQL is configured for scram-sha-256 and accepts
  // this client, which no amount of self-consistent maths could fake.)
  const clientNonce = 'rOprNGfwEbeRWgbNEkqO';
  const serverFirst = 'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096';
  const scram = createScram('pencil', clientNonce);
  assert.equal(scram.firstMessage(), `n,,n=,r=${clientNonce}`, 'gs2 header + empty username (PostgreSQL sends it in the startup packet)');

  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
  const salted = crypto.pbkdf2Sync(Buffer.from('pencil', 'utf8'), Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64'), 4096, 32, 'sha256');
  const clientKey = hmac(salted, 'Client Key');
  const storedKey = crypto.createHash('sha256').update(clientKey).digest();
  const serverNonce = 'rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
  const authMessage = `n=,r=${clientNonce},${serverFirst},c=biws,r=${serverNonce}`;
  const signature = hmac(storedKey, authMessage);
  const expectedProof = Buffer.from(clientKey.map((b, i) => b ^ signature[i])).toString('base64');

  assert.equal(scram.finalMessage(serverFirst), `c=biws,r=${serverNonce},p=${expectedProof}`);
  assert.ok(scram.verify(`v=${hmac(hmac(salted, 'Server Key'), authMessage).toString('base64')}`), 'mutual authentication');
  assert.throws(() => scram.verify('v=wrong'), /server signature/);
  assert.throws(() => createScram('pencil', 'abc').finalMessage('r=zzz,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096'), /nonce/);
  assert.notEqual(createScram('pencil').clientNonce, createScram('pencil').clientNonce, 'a fresh nonce every time');
});

test('STEP 6: SQLite mode still works and needs no PostgreSQL at all', () => {
  // The default configuration names a SQLite file and no PostgreSQL.
  const config = loadConfig({});
  assert.match(config.dbPath, /\.sqlite$/);
  assert.equal(config.postgresConfigured, false);

  const db = openDatabase(':memory:');
  const repo = placesRepo(db);
  const all = repo.listActive();
  assert.ok(all.length > 100, `SQLite still seeds and reads places (${all.length})`);
  const near = repo.near([17.6868, 83.2185], 40);
  assert.ok(near.length > 0, 'the SQLite bounding-box query still answers');
  db.close();
});

// ---------------------------------------------------------------- live database
test('STEP 6: connection, schema creation, seed and migration idempotency', { skip }, async () => {
  const check = await checkConnection(pgConfig({ DATABASE_URL: URL_ }));
  assert.equal(check.ok, true, `connected: ${check.reason || ''}`);
  assert.match(check.server, /PostgreSQL/);
  assert.ok(['postgis', 'earthdistance', 'none'].includes(check.spatial));

  const database = await testDatabase();
  const { client } = database;
  try {
    assert.deepEqual(await appliedVersions(client), [], 'a fresh database has no migrations');
    const first = await migrate(client);
    assert.deepEqual(first.applied, [1, 2]);
    assert.equal(first.version, 2);

    // Every table the application relies on exists.
    const { rows } = await client.query('SELECT table_name FROM information_schema.tables WHERE table_schema = $1', ['public']);
    const tables = rows.map(r => r.table_name);
    for (const t of ['users', 'sessions', 'user_preferences', 'place_categories', 'places', 'place_attributes', 'place_sources',
      'place_opening_hours', 'place_seasonality', 'routes', 'route_segments', 'detour_calculations', 'recommendations',
      'trips', 'trip_preferences', 'trip_stops', 'saved_trips', 'feedback', 'analytics_events', 'audit_log', 'schema_migrations']) {
      assert.ok(tables.includes(t), `table ${t} was created`);
    }
    // Useful indexes, including the spatial one for whichever mode this is.
    const { rows: indexes } = await client.query('SELECT indexname FROM pg_indexes WHERE schemaname = $1', ['public']);
    const names = indexes.map(i => i.indexname);
    assert.ok(names.includes('places_latlng') && names.includes('places_active'));
    const mode = await spatialMode(client);
    if (mode === 'postgis') assert.ok(names.includes('places_geog_gix'), 'PostGIS GiST index on places');
    if (mode === 'earthdistance') assert.ok(names.includes('places_earth_gix'), 'earthdistance GiST index on places');

    // Seeded reference data, and re-running changes nothing.
    const { rows: [counts] } = await client.query('SELECT (SELECT count(*) FROM places) AS places, (SELECT count(*) FROM place_categories) AS categories');
    assert.ok(counts.places > 100 && counts.categories > 10);
    const again = await migrate(client);
    assert.deepEqual(again.applied, [], 'migrations are idempotent');
    await seed(client);
    const { rows: [after] } = await client.query('SELECT count(*) AS places FROM places');
    assert.equal(after.places, counts.places, 're-seeding updates rows, it does not duplicate them');
  } finally { await database.drop(); }
});

test('STEP 6: spatial query returns the right places, nearest first', { skip }, async () => {
  const database = await testDatabase();
  const { client } = database;
  try {
    await migrate(client);
    const mode = await spatialMode(client);
    const near = await placesNear(client, [17.6868, 83.2185], 40, { spatial: mode });   // Visakhapatnam
    assert.ok(near.length > 0, 'found curated places near Visakhapatnam');
    assert.ok(near.some(p => /Simhachalam|Kailasagiri/.test(p.name)));
    if (mode !== 'none') {
      const distances = near.map(p => Number(p.distance_km));
      assert.deepEqual(distances, [...distances].sort((a, b) => a - b), 'ordered by distance');
      assert.ok(distances.every(d => d <= 40), 'nothing outside the radius');
    }
    // A point in the middle of the ocean has nothing near it.
    assert.equal((await placesNear(client, [0, 0], 50, { spatial: mode })).length, 0);
    // Bound parameters, not string building: a hostile name is stored verbatim.
    await client.query("INSERT INTO places (id,name,category_id,lat,lng,created_at,updated_at) VALUES ($1,$2,'scenic',17.7,83.3,now(),now())",
      ['test:injection', "Robert'); DROP TABLE places;--"]);
    const { rows } = await client.query('SELECT name FROM places WHERE id = $1', ['test:injection']);
    assert.equal(rows[0].name, "Robert'); DROP TABLE places;--");
    assert.ok((await client.query('SELECT count(*) AS n FROM places')).rows[0].n > 100, 'places table is still there');
  } finally { await database.drop(); }
});

test('STEP 6: routes and detours store and read back, and a SQLite database imports', { skip }, async () => {
  const database = await testDatabase();
  const { client } = database;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-pg-'));
  try {
    await migrate(client);

    // Store a plan exactly as server/domains/journeys.js persists one.
    const plan = {
      origin: { name: 'Visakhapatnam', lat: 17.6868, lng: 83.2185 },
      destination: { name: 'Manali', lat: 32.2396, lng: 77.1887 },
      route: { distanceKm: 2628.7, durationMin: 3008, provider: 'osrm', method: 'road-network', geometry: [[17.6868, 83.2185], [25, 80], [32.2396, 77.1887]] },
      phases: [{ index: 0, name: 'Visakhapatnam – Nagpur', startKm: 0, endKm: 900 }],
      places: [{ id: 'curated:simhachalam', routeKm: 12.4, distanceFromRouteKm: 3.1, detourDistanceKm: 8.2, detourTimeMinutes: 19, detour: { strategy: 'through', method: 'road-network', anchorKm: 9, rejoinKm: 17 } }]
    };
    await insertRoute(client, 'rte_test_1', plan);

    const { rows: [route] } = await client.query('SELECT * FROM routes WHERE id = $1', ['rte_test_1']);
    assert.equal(route.origin_name, 'Visakhapatnam');
    assert.equal(Math.round(route.distance_km * 10) / 10, 2628.7);
    assert.equal(route.provider, 'osrm');
    assert.deepEqual(route.geometry[0], [17.6868, 83.2185], 'geometry survives as JSONB');
    assert.equal(route.plan_json.route.method, 'road-network', 'the plan snapshot is queryable JSONB');

    const { rows: [detour] } = await client.query('SELECT * FROM detour_calculations WHERE route_id = $1', ['rte_test_1']);
    assert.equal(detour.place_id, 'curated:simhachalam');
    assert.equal(detour.method, 'road-network', 'provenance is recorded, never assumed');
    assert.equal(detour.extra_min, 19);
    assert.equal((await client.query('SELECT count(*) AS n FROM route_segments WHERE route_id = $1', ['rte_test_1'])).rows[0].n, 1);

    // Import a real SQLite database (auth, ownership and audit rows included).
    const sqlitePath = path.join(dir, 'source.sqlite');
    const db = openDatabase(sqlitePath);
    db.prepare('INSERT INTO users (id,email,password_hash,display_name,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run('usr_1', 'Deva@Example.com', 'scrypt$fake', 'Deva', 'admin', new Date().toISOString(), new Date().toISOString());
    db.prepare('INSERT INTO audit_log (user_id, action, target, detail, created_at) VALUES (?,?,?,?,?)')
      .run('usr_1', 'place.disable', 'curated:x', JSON.stringify({ reason: 'test' }), new Date().toISOString());
    db.close();

    const counts = await importFromSqlite(client, sqlitePath);
    assert.ok(counts.places > 100, `places imported (${counts.places})`);
    assert.equal(counts.users, 1);
    assert.equal(counts.audit_log, 1);

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE id = $1', ['usr_1']);
    assert.equal(user.role, 'admin', 'roles survive the migration');
    assert.equal(user.password_hash, 'scrypt$fake', 'password hashes are copied, never re-derived');
    const { rows: [audit] } = await client.query('SELECT * FROM audit_log LIMIT 1');
    assert.deepEqual(audit.detail, { reason: 'test' }, 'audit detail becomes queryable JSONB');
    // Case-insensitive email uniqueness, as in SQLite.
    await assert.rejects(
      client.query('INSERT INTO users (id,email,password_hash,display_name,created_at,updated_at) VALUES ($1,$2,$3,$4,now(),now())',
        ['usr_2', 'deva@example.com', 'x', 'Copy']),
      e => e instanceof PgError && e.code === '23505');
  } finally {
    await database.drop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('STEP 6: route corridor proximity — places near a driven line', { skip }, async () => {
  const database = await testDatabase();
  const { client } = database;
  try {
    await migrate(client);
    const mode = await spatialMode(client);

    // A line down the east coast and up through central India.
    const line = [[17.6868, 83.2185], [18.1, 82.6], [19.1, 82.0], [20.5, 81.9], [21.2, 81.6]];
    const corridor = await placesAlongRoute(client, line, 30, { spatial: mode });
    assert.ok(corridor.length > 0, `found places along the line (${corridor.length})`);
    const distances = corridor.map(p => Number(p.distance_km));
    assert.deepEqual(distances, [...distances].sort((a, b) => a - b), 'nearest to the road first');
    assert.ok(distances.every(d => d <= 30), 'nothing outside the corridor');

    // A narrower corridor is a subset of a wider one.
    const narrow = await placesAlongRoute(client, line, 5, { spatial: mode });
    assert.ok(narrow.length <= corridor.length);
    const wide = new Set(corridor.map(p => p.id));
    assert.ok(narrow.every(p => wide.has(p.id)), '5 km corridor ⊂ 30 km corridor');

    // Degenerate input is answered, not crashed on.
    assert.deepEqual(await placesAlongRoute(client, [[0, 0]], 10, { spatial: mode }), []);
    assert.deepEqual(await placesAlongRoute(client, [], 10, { spatial: mode }), []);
    // A line in the middle of the ocean has nothing near it.
    assert.equal((await placesAlongRoute(client, [[0, 0], [1, 1]], 50, { spatial: mode })).length, 0);
  } finally { await database.drop(); }
});

test('STEP 6: connection retry and the pool', { skip }, async () => {
  const config = pgConfig({ DATABASE_URL: URL_ });
  // Retry succeeds immediately against a healthy server.
  const client = await connectWithRetry(config, { attempts: 2 });
  assert.equal((await client.query('SELECT 1 AS n')).rows[0].n, 1);
  await client.end();

  // The password property cannot be swapped out or enumerated after the fact.
  assert.throws(() => Object.defineProperty(config, 'password', { value: 'x' }), /Cannot redefine/);

  // A wrong password is NOT retried — retrying would only lock the account.
  const wrong = new URL(URL_);
  wrong.password = 'definitely-not-the-password';
  const bad = pgConfig({ DATABASE_URL: wrong.toString() });
  let attempts = 0;
  await assert.rejects(connectWithRetry(bad, { attempts: 3, delayMs: 1, log: () => { attempts++; } }),
    e => e instanceof PgError && e.code === '28P01');
  assert.equal(attempts, 0, 'an authentication failure is not retried');

  // The pool runs concurrent queries and recovers a dropped connection.
  const pool = createPool(config, { size: 3 });
  try {
    const answers = await Promise.all(Array.from({ length: 9 }, (_, i) => pool.query('SELECT $1::int AS n', [i])));
    assert.deepEqual(answers.map(a => a.rows[0].n), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.ok(pool.open > 1 && pool.open <= 3, `reused ${pool.open} connection(s)`);
    await pool.transaction(async ({ query }) => { await query('SELECT 1'); });
    await assert.rejects(pool.query('SELECT * FROM a_table_that_does_not_exist'), e => e instanceof PgError && e.code === '42P01');
    assert.equal((await pool.query('SELECT 2 AS n')).rows[0].n, 2, 'the pool still works after a query error');
  } finally { await pool.end(); }
  await assert.rejects(pool.query('SELECT 1'), /closed/);
});
