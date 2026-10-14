// INSIGHTS domain (Phases 3–4): feedback, analytics events, personalisation,
// weather context and admin reporting. Behaviour data is aggregated; no
// location history is ever stored.

import { HttpError } from '../lib/http.js';
import { now } from '../db/database.js';
import { EVENTS } from '../../shared/events.js';
import {
  categoryBoosts,
  placeFeedbackAdjustments
} from '../../shared/engine/personalize.js';
import { haversineKm } from '../../shared/geo.js';
import { runPlacePipeline } from '../../shared/engine/placePipeline.js';

const ALLOWED_PROPS = [
  'planId',
  'mode',
  'distanceKm',
  'candidates',
  'placeId',
  'category',
  'score',
  'extraMin',
  'extraKm',
  'from',
  'to',
  'days',
  'stops',
  'origin',
  'destination',
  'tripDays',
  'travelerType',
  'phaseId',
  'worth'
];

function cleanProps(props = {}) {
  const out = {};

  for (const key of ALLOWED_PROPS) {
    const v = props[key];

    if (
      typeof v === 'number' &&
      Number.isFinite(v)
    ) {
      out[key] = v;
    } else if (typeof v === 'string') {
      out[key] = v.slice(0, 80);
    }
  }

  return out;
}

function isPostgres(db) {
  return typeof db?.query === 'function';
}

function intValue(value) {
  return Number(value ?? 0);
}

export function createInsights({
  db,
  placesRepo,
  weather
}) {
  const postgres = isPostgres(db);

  return {
    async recordEvents(user, body) {
      const events = Array.isArray(body.events)
        ? body.events.slice(0, 100)
        : [];

      let stored = 0;

      for (const e of events) {
        if (!EVENTS.includes(e?.name)) {
          continue;
        }

        const props = cleanProps(e.props);
        const userId = user?.id ?? null;
        const sessionId = String(
          e.sessionId || ''
        ).slice(0, 40);
        const placeId =
          props.placeId ?? null;

        if (postgres) {
          await db.query(
            `INSERT INTO analytics_events
              (name, user_id, session_id, place_id, props, created_at)
             VALUES ($1, $2, $3, $4, $5, now())`,
            [
              e.name,
              userId,
              sessionId,
              placeId,
              JSON.stringify(props)
            ]
          );
        } else {
          db.prepare(
            `INSERT INTO analytics_events
              (name, user_id, session_id, place_id, props, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(
            e.name,
            userId,
            sessionId,
            placeId,
            JSON.stringify(props),
            now()
          );
        }

        stored++;
      }

      return { stored };
    },

    async recordFeedback(user, body) {
      const placeId = String(
        body.placeId || ''
      ).slice(0, 120);

      if (!placeId) {
        throw new HttpError(
          400,
          'INVALID_FEEDBACK',
          'Which place is this feedback for?'
        );
      }

      const visited =
        body.visited === true;

      const worth =
        body.worthIt === true
          ? 1
          : body.worthIt === false
            ? 0
            : null;

      const rating =
        Number.isInteger(body.rating) &&
        body.rating >= 1 &&
        body.rating <= 5
          ? body.rating
          : null;

      const tripId = body.tripId
        ? String(body.tripId).slice(0, 60)
        : null;

      const comment = body.comment
        ? String(body.comment).slice(0, 500)
        : null;

      const userId =
        user?.id ?? null;

      const worthText =
        worth === 1
          ? 'yes'
          : worth === 0
            ? 'no'
            : 'skipped';

      const eventProps =
        JSON.stringify({
          placeId,
          worth: worthText
        });

      if (postgres) {
        await db.query(
          `INSERT INTO feedback
            (user_id, trip_id, place_id, visited, worth_it, rating, comment, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
          [
            userId,
            tripId,
            placeId,
            visited,
            visited ? worth === 1
              ? true
              : worth === 0
                ? false
                : null
              : null,
            rating,
            comment
          ]
        );

        await db.query(
          `INSERT INTO analytics_events
            (name, user_id, place_id, props, created_at)
           VALUES ($1, $2, $3, $4, now())`,
          [
            'place_feedback',
            userId,
            placeId,
            eventProps
          ]
        );
      } else {
        db.prepare(
          `INSERT INTO feedback
            (user_id, trip_id, place_id, visited, worth_it, rating, comment, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          userId,
          tripId,
          placeId,
          visited ? 1 : 0,
          visited ? worth : null,
          rating,
          comment,
          now()
        );

        db.prepare(
          `INSERT INTO analytics_events
            (name, user_id, place_id, props, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(
          'place_feedback',
          userId,
          placeId,
          eventProps,
          now()
        );
      }

      return { ok: true };
    },

    /** Behaviour-based adjustments for one user + crowd feedback for places. */
    async personalization(user) {
      const byCategory = {};

      if (user) {
        let rows;

        if (postgres) {
          const result = await db.query(
            `SELECT
               name,
               props->>'category' AS category,
               COUNT(*)::int AS n
             FROM analytics_events
             WHERE user_id = $1
               AND name IN (
                 'discovery_added',
                 'discovery_skipped',
                 'discovery_removed'
               )
               AND props->>'category' IS NOT NULL
             GROUP BY name, props->>'category'`,
            [user.id]
          );

          rows = result.rows;
        } else {
          rows = db.prepare(
            `SELECT
               name,
               json_extract(props, '$.category') AS category,
               COUNT(*) AS n
             FROM analytics_events
             WHERE user_id = ?
               AND name IN (
                 'discovery_added',
                 'discovery_skipped',
                 'discovery_removed'
               )
               AND category IS NOT NULL
             GROUP BY name, category`
          ).all(user.id);
        }

        for (const r of rows) {
          const c =
            (byCategory[r.category] ||= {});

          c[
            {
              discovery_added: 'added',
              discovery_skipped: 'skipped',
              discovery_removed: 'removed'
            }[r.name]
          ] = intValue(r.n);
        }
      }

      let fb;

      if (postgres) {
        const result = await db.query(
          `SELECT
             place_id,
             SUM(
               CASE
                 WHEN worth_it IS TRUE THEN 1
                 ELSE NULL
               END
             )::int AS yes,
             SUM(
               CASE
                 WHEN worth_it IS FALSE THEN 1
                 ELSE NULL
               END
             )::int AS no
           FROM feedback
           WHERE visited IS TRUE
           GROUP BY place_id`
        );

        fb = result.rows;
      } else {
        fb = db.prepare(
          `SELECT
             place_id,
             SUM(worth_it = 1) AS yes,
             SUM(worth_it = 0) AS no
           FROM feedback
           WHERE visited = 1
           GROUP BY place_id`
        ).all();
      }

      const byPlace = Object.fromEntries(
        fb.map(r => [
          r.place_id,
          {
            yes: r.yes == null
              ? null
              : intValue(r.yes),
            no: r.no == null
              ? null
              : intValue(r.no)
          }
        ])
      );

      return {
        categories:
          categoryBoosts(byCategory),
        places:
          placeFeedbackAdjustments(byPlace)
      };
    },

    /** Weather per route phase (live provider only). */
    async context(body) {
      if (!weather) {
        return {
          available: false,
          phases: []
        };
      }

      const phases = (
        Array.isArray(body.phases)
          ? body.phases
          : []
      )
        .slice(0, 8)
        .filter(
          p =>
            Number.isFinite(p.lat) &&
            Number.isFinite(p.lng)
        );

      const out = [];

      for (const p of phases) {
        try {
          const days =
            await weather.forecast([
              p.lat,
              p.lng
            ]);

          out.push({
            phaseId: String(p.id),
            rainMm: Math.max(
              ...days.map(
                d => d.rainMm
              )
            ),
            days
          });
        } catch {
          // Weather is optional: skip this phase.
        }
      }

      return {
        available: true,
        phases: out
      };
    },

    /** GPS companion: active places near a point, nearest first (no location stored). */
    async near(lat, lng, radiusKm = 30) {
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        Math.abs(lat) > 90 ||
        Math.abs(lng) > 180
      ) {
        throw new HttpError(
          400,
          'INVALID_LOCATION',
          'Invalid coordinates.'
        );
      }

      const r = Math.min(
        Math.max(radiusKm, 1),
        80
      );

      const nearby =
        await placesRepo.near(
          [lat, lng],
          r
        );

      return runPlacePipeline(nearby)
        .map(p => ({
          ...p,
          distanceKm:
            Math.round(
              haversineKm(
                [lat, lng],
                [p.lat, p.lng]
              ) * 10
            ) / 10
        }))
        .filter(
          p => p.distanceKm <= r
        )
        .sort(
          (a, b) =>
            a.distanceKm -
            b.distanceKm
        )
        .slice(0, 30);
    },

    /** Admin: product metrics answering "do travellers value route discovery?" */
    async productMetrics(days = 30) {
      const since =
        new Date(
          Date.now() -
            days * 86400_000
        ).toISOString();

      const counts =
        Object.fromEntries(
          EVENTS.map(
            e => [e, 0]
          )
        );

      let eventRows;

      if (postgres) {
        const result = await db.query(
          `SELECT
             name,
             COUNT(*)::int AS n
           FROM analytics_events
           WHERE created_at >= $1
           GROUP BY name`,
          [since]
        );

        eventRows = result.rows;
      } else {
        eventRows = db.prepare(
          `SELECT
             name,
             COUNT(*) AS n
           FROM analytics_events
           WHERE created_at >= ?
           GROUP BY name`
        ).all(since);
      }

      for (const r of eventRows) {
        counts[r.name] =
          intValue(r.n);
      }

      const rate = (a, b) =>
        b
          ? Math.round(
              (a / b) * 1000
            ) / 10
          : 0;

      let repeat;
      let users;

      if (postgres) {
        const repeatResult =
          await db.query(
            `SELECT COUNT(*)::int AS n
             FROM (
               SELECT user_id
               FROM trips
               GROUP BY user_id
               HAVING COUNT(*) > 1
             ) repeat_users`
          );

        repeat =
          intValue(
            repeatResult.rows[0]?.n
          );

        const usersResult =
          await db.query(
            `SELECT COUNT(*)::int AS n
             FROM users`
          );

        users =
          intValue(
            usersResult.rows[0]?.n
          );
      } else {
        repeat =
          intValue(
            db.prepare(
              `SELECT COUNT(*) AS n
               FROM (
                 SELECT user_id
                 FROM trips
                 GROUP BY user_id
                 HAVING COUNT(*) > 1
               )`
            ).get().n
          );

        users =
          intValue(
            db.prepare(
              'SELECT COUNT(*) AS n FROM users'
            ).get().n
          );
      }

      return {
        windowDays: days,
        counts,
        funnel: {
          openRate: rate(
            counts.discovery_opened,
            counts.discovery_seen ||
              counts.route_generated
          ),
          addRate: rate(
            counts.discovery_added,
            counts.discovery_seen
          ),
          skipRate: rate(
            counts.discovery_skipped,
            counts.discovery_opened +
              counts.discovery_skipped
          ),
          removeAfterAdd: rate(
            counts.discovery_removed,
            counts.discovery_added
          ),
          extensionRate: rate(
            counts.trip_extended,
            counts.route_generated
          ),
          saveRate: rate(
            counts.trip_saved,
            counts.route_generated
          )
        },
        users,
        repeatTravellers: repeat
      };
    },

    /** Admin: which places earn their spot (added vs skipped vs feedback). */
    async placePerformance(limit = 50) {
      if (postgres) {
        const result = await db.query(
          `SELECT
             p.id,
             p.name,
             p.category_id AS category,
             p.active,
             p.flagged,

             SUM(
               CASE
                 WHEN e.name = 'discovery_opened'
                 THEN 1
                 ELSE NULL
               END
             )::int AS opened,

             SUM(
               CASE
                 WHEN e.name = 'discovery_added'
                 THEN 1
                 ELSE NULL
               END
             )::int AS added,

             SUM(
               CASE
                 WHEN e.name = 'discovery_skipped'
                 THEN 1
                 ELSE NULL
               END
             )::int AS skipped,

             SUM(
               CASE
                 WHEN e.name = 'discovery_removed'
                 THEN 1
                 ELSE NULL
               END
             )::int AS removed,

             (
               SELECT SUM(
                 CASE
                   WHEN f.worth_it IS TRUE
                   THEN 1
                   ELSE NULL
                 END
               )::int
               FROM feedback f
               WHERE f.place_id = p.id
             ) AS "worthYes",

             (
               SELECT SUM(
                 CASE
                   WHEN f.worth_it IS FALSE
                   THEN 1
                   ELSE NULL
                 END
               )::int
               FROM feedback f
               WHERE f.place_id = p.id
             ) AS "worthNo"

           FROM places p
           LEFT JOIN analytics_events e
             ON e.place_id = p.id

           GROUP BY
             p.id,
             p.name,
             p.category_id,
             p.active,
             p.flagged

            ORDER BY
              (
                COUNT(*) FILTER (WHERE e.name = 'discovery_added') +
                COUNT(*) FILTER (WHERE e.name = 'discovery_skipped') +
                COUNT(*) FILTER (WHERE e.name = 'discovery_opened')
              ) DESC,
              p.name

           LIMIT $1`,
          [limit]
        );

        // SQLite returns 1/0 for p.active and p.flagged; PostgreSQL returns
        // native booleans. The admin API has always exposed the SQLite shape,
        // so normalise rather than making every consumer handle both.
        return result.rows.map(r => ({
          ...r,
          active: r.active ? 1 : 0,
          flagged: r.flagged ? 1 : 0
        }));
      }

      return db.prepare(
        `SELECT
           p.id,
           p.name,
           p.category_id AS category,
           p.active,
           p.flagged,

           SUM(
             e.name = 'discovery_opened'
           ) AS opened,

           SUM(
             e.name = 'discovery_added'
           ) AS added,

           SUM(
             e.name = 'discovery_skipped'
           ) AS skipped,

           SUM(
             e.name = 'discovery_removed'
           ) AS removed,

           (
             SELECT SUM(
               worth_it = 1
             )
             FROM feedback f
             WHERE f.place_id = p.id
           ) AS worthYes,

           (
             SELECT SUM(
               worth_it = 0
             )
             FROM feedback f
             WHERE f.place_id = p.id
           ) AS worthNo

         FROM places p
         LEFT JOIN analytics_events e
           ON e.place_id = p.id

         GROUP BY p.id

         ORDER BY
           (COUNT(*) FILTER (WHERE e.name = 'discovery_added') + COUNT(*) FILTER (WHERE e.name = 'discovery_skipped') + COUNT(*) FILTER (WHERE e.name = 'discovery_opened')) DESC,
           p.name

         LIMIT ?`
      ).all(limit);
    },

    async recentFeedback(limit = 50) {
      if (postgres) {
        const result = await db.query(
          `SELECT
             f.*,
             p.name AS place_name
           FROM feedback f
           LEFT JOIN places p
             ON p.id = f.place_id
           ORDER BY f.id DESC
           LIMIT $1`,
          [limit]
        );

        // visited and worth_it are BOOLEAN here and 1/0/NULL on SQLite. The
        // admin page tests `worth_it === 1`, so a raw boolean silently renders
        // every answer as "unknown". Return the shape the API has always had.
        return result.rows.map(r => ({
          ...r,
          visited: r.visited ? 1 : 0,
          worth_it: r.worth_it == null ? null : r.worth_it ? 1 : 0
        }));
      }

      return db.prepare(
        `SELECT
           f.*,
           p.name AS place_name
         FROM feedback f
         LEFT JOIN places p
           ON p.id = f.place_id
         ORDER BY f.id DESC
         LIMIT ?`
      ).all(limit);
    }
  };
}
