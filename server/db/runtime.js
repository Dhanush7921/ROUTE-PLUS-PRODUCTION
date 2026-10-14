// ROUTE+ database runtime selector.
//
// SQLite remains the default so the existing beta/tests keep working.
// PostgreSQL is opt-in through ROUTE_PLUS_DB_MODE=postgres.

import { openDatabase as openSqliteDatabase } from './database.js';
import { createPool, pgConfig } from './pg/client.js';

export function databaseMode(env = process.env) {
  const mode = String(env.ROUTE_PLUS_DB_MODE || 'sqlite').trim().toLowerCase();

  if (mode === 'sqlite' || mode === 'postgres') return mode;

  throw new Error(
    `ROUTE_PLUS_DB_MODE must be "sqlite" or "postgres" (got "${mode}").`
  );
}

/**
 * Open the selected runtime database.
 *
 * Returns { mode, db, close() }. `db` is a SQLite handle (synchronous
 * prepare/run) or a PostgreSQL pool (asynchronous query). The domains,
 * repositories and background jobs all branch on `typeof db.query ===
 * 'function'`, so both shapes are served by the same code paths.
 */
export async function openRuntimeDatabase({
  env = process.env,
  sqlitePath,
  postgresPoolSize = Number(env.PGPOOL_SIZE || 4)
} = {}) {
  const mode = databaseMode(env);

  if (mode === 'sqlite') {
    const db = openSqliteDatabase(sqlitePath);

    return {
      mode,
      db,
      async close() {
        db.close();
      }
    };
  }

  const config = pgConfig(env);

  if (!config.configured) {
    throw new Error(
      'ROUTE_PLUS_DB_MODE=postgres requires PostgreSQL configuration such as PGHOST/PGDATABASE or DATABASE_URL.'
    );
  }

  const pool = createPool(config, {
    size: Math.max(1, postgresPoolSize)
  });

  try {
    await pool.query('SELECT 1 AS ok');

    return {
      mode,
      db: pool,
      async close() {
        await pool.end();
      }
    };
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
}
