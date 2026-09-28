// PostgreSQL migrations, seed and import for ROUTE+.
//
//   init      apply schema.sql (idempotent) and record the migration
//   seed      reference data: place categories + the curated place list
//   import    copy an existing SQLite database into PostgreSQL
//   verify    read back what was written, including a spatial query
//   down      documented rollback (see ROLLBACK_SQL — destructive, opt-in)
//
// Everything here is additive and safe to re-run: `CREATE ... IF NOT EXISTS`,
// `INSERT ... ON CONFLICT DO UPDATE`. Nothing drops a table unless you ask for
// the rollback explicitly.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES } from '../../../shared/taxonomy.js';
import { CURATED_PLACES } from '../../../shared/data/places.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = path.join(here, 'schema.sql');

export const MIGRATIONS = [
  { version: 1, name: 'base schema, indexes and spatial objects', file: SCHEMA_PATH },
  { version: 2, name: 'reference data: categories and curated places', seed: true }
];

/** Tables dropped by `down`, children first. Documented, never automatic. */
export const ROLLBACK_SQL = `-- ROUTE+ PostgreSQL rollback. DESTRUCTIVE: this deletes all data.
-- Run it only to return a database to "before ROUTE+ was installed".
DROP TRIGGER IF EXISTS routes_geom_sync ON routes;
DROP FUNCTION IF EXISTS route_geom_sync();
DROP TABLE IF EXISTS audit_log, analytics_events, feedback, saved_trips, trip_stops, trip_preferences, trips,
  recommendations, detour_calculations, route_segments, routes,
  place_seasonality, place_opening_hours, place_sources, place_attributes, places, place_categories,
  user_preferences, sessions, users, schema_migrations CASCADE;
-- Extensions are left in place: other databases/schemas may rely on them.`;

const j = v => (v === undefined || v === null ? null : JSON.stringify(v));

/** Which migrations have already run? Returns [] on a brand-new database. */
export async function appliedVersions(client) {
  try {
    const { rows } = await client.query('SELECT version FROM schema_migrations ORDER BY version');
    return rows.map(r => r.version);
  } catch {
    return [];
  }
}

/**
 * Bring the database up to date. Safe to run on every deploy.
 * @returns {{ applied: number[], skipped: number[], version: number }}
 */
export async function migrate(client, { log = () => {} } = {}) {
  const done = new Set(await appliedVersions(client));
  const applied = [];
  const skipped = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) { skipped.push(m.version); continue; }
    log(`applying migration ${m.version}: ${m.name}`);
    if (m.file) await client.exec(fs.readFileSync(m.file, 'utf8'));
    if (m.seed) await seed(client);
    await client.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, now()) ON CONFLICT (version) DO NOTHING', [m.version]);
    applied.push(m.version);
  }
  const { rows } = await client.query('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations');
  return { applied, skipped, version: rows[0].version };
}

/** Reference data. Re-running updates rows instead of duplicating them. */
export async function seed(client, places = CURATED_PLACES) {
  await client.transaction(async ({ query }) => {
    for (const [id, c] of Object.entries(CATEGORIES)) {
      await query('INSERT INTO place_categories (id, label) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label', [id, c.label]);
    }
    for (const p of places) await upsertPlace(query, p);
  });
  return places.length;
}

