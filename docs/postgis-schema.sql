-- SUPERSEDED: this early sketch is kept for reference only.
-- The real, runnable schema is server/db/pg/schema.sql (see docs/DATABASE.md).
-- ROUTE+ production schema for PostgreSQL 15+ with PostGIS 3+.
-- Same tables and columns as server/db/schema.sql (SQLite), plus real
-- geography types and spatial indexes. Moving from SQLite = copy the rows,
-- then fill the geography columns from lat/lng (see bottom of this file).

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id TEXT PRIMARY KEY, email CITEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'traveller' CHECK (role IN ('traveller', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL, user_agent TEXT
);
CREATE INDEX ON sessions (user_id);
CREATE TABLE user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, traveler_type TEXT, interests JSONB NOT NULL DEFAULT '[]',
  default_days INT, location_opt_in BOOLEAN NOT NULL DEFAULT false, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE place_categories (id TEXT PRIMARY KEY, label TEXT NOT NULL);
CREATE TABLE places (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, category_id TEXT NOT NULL REFERENCES place_categories(id),
  lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL,
  geog GEOGRAPHY(POINT, 4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) STORED,
  locality TEXT, description TEXT, why_visit TEXT, quality REAL,
  active BOOLEAN NOT NULL DEFAULT true, flagged BOOLEAN NOT NULL DEFAULT false, flag_reason TEXT,
  sponsored BOOLEAN NOT NULL DEFAULT false,            -- display label only; never used in ranking
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX places_geog_gix ON places USING GIST (geog);
CREATE INDEX ON places (active);
CREATE TABLE place_attributes (
  place_id TEXT PRIMARY KEY REFERENCES places(id) ON DELETE CASCADE,
  visit_minutes INT, walking_minutes INT, suitable_for JSONB, less_suitable_for JSONB, extra_interests JSONB,
  parking BOOLEAN, food_available BOOLEAN, facilities JSONB, caution TEXT, terrain TEXT, entry_fee TEXT,
  family_fit REAL, couple_fit REAL, solo_fit REAL, nature_fit REAL, devotional_fit REAL, photography_fit REAL,
  walking_difficulty REAL, practicality REAL, safety_note TEXT
);
CREATE TABLE place_sources (
  place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE, provider TEXT NOT NULL, external_ref TEXT, label TEXT,
  verified BOOLEAN NOT NULL DEFAULT false, fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (place_id, provider)
);
CREATE TABLE place_opening_hours (
  place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE, weekday SMALLINT NOT NULL DEFAULT -1,
  open_min SMALLINT NOT NULL, close_min SMALLINT NOT NULL, note TEXT, PRIMARY KEY (place_id, weekday)
);
CREATE TABLE place_seasonality (place_id TEXT PRIMARY KEY REFERENCES places(id) ON DELETE CASCADE, best_months TEXT NOT NULL);

CREATE TABLE routes (
  id TEXT PRIMARY KEY, origin_name TEXT NOT NULL, origin_lat DOUBLE PRECISION, origin_lng DOUBLE PRECISION,
  dest_name TEXT NOT NULL, dest_lat DOUBLE PRECISION, dest_lng DOUBLE PRECISION,
  distance_km REAL NOT NULL, duration_min REAL NOT NULL, provider TEXT NOT NULL, method TEXT NOT NULL,
  geometry JSONB NOT NULL, geom GEOGRAPHY(LINESTRING, 4326), plan_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX routes_geom_gix ON routes USING GIST (geom);
CREATE TABLE route_segments (route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE, idx INT NOT NULL, phase_name TEXT, start_km REAL, end_km REAL, PRIMARY KEY (route_id, idx));
CREATE TABLE detour_calculations (
  route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE, place_id TEXT NOT NULL, route_km REAL NOT NULL,
  distance_from_route_km REAL NOT NULL, extra_km REAL NOT NULL, extra_min REAL NOT NULL, strategy TEXT NOT NULL, method TEXT NOT NULL,
  anchor_km REAL, rejoin_km REAL, PRIMARY KEY (route_id, place_id)
);
CREATE TABLE recommendations (
  route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE, place_id TEXT NOT NULL, profile_key TEXT NOT NULL,
  score INT NOT NULL, reasons JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (route_id, place_id, profile_key)
);

CREATE TABLE trips (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, origin TEXT NOT NULL, destination TEXT NOT NULL,
  original_days INT NOT NULL, planned_days INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'completed', 'archived')),
  kept_over_limit BOOLEAN NOT NULL DEFAULT false, route_id TEXT REFERENCES routes(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ
);
CREATE INDEX ON trips (user_id, updated_at DESC);
CREATE TABLE trip_preferences (trip_id TEXT PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE, traveler_type TEXT NOT NULL, interests JSONB NOT NULL);
CREATE TABLE trip_stops (
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE, place_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('selected', 'skipped', 'visited')), position INT NOT NULL DEFAULT 0,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (trip_id, place_id)
);
CREATE TABLE saved_trips (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE, saved_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (user_id, trip_id));

CREATE TABLE feedback (
  id BIGSERIAL PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE SET NULL, trip_id TEXT, place_id TEXT NOT NULL,
  visited BOOLEAN NOT NULL, worth_it BOOLEAN, rating SMALLINT CHECK (rating BETWEEN 1 AND 5), comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON feedback (place_id);
CREATE TABLE analytics_events (
  id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, user_id TEXT, session_id TEXT, place_id TEXT,
  props JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON analytics_events (name, created_at);
CREATE INDEX ON analytics_events (place_id);
CREATE TABLE daily_metrics (day DATE NOT NULL, name TEXT NOT NULL, count INT NOT NULL, PRIMARY KEY (day, name));
CREATE TABLE audit_log (id BIGSERIAL PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, target TEXT, detail JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now());

-- ---------------------------------------------------------------------------
-- The corridor query PostGIS makes fast (replaces the JS bbox + projection):
--   SELECT p.* FROM places p, routes r
--   WHERE r.id = $1 AND p.active
--     AND ST_DWithin(p.geog, r.geom, $2 * 1000)          -- within $2 km of the route
--   ORDER BY ST_LineLocatePoint(r.geom::geometry, p.geog::geometry);  -- in travel order
--
-- After importing SQLite rows, build route lines once:
--   UPDATE routes SET geom = ST_SetSRID(ST_MakeLine(ARRAY(
--     SELECT ST_MakePoint((pt->>1)::float, (pt->>0)::float) FROM jsonb_array_elements(geometry) pt)), 4326)::geography;
