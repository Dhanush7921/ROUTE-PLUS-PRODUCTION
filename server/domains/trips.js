// TRIPS domain: My Trips, saved journeys, selected stops, trip history.
// Every query is scoped to the signed-in user (authorization by ownership).

import { HttpError } from '../lib/http.js';
import { now, newId, tx, parseJson } from '../db/database.js';
import { INTERESTS, TRAVELERS } from '../../shared/taxonomy.js';

const MAX_PLAN_BYTES = 900_000;

function validateJourney(body) {
  const days = n => Number.isInteger(n) && n >= 1 && n <= 60;
  if (!body || typeof body !== 'object') throw new HttpError(400, 'INVALID_TRIP', 'Trip data is missing.');
  const plan = body.plan;
  if (!plan || !Array.isArray(plan.places) || !plan.route || !plan.origin || !plan.destination) throw new HttpError(400, 'INVALID_TRIP', 'Trip needs a planned route.');
  if (!days(body.tripDays) || !days(body.originalDays ?? body.tripDays)) throw new HttpError(400, 'INVALID_TRIP', 'Trip duration is invalid.');
  if (!TRAVELERS.includes(body.travelerType)) throw new HttpError(400, 'INVALID_TRIP', 'Traveller type is invalid.');
  const interests = (body.interests || []).filter(i => INTERESTS.includes(i));
  if (!interests.length) throw new HttpError(400, 'INVALID_TRIP', 'Choose at least one interest.');
  const ids = new Set(plan.places.map(p => p.id));
  const list = v => [...new Set((Array.isArray(v) ? v : []).filter(id => ids.has(id)))];
  const planJson = JSON.stringify(plan);
  if (planJson.length > MAX_PLAN_BYTES) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'This trip is too large to save.');
  return { plan, planJson, interests, selected: list(body.selectedStops), skipped: list(body.skippedPlaces) };
}

