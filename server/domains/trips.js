// TRIPS domain: My Trips, saved journeys, selected stops, trip history.
// Every query is scoped to the signed-in user (authorization by ownership).
//
// Supports both:
//   - SQLite: synchronous node:sqlite repository
//   - PostgreSQL: asynchronous pool/query repository
//
// Business rules and returned shapes are intentionally kept the same.

import { HttpError } from '../lib/http.js';
import { now, newId, tx, parseJson } from '../db/database.js';
import { INTERESTS, TRAVELERS } from '../../shared/taxonomy.js';

const MAX_PLAN_BYTES = 900_000;

function isPostgres(db) {
  return typeof db?.query === 'function';
}

function parseStoredJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function asBool(value) {
  return (
    value === true ||
    value === 1 ||
    value === '1' ||
    value === 't' ||
    value === 'true'
  );
}

function validateJourney(body) {
  const days = n => Number.isInteger(n) && n >= 1 && n <= 60;

  if (!body || typeof body !== 'object') {
    throw new HttpError(
      400,
      'INVALID_TRIP',
      'Trip data is missing.'
    );
  }

  const plan = body.plan;

  if (
    !plan ||
    !Array.isArray(plan.places) ||
    !plan.route ||
    !plan.origin ||
    !plan.destination
  ) {
    throw new HttpError(
      400,
      'INVALID_TRIP',
      'Trip needs a planned route.'
    );
  }

  if (
    !days(body.tripDays) ||
    !days(body.originalDays ?? body.tripDays)
  ) {
    throw new HttpError(
      400,
      'INVALID_TRIP',
      'Trip duration is invalid.'
    );
  }

  if (!TRAVELERS.includes(body.travelerType)) {
    throw new HttpError(
      400,
      'INVALID_TRIP',
      'Traveller type is invalid.'
    );
  }

  const interests = (body.interests || [])
    .filter(i => INTERESTS.includes(i));

  if (!interests.length) {
    throw new HttpError(
      400,
      'INVALID_TRIP',
      'Choose at least one interest.'
    );
  }

  const ids = new Set(
    plan.places.map(p => p.id)
  );

  const list = value => [
    ...new Set(
      (Array.isArray(value) ? value : [])
        .filter(id => ids.has(id))
    )
  ];

  const planJson = JSON.stringify(plan);

  if (planJson.length > MAX_PLAN_BYTES) {
    throw new HttpError(
      413,
      'PAYLOAD_TOO_LARGE',
      'This trip is too large to save.'
    );
  }

  return {
    plan,
    planJson,
    interests,
    selected: list(body.selectedStops),
    skipped: list(body.skippedPlaces)
  };
}

