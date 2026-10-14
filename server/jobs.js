// BACKGROUND JOBS — work that must not slow down a traveller's request.
// Run them on a schedule with `npm run worker` (cron, systemd timer, or a
// hosted scheduler). The server also runs the cheap ones hourly.
//
//   purgeSessions      remove expired login sessions
//   aggregateMetrics   roll analytics events up into daily counts
//   reviewPlaces       auto-flag places travellers say are not worth it
//   ingestPlaces       pull candidate places from a live PlaceProvider along
//                      popular corridors → normalise → de-duplicate → store as
//                      DISABLED + FLAGGED so staff verify before travellers see them
//
// EVERY job is async and works on BOTH backends. SQLite is synchronous, so its
// branches simply return a value that `await` passes straight through; nothing
// about the SQLite behaviour changes. PostgreSQL differs in more than syntax:
//
//   • created_at / expires_at are TIMESTAMPTZ, not ISO text — no substr(), and
//     expiry is compared against now() in the database
//   • worth_it and visited are BOOLEAN — SUM(worth_it = 1) is not valid SQL
//   • flagged / active are BOOLEAN, not 0/1
//   • the places repository and upsert are asynchronous
//
// Running the SQLite statements against PostgreSQL does not degrade, it errors.

import { now, upsertPlace, placesRepo } from './db/database.js';
import { upsertPlace as pgUpsertPlace } from './db/pg/migrate.js';
import { runPlacePipeline } from '../shared/engine/placePipeline.js';
import { haversineKm } from '../shared/geo.js';

/** The PostgreSQL pool exposes query(); the SQLite handle exposes prepare(). */
const isPostgres = db => typeof db?.query === 'function';

/**
 * daily_metrics is created by the job on both backends, exactly as it always
 * has been on SQLite: it is a derived roll-up, so a worker must be able to run
 * against a database migrated before this table existed. The PostgreSQL schema
 * also declares it, so a fresh migration creates it up front.
 */
const PG_DAILY_METRICS = `
  CREATE TABLE IF NOT EXISTS daily_metrics (
    day   TEXT NOT NULL,
    name  TEXT NOT NULL,
    count BIGINT NOT NULL,
    PRIMARY KEY (day, name)
  )
`;

export async function purgeSessions(db) {
  if (isPostgres(db)) {
    const result = await db.query('DELETE FROM sessions WHERE expires_at <= now()');
    return result.rowCount ?? 0;
  }

  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now()).changes;
}

export async function aggregateMetrics(db) {
  if (isPostgres(db)) {
    await db.query(PG_DAILY_METRICS);

    // to_char, not substr: created_at is a timestamp here, and the day key has
    // to stay the same 'YYYY-MM-DD' text the SQLite roll-up produces.
    const { rows } = await db.query(`
      SELECT to_char(created_at, 'YYYY-MM-DD') AS day, name, COUNT(*)::bigint AS n
        FROM analytics_events
       GROUP BY day, name
    `);

    for (const r of rows) {
      await db.query(`
        INSERT INTO daily_metrics (day, name, count)
        VALUES ($1, $2, $3)
        ON CONFLICT (day, name) DO UPDATE SET count = EXCLUDED.count
      `, [r.day, r.name, Number(r.n)]);
    }

    return rows.length;
  }

  db.exec(`CREATE TABLE IF NOT EXISTS daily_metrics (day TEXT NOT NULL, name TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (day, name))`);
  const rows = db.prepare(`SELECT substr(created_at, 1, 10) AS day, name, COUNT(*) AS n FROM analytics_events GROUP BY day, name`).all();
  const up = db.prepare('INSERT INTO daily_metrics (day, name, count) VALUES (?, ?, ?) ON CONFLICT(day, name) DO UPDATE SET count = excluded.count');
  for (const r of rows) up.run(r.day, r.name, r.n);
  return rows.length;
}

