// BACKUP the serving SQLite database, safely, while the server is running.
//
//   npm run db:backup                    → ./backups/routeplus-<timestamp>.sqlite
//   npm run db:backup -- /path/to/dir
//
// Uses SQLite's own `VACUUM INTO`, which writes a consistent single-file copy
// even with writers active — unlike copying the file, which can capture a
// half-written page or miss the WAL. The copy is compacted, so it is usually
// smaller than the original.
//
// A beta database holds your testers' accounts, trips and feedback. Take a copy
// before every deploy, and keep one off the server.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../server/config.js';

const config = loadConfig();
const source = config.dbPath;
if (source === ':memory:' || !fs.existsSync(source)) {
  console.error(`\n  No database file at ${source}. Start ROUTE+ once, or set ROUTE_PLUS_DB.\n`);
  process.exit(2);
}

const dir = path.resolve(process.argv[2] || path.join(config.root, 'backups'));
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = path.join(dir, `routeplus-${stamp}.sqlite`);
if (fs.existsSync(target)) { console.error(`\n  ${target} already exists.\n`); process.exit(1); }

const db = new DatabaseSync(source, { readOnly: true });
try {
  // The path is a literal in SQL, so refuse anything that could break out of
  // the quotes rather than escaping it and hoping.
  if (target.includes("'")) throw new Error('Backup path must not contain a single quote.');
  db.exec(`VACUUM INTO '${target}'`);
  const counts = ['users', 'trips', 'routes', 'feedback', 'analytics_events']
    .map(t => `${t} ${db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n}`).join(', ');
  const size = fs.statSync(target).size;
  console.log(`\n  backed up ${source}\n       → ${target}  (${(size / 1024).toFixed(0)} KB)`);
  console.log(`  contents: ${counts}`);
  console.log(`\n  restore:  stop ROUTE+, then  cp "${target}" "${source}"  (and delete ${path.basename(source)}-wal / -shm if present)\n`);
} catch (error) {
  console.error(`\n  backup failed: ${error.message}\n`);
  process.exit(1);
} finally {
  db.close();
}
