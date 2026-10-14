// VERIFY A BACKUP BY RESTORING IT — into a disposable database, never production.
//
//   npm run db:restore:verify                          # newest backup in ./backups
//   npm run db:restore:verify -- ./backups/x.dump      # a specific file
//   npm run db:restore:verify -- --keep                # leave the scratch database behind
//   npm run db:restore:verify -- --into routeplus_restorecheck_manual
//
// An untested backup is a hope, not a backup. This restores one and then asks
// the questions that actually matter: did the schema arrive, did the extensions
// arrive, did every row arrive, and can ROUTE+ still serve a query from it.
//
// POSTGRESQL
//   Creates routeplus_restorecheck_<pid>_<stamp>, runs pg_restore into it,
//   verifies against the backup's manifest, then drops it again.
//
//   The production database is never the restore target. Three independent
//   refusals enforce that: the target name must match
//   /^routeplus_restorecheck_[a-z0-9_]+$/, it must not equal the configured
//   database, and it must not already exist. The DROP at the end can only name
//   the database this run created. The configured database is used for one
//   thing only — as the connection from which CREATE/DROP DATABASE is issued —
//   and no statement is ever run against its contents.
//
// SQLITE
//   Opens the backup file read-only (never the live database), runs SQLite's
//   own integrity_check, and counts the same tables. A SQLite restore is a file
//   copy, so this is the part worth verifying.
//
// PG_RESTORE may name the binary explicitly, for a machine where the client
// tools are installed but not on PATH (common on Windows).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../server/config.js';
import { databaseMode } from '../server/db/runtime.js';
import { connect, pgConfig, describeConnection } from '../server/db/pg/client.js';
import { spatialMode, placesNear } from '../server/db/pg/migrate.js';

const run = promisify(execFile);
const CHECKED_TABLES = ['users', 'places', 'routes', 'trips', 'feedback', 'analytics_events'];
const SCRATCH = /^routeplus_restorecheck_[a-z0-9_]+$/;

const config = loadConfig();
const mode = databaseMode(process.env);
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const intoAt = args.indexOf('--into');
const requestedName = intoAt >= 0 ? args[intoAt + 1] : null;
// Everything that is not a flag, and not the value belonging to --into.
const nameIndex = intoAt >= 0 ? intoAt + 1 : -1;
const fileArg = args.find((a, i) => !a.startsWith('--') && i !== nameIndex) || null;

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const fail = (code, message) => {
  console.error(`\n  ${message}\n`);
  process.exit(code);
};

/** Newest backup of the right kind, so the common case needs no argument. */
function resolveBackup(extension) {
  if (fileArg) {
    const file = path.resolve(fileArg);
    if (!fs.existsSync(file)) fail(2, `No backup at ${file}.`);
    return file;
  }
  const dir = path.join(config.root, 'backups');
  if (!fs.existsSync(dir)) fail(2, `No backups directory at ${dir}. Run: npm run db:backup`);
  const candidates = fs.readdirSync(dir)
    .filter(f => f.endsWith(`.${extension}`))
    .map(f => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!candidates.length) fail(2, `No .${extension} backup in ${dir}. Run: npm run db:backup`);
  return candidates[0];
}