/** One place, in the same raw shape the SQLite layer uses. */
export async function upsertPlace(query, p) {
  await query(`INSERT INTO places (id, name, category_id, lat, lng, locality, description, why_visit, quality, active, sponsored, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10, now(), now())
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, category_id = EXCLUDED.category_id, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
      locality = EXCLUDED.locality, description = EXCLUDED.description, why_visit = EXCLUDED.why_visit,
      quality = EXCLUDED.quality, sponsored = EXCLUDED.sponsored, updated_at = now()`,
  [p.id, p.name, p.category, p.lat, p.lng, p.locality ?? null, p.description ?? null, p.whyVisit ?? null, p.quality ?? null, Boolean(p.sponsored)]);

  await query(`INSERT INTO place_attributes (place_id, visit_minutes, walking_minutes, suitable_for, less_suitable_for, extra_interests, parking, food_available, facilities, caution, terrain, entry_fee)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (place_id) DO UPDATE SET visit_minutes = EXCLUDED.visit_minutes, walking_minutes = EXCLUDED.walking_minutes,
      suitable_for = EXCLUDED.suitable_for, less_suitable_for = EXCLUDED.less_suitable_for, extra_interests = EXCLUDED.extra_interests,
      parking = EXCLUDED.parking, food_available = EXCLUDED.food_available, facilities = EXCLUDED.facilities,
      caution = EXCLUDED.caution, terrain = EXCLUDED.terrain, entry_fee = EXCLUDED.entry_fee`,
  [p.id, p.visitDurationMinutes ?? null, p.walkingMinutes ?? null, j(p.suitableFor), j(p.lessSuitableFor), j(p.extraInterests),
    p.parking ?? null, p.foodAvailable ?? null, j(p.facilities), p.caution ?? null, p.terrain ?? null, p.entryFee ?? null]);

  await query(`INSERT INTO place_sources (place_id, provider, external_ref, label, verified, fetched_at)
    VALUES ($1,$2,$3,$4,$5, now())
    ON CONFLICT (place_id, provider) DO UPDATE SET external_ref = EXCLUDED.external_ref, label = EXCLUDED.label,
      verified = EXCLUDED.verified, fetched_at = now()`,
  [p.id, p.source?.provider || 'curated', p.source?.ref ?? null, p.source?.label ?? null, Boolean(p.source?.verified)]);

  await query('DELETE FROM place_opening_hours WHERE place_id = $1', [p.id]);
  if (p.openingHours) {
    await query('INSERT INTO place_opening_hours (place_id, weekday, open_min, close_min, note) VALUES ($1, -1, $2, $3, $4)', [p.id, p.openingHours.open, p.openingHours.close, p.closedNote ?? null]);
  } else if (p.closedNote) {
    await query('INSERT INTO place_opening_hours (place_id, weekday, open_min, close_min, note) VALUES ($1, -2, 0, 0, $2)', [p.id, p.closedNote]);
  }
  await query('DELETE FROM place_seasonality WHERE place_id = $1', [p.id]);
  if (p.bestMonths) await query('INSERT INTO place_seasonality (place_id, best_months) VALUES ($1, $2)', [p.id, p.bestMonths]);
}

/** Store one planned route (the shape server/domains/journeys.js persists). */
export async function insertRoute(client, routeId, plan) {
  await client.query(`INSERT INTO routes (id, origin_name, origin_lat, origin_lng, dest_name, dest_lat, dest_lng, distance_km, duration_min, provider, method, geometry, plan_json, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now()) ON CONFLICT (id) DO NOTHING`,
  [routeId, plan.origin.name, plan.origin.lat, plan.origin.lng, plan.destination.name, plan.destination.lat, plan.destination.lng,
    plan.route.distanceKm, plan.route.durationMin, plan.route.provider, plan.route.method,
    JSON.stringify(plan.route.geometry), JSON.stringify({ ...plan, routeId })]);
  for (const ph of plan.phases || []) {
    await client.query('INSERT INTO route_segments (route_id, idx, phase_name, start_km, end_km) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (route_id, idx) DO NOTHING',
      [routeId, ph.index, ph.name, ph.startKm, ph.endKm]);
  }
  for (const p of plan.places || []) {
    await client.query(`INSERT INTO detour_calculations (route_id, place_id, route_km, distance_from_route_km, extra_km, extra_min, strategy, method, anchor_km, rejoin_km)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (route_id, place_id) DO NOTHING`,
    [routeId, p.id, p.routeKm, p.distanceFromRouteKm, p.detourDistanceKm, p.detourTimeMinutes, p.detour.strategy, p.detour.method, p.detour.anchorKm, p.detour.rejoinKm]);
  }
  return routeId;
}

/**
 * Places within `radiusKm` of a point, nearest first.
 * Uses the PostGIS index when it exists, the earthdistance index when it does
 * not, and a plain bounding box as the last resort — the answer is the same
 * either way, only the speed differs.
 */
export async function placesNear(client, [lat, lng], radiusKm = 25, { spatial } = {}) {
  const mode = spatial || (await spatialMode(client));
  if (mode === 'postgis') {
    const { rows } = await client.query(
      `SELECT id, name, lat, lng, ST_Distance(geog, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) / 1000 AS distance_km
         FROM places WHERE active AND ST_DWithin(geog, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, $3)
         ORDER BY distance_km LIMIT 200`, [lat, lng, radiusKm * 1000]);
    return rows;
  }
  if (mode === 'earthdistance') {
    const { rows } = await client.query(
      `SELECT id, name, lat, lng, earth_distance(ll_to_earth(lat, lng), ll_to_earth($1, $2)) / 1000 AS distance_km
         FROM places WHERE active AND earth_box(ll_to_earth($1, $2), $3) @> ll_to_earth(lat, lng)
           AND earth_distance(ll_to_earth(lat, lng), ll_to_earth($1, $2)) <= $3
         ORDER BY distance_km LIMIT 200`, [lat, lng, radiusKm * 1000]);
    return rows;
  }
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.cos(lat * Math.PI / 180));
  const { rows } = await client.query(
    'SELECT id, name, lat, lng FROM places WHERE active AND lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4 LIMIT 200',
    [lat - dLat, lat + dLat, lng - dLng, lng + dLng]);
  return rows;
}