export async function reviewPlaces(db, { minResponses = 5, maxWorthRate = 0.3 } = {}) {
  if (isPostgres(db)) {
    // worth_it and visited are BOOLEAN: count with FILTER rather than SUM(= 1).
    const { rows } = await db.query(`
      SELECT place_id,
             COUNT(*) FILTER (WHERE worth_it)               AS yes,
             COUNT(*) FILTER (WHERE worth_it IS FALSE)      AS no
        FROM feedback
       WHERE visited
       GROUP BY place_id
    `);

    let flagged = 0;

    for (const r of rows) {
      const yes = Number(r.yes);
      const n = yes + Number(r.no);

      if (n >= minResponses && yes / n <= maxWorthRate) {
        const result = await db.query(`
          UPDATE places
             SET flagged = TRUE, flag_reason = $1, updated_at = now()
           WHERE id = $2 AND flagged = FALSE
        `, [
          `Only ${Math.round(yes / n * 100)}% of ${n} travellers said it was worth the detour`,
          r.place_id
        ]);

        flagged += result.rowCount ?? 0;
      }
    }

    return flagged;
  }

  const rows = db.prepare(`SELECT place_id, SUM(worth_it = 1) AS yes, SUM(worth_it = 0) AS no FROM feedback WHERE visited = 1 GROUP BY place_id`).all();
  let flagged = 0;
  for (const r of rows) {
    const n = r.yes + r.no;
    if (n >= minResponses && r.yes / n <= maxWorthRate) {
      flagged += db.prepare('UPDATE places SET flagged = 1, flag_reason = ?, updated_at = ? WHERE id = ? AND flagged = 0')
        .run(`Only ${Math.round(r.yes / n * 100)}% of ${n} travellers said it was worth the detour`, now(), r.place_id).changes;
    }
  }
  return flagged;
}

/**
 * @param {object} opts.provider  a PlaceProvider (e.g. Overpass)
 * @param {Array<[lat,lng][]>} opts.corridors  route geometries to scan
 */
export async function ingestPlaces(db, { provider, corridors, bufferKm = 25 }) {
  const pg = isPostgres(db);
  const repo = placesRepo(db);

  // listAll is synchronous on SQLite and a promise on PostgreSQL.
  const existing = await repo.listAll({ limit: 100000 });

  let added = 0;

  for (const geometry of corridors) {
    const raw = await provider.searchCorridor({ geometry, bufferKm });

    for (const p of runPlacePipeline(raw)) {
      const duplicate = existing.some(e => e.id === p.id || (haversineKm([e.lat, e.lng], [p.lat, p.lng]) < 1.5 && e.name.toLowerCase() === p.name.toLowerCase()));
      if (duplicate) continue;

      const record = { ...p, quality: p.rating, visitDurationMinutes: undefined };
      const reason = `New from ${p.source?.provider || 'provider'} — verify before enabling`;

      if (pg) {
        // The PostgreSQL upsert takes a query FUNCTION, not the pool.
        await pgUpsertPlace((sql, params) => db.query(sql, params), record);
        await db.query(
          'UPDATE places SET active = FALSE, flagged = TRUE, flag_reason = $1 WHERE id = $2',
          [reason, p.id]
        );
      } else {
        upsertPlace(db, record);
        db.prepare('UPDATE places SET active = 0, flagged = 1, flag_reason = ? WHERE id = ?').run(reason, p.id);
      }

      existing.push(p);
      added++;
    }
  }

  return added;
}

export function startScheduledJobs(db, logger, intervalMs = 3600_000) {
  // The jobs are async on both backends now, so a failure has to be caught on
  // the promise: a throw inside a bare setInterval callback is an unhandled
  // rejection that can take the process down instead of logging one bad run.
  const run = async () => {
    try {
      logger.info('jobs', {
        sessionsPurged: await purgeSessions(db),
        metricDays: await aggregateMetrics(db),
        placesFlagged: await reviewPlaces(db)
      });
    } catch (error) {
      logger.error('jobs failed', { error: error.message });
    }
  };

  const timer = setInterval(() => { run(); }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
