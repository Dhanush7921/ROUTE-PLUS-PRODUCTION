// ROUTE+ PostgreSQL / PostGIS command line.
//
//   npm run db:pg -- status            what is configured, reachable and installed
//   npm run db:pg -- migrate           create/update the schema (safe to re-run)
//   npm run db:pg -- seed              reference data: categories + curated places
//   npm run db:pg -- import [file]     copy an existing SQLite database in
//   npm run db:pg -- verify            read back rows, including a spatial query
//   npm run db:pg -- rollback --yes    DESTRUCTIVE: drop every ROUTE+ table
//
// Connection comes from DATABASE_URL (or PGHOST/PGUSER/PGDATABASE/PGPASSWORD).
// The password is never printed, never logged, and never written to a file.

import path from 'node:path';
import { connect, pgConfig, describeConnection, checkConnection, scrubDsn } from '../server/db/pg/client.js';
import { migrate, seed, importFromSqlite, placesNear, placesAlongRoute, spatialMode, appliedVersions, ROLLBACK_SQL } from '../server/db/pg/migrate.js';
import { loadConfig } from '../server/config.js';

const [, , command = 'status', ...rest] = process.argv;
const config = pgConfig();
const log = line => console.log(`  ${line}`);

if (!config.configured && command !== 'help') {
  console.error('\n  No PostgreSQL configured. Set DATABASE_URL (or PGHOST/PGDATABASE) and try again.');
  console.error('  Local development keeps working on SQLite with no configuration at all.\n');
  process.exit(2);
}

async function withClient(fn) {
  const client = await connect(config);
  try { return await fn(client); } finally { await client.end(); }
}

try {
  console.log(`\nROUTE+ database — ${describeConnection(config)}\n`);
  switch (command) {
    case 'status': {
      const check = await checkConnection(config);
      if (!check.ok) { console.error(`  unreachable: ${check.reason}\n`); process.exit(1); }
      log(`server      ${check.server}`);
      log(`database    ${check.database}`);
      log(`extensions  ${check.extensions.join(', ') || 'none'}`);
      log(`spatial     ${check.spatial}${check.postgis ? '' : '  (no PostGIS — lat/lng indexes and shared/geo.js maths are used)'}`);
      await withClient(async client => {
        const versions = await appliedVersions(client);
        log(`migrations  ${versions.length ? versions.join(', ') : 'none applied yet — run: npm run db:pg -- migrate'}`);
        if (versions.length) {
          const { rows } = await client.query('SELECT (SELECT count(*) FROM places) AS places, (SELECT count(*) FROM routes) AS routes, (SELECT count(*) FROM users) AS users');
          log(`rows        places ${rows[0].places}, routes ${rows[0].routes}, users ${rows[0].users}`);
        }
      });
      break;
    }
    case 'migrate': {
      await withClient(async client => {
        const result = await migrate(client, { log });
        log(`applied ${result.applied.length ? result.applied.join(', ') : 'nothing new'}; schema version ${result.version}`);
        log(`spatial mode: ${await spatialMode(client)}`);
      });
      break;
    }
    case 'seed': {
      await withClient(async client => log(`seeded ${await seed(client)} curated places and the category list`));
      break;
    }
    case 'import': {
      const file = rest.find(a => !a.startsWith('-')) || loadConfig().dbPath;
      await withClient(async client => {
        const counts = await importFromSqlite(client, path.resolve(file), { log });
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        log(`imported ${total} row(s) from ${file}`);
      });
      break;
    }
    case 'verify': {
      await withClient(async client => {
        const mode = await spatialMode(client);
        const { rows: [counts] } = await client.query('SELECT (SELECT count(*) FROM places) AS places, (SELECT count(*) FROM place_categories) AS categories, (SELECT count(*) FROM routes) AS routes');
        log(`rows: ${counts.places} places, ${counts.categories} categories, ${counts.routes} routes`);
        const near = await placesNear(client, [17.6868, 83.2185], 40, { spatial: mode });
        log(`point proximity (${mode}): ${near.length} place(s) within 40 km of Visakhapatnam`);
        for (const p of near.slice(0, 3)) log(`   ${p.name}${p.distance_km !== undefined ? ` — ${Number(p.distance_km).toFixed(1)} km` : ''}`);
        if (!near.length) log('   (none — run: npm run db:pg -- seed)');

        // Route corridor: the query discovery is built on.
        const { rows: [route] } = await client.query('SELECT geometry FROM routes ORDER BY created_at DESC LIMIT 1');
        const line = route?.geometry?.length > 1 ? route.geometry : [[17.6868, 83.2185], [20.5, 79.0], [28.61, 77.21], [32.2396, 77.1887]];
        const corridor = await placesAlongRoute(client, line, 30, { spatial: mode });
        log(`route corridor (${mode}): ${corridor.length} place(s) within 30 km of a ${line.length}-point line${route ? ' (the newest stored route)' : ' (a sample line)'}`);
        for (const p of corridor.slice(0, 5)) log(`   ${p.name} — ${Number(p.distance_km).toFixed(1)} km from the road`);
      });
      break;
    }
    case 'rollback': {
      if (!rest.includes('--yes')) {
        console.error('  This DROPS every ROUTE+ table and all of its data.');
        console.error('  Re-run with --yes if that is really what you want.\n');
        console.error(ROLLBACK_SQL);
        process.exit(2);
      }
      await withClient(async client => { await client.exec(ROLLBACK_SQL); log('all ROUTE+ tables dropped'); });
      break;
    }
    default:
      console.log('  commands: status | migrate | seed | import [sqlite-file] | verify | rollback --yes');
  }
  console.log('');
} catch (error) {
  console.error(`\n  ${scrubDsn(error.message)}\n`);
  process.exit(1);
}