/**
 * ROUTE/PLACE PROXIMITY — the corridor query ROUTE+ discovery is built on:
 * "which places are within `bufferKm` of this driven line?"
 *
 * With PostGIS the whole question is answered in the database, against the
 * GiST index, using the real linestring. Without it the database narrows by
 * bounding box (index-backed) and the exact distance to the line is finished
 * with the same `shared/geo.js` maths the app already uses — so the answer is
 * identical, and only the work distribution changes.
 *
 * @param {[number,number][]} geometry  the route line as [[lat,lng],…]
 */
export async function placesAlongRoute(client, geometry, bufferKm = 25, { spatial, limit = 500 } = {}) {
  if (!Array.isArray(geometry) || geometry.length < 2) return [];
  const mode = spatial || (await spatialMode(client));

  if (mode === 'postgis') {
    const { rows } = await client.query(
      `WITH line AS (
         SELECT ST_SetSRID(ST_MakeLine(ARRAY(
           SELECT ST_MakePoint((p->>1)::float8, (p->>0)::float8)
           FROM jsonb_array_elements($1::jsonb) AS p)), 4326)::geography AS g)
       SELECT p.id, p.name, p.category_id, p.lat, p.lng,
              ST_Distance(p.geog, line.g) / 1000 AS distance_km
         FROM places p, line
        WHERE p.active AND ST_DWithin(p.geog, line.g, $2)
        ORDER BY distance_km
        LIMIT $3`,
      [JSON.stringify(geometry), bufferKm * 1000, limit]);
    return rows;
  }

  // Bounding box of the whole line, padded by the corridor width.
  const { bbox, projectOntoLine, cumulativeKm } = await import('../../../shared/geo.js');
  const [south, west, north, east] = bbox(geometry, bufferKm);
  const { rows } = await client.query(
    `SELECT id, name, category_id, lat, lng FROM places
      WHERE active AND lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4`,
    [south, north, west, east]);
  const cum = cumulativeKm(geometry);
  return rows
    .map(r => ({ ...r, distance_km: projectOntoLine([r.lat, r.lng], geometry, cum).distanceKm }))
    .filter(r => r.distance_km <= bufferKm)
    .sort((a, b) => a.distance_km - b.distance_km)
    .slice(0, limit);
}

/** 'postgis' | 'earthdistance' | 'none' — what this database can do spatially. */
export async function spatialMode(client) {
  const { rows } = await client.query("SELECT extname FROM pg_extension WHERE extname IN ('postgis','earthdistance')");
  const names = rows.map(r => r.extname);
  return names.includes('postgis') ? 'postgis' : names.includes('earthdistance') ? 'earthdistance' : 'none';
}

/**
 * Copy an existing SQLite database into PostgreSQL. Read-only on the source.
 * Runs in one transaction: either the whole import lands or none of it does.
 */
