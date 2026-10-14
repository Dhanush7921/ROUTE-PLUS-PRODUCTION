// PRODUCTION STEP 6c — BACKUP AND RESTORE, on both backends.
//
// A backup nobody has restored is a hope. These tests exercise the two scripts
// end to end as a subprocess, the way an operator runs them, and check the
// properties that make a backup trustworthy rather than merely present:
//
//   * the copy is timestamped, and an existing backup is never overwritten
//   * a manifest records size, SHA-256 and per-table row counts
//   * corruption is caught, not restored over the top of something
//   * the restore target is ALWAYS a disposable database, never the configured one
//   * missing PostgreSQL client tools fail with a clear, actionable message
//   * the password never reaches stdout, stderr or the manifest
//
// The PostgreSQL round trip is skipped unless ROUTE_PLUS_PG_TEST_URL is set, and
// it builds its own throwaway source database — nothing here touches a
// configured production database.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { openDatabase } from '../../server/db/database.js';
import { connect, pgConfig, checkConnection } from '../../server/db/pg/client.js';
import { migrate, seed } from '../../server/db/pg/migrate.js';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const BACKUP = ['--disable-warning=ExperimentalWarning', 'scripts/db-backup.mjs'];
const VERIFY = ['--disable-warning=ExperimentalWarning', 'scripts/db-restore-verify.mjs'];
const TABLES = ['users', 'places', 'routes', 'trips', 'feedback', 'analytics_events'];

/** Run a script and return { code, stdout, stderr } instead of throwing. */
async function run(args, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: root,
      env: { ...process.env, ...env },
      maxBuffer: 16 * 1024 * 1024
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error.message) };
  }
}

/** A live SQLite database in a throwaway directory, plus a place to back it up to. */
function sqliteFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-backup-'));
  const live = path.join(dir, 'live.sqlite');
  openDatabase(live).close();
  return {
    dir,
    live,
    out: path.join(dir, 'out'),
    // A clean environment: no PostgreSQL, no inherited mode.
    env: { ROUTE_PLUS_DB: live, ROUTE_PLUS_DB_MODE: 'sqlite', DATABASE_URL: '', POSTGRES_URL: '', PGHOST: '', PGDATABASE: '' },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

const backupIn = dir => fs.readdirSync(dir).filter(f => !f.endsWith('.json'));
const manifestIn = dir => JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find(f => f.endsWith('.json'))), 'utf8'));

// ------------------------------------------------------------------ sqlite
test('STEP 6c: a SQLite backup is a timestamped copy with a manifest that matches it', async () => {
  const fx = sqliteFixture();
  try {
    const result = await run([...BACKUP, fx.out], fx.env);
    assert.equal(result.code, 0, result.stderr);

    const files = backupIn(fx.out);
    assert.equal(files.length, 1, 'exactly one backup file');
    assert.match(files[0], /^routeplus-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.sqlite$/, 'timestamped name');

    const manifest = manifestIn(fx.out);
    assert.equal(manifest.mode, 'sqlite');
    assert.equal(manifest.countsExact, true);
    assert.equal(manifest.bytes, fs.statSync(path.join(fx.out, files[0])).size, 'recorded size is the real size');
    assert.match(manifest.sha256, /^[0-9a-f]{64}$/);
    for (const table of TABLES) {
      assert.ok(Number.isInteger(manifest.rowCounts[table]), `${table} was counted`);
    }
    // The seed really is in there — a backup of an empty file would pass a
    // shape check but be worthless.
    assert.ok(manifest.rowCounts.places > 0, 'the curated places are in the backup');

    // The live database is untouched.
    assert.ok(fs.existsSync(fx.live), 'the live database is still there');
  } finally {
    fx.cleanup();
  }
});

test('STEP 6c: a backup never overwrites an existing backup', async () => {
  const fx = sqliteFixture();
  try {
    // Claim every filename the script could choose in the next few seconds, so
    // this does not depend on winning a race with the clock.
    fs.mkdirSync(fx.out, { recursive: true });
    for (let offset = 0; offset < 6; offset++) {
      const stamp = new Date(Date.now() + offset * 1000).toISOString().replace(/[:.]/g, '-').slice(0, 19);
      fs.writeFileSync(path.join(fx.out, `routeplus-${stamp}.sqlite.json`), '{}');
    }
    const taken = fs.readdirSync(fx.out).length;

    const result = await run([...BACKUP, fx.out], fx.env);
    assert.equal(result.code, 1, 'refused');
    assert.match(result.stderr, /refusing to overwrite a backup/i);
    assert.equal(fs.readdirSync(fx.out).length, taken, 'nothing was written');
  } finally {
    fx.cleanup();
  }
});

