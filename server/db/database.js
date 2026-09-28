// Database access (SQLite via Node's built-in node:sqlite — no install needed).
// Opens the file, applies the schema, seeds reference data, and exposes small
// repository helpers. Every query uses parameters (no string-built SQL).

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CATEGORIES } from '../../shared/taxonomy.js';
import { CURATED_PLACES } from '../../shared/data/places.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const now = () => new Date().toISOString();
export const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
const j = v => (v === undefined || v === null ? null : JSON.stringify(v));
const pj = (v, d = null) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

export function openDatabase(file) {
  // A beta lives or dies on its storage, so say plainly what is wrong instead
  // of letting a raw EACCES/EROFS surface from deep inside the driver: the
  // usual cause is a container volume that is missing or not writable, and the
  // fix is a directory, not a code change.
  if (file !== ':memory:') {
    const dir = path.dirname(file);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (error) {
      const why = error.code === 'EACCES' || error.code === 'EPERM' ? 'is not writable by this user'
        : error.code === 'EROFS' ? 'is on a read-only filesystem'
        : `could not be created (${error.code || error.message})`;
      const problem = new Error(`The database directory ${dir} ${why}. ROUTE_PLUS_DB must point at a writable, persistent location (see docs/DEPLOY.md).`);
      problem.code = 'DB_NOT_WRITABLE';
      throw problem;
    }
  }
  // A writable directory is not enough. SQLite also needs a filesystem that
  // supports file locking, and several perfectly ordinary deployment choices do
  // not: a network share, a cloud-synced folder, or a mounted/FUSE drive. Those
  // fail deep inside the driver as "disk I/O error" or "unable to open database
  // file", which reads like a corrupt database and sends whoever is deploying
  // in the wrong direction. Name the real cause instead.
  let db;
  try {
    db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  } catch (error) {
    try { db?.close(); } catch { /* it never opened; nothing to close */ }
    const problem = new Error(`SQLite could not use ${file} (${error.message}). This usually means the location does not support database file locking — a network share, a cloud-synced folder or a mounted drive. Point ROUTE_PLUS_DB at a local, persistent disk (see docs/DEPLOY.md).`);
    problem.code = 'DB_UNAVAILABLE';
    problem.cause = error;
    throw problem;
  }
  db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = 1').get();
  if (!applied) {
    seed(db);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(now());
  }
  return db;
}