export function createTrips({ db, audit }) {
  function saveRoute(plan, planJson) {
    const id = plan.routeId || newId('rte');
    db.prepare(`INSERT OR REPLACE INTO routes (id, origin_name, origin_lat, origin_lng, dest_name, dest_lat, dest_lng, distance_km, duration_min, provider, method, geometry, plan_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, plan.origin.name, plan.origin.lat ?? 0, plan.origin.lng ?? 0, plan.destination.name, plan.destination.lat ?? 0, plan.destination.lng ?? 0,
        plan.route.distanceKm, plan.route.durationMin, plan.route.provider || 'unknown', plan.route.method || plan.mode || 'unknown',
        JSON.stringify(plan.route.geometry || []), planJson, now());
    return id;
  }

  function toJourney(trip) {
    const route = db.prepare('SELECT plan_json FROM routes WHERE id = ?').get(trip.route_id);
    const prefs = db.prepare('SELECT * FROM trip_preferences WHERE trip_id = ?').get(trip.id);
    const stops = db.prepare('SELECT place_id, status FROM trip_stops WHERE trip_id = ? ORDER BY position').all(trip.id);
    return {
      id: trip.id,
      journeyId: trip.id,
      serverTripId: trip.id,
      origin: trip.origin,
      destination: trip.destination,
      tripDays: trip.planned_days,
      originalDays: trip.original_days,
      travelerType: prefs?.traveler_type,
      interests: parseJson(prefs?.interests, []),
      plan: parseJson(route?.plan_json),
      selectedStops: stops.filter(s => s.status !== 'skipped').map(s => s.place_id),
      visitedStops: stops.filter(s => s.status === 'visited').map(s => s.place_id),
      skippedPlaces: stops.filter(s => s.status === 'skipped').map(s => s.place_id),
      keptOverLimit: Boolean(trip.kept_over_limit),
      status: trip.status,
      savedAt: trip.updated_at,
      completedAt: trip.completed_at
    };
  }

  const own = (user, id) => {
    const trip = db.prepare('SELECT * FROM trips WHERE id = ? AND user_id = ?').get(id, user.id);
    if (!trip) throw new HttpError(404, 'NOT_FOUND', 'Trip not found.');
    return trip;
  };

  return {
    list(user) {
      return db.prepare('SELECT * FROM trips WHERE user_id = ? AND status != ? ORDER BY updated_at DESC LIMIT 100').all(user.id, 'archived').map(t => {
        const prefs = db.prepare('SELECT traveler_type FROM trip_preferences WHERE trip_id = ?').get(t.id);
        const count = db.prepare("SELECT COUNT(*) AS n FROM trip_stops WHERE trip_id = ? AND status != 'skipped'").get(t.id).n;
        return { id: t.id, journeyId: t.id, origin: t.origin, destination: t.destination, tripDays: t.planned_days, travelerType: prefs?.traveler_type, selectedStops: Array(count).fill(0), status: t.status, savedAt: t.updated_at };
      });
    },
    get: (user, id) => toJourney(own(user, id)),
    /** Create or update. If body.serverTripId belongs to the user it is updated. */
    save(user, body) {
      const v = validateJourney(body);
      return tx(db, () => {
        const existing = body.serverTripId ? db.prepare('SELECT * FROM trips WHERE id = ? AND user_id = ?').get(body.serverTripId, user.id) : null;
        const id = existing?.id || newId('trp');
        const routeId = saveRoute({ ...v.plan, routeId: existing?.route_id }, v.planJson);
        if (existing) {
          db.prepare('UPDATE trips SET planned_days = ?, original_days = ?, kept_over_limit = ?, route_id = ?, updated_at = ? WHERE id = ?')
            .run(body.tripDays, body.originalDays ?? body.tripDays, body.keptOverLimit ? 1 : 0, routeId, now(), id);
        } else {
          db.prepare('INSERT INTO trips (id, user_id, origin, destination, original_days, planned_days, status, kept_over_limit, route_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(id, user.id, v.plan.origin.name, v.plan.destination.name, body.originalDays ?? body.tripDays, body.tripDays, 'planned', body.keptOverLimit ? 1 : 0, routeId, now(), now());
          db.prepare('INSERT INTO saved_trips (user_id, trip_id, saved_at) VALUES (?, ?, ?)').run(user.id, id, now());
        }
        db.prepare('INSERT OR REPLACE INTO trip_preferences (trip_id, traveler_type, interests) VALUES (?, ?, ?)').run(id, body.travelerType, JSON.stringify(v.interests));
        const visited = new Set(existing ? db.prepare("SELECT place_id FROM trip_stops WHERE trip_id = ? AND status = 'visited'").all(id).map(r => r.place_id) : []);
        db.prepare('DELETE FROM trip_stops WHERE trip_id = ?').run(id);
        const ins = db.prepare('INSERT INTO trip_stops (trip_id, place_id, status, position, added_at) VALUES (?, ?, ?, ?, ?)');
        v.selected.forEach((pid, i) => ins.run(id, pid, visited.has(pid) ? 'visited' : 'selected', i, now()));
        v.skipped.forEach((pid, i) => ins.run(id, pid, 'skipped', 1000 + i, now()));
        audit(user.id, existing ? 'trip.update' : 'trip.create', id);
        return toJourney(db.prepare('SELECT * FROM trips WHERE id = ?').get(id));
      });
    },
    setStatus(user, id, status) {
      if (!['planned', 'active', 'completed', 'archived'].includes(status)) throw new HttpError(400, 'INVALID_STATUS', 'Unknown trip status.');
      own(user, id);
      db.prepare('UPDATE trips SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?').run(status, now(), status === 'completed' ? now() : null, id);
      return { ok: true, status };
    },
    markVisited(user, id, placeId) {
      own(user, id);
      db.prepare("UPDATE trip_stops SET status = 'visited' WHERE trip_id = ? AND place_id = ?").run(id, placeId);
    },
    remove(user, id) {
      own(user, id);
      db.prepare('DELETE FROM trips WHERE id = ?').run(id);
      audit(user.id, 'trip.delete', id);
      return { ok: true };
    },
    history: user => db.prepare("SELECT id, origin, destination, planned_days AS tripDays, completed_at AS completedAt FROM trips WHERE user_id = ? AND status = 'completed' ORDER BY completed_at DESC").all(user.id),
    saveRoute
  };
}

export function createPreferences({ db }) {
  return {
    get(user) {
      const p = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(user.id);
      return { travelerType: p?.traveler_type || null, interests: parseJson(p?.interests, []), defaultDays: p?.default_days || null, locationOptIn: Boolean(p?.location_opt_in) };
    },
    set(user, body) {
      const travelerType = body.travelerType == null ? null : TRAVELERS.includes(body.travelerType) ? body.travelerType : (() => { throw new HttpError(400, 'INVALID_PREFERENCES', 'Unknown traveller type.'); })();
      const interests = Array.isArray(body.interests) ? [...new Set(body.interests.filter(i => INTERESTS.includes(i)))] : [];
      const days = Number.isInteger(body.defaultDays) && body.defaultDays > 0 && body.defaultDays <= 60 ? body.defaultDays : null;
      db.prepare(`INSERT INTO user_preferences (user_id, traveler_type, interests, default_days, location_opt_in, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET traveler_type = excluded.traveler_type, interests = excluded.interests, default_days = excluded.default_days, location_opt_in = excluded.location_opt_in, updated_at = excluded.updated_at`)
        .run(user.id, travelerType, JSON.stringify(interests), days, body.locationOptIn ? 1 : 0, now());
      return this.get(user);
    }
  };
}