test('STEP 6c: verifying a SQLite backup checks its integrity, and catches corruption', async () => {
  const fx = sqliteFixture();
  try {
    assert.equal((await run([...BACKUP, fx.out], fx.env)).code, 0);
    const file = path.join(fx.out, backupIn(fx.out)[0]);

    const good = await run([...VERIFY, file], fx.env);
    assert.equal(good.code, 0, good.stdout + good.stderr);
    assert.match(good.stdout, /BACKUP VERIFIED/);
    assert.match(good.stdout, /integrity_check passes/);
    for (const table of TABLES) {
      assert.match(good.stdout, new RegExp(`"${table}" row count matches the manifest`), `${table} was compared`);
    }
    assert.doesNotMatch(good.stdout, /FAIL/);

    // Flip bytes in the middle of the copy: the manifest hash must notice even
    // if SQLite itself still opens the file.
    const fd = fs.openSync(file, 'r+');
    fs.writeSync(fd, Buffer.from('corruptcorrupt'), 0, 14, 40_000);
    fs.closeSync(fd);

    const bad = await run([...VERIFY, file], fx.env);
    assert.equal(bad.code, 1, 'corruption fails the check');
    assert.match(bad.stdout, /FAIL {2}backup file matches its recorded SHA-256/);
  } finally {
    fx.cleanup();
  }
});

test('STEP 6c: the live database is never "verified" in place', async () => {
  const fx = sqliteFixture();
  try {
    const result = await run([...VERIFY, fx.live], fx.env);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /live database, not a backup/i);
  } finally {
    fx.cleanup();
  }
});

// ------------------------------------------------- postgres, without a server
test('STEP 6c: postgres mode without a configured database says so, and writes nothing', async () => {
  const fx = sqliteFixture();
  try {
    const env = { ...fx.env, ROUTE_PLUS_DB_MODE: 'postgres' };
    for (const script of [BACKUP, VERIFY]) {
      const result = await run([...script, fx.out], env);
      assert.equal(result.code, 2, `${script[1]} exited 2`);
      assert.match(result.stderr, /no PostgreSQL is configured/i);
    }
    assert.ok(!fs.existsSync(fx.out) || backupIn(fx.out).length === 0, 'nothing was written');
  } finally {
    fx.cleanup();
  }
});

test('STEP 6c: missing pg_dump / pg_restore fails with an actionable message, not a stack trace', async () => {
  const fx = sqliteFixture();
  try {
    // An empty PATH is the honest simulation of a machine without the client
    // tools installed. node itself is launched by absolute path.
    const env = {
      ...fx.env,
      ROUTE_PLUS_DB_MODE: 'postgres',
      DATABASE_URL: 'postgres://u:p@127.0.0.1:1/routeplus_not_running',
      PATH: path.join(os.tmpdir(), 'route-plus-empty-path')
    };

    const backup = await run([...BACKUP, fx.out], env);
    assert.equal(backup.code, 3, 'a missing tool is its own exit code, not a generic failure');
    assert.match(backup.stderr, /pg_dump was not found on PATH/);
    assert.match(backup.stderr, /postgresql-client/, 'says how to fix it');
    assert.doesNotMatch(backup.stderr, /at .*node:internal/, 'no stack trace');

    const verify = await run([...VERIFY], env);
    assert.equal(verify.code, 3);
    assert.match(verify.stderr, /pg_restore was not found on PATH/);
  } finally {
    fx.cleanup();
  }
});