/** Run `fn` inside a transaction; roll back on any error. */
export function tx(db, fn) {
  db.exec('BEGIN');
  try { const out = fn(); db.exec('COMMIT'); return out; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

function seed(db) {
  tx(db, () => {
    const cat = db.prepare('INSERT OR IGNORE INTO place_categories (id, label) VALUES (?, ?)');
    for (const [id, c] of Object.entries(CATEGORIES)) cat.run(id, c.label);
    for (const p of CURATED_PLACES) upsertPlace(db, p);
  });
}

/** Insert or update one place from the ROUTE+ raw place shape. */
export function upsertPlace(db, p) {
  const t = now();
  db.prepare(`INSERT INTO places (id, name, category_id, lat, lng, locality, description, why_visit, quality, active, sponsored, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, category_id=excluded.category_id, lat=excluded.lat, lng=excluded.lng,
      locality=excluded.locality, description=excluded.description, why_visit=excluded.why_visit, quality=excluded.quality, updated_at=excluded.updated_at`)
    .run(p.id, p.name, p.category, p.lat, p.lng, p.locality ?? null, p.description ?? null, p.whyVisit ?? null, p.quality ?? null, p.sponsored ? 1 : 0, t, t);
  db.prepare(`INSERT OR REPLACE INTO place_attributes (place_id, visit_minutes, walking_minutes, suitable_for, less_suitable_for, extra_interests, parking, food_available, facilities, caution, terrain, entry_fee)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(p.id, p.visitDurationMinutes ?? null, p.walkingMinutes ?? null, j(p.suitableFor), j(p.lessSuitableFor), j(p.extraInterests),
      p.parking === undefined ? null : p.parking ? 1 : 0, p.foodAvailable === undefined ? null : p.foodAvailable ? 1 : 0,
      j(p.facilities), p.caution ?? null, p.terrain ?? null, p.entryFee ?? null);
  db.prepare('INSERT OR REPLACE INTO place_sources (place_id, provider, external_ref, label, verified, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(p.id, p.source?.provider || 'curated', p.source?.ref ?? null, p.source?.label ?? null, p.source?.verified ? 1 : 0, t);
  db.prepare('DELETE FROM place_opening_hours WHERE place_id = ?').run(p.id);
  if (p.openingHours) db.prepare('INSERT INTO place_opening_hours (place_id, weekday, open_min, close_min, note) VALUES (?, -1, ?, ?, ?)').run(p.id, p.openingHours.open, p.openingHours.close, p.closedNote ?? null);
  else if (p.closedNote) db.prepare('INSERT INTO place_opening_hours (place_id, weekday, open_min, close_min, note) VALUES (?, -2, 0, 0, ?)').run(p.id, p.closedNote);
  db.prepare('DELETE FROM place_seasonality WHERE place_id = ?').run(p.id);
  if (p.bestMonths) db.prepare('INSERT INTO place_seasonality (place_id, best_months) VALUES (?, ?)').run(p.id, p.bestMonths);
}

const PLACE_SELECT = `SELECT p.*, a.*, s.provider AS src_provider, s.label AS src_label, s.external_ref AS src_ref, s.verified AS src_verified,
  h.open_min, h.close_min, h.note AS hours_note, se.best_months
  FROM places p
  LEFT JOIN place_attributes a ON a.place_id = p.id
  LEFT JOIN place_sources s ON s.place_id = p.id
  LEFT JOIN place_opening_hours h ON h.place_id = p.id
  LEFT JOIN place_seasonality se ON se.place_id = p.id`;

/** DB row → the raw place shape the shared pipeline understands. */
export function rowToPlace(r) {
  const b = v => (v === null || v === undefined ? undefined : Boolean(v));
  return {
    id: r.id, name: r.name, category: r.category_id, lat: r.lat, lng: r.lng, locality: r.locality || '',
    description: r.description || undefined, whyVisit: r.why_visit || undefined, quality: r.quality ?? undefined,
    visitDurationMinutes: r.visit_minutes ?? undefined, walkingMinutes: r.walking_minutes ?? undefined,
    suitableFor: pj(r.suitable_for) ?? undefined, lessSuitableFor: pj(r.less_suitable_for) ?? undefined,
    extraInterests: pj(r.extra_interests) ?? undefined, parking: b(r.parking), foodAvailable: b(r.food_available),
    facilities: pj(r.facilities) ?? undefined, caution: r.caution || undefined, terrain: r.terrain || 'plain', entryFee: r.entry_fee || undefined,
    openingHours: r.open_min !== null && r.open_min !== undefined && r.close_min > r.open_min ? { open: r.open_min, close: r.close_min } : undefined,
    closedNote: r.hours_note || undefined, bestMonths: r.best_months || undefined,
    sponsored: Boolean(r.sponsored), active: Boolean(r.active), flagged: Boolean(r.flagged), flagReason: r.flag_reason || null,
    source: { provider: r.src_provider || 'curated', label: r.src_label || 'ROUTE+ curated list', ref: r.src_ref || undefined, verified: Boolean(r.src_verified) }
  };
}

export const placesRepo = db => ({
  listActive: () => db.prepare(`${PLACE_SELECT} WHERE p.active = 1`).all().map(rowToPlace),
  listAll: ({ q = '', limit = 200 } = {}) => db.prepare(`${PLACE_SELECT} WHERE p.name LIKE ? ORDER BY p.flagged DESC, p.name LIMIT ?`).all(`%${q}%`, limit).map(rowToPlace),
  get: id => { const r = db.prepare(`${PLACE_SELECT} WHERE p.id = ?`).get(id); return r ? rowToPlace(r) : null; },
  setActive: (id, active) => db.prepare('UPDATE places SET active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, now(), id).changes,
  flag: (id, reason) => db.prepare('UPDATE places SET flagged = 1, flag_reason = ?, updated_at = ? WHERE id = ?').run(reason, now(), id).changes,
  unflag: id => db.prepare('UPDATE places SET flagged = 0, flag_reason = NULL, updated_at = ? WHERE id = ?').run(now(), id).changes,
  update: (id, fields) => {
    const current = db.prepare(`${PLACE_SELECT} WHERE p.id = ?`).get(id);
    if (!current) return 0;
    upsertPlace(db, { ...rowToPlace(current), ...fields, id });
    return 1;
  },
  /** Bounding-box prefilter (index-backed); callers refine with exact distance. */
  near: ([lat, lng], radiusKm) => {
    const dLat = radiusKm / 111;
    const dLng = radiusKm / (111 * Math.cos(lat * Math.PI / 180));
    return db.prepare(`${PLACE_SELECT} WHERE p.active = 1 AND p.lat BETWEEN ? AND ? AND p.lng BETWEEN ? AND ?`)
      .all(lat - dLat, lat + dLat, lng - dLng, lng + dLng).map(rowToPlace);
  }
});

export { pj as parseJson };