function readManifest(file) {
  const manifestPath = `${file}.json`;
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

/** The manifest's own integrity, before trusting anything it claims. */
function verifyManifest(file, manifest) {
  console.log(`\n  backup   ${file}`);
  if (!manifest) {
    console.log('  manifest missing — row counts cannot be checked for equality,');
    console.log('             only for internal consistency. Re-take the backup with');
    console.log('             npm run db:backup to get one.\n');
    return;
  }
  console.log(`  taken    ${manifest.createdAt}   (${manifest.format})\n`);
  const bytes = fs.statSync(file).size;
  check(bytes === manifest.bytes, 'backup file is the size the manifest recorded', `${bytes} vs ${manifest.bytes}`);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  check(sha256 === manifest.sha256, 'backup file matches its recorded SHA-256', `${sha256.slice(0, 16)}…`);
  check(manifest.mode === mode, 'backup was taken in the mode being verified', `${manifest.mode} vs ${mode}`);
}

// ---------------------------------------------------------------- sqlite mode
if (mode === 'sqlite') {
  const file = resolveBackup('sqlite');
  const manifest = readManifest(file);
  verifyManifest(file, manifest);

  if (path.resolve(file) === path.resolve(config.dbPath)) {
    fail(2, 'That is the live database, not a backup of it. Refusing to verify in place.');
  }

  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get();
    check(Object.values(integrity)[0] === 'ok', 'SQLite integrity_check passes', String(Object.values(integrity)[0]));

    const counts = {};
    for (const table of CHECKED_TABLES) {
      const present = db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table).n;
      check(present === 1, `table "${table}" exists in the backup`);
      counts[table] = present === 1 ? db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n : null;
    }

    if (manifest?.rowCounts) {
      for (const table of CHECKED_TABLES) {
        check(counts[table] === manifest.rowCounts[table], `"${table}" row count matches the manifest`,
          `${counts[table]} vs ${manifest.rowCounts[table]}`);
      }
    } else {
      console.log(`  counts: ${CHECKED_TABLES.map(t => `${t} ${counts[t]}`).join(', ')}`);
    }

    console.log('\n  restore procedure for this backup:');
    console.log('    1. stop ROUTE+');
    console.log(`    2. cp "${file}" "${config.dbPath}"`);
    console.log(`    3. delete ${path.basename(config.dbPath)}-wal and -shm if present`);
    console.log('    4. start ROUTE+ and check GET /api/health');
  } finally {
    db.close();
  }

  console.log(`\n  ${failures === 0 ? 'BACKUP VERIFIED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

// ------------------------------------------------------------ postgres mode
const pg = pgConfig(process.env);
if (!pg.configured) {
  fail(2, 'ROUTE_PLUS_DB_MODE=postgres but no PostgreSQL is configured. Set DATABASE_URL (or PGHOST/PGDATABASE).');
}

const scratch = requestedName || `routeplus_restorecheck_${process.pid}_${Date.now().toString(36)}`;

// Refusal 1: the name must be a disposable one.
if (!SCRATCH.test(scratch)) {
  fail(2, `Refusing to restore into "${scratch}": a restore target must be named routeplus_restorecheck_<something>.`);
}
// Refusal 2: never the configured database, whatever it is called.
if (scratch === pg.database) {
  fail(2, `Refusing to restore into "${scratch}": that is the configured database. This command never overwrites it.`);
}

const PG_RESTORE = process.env.PG_RESTORE || 'pg_restore';

try {
  await run(PG_RESTORE, ['--version']);
} catch (error) {
  fail(3, [
    'pg_restore was not found on PATH, so a backup cannot be verified.',
    '',
    '  Install the PostgreSQL client tools that match your server version:',
    '    Debian/Ubuntu   sudo apt-get install postgresql-client-16',
    '    macOS           brew install libpq   (then add its bin to PATH)',
    '    Windows         the EnterpriseDB installer, "Command Line Tools"',
    '',
    '  Already have it somewhere off PATH? Point at it instead of installing:',
    '    PG_RESTORE="C:\\Program Files\\PostgreSQL\\16\\bin\\pg_restore.exe" npm run db:restore:verify',
    '',
    `  (${error.code === 'ENOENT' ? 'ENOENT: not on PATH' : error.message})`
  ].join('\n  '));
}

const file = resolveBackup('dump');
const manifest = readManifest(file);
verifyManifest(file, manifest);

const childEnv = { ...process.env, PGSSLMODE: pg.sslmode, PGCONNECT_TIMEOUT: '15' };
if (pg.password) childEnv.PGPASSWORD = pg.password;
else delete childEnv.PGPASSWORD;

// This connection exists only to issue CREATE DATABASE / DROP DATABASE. Nothing
// is read from or written to the configured database's own contents.
const admin = await connect(pg);
let created = false;

try {
  console.log(`\n  cluster  ${describeConnection(pg)}`);
  console.log(`  restoring into disposable database "${scratch}" (the configured database "${pg.database}" is not touched)\n`);

  // Refusal 3: an existing database is somebody else's, so leave it alone.
  const { rows: existing } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [scratch]);
  if (existing.length) {
    fail(2, `Database "${scratch}" already exists. Refusing to reuse or drop a database this run did not create.`);
  }

  await admin.exec(`CREATE DATABASE "${scratch}"`);
  created = true;

  const restoreArgs = [
    '-h', pg.host, '-p', String(pg.port), '-U', pg.user, '-d', scratch,
    '--no-owner', '--no-privileges',   // the scratch db is ours, not the dump's owner's
    '--no-password',
    '--exit-on-error',
    file
  ];
  try {
    await run(PG_RESTORE, restoreArgs, { env: childEnv, maxBuffer: 16 * 1024 * 1024 });
    check(true, 'pg_restore completed without error');
  } catch (error) {
    const detail = String(error.stderr || error.message).replace(/:\/\/[^@\s]*@/g, '://***@').trim();
    check(false, 'pg_restore completed without error', detail.split('\n').slice(0, 6).join(' | '));
    if (/could not open extension control file|extension "postgis" is not available/i.test(detail)) {
      console.log('\n  The dump requires an extension this server does not have installed.');
      console.log('  A PostGIS backup can only be restored onto a server with PostGIS.');
    }
  }

  // ------------------------------------------------------------- verification
  const restored = pgConfig(process.env);
  restored.database = scratch;
  const db = await connect(restored);
  try {
    const { rows: extRows } = await db.query('SELECT extname FROM pg_extension ORDER BY extname');
    const extensions = extRows.map(r => r.extname);
    if (manifest?.extensions) {
      const missing = manifest.extensions.filter(e => !extensions.includes(e));
      check(missing.length === 0, 'every extension the source had is present after restore',
        missing.length ? `missing: ${missing.join(', ')}` : extensions.join(', '));
    } else {
      console.log(`  extensions present: ${extensions.join(', ')}`);
    }

    const { rows: verRows } = await db.query('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations');
    const schemaVersion = Number(verRows[0].version);
    if (manifest?.schemaVersion !== undefined) {
      check(schemaVersion === manifest.schemaVersion, 'schema version matches the source',
        `${schemaVersion} vs ${manifest.schemaVersion}`);
    } else {
      check(schemaVersion > 0, 'schema_migrations records an applied version', String(schemaVersion));
    }

    const counts = {};
    for (const table of CHECKED_TABLES) {
      const { rows } = await db.query('SELECT to_regclass($1) AS oid', [table]);
      const present = rows[0].oid !== null;
      check(present, `table "${table}" exists after restore`);
      if (!present) { counts[table] = null; continue; }
      const { rows: c } = await db.query(`SELECT count(*)::bigint AS n FROM ${table}`);
      counts[table] = Number(c[0].n);
    }

    if (manifest?.rowCounts) {
      for (const table of CHECKED_TABLES) {
        check(counts[table] === manifest.rowCounts[table], `"${table}" row count matches the source`,
          `${counts[table]} vs ${manifest.rowCounts[table]}${manifest.countsExact ? '' : ' (source counts were not snapshot-exact)'}`);
      }
    } else {
      console.log(`  restored counts: ${CHECKED_TABLES.map(t => `${t} ${counts[t]}`).join(', ')}`);
    }

    // Constraints, not just rows: a restore that dropped a foreign key would
    // still count correctly.
    const { rows: orphans } = await db.query(
      'SELECT count(*)::int AS n FROM trips t LEFT JOIN users u ON u.id = t.user_id WHERE u.id IS NULL');
    check(Number(orphans[0].n) === 0, 'no trip lost its owner in the restore', `${orphans[0].n} orphaned`);

    // And finally: can ROUTE+ actually serve a query from the restored data?
    const spatial = await spatialMode(db);
    if (manifest?.extensions) {
      const expected = manifest.extensions.includes('postgis') ? 'postgis'
        : manifest.extensions.includes('earthdistance') ? 'earthdistance' : 'none';
      check(spatial === expected, 'spatial support after restore is what the source had', `${spatial} vs ${expected}`);
    }
    if (counts.places > 0) {
      const near = await placesNear(db, [28.6139, 77.2090], 400, { spatial });
      check(Array.isArray(near) && near.length > 0,
        `a real "places near me" query runs on the restored data (${spatial} mode)`, `${near.length} places near Delhi`);
    }
  } finally {
    await db.end().catch(() => {});
  }
} finally {
  if (created && !keep) {
    // Only ever the database this run created, and only after the pattern check.
    if (!SCRATCH.test(scratch) || scratch === pg.database) {
      console.error(`\n  refusing to drop "${scratch}" — leaving it in place.`);
    } else {
      await admin.exec(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(async () => {
        await admin.exec(`DROP DATABASE IF EXISTS "${scratch}"`).catch(() => {});
      });
      console.log(`\n  disposable database "${scratch}" dropped.`);
    }
  } else if (created) {
    console.log(`\n  disposable database "${scratch}" kept (--keep). Drop it with:`);
    console.log(`    psql -c 'DROP DATABASE "${scratch}"'`);
  }
  await admin.end().catch(() => {});
}

console.log(`\n  ${failures === 0 ? 'BACKUP VERIFIED — this dump restores, and the restored data is complete' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