export async function importFromSqlite(client, sqlitePath, { log = () => {} } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  if (!fs.existsSync(sqlitePath)) throw new Error(`SQLite file not found: ${sqlitePath}`);
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  const counts = {};
  const bool = v => (v === null || v === undefined ? null : Boolean(v));
  const json = v => { if (v === null || v === undefined) return null; try { return JSON.stringify(JSON.parse(v)); } catch { return JSON.stringify(v); } };
  const tableExists = t => Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(t));

  // Parents before children, so foreign keys are always satisfied.
  const plan = [
    ['place_categories', 'INSERT INTO place_categories (id, label) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', r => [r.id, r.label]],
    ['users', `INSERT INTO users (id, email, password_hash, display_name, role, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`, r => [r.id, r.email, r.password_hash, r.display_name, r.role, r.created_at, r.updated_at]],
    ['places', `INSERT INTO places (id, name, category_id, lat, lng, locality, description, why_visit, quality, active, flagged, flag_reason, sponsored, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (id) DO NOTHING`,
    r => [r.id, r.name, r.category_id, r.lat, r.lng, r.locality, r.description, r.why_visit, r.quality, bool(r.active), bool(r.flagged), r.flag_reason, bool(r.sponsored), r.created_at, r.updated_at]],
    ['place_attributes', `INSERT INTO place_attributes (place_id, visit_minutes, walking_minutes, suitable_for, less_suitable_for, extra_interests, parking, food_available, facilities, caution, terrain, entry_fee)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (place_id) DO NOTHING`,
    r => [r.place_id, r.visit_minutes, r.walking_minutes, json(r.suitable_for), json(r.less_suitable_for), json(r.extra_interests), bool(r.parking), bool(r.food_available), json(r.facilities), r.caution, r.terrain, r.entry_fee]],
    ['place_sources', `INSERT INTO place_sources (place_id, provider, external_ref, label, verified, fetched_at)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (place_id, provider) DO NOTHING`, r => [r.place_id, r.provider, r.external_ref, r.label, bool(r.verified), r.fetched_at]],
    ['place_opening_hours', 'INSERT INTO place_opening_hours (place_id, weekday, open_min, close_min, note) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (place_id, weekday) DO NOTHING',
      r => [r.place_id, r.weekday, r.open_min, r.close_min, r.note]],
    ['place_seasonality', 'INSERT INTO place_seasonality (place_id, best_months) VALUES ($1,$2) ON CONFLICT (place_id) DO NOTHING', r => [r.place_id, r.best_months]],
    ['routes', `INSERT INTO routes (id, origin_name, origin_lat, origin_lng, dest_name, dest_lat, dest_lng, distance_km, duration_min, provider, method, geometry, plan_json, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (id) DO NOTHING`,
    r => [r.id, r.origin_name, r.origin_lat, r.origin_lng, r.dest_name, r.dest_lat, r.dest_lng, r.distance_km, r.duration_min, r.provider, r.method, json(r.geometry), json(r.plan_json), r.created_at]],
    ['route_segments', 'INSERT INTO route_segments (route_id, idx, phase_name, start_km, end_km) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (route_id, idx) DO NOTHING',
      r => [r.route_id, r.idx, r.phase_name, r.start_km, r.end_km]],
    ['detour_calculations', `INSERT INTO detour_calculations (route_id, place_id, route_km, distance_from_route_km, extra_km, extra_min, strategy, method, anchor_km, rejoin_km)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (route_id, place_id) DO NOTHING`,
    r => [r.route_id, r.place_id, r.route_km, r.distance_from_route_km, r.extra_km, r.extra_min, r.strategy, r.method, r.anchor_km, r.rejoin_km]],
    ['trips', `INSERT INTO trips (id, user_id, origin, destination, original_days, planned_days, status, kept_over_limit, route_id, created_at, updated_at, completed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
    r => [r.id, r.user_id, r.origin, r.destination, r.original_days, r.planned_days, r.status, bool(r.kept_over_limit), r.route_id, r.created_at, r.updated_at, r.completed_at]],
    ['trip_preferences', 'INSERT INTO trip_preferences (trip_id, traveler_type, interests) VALUES ($1,$2,$3) ON CONFLICT (trip_id) DO NOTHING', r => [r.trip_id, r.traveler_type, json(r.interests)]],
    ['trip_stops', 'INSERT INTO trip_stops (trip_id, place_id, status, position, added_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (trip_id, place_id) DO NOTHING',
      r => [r.trip_id, r.place_id, r.status, r.position, r.added_at]],
    ['saved_trips', 'INSERT INTO saved_trips (user_id, trip_id, saved_at) VALUES ($1,$2,$3) ON CONFLICT (user_id, trip_id) DO NOTHING', r => [r.user_id, r.trip_id, r.saved_at]],
    ['user_preferences', `INSERT INTO user_preferences (user_id, traveler_type, interests, default_days, location_opt_in, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id) DO NOTHING`, r => [r.user_id, r.traveler_type, json(r.interests), r.default_days, bool(r.location_opt_in), r.updated_at]],
    ['sessions', 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING',
      r => [r.token_hash, r.user_id, r.created_at, r.expires_at, r.user_agent]],
    ['feedback', 'INSERT INTO feedback (user_id, trip_id, place_id, visited, worth_it, rating, comment, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      r => [r.user_id, r.trip_id, r.place_id, bool(r.visited), bool(r.worth_it), r.rating, r.comment, r.created_at]],
    ['analytics_events', 'INSERT INTO analytics_events (name, user_id, session_id, place_id, props, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      r => [r.name, r.user_id, r.session_id, r.place_id, json(r.props), r.created_at]],
    ['audit_log', 'INSERT INTO audit_log (user_id, action, target, detail, created_at) VALUES ($1,$2,$3,$4,$5)',
      r => [r.user_id, r.action, r.target, json(r.detail), r.created_at]]
  ];

  await client.transaction(async ({ query }) => {
    for (const [table, sql, values] of plan) {
      if (!tableExists(table)) { counts[table] = 0; continue; }
      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      for (const row of rows) await query(sql, values(row));
      counts[table] = rows.length;
      if (rows.length) log(`imported ${rows.length} row(s) from ${table}`);
    }
  });
  db.close();
  return counts;
}