export function createTrips({ db, audit }) {
  const postgres = isPostgres(db);

  // ------------------------------------------------------------------
  // SQLite route persistence
  // ------------------------------------------------------------------
  function saveRouteSqlite(plan, planJson) {
    const id = plan.routeId || newId('rte');

    db.prepare(`
      INSERT OR REPLACE INTO routes (
        id,
        origin_name,
        origin_lat,
        origin_lng,
        dest_name,
        dest_lat,
        dest_lng,
        distance_km,
        duration_min,
        provider,
        method,
        geometry,
        plan_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      plan.origin.name,
      plan.origin.lat ?? 0,
      plan.origin.lng ?? 0,
      plan.destination.name,
      plan.destination.lat ?? 0,
      plan.destination.lng ?? 0,
      plan.route.distanceKm,
      plan.route.durationMin,
      plan.route.provider || 'unknown',
      plan.route.method || plan.mode || 'unknown',
      JSON.stringify(plan.route.geometry || []),
      planJson,
      now()
    );

    return id;
  }

  // ------------------------------------------------------------------
  // PostgreSQL route persistence
  // ------------------------------------------------------------------
  async function saveRoutePostgres(client, plan, planJson) {
    const id = plan.routeId || newId('rte');
    const timestamp = now();

    await client.query(`
      INSERT INTO routes (
        id,
        origin_name,
        origin_lat,
        origin_lng,
        dest_name,
        dest_lat,
        dest_lng,
        distance_km,
        duration_min,
        provider,
        method,
        geometry,
        plan_json,
        created_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13, $14
      )
      ON CONFLICT (id) DO UPDATE SET
        origin_name = EXCLUDED.origin_name,
        origin_lat = EXCLUDED.origin_lat,
        origin_lng = EXCLUDED.origin_lng,
        dest_name = EXCLUDED.dest_name,
        dest_lat = EXCLUDED.dest_lat,
        dest_lng = EXCLUDED.dest_lng,
        distance_km = EXCLUDED.distance_km,
        duration_min = EXCLUDED.duration_min,
        provider = EXCLUDED.provider,
        method = EXCLUDED.method,
        geometry = EXCLUDED.geometry,
        plan_json = EXCLUDED.plan_json
    `, [
      id,
      plan.origin.name,
      plan.origin.lat ?? 0,
      plan.origin.lng ?? 0,
      plan.destination.name,
      plan.destination.lat ?? 0,
      plan.destination.lng ?? 0,
      plan.route.distanceKm,
      plan.route.durationMin,
      plan.route.provider || 'unknown',
      plan.route.method || plan.mode || 'unknown',
      JSON.stringify(plan.route.geometry || []),
      planJson,
      timestamp
    ]);

    return id;
  }

  // ------------------------------------------------------------------
  // Read a complete saved trip
  // ------------------------------------------------------------------
  async function toJourney(trip) {
    if (!trip) {
      throw new HttpError(
        404,
        'NOT_FOUND',
        'Trip not found.'
      );
    }

    if (postgres) {
      const [
        routeResult,
        prefsResult,
        stopsResult
      ] = await Promise.all([
        db.query(
          'SELECT plan_json FROM routes WHERE id = $1',
          [trip.route_id]
        ),

        db.query(
          'SELECT * FROM trip_preferences WHERE trip_id = $1',
          [trip.id]
        ),

        db.query(
          'SELECT place_id, status FROM trip_stops WHERE trip_id = $1 ORDER BY position',
          [trip.id]
        )
      ]);

      const route = routeResult.rows[0];
      const prefs = prefsResult.rows[0];
      const stops = stopsResult.rows;

      return {
        id: trip.id,
        journeyId: trip.id,
        serverTripId: trip.id,
        origin: trip.origin,
        destination: trip.destination,
        tripDays: trip.planned_days,
        originalDays: trip.original_days,
        travelerType: prefs?.traveler_type,
        interests: parseStoredJson(
          prefs?.interests,
          []
        ),
        plan: parseStoredJson(
          route?.plan_json
        ),
        selectedStops: stops
          .filter(s => s.status !== 'skipped')
          .map(s => s.place_id),
        visitedStops: stops
          .filter(s => s.status === 'visited')
          .map(s => s.place_id),
        skippedPlaces: stops
          .filter(s => s.status === 'skipped')
          .map(s => s.place_id),
        keptOverLimit: asBool(
          trip.kept_over_limit
        ),
        status: trip.status,
        savedAt: trip.updated_at,
        completedAt: trip.completed_at
      };
    }

    const route = db.prepare(
      'SELECT plan_json FROM routes WHERE id = ?'
    ).get(trip.route_id);

    const prefs = db.prepare(
      'SELECT * FROM trip_preferences WHERE trip_id = ?'
    ).get(trip.id);

    const stops = db.prepare(
      'SELECT place_id, status FROM trip_stops WHERE trip_id = ? ORDER BY position'
    ).all(trip.id);

    return {
      id: trip.id,
      journeyId: trip.id,
      serverTripId: trip.id,
      origin: trip.origin,
      destination: trip.destination,
      tripDays: trip.planned_days,
      originalDays: trip.original_days,
      travelerType: prefs?.traveler_type,
      interests: parseJson(
        prefs?.interests,
        []
      ),
      plan: parseJson(
        route?.plan_json
      ),
      selectedStops: stops
        .filter(s => s.status !== 'skipped')
        .map(s => s.place_id),
      visitedStops: stops
        .filter(s => s.status === 'visited')
        .map(s => s.place_id),
      skippedPlaces: stops
        .filter(s => s.status === 'skipped')
        .map(s => s.place_id),
      keptOverLimit: Boolean(
        trip.kept_over_limit
      ),
      status: trip.status,
      savedAt: trip.updated_at,
      completedAt: trip.completed_at
    };
  }

  // ------------------------------------------------------------------
  // Ownership
  // ------------------------------------------------------------------
  async function own(user, id) {
    if (postgres) {
      const { rows } = await db.query(
        'SELECT * FROM trips WHERE id = $1 AND user_id = $2',
        [id, user.id]
      );

      const trip = rows[0];

      if (!trip) {
        throw new HttpError(
          404,
          'NOT_FOUND',
          'Trip not found.'
        );
      }

      return trip;
    }

    const trip = db.prepare(
      'SELECT * FROM trips WHERE id = ? AND user_id = ?'
    ).get(
      id,
      user.id
    );

    if (!trip) {
      throw new HttpError(
        404,
        'NOT_FOUND',
        'Trip not found.'
      );
    }

    return trip;
  }

  // ------------------------------------------------------------------
  // Save / update a trip
  // ------------------------------------------------------------------
  async function savePostgres(user, body) {
    const v = validateJourney(body);

    const result = await db.transaction(
      async client => {
        const existingResult = body.serverTripId
          ? await client.query(
              'SELECT * FROM trips WHERE id = $1 AND user_id = $2',
              [
                body.serverTripId,
                user.id
              ]
            )
          : { rows: [] };

        const existing =
          existingResult.rows[0] || null;

        const id =
          existing?.id ||
          newId('trp');

        const routeId =
          await saveRoutePostgres(
            client,
            {
              ...v.plan,
              routeId: existing?.route_id || v.plan.routeId
            },
            v.planJson
          );

        const originalDays =
          body.originalDays ??
          body.tripDays;

        const keptOverLimit =
          body.keptOverLimit ? true : false;

        if (existing) {
          await client.query(`
            UPDATE trips
            SET
              planned_days = $1,
              original_days = $2,
              kept_over_limit = $3,
              route_id = $4,
              updated_at = $5
            WHERE id = $6
          `, [
            body.tripDays,
            originalDays,
            keptOverLimit,
            routeId,
            now(),
            id
          ]);
        } else {
          const createdAt = now();
          const updatedAt = now();

          await client.query(`
            INSERT INTO trips (
              id,
              user_id,
              origin,
              destination,
              original_days,
              planned_days,
              status,
              kept_over_limit,
              route_id,
              created_at,
              updated_at
            )
            VALUES (
              $1, $2, $3, $4, $5,
              $6, $7, $8, $9, $10, $11
            )
          `, [
            id,
            user.id,
            v.plan.origin.name,
            v.plan.destination.name,
            originalDays,
            body.tripDays,
            'planned',
            keptOverLimit,
            routeId,
            createdAt,
            updatedAt
          ]);

          // Avoid depending on a specific unique-index definition.
          await client.query(
            'DELETE FROM saved_trips WHERE user_id = $1 AND trip_id = $2',
            [user.id, id]
          );

          await client.query(`
            INSERT INTO saved_trips (
              user_id,
              trip_id,
              saved_at
            )
            VALUES ($1, $2, $3)
          `, [
            user.id,
            id,
            now()
          ]);
        }

        // Replace preferences deterministically.
        await client.query(
          'DELETE FROM trip_preferences WHERE trip_id = $1',
          [id]
        );

        await client.query(`
          INSERT INTO trip_preferences (
            trip_id,
            traveler_type,
            interests
          )
          VALUES ($1, $2, $3)
        `, [
          id,
          body.travelerType,
          JSON.stringify(v.interests)
        ]);

        let visited = new Set();

        if (existing) {
          const visitedResult =
            await client.query(`
              SELECT place_id
              FROM trip_stops
              WHERE trip_id = $1
                AND status = 'visited'
            `, [id]);

          visited = new Set(
            visitedResult.rows.map(
              row => row.place_id
            )
          );
        }

        await client.query(
          'DELETE FROM trip_stops WHERE trip_id = $1',
          [id]
        );

        for (const [index, placeId] of
          v.selected.entries()) {

          await client.query(`
            INSERT INTO trip_stops (
              trip_id,
              place_id,
              status,
              position,
              added_at
            )
            VALUES ($1, $2, $3, $4, $5)
          `, [
            id,
            placeId,
            visited.has(placeId)
              ? 'visited'
              : 'selected',
            index,
            now()
          ]);
        }

        for (const [index, placeId] of
          v.skipped.entries()) {

          await client.query(`
            INSERT INTO trip_stops (
              trip_id,
              place_id,
              status,
              position,
              added_at
            )
            VALUES ($1, $2, $3, $4, $5)
          `, [
            id,
            placeId,
            'skipped',
            1000 + index,
            now()
          ]);
        }

        return {
          id,
          action: existing
            ? 'trip.update'
            : 'trip.create'
        };
      }
    );

    await audit(
      user.id,
      result.action,
      result.id
    );

    const { rows } = await db.query(
      'SELECT * FROM trips WHERE id = $1',
      [result.id]
    );

    return toJourney(rows[0]);
  }

  function saveSqlite(user, body) {
    const v = validateJourney(body);

    return tx(db, () => {
      const existing = body.serverTripId
        ? db.prepare(
            'SELECT * FROM trips WHERE id = ? AND user_id = ?'
          ).get(
            body.serverTripId,
            user.id
          )
        : null;

      const id =
        existing?.id ||
        newId('trp');

      const routeId = saveRouteSqlite(
        {
          ...v.plan,
          routeId: existing?.route_id || v.plan.routeId || v.plan.routeId
        },
        v.planJson
      );

      if (existing) {
        db.prepare(`
          UPDATE trips
          SET
            planned_days = ?,
            original_days = ?,
            kept_over_limit = ?,
            route_id = ?,
            updated_at = ?
          WHERE id = ?
        `).run(
          body.tripDays,
          body.originalDays ??
            body.tripDays,
          body.keptOverLimit
            ? 1
            : 0,
          routeId,
          now(),
          id
        );
      } else {
        db.prepare(`
          INSERT INTO trips (
            id,
            user_id,
            origin,
            destination,
            original_days,
            planned_days,
            status,
            kept_over_limit,
            route_id,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          user.id,
          v.plan.origin.name,
          v.plan.destination.name,
          body.originalDays ??
            body.tripDays,
          body.tripDays,
          'planned',
          body.keptOverLimit
            ? 1
            : 0,
          routeId,
          now(),
          now()
        );

        db.prepare(`
          INSERT INTO saved_trips (
            user_id,
            trip_id,
            saved_at
          )
          VALUES (?, ?, ?)
        `).run(
          user.id,
          id,
          now()
        );
      }

      db.prepare(`
        INSERT OR REPLACE INTO trip_preferences (
          trip_id,
          traveler_type,
          interests
        )
        VALUES (?, ?, ?)
      `).run(
        id,
        body.travelerType,
        JSON.stringify(v.interests)
      );

      const visited = new Set(
        existing
          ? db.prepare(`
              SELECT place_id
              FROM trip_stops
              WHERE trip_id = ?
                AND status = 'visited'
            `)
              .all(id)
              .map(row => row.place_id)
          : []
      );

      db.prepare(
        'DELETE FROM trip_stops WHERE trip_id = ?'
      ).run(id);

      const ins = db.prepare(`
        INSERT INTO trip_stops (
          trip_id,
          place_id,
          status,
          position,
          added_at
        )
        VALUES (?, ?, ?, ?, ?)
      `);

      v.selected.forEach(
        (placeId, index) =>
          ins.run(
            id,
            placeId,
            visited.has(placeId)
              ? 'visited'
              : 'selected',
            index,
            now()
          )
      );

      v.skipped.forEach(
        (placeId, index) =>
          ins.run(
            id,
            placeId,
            'skipped',
            1000 + index,
            now()
          )
      );

      const savedTrip =
        db.prepare(
          'SELECT * FROM trips WHERE id = ?'
        ).get(id);

      // SQLite audit is synchronous, but awaiting a non-Promise value
      // is harmless. This keeps the calling contract identical.
      audit(
        user.id,
        existing
          ? 'trip.update'
          : 'trip.create',
        id
      );

      return toJourney(savedTrip);
    });
  }

  // ------------------------------------------------------------------
  // Public domain API
  // ------------------------------------------------------------------
  return {
    async list(user) {
      if (postgres) {
        const { rows } = await db.query(`
          SELECT *
          FROM trips
          WHERE user_id = $1
            AND status != $2
          ORDER BY updated_at DESC
          LIMIT 100
        `, [
          user.id,
          'archived'
        ]);

        const output = [];

        for (const trip of rows) {
          const [
            prefsResult,
            countResult
          ] = await Promise.all([
            db.query(
              'SELECT traveler_type FROM trip_preferences WHERE trip_id = $1',
              [trip.id]
            ),

            db.query(`
              SELECT COUNT(*) AS n
              FROM trip_stops
              WHERE trip_id = $1
                AND status != 'skipped'
            `, [trip.id])
          ]);

          const prefs =
            prefsResult.rows[0];

          const count =
            Number(
              countResult.rows[0]?.n || 0
            );

          output.push({
            id: trip.id,
            journeyId: trip.id,
            origin: trip.origin,
            destination: trip.destination,
            tripDays: trip.planned_days,
            travelerType:
              prefs?.traveler_type,
            selectedStops:
              Array(count).fill(0),
            status: trip.status,
            savedAt: trip.updated_at
          });
        }

        return output;
      }

      return db.prepare(`
        SELECT *
        FROM trips
        WHERE user_id = ?
          AND status != ?
        ORDER BY updated_at DESC
        LIMIT 100
      `)
        .all(
          user.id,
          'archived'
        )
        .map(trip => {
          const prefs =
            db.prepare(
              'SELECT traveler_type FROM trip_preferences WHERE trip_id = ?'
            ).get(trip.id);

          const count =
            db.prepare(`
              SELECT COUNT(*) AS n
              FROM trip_stops
              WHERE trip_id = ?
                AND status != 'skipped'
            `).get(trip.id).n;

          return {
            id: trip.id,
            journeyId: trip.id,
            origin: trip.origin,
            destination: trip.destination,
            tripDays: trip.planned_days,
            travelerType:
              prefs?.traveler_type,
            selectedStops:
              Array(count).fill(0),
            status: trip.status,
            savedAt: trip.updated_at
          };
        });
    },

    async get(user, id) {
      const trip = await own(user, id);
      return toJourney(trip);
    },

    async save(user, body) {
      return postgres
        ? savePostgres(user, body)
        : saveSqlite(user, body);
    },

    async setStatus(user, id, status) {
      if (
        ![
          'planned',
          'active',
          'completed',
          'archived'
        ].includes(status)
      ) {
        throw new HttpError(
          400,
          'INVALID_STATUS',
          'Unknown trip status.'
        );
      }

      await own(user, id);

      if (postgres) {
        const completedAt =
          status === 'completed'
            ? now()
            : null;

        await db.query(`
          UPDATE trips
          SET
            status = $1,
            updated_at = $2,
            completed_at = $3
          WHERE id = $4
        `, [
          status,
          now(),
          completedAt,
          id
        ]);
      } else {
        db.prepare(`
          UPDATE trips
          SET
            status = ?,
            updated_at = ?,
            completed_at = ?
          WHERE id = ?
        `).run(
          status,
          now(),
          status === 'completed'
            ? now()
            : null,
          id
        );
      }

      return {
        ok: true,
        status
      };
    },

    async markVisited(user, id, placeId) {
      await own(user, id);

      if (postgres) {
        await db.query(`
          UPDATE trip_stops
          SET status = 'visited'
          WHERE trip_id = $1
            AND place_id = $2
        `, [
          id,
          placeId
        ]);
      } else {
        db.prepare(`
          UPDATE trip_stops
          SET status = 'visited'
          WHERE trip_id = ?
            AND place_id = ?
        `).run(
          id,
          placeId
        );
      }
    },

    async remove(user, id) {
      await own(user, id);

      if (postgres) {
        await db.query(
          'DELETE FROM trips WHERE id = $1',
          [id]
        );
      } else {
        db.prepare(
          'DELETE FROM trips WHERE id = ?'
        ).run(id);
      }

      await audit(
        user.id,
        'trip.delete',
        id
      );

      return {
        ok: true
      };
    },

    async history(user) {
      if (postgres) {
        const { rows } = await db.query(`
          SELECT
            id,
            origin,
            destination,
            planned_days AS "tripDays",
            completed_at AS "completedAt"
          FROM trips
          WHERE user_id = $1
            AND status = 'completed'
          ORDER BY completed_at DESC
        `, [
          user.id
        ]);

        return rows;
      }

      return db.prepare(`
        SELECT
          id,
          origin,
          destination,
          planned_days AS tripDays,
          completed_at AS completedAt
        FROM trips
        WHERE user_id = ?
          AND status = 'completed'
        ORDER BY completed_at DESC
      `).all(user.id);
    },

    async saveRoute(plan, planJson) {
      if (postgres) {
        return db.transaction(
          client =>
            saveRoutePostgres(
              client,
              plan,
              planJson
            )
        );
      }

      return saveRouteSqlite(
        plan,
        planJson
      );
    }
  };
}

