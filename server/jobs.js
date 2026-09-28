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

import { now, upsertPlace, placesRepo } from './db/database.js';
import { runPlacePipeline } from '../shared/engine/placePipeline.js';
import { haversineKm } from '../shared/geo.js';

export function purgeSessions(db) {
  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now()).changes;
}

export function aggregateMetrics(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS daily_metrics (day TEXT NOT NULL, name TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (day, name))`);
  const rows = db.prepare(`SELECT substr(created_at, 1, 10) AS day, name, COUNT(*) AS n FROM analytics_events GROUP BY day, name`).all();
  const up = db.prepare('INSERT INTO daily_metrics (day, name, count) VALUES (?, ?, ?) ON CONFLICT(day, name) DO UPDATE SET count = excluded.count');
  for (const r of rows) up.run(r.day, r.name, r.n);
  return rows.length;
}

export function reviewPlaces(db, { minResponses = 5, maxWorthRate = 0.3 } = {}) {
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
  const repo = placesRepo(db);
  const existing = repo.listAll({ limit: 100000 });
  let added = 0;
  for (const geometry of corridors) {
    const raw = await provider.searchCorridor({ geometry, bufferKm });
    for (const p of runPlacePipeline(raw)) {
      const duplicate = existing.some(e => e.id === p.id || (haversineKm([e.lat, e.lng], [p.lat, p.lng]) < 1.5 && e.name.toLowerCase() === p.name.toLowerCase()));
      if (duplicate) continue;
      upsertPlace(db, { ...p, quality: p.rating, visitDurationMinutes: undefined });
      db.prepare('UPDATE places SET active = 0, flagged = 1, flag_reason = ? WHERE id = ?').run(`New from ${p.source?.provider || 'provider'} — verify before enabling`, p.id);
      existing.push(p);
      added++;
    }
  }
  return added;
}

export function startScheduledJobs(db, logger, intervalMs = 3600_000) {
  const run = () => {
    try {
      logger.info('jobs', { sessionsPurged: purgeSessions(db), metricDays: aggregateMetrics(db), placesFlagged: reviewPlaces(db) });
    } catch (error) {
      logger.error('jobs failed', { error: error.message });
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