test('STEP 6c: a restore target must be disposable — production names are refused', async () => {
  const fx = sqliteFixture();
  try {
    const env = {
      ...fx.env,
      ROUTE_PLUS_DB_MODE: 'postgres',
      DATABASE_URL: 'postgres://u:p@127.0.0.1:1/routeplus'
    };
    // An explicit dump path, so nothing here depends on whether a backups/
    // directory happens to exist in the project root — that made the
    // accepted-name assertion below pass or fail according to the order other
    // tests had run in.
    fs.mkdirSync(fx.out, { recursive: true });
    const dump = path.join(fx.out, 'routeplus-2026-01-01T00-00-00.dump');
    fs.writeFileSync(dump, 'not a real dump — the name guard runs before the file is read');

    // The refusal happens before any connection is attempted, and before the
    // file is even looked at, so it holds even with no server there at all —
    // which is what makes it a guard and not a side effect of a later failure.
    for (const name of ['routeplus', 'routeplus_production', 'postgres', 'routeplus_test', 'restorecheck']) {
      const result = await run([...VERIFY, dump, '--into', name], env);
      assert.equal(result.code, 2, `"${name}" refused`);
      assert.match(result.stderr, /Refusing to restore into/);
    }

    // And the one shape it does accept: it gets past the name guard and fails
    // later, on the unreachable server — not with the refusal code.
    const allowed = await run([...VERIFY, dump, '--into', 'routeplus_restorecheck_ok'], env);
    assert.notEqual(allowed.code, 2, 'a disposable name is not refused by the name guard');
    assert.doesNotMatch(allowed.stderr, /Refusing to restore into/);
  } finally {
    fx.cleanup();
  }
});

// ------------------------------------------------- postgres, real round trip
const PG_URL = process.env.ROUTE_PLUS_PG_TEST_URL || '';
const reachable = PG_URL ? await checkConnection(pgConfig({ DATABASE_URL: PG_URL })) : { ok: false };
const skip = !PG_URL ? 'set ROUTE_PLUS_PG_TEST_URL to run the PostgreSQL backup tests'
  : !reachable.ok ? `PostgreSQL at the configured URL is not reachable (${reachable.reason})`
    : false;

let counter = 0;