export function createPreferences({ db }) {
  const postgres = isPostgres(db);

  return {
    async get(user) {
      if (postgres) {
        const { rows } =
          await db.query(`
            SELECT *
            FROM user_preferences
            WHERE user_id = $1
          `, [
            user.id
          ]);

        const p = rows[0];

        return {
          travelerType:
            p?.traveler_type || null,

          interests:
            parseStoredJson(
              p?.interests,
              []
            ),

          defaultDays:
            p?.default_days || null,

          locationOptIn:
            asBool(
              p?.location_opt_in
            )
        };
      }

      const p = db.prepare(`
        SELECT *
        FROM user_preferences
        WHERE user_id = ?
      `).get(user.id);

      return {
        travelerType:
          p?.traveler_type || null,

        interests:
          parseJson(
            p?.interests,
            []
          ),

        defaultDays:
          p?.default_days || null,

        locationOptIn:
          Boolean(
            p?.location_opt_in
          )
      };
    },

    async set(user, body) {
      const travelerType =
        body.travelerType == null
          ? null
          : TRAVELERS.includes(
              body.travelerType
            )
            ? body.travelerType
            : (() => {
                throw new HttpError(
                  400,
                  'INVALID_PREFERENCES',
                  'Unknown traveller type.'
                );
              })();

      const interests =
        Array.isArray(body.interests)
          ? [
              ...new Set(
                body.interests.filter(
                  i => INTERESTS.includes(i)
                )
              )
            ]
          : [];

      const days =
        Number.isInteger(
          body.defaultDays
        ) &&
        body.defaultDays > 0 &&
        body.defaultDays <= 60
          ? body.defaultDays
          : null;

      if (postgres) {
        // Deterministic replacement avoids depending on
        // the exact unique-index definition.
        await db.transaction(
          async client => {
            await client.query(
              'DELETE FROM user_preferences WHERE user_id = $1',
              [user.id]
            );

            await client.query(`
              INSERT INTO user_preferences (
                user_id,
                traveler_type,
                interests,
                default_days,
                location_opt_in,
                updated_at
              )
              VALUES ($1, $2, $3, $4, $5, $6)
            `, [
              user.id,
              travelerType,
              JSON.stringify(interests),
              days,
              Boolean(
                body.locationOptIn
              ),
              now()
            ]);
          }
        );

        return this.get(user);
      }

      db.prepare(`
        INSERT INTO user_preferences (
          user_id,
          traveler_type,
          interests,
          default_days,
          location_opt_in,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id)
        DO UPDATE SET
          traveler_type =
            excluded.traveler_type,
          interests =
            excluded.interests,
          default_days =
            excluded.default_days,
          location_opt_in =
            excluded.location_opt_in,
          updated_at =
            excluded.updated_at
      `).run(
        user.id,
        travelerType,
        JSON.stringify(
          interests
        ),
        days,
        body.locationOptIn
          ? 1
          : 0,
        now()
      );

      return this.get(user);
    }
  };
}