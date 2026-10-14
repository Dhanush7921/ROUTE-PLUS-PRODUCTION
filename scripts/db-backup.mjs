// BACKUP the serving database — whichever backend ROUTE_PLUS_DB_MODE selects.
//
//   npm run db:backup                 → ./backups/routeplus-<stamp>.sqlite   (sqlite mode)
//                                     → ./backups/routeplus-<stamp>.dump     (postgres mode)
//   npm run db:backup -- /mnt/backups
//
// SQLITE (default) — unchanged behaviour. Uses SQLite's own `VACUUM INTO`,
// which writes a consistent single-file copy even with writers active, unlike
// copying the file, which can capture a half-written page or miss the WAL.
//
// POSTGRESQL — `pg_dump` in custom format (-Fc): compressed, and restorable
// selectively with pg_restore. The row counts recorded beside the dump are read
// inside pg_dump's OWN transaction snapshot (pg_export_snapshot + --snapshot),
// so they describe exactly what the dump contains rather than what the database
// happened to hold a moment later. That is what makes a restore check able to
// assert equality instead of "close enough".
//
// Both modes: a timestamped filename, never an overwrite, and a sidecar
// <file>.json manifest recording size, SHA-256, schema version, extensions and
// per-table row counts. The password is never printed, never written to the
// manifest, and never placed on a command line — pg_dump receives it through
// its environment, where `ps` cannot read it.
//
// PG_DUMP / PG_RESTORE may name the binaries explicitly, for a machine where the
// client tools are installed but not on PATH (common on Windows).
//
// A beta database holds your testers' accounts, trips and feedback. Take a copy
// before every deploy, keep one off the server, and verify it:
//
//   npm run db:restore:verify

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../server/config.js';
import { databaseMode } from '../server/db/runtime.js';
import { connect, pgConfig, describeConnection } from '../server/db/pg/client.js';

const run = promisify(execFile);

/** The tables a ROUTE+ backup is judged by. Order is stable so output diffs read cleanly. */
export const CHECKED_TABLES = ['users', 'places', 'routes', 'trips', 'feedback', 'analytics_events'];

const config = loadConfig();
const mode = databaseMode(process.env);
const dir = path.resolve(process.argv[2] || path.join(config.root, 'backups'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const fail = (code, message) => {
  console.error(`\n  ${message}\n`);
  process.exit(code);
};

/** Never clobber a backup, and never leave a half-written file looking like one. */
function claimTarget(extension) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `routeplus-${stamp}.${extension}`);
  for (const existing of [target, `${target}.json`]) {
    if (fs.existsSync(existing)) fail(1, `${existing} already exists — refusing to overwrite a backup.`);
  }
  return target;
}

function writeManifest(target, manifest) {
  const bytes = fs.statSync(target).size;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  fs.writeFileSync(`${target}.json`, `${JSON.stringify({ ...manifest, bytes, sha256 }, null, 2)}\n`);
  return { bytes, sha256 };
}

const report = (target, { bytes, sha256 }, counts, restoreHint) => {
  console.log(`\n  → ${target}  (${(bytes / 1024).toFixed(0)} KB)`);
  console.log(`    sha256 ${sha256.slice(0, 16)}…   manifest ${path.basename(target)}.json`);
  console.log(`    contents: ${CHECKED_TABLES.map(t => `${t} ${counts[t]}`).join(', ')}`);
  console.log(`\n  ${restoreHint}\n`);
};

// ---------------------------------------------------------------- sqlite mode
if (mode === 'sqlite') {
  const source = config.dbPath;
  if (source === ':memory:' || !fs.existsSync(source)) {
    fail(2, `No database file at ${source}. Start ROUTE+ once, or set ROUTE_PLUS_DB.`);
  }

  const target = claimTarget('sqlite');
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    // The path is a literal in SQL, so refuse anything that could break out of
    // the quotes rather than escaping it and hoping.
    if (target.includes("'")) throw new Error('Backup path must not contain a single quote.');
    db.exec(`VACUUM INTO '${target}'`);

    const counts = {};
    for (const table of CHECKED_TABLES) {
      counts[table] = db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    }

    console.log(`\n  backed up ${source}  (sqlite)`);
    const written = writeManifest(target, {
      tool: 'route-plus db:backup',
      createdAt: new Date().toISOString(),
      mode: 'sqlite',
      format: 'sqlite VACUUM INTO',
      file: path.basename(target),
      countsExact: true,
      rowCounts: counts
    });
    report(target, written, counts,
      `restore:  stop ROUTE+, then  cp "${target}" "${source}"  (and delete ${path.basename(source)}-wal / -shm if present)`);
  } catch (error) {
    fs.rmSync(target, { force: true });
    fail(1, `backup failed: ${error.message}`);
  } finally {
    db.close();
  }
  process.exit(0);
}

// ------------------------------------------------------------ postgres mode
const pg = pgConfig(process.env);
if (!pg.configured) {
  fail(2, 'ROUTE_PLUS_DB_MODE=postgres but no PostgreSQL is configured. Set DATABASE_URL (or PGHOST/PGDATABASE).');
}

/** pg_dump has to exist, and must not be older than the server it reads. */
const PG_DUMP = process.env.PG_DUMP || 'pg_dump';