/** A migrated, seeded throwaway source database with a row in every checked table. */
async function sourceDatabase() {
  const name = `routeplus_bk_${process.pid}_${++counter}`;
  const admin = await connect(pgConfig({ DATABASE_URL: PG_URL }));
  await admin.exec(`DROP DATABASE IF EXISTS ${name}`);
  await admin.exec(`CREATE DATABASE ${name}`);

  const config = pgConfig({ DATABASE_URL: PG_URL });
  config.database = name;
  const client = await connect(config);
  await migrate(client);
  await seed(client);

  // Every table the restore check compares needs rows, or the comparison only
  // proves that zero equals zero.
  await client.query(
    `INSERT INTO users (id, email, password_hash, display_name, role)
     VALUES ('usr_bk', 'backup@example.com', 'scrypt$x$y', 'Backup Tester', 'admin')`);
  await client.query(
    `INSERT INTO routes (id, origin_name, origin_lat, origin_lng, dest_name, dest_lat, dest_lng,
                         distance_km, duration_min, provider, method, geometry, plan_json)
     VALUES ('rte_bk', 'Chennai', 13.0827, 80.2707, 'Ooty', 11.4102, 76.6950,
             535, 610, 'offline-network', 'estimated', '[[13.0827,80.2707],[11.4102,76.695]]', '{"places":[]}')`);
  await client.query(
    `INSERT INTO trips (id, user_id, origin, destination, original_days, planned_days, status, route_id)
     VALUES ('trp_bk', 'usr_bk', 'Chennai', 'Ooty', 3, 3, 'planned', 'rte_bk')`);
  const { rows: [place] } = await client.query('SELECT id FROM places LIMIT 1');
  await client.query(
    `INSERT INTO feedback (user_id, trip_id, place_id, visited, worth_it, rating)
     VALUES ('usr_bk', 'trp_bk', $1, TRUE, TRUE, 5)`, [place.id]);
  await client.query(
    `INSERT INTO analytics_events (name, user_id, place_id, props)
     VALUES ('discovery_opened', 'usr_bk', $1, '{"category":"Nature"}')`, [place.id]);

  const counts = {};
  for (const table of TABLES) {
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
    counts[table] = rows[0].n;
  }
  await client.end();

  const url = new URL(PG_URL);
  url.pathname = `/${name}`;

  return {
    name,
    counts,
    dsn: url.toString(),
    async drop() {
      await admin.exec(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
    }
  };
}

test('STEP 6c: a PostgreSQL backup restores into a disposable database with every row intact', { skip }, async () => {
  const src = await sourceDatabase();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-pgbackup-'));
  try {
    const env = { ROUTE_PLUS_DB_MODE: 'postgres', DATABASE_URL: src.dsn, PGHOST: '', PGDATABASE: '' };

    const backup = await run([...BACKUP, out], env);
    assert.equal(backup.code, 0, backup.stderr);
    const dumps = backupIn(out);
    assert.equal(dumps.length, 1);
    assert.match(dumps[0], /^routeplus-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.dump$/);
    assert.ok(!fs.existsSync(path.join(out, `${dumps[0]}.part`)), 'no partial file left behind');

    const manifest = manifestIn(out);
    assert.equal(manifest.mode, 'postgres');
    assert.equal(manifest.database, src.name, 'the manifest names the database, and nothing else about the connection');
    assert.ok(manifest.schemaVersion > 0, 'the schema version was recorded');
    assert.ok(manifest.extensions.length > 0, 'the extension list was recorded');
    assert.deepEqual(manifest.rowCounts, src.counts, 'the manifest counts what the source held');
    assert.equal(manifest.countsExact, true, 'counts came from pg_dump\'s own snapshot');

    const verify = await run([...VERIFY, path.join(out, dumps[0])], env);
    assert.equal(verify.code, 0, verify.stdout + verify.stderr);
    assert.match(verify.stdout, /BACKUP VERIFIED/);
    assert.doesNotMatch(verify.stdout, /FAIL/);
    assert.match(verify.stdout, /pg_restore completed without error/);
    assert.match(verify.stdout, /every extension the source had is present after restore/);
    assert.match(verify.stdout, /schema version matches the source/);
    assert.match(verify.stdout, /no trip lost its owner in the restore/);
    assert.match(verify.stdout, /places near me" query runs on the restored data/);
    for (const table of TABLES) {
      assert.match(verify.stdout, new RegExp(`PASS {2}"${table}" row count matches the source`), `${table} matched`);
    }

    // The configured database was never the target, and the scratch database
    // did not survive the run.
    assert.match(verify.stdout, /restoring into disposable database "routeplus_restorecheck_/);
    assert.match(verify.stdout, /is not touched/);
    const admin = await connect(pgConfig({ DATABASE_URL: PG_URL }));
    try {
      const { rows } = await admin.query(
        `SELECT datname FROM pg_database WHERE datname LIKE 'routeplus_restorecheck%'`);
      assert.deepEqual(rows, [], 'every disposable database was dropped again');
      const { rows: still } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [src.name]);
      assert.equal(still.length, 1, 'the source database is still there');
    } finally {
      await admin.end();
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    await src.drop();
  }
});

test('STEP 6c: the PostgreSQL password never reaches the output or the manifest', { skip }, async () => {
  const src = await sourceDatabase();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-pgsecret-'));
  try {
    const password = pgConfig({ DATABASE_URL: PG_URL }).password;
    const env = { ROUTE_PLUS_DB_MODE: 'postgres', DATABASE_URL: src.dsn, PGHOST: '', PGDATABASE: '' };

    const backup = await run([...BACKUP, out], env);
    assert.equal(backup.code, 0, backup.stderr);

    const dump = backupIn(out)[0];
    const manifestText = fs.readFileSync(path.join(out, `${dump}.json`), 'utf8');
    const verify = await run([...VERIFY, path.join(out, dump)], env);

    if (password) {
      for (const [where, text] of [
        ['backup stdout', backup.stdout], ['backup stderr', backup.stderr],
        ['verify stdout', verify.stdout], ['verify stderr', verify.stderr],
        ['the manifest', manifestText]
      ]) {
        assert.ok(!text.includes(password), `the password does not appear in ${where}`);
      }
    }

    // And no DSN with credentials in it, whether or not a password is set.
    for (const text of [backup.stdout, verify.stdout, manifestText]) {
      assert.doesNotMatch(text, /postgres(ql)?:\/\/[^@\s]*:[^@\s]+@/, 'no user:password DSN was printed');
    }
    // What IS printed is the password-free description the project already uses.
    assert.match(backup.stdout, /password set|password not set/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    await src.drop();
  }
});