async function pgDumpVersion() {
  try {
    const { stdout } = await run(PG_DUMP, ['--version']);
    return { text: stdout.trim(), major: Number(stdout.match(/(\d+)\.\d+/)?.[1] ?? stdout.match(/\s(\d+)/)?.[1]) };
  } catch (error) {
    fail(3, [
      'pg_dump was not found on PATH, so a PostgreSQL backup cannot be taken.',
      '',
      '  Install the PostgreSQL client tools that match your server version:',
      '    Debian/Ubuntu   sudo apt-get install postgresql-client-16',
      '    macOS           brew install libpq   (then add its bin to PATH)',
      '    Windows         the EnterpriseDB installer, "Command Line Tools"',
      '    Docker          docker exec <container> pg_dump ...',
      '',
      '  Already have it somewhere off PATH? Point at it instead of installing:',
      '    PG_DUMP="C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe" npm run db:backup',
      '',
      `  (${error.code === 'ENOENT' ? 'ENOENT: not on PATH' : error.message})`
    ].join('\n  '));
  }
}

const tool = await pgDumpVersion();

// The password goes in the child's ENVIRONMENT, never in argv: command lines are
// world-readable through ps, environments are not.
const childEnv = { ...process.env, PGSSLMODE: pg.sslmode, PGCONNECT_TIMEOUT: '15' };
if (pg.password) childEnv.PGPASSWORD = pg.password;
else delete childEnv.PGPASSWORD;

let client;
let target;
let partial;
try {
  client = await connect(pg);

  // current_setting, not SHOW: SHOW's column is named after the setting and
  // cannot be aliased, which is how this read silently produced "undefined"
  // and disabled the version-skew guard below.
  const { rows: [{ v }] } = await client.query(`SELECT current_setting('server_version') AS v`);
  const serverMajor = Number(String(v).match(/^(\d+)/)?.[1]);
  if (Number.isFinite(tool.major) && Number.isFinite(serverMajor) && tool.major < serverMajor) {
    fail(3, [
      `pg_dump is version ${tool.major} but the server is version ${serverMajor}.`,
      'pg_dump refuses to dump a newer server, and a dump taken this way would be incomplete.',
      `Install postgresql-client-${serverMajor} (or newer) and re-run.`
    ].join('\n  '));
  }

  console.log(`\n  backing up ${describeConnection(pg)}`);
  console.log(`    server ${v}   pg_dump ${tool.major}`);

  target = claimTarget('dump');
  partial = `${target}.part`;

  // Export a snapshot and hand it to pg_dump, so the counts recorded below and
  // the rows inside the dump are the same instant. Without this the counts are
  // only "shortly after", and a restore check cannot assert equality.
  let snapshot = null;
  let countsExact = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows } = await client.query('SELECT pg_export_snapshot() AS id');
    snapshot = rows[0]?.id || null;
    countsExact = Boolean(snapshot);
  } catch {
    // Older server, or a pooler that will not export snapshots. Fall back to
    // counting after the dump and say so in the manifest.
    await client.query('ROLLBACK').catch(() => {});
    snapshot = null;
  }

  const args = [
    '-h', pg.host, '-p', String(pg.port), '-U', pg.user, '-d', pg.database,
    '--format=custom', '--compress=6',
    '--no-password',              // fail fast instead of waiting on a prompt
    '--file', partial
  ];
  if (snapshot) args.push(`--snapshot=${snapshot}`);

  try {
    await run(PG_DUMP, args, { env: childEnv, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    // pg_dump's own message is the useful one, and it never contains the
    // password — but scrub a DSN shape defensively before printing it.
    const detail = String(error.stderr || error.message).replace(/:\/\/[^@\s]*@/g, '://***@').trim();
    throw new Error(`pg_dump failed:\n    ${detail.split('\n').join('\n    ')}`);
  }

  const counts = {};
  for (const table of CHECKED_TABLES) {
    const { rows } = await client.query(`SELECT count(*)::bigint AS n FROM ${table}`);
    counts[table] = Number(rows[0].n);
  }
  const { rows: extRows } = await client.query('SELECT extname FROM pg_extension ORDER BY extname');
  const { rows: verRows } = await client.query('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations');

  if (snapshot) await client.query('COMMIT').catch(() => {});

  // Only now does the file get its real name: a failed dump never leaves
  // something that looks like a usable backup.
  fs.renameSync(partial, target);
  partial = null;

  const written = writeManifest(target, {
    tool: 'route-plus db:backup',
    createdAt: new Date().toISOString(),
    mode: 'postgres',
    format: 'pg_dump custom (-Fc)',
    file: path.basename(target),
    pgDumpMajor: tool.major,
    serverVersion: String(v),
    database: pg.database,           // name only — no host, user or password
    schemaVersion: Number(verRows[0].version),
    extensions: extRows.map(r => r.extname),
    countsExact,
    rowCounts: counts
  });

  if (!countsExact) {
    console.log('    note: this server would not export a snapshot, so the recorded');
    console.log('          row counts were read just after the dump, not inside it.');
  }
  report(target, written, counts,
    `verify it:  npm run db:restore:verify -- "${target}"    (restores into a disposable database, never production)`);
} catch (error) {
  if (partial) fs.rmSync(partial, { force: true });
  if (target) fs.rmSync(`${target}.json`, { force: true });
  fail(1, `backup failed: ${error.message}`);
} finally {
  await client?.end().catch(() => {});
}
