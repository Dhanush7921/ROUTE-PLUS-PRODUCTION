-- ROUTE+ production schema — PostgreSQL 14+ with PostGIS 3+.
--
-- Table and column names are IDENTICAL to server/db/schema.sql (SQLite), so
-- moving between the two is a data copy, not a rewrite. What changes here:
--   • real types: TIMESTAMPTZ, BOOLEAN, JSONB, CITEXT-style case-insensitive email
--   • PostGIS geography columns, generated from the lat/lng the app already
--     writes, so nothing in the application has to know about them
--   • GiST spatial indexes for corridor and "places near me" queries
--
-- POSTGIS IS OPTIONAL. Every spatial object below is created only if the
-- extension is installed, so this same file runs on a managed PostgreSQL that
-- has no PostGIS — the app then falls back to the lat/lng btree index and the
-- distance maths in shared/geo.js, exactly as SQLite does. `db:pg status`
-- reports which mode a database is in.

-- ---------------------------------------------------------------- extensions
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'postgis') THEN
    CREATE EXTENSION IF NOT EXISTS postgis;
  ELSIF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'earthdistance') THEN
    CREATE EXTENSION IF NOT EXISTS cube;           -- earthdistance depends on cube
    CREATE EXTENSION IF NOT EXISTS earthdistance;  -- great-circle fallback
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());

-- ---------------------------------------------------------------- auth / users
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,          -- scrypt, same format as the SQLite layer
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'traveller' CHECK (role IN ('traveller', 'admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Case-insensitive uniqueness, matching SQLite's COLLATE NOCASE on email.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,         -- sha256 of the cookie; the raw token is never stored
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  traveler_type   TEXT,
  interests       JSONB NOT NULL DEFAULT '[]'::jsonb,
  default_days    INTEGER,
  location_opt_in BOOLEAN NOT NULL DEFAULT false,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- places
CREATE TABLE IF NOT EXISTS place_categories (
  id    TEXT PRIMARY KEY,
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS places (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES place_categories(id),
  lat         DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng         DOUBLE PRECISION NOT NULL CHECK (lng BETWEEN -180 AND 180),
  locality    TEXT,
  description TEXT,
  why_visit   TEXT,
  quality     REAL,
  active      BOOLEAN NOT NULL DEFAULT true,   -- admins can disable a place
  flagged     BOOLEAN NOT NULL DEFAULT false,  -- needs review
  flag_reason TEXT,
  sponsored   BOOLEAN NOT NULL DEFAULT false,  -- shown with a label; NEVER used in scoring
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS places_latlng ON places (lat, lng);
CREATE INDEX IF NOT EXISTS places_active ON places (active);
CREATE INDEX IF NOT EXISTS places_category ON places (category_id);

CREATE TABLE IF NOT EXISTS place_attributes (
  place_id          TEXT PRIMARY KEY REFERENCES places(id) ON DELETE CASCADE,
  visit_minutes     INTEGER,
  walking_minutes   INTEGER,
  suitable_for      JSONB,
  less_suitable_for JSONB,
  extra_interests   JSONB,
  parking           BOOLEAN,
  food_available    BOOLEAN,
  facilities        JSONB,
  caution           TEXT,
  terrain           TEXT,
  entry_fee         TEXT,
  -- Phase 4 place intelligence (0–1 fit scores)
  family_fit REAL, couple_fit REAL, solo_fit REAL, nature_fit REAL, devotional_fit REAL, photography_fit REAL,
  walking_difficulty REAL, practicality REAL, safety_note TEXT
);

CREATE TABLE IF NOT EXISTS place_sources (
  place_id     TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,          -- curated | openstreetmap | partner:…
  external_ref TEXT,
  label        TEXT,
  verified     BOOLEAN NOT NULL DEFAULT false,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (place_id, provider)
);
CREATE INDEX IF NOT EXISTS place_sources_provider ON place_sources (provider, external_ref);

CREATE TABLE IF NOT EXISTS place_opening_hours (
  place_id  TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  weekday   SMALLINT NOT NULL DEFAULT -1,   -- -1 = every day, 0 = Sunday … 6 = Saturday
  open_min  SMALLINT NOT NULL,
  close_min SMALLINT NOT NULL,
  note      TEXT,
  PRIMARY KEY (place_id, weekday)
);

CREATE TABLE IF NOT EXISTS place_seasonality (
  place_id    TEXT PRIMARY KEY REFERENCES places(id) ON DELETE CASCADE,
  best_months TEXT NOT NULL
);

-- ---------------------------------------------------------------- routes
CREATE TABLE IF NOT EXISTS routes (
  id           TEXT PRIMARY KEY,
  origin_name  TEXT NOT NULL, origin_lat DOUBLE PRECISION NOT NULL, origin_lng DOUBLE PRECISION NOT NULL,
  dest_name    TEXT NOT NULL, dest_lat   DOUBLE PRECISION NOT NULL, dest_lng   DOUBLE PRECISION NOT NULL,
  distance_km  REAL NOT NULL,
  duration_min REAL NOT NULL,
  provider     TEXT NOT NULL,          -- osrm | google-routes | offline-network
  method       TEXT NOT NULL,          -- road-network | estimated
  geometry     JSONB NOT NULL,         -- [[lat,lng],…] exactly as the app stores it
  plan_json    JSONB NOT NULL,         -- full JourneyPlan snapshot for restore
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS routes_created ON routes (created_at);
CREATE INDEX IF NOT EXISTS routes_provider ON routes (provider, method);

CREATE TABLE IF NOT EXISTS route_segments (
  route_id   TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  phase_name TEXT,
  start_km   REAL NOT NULL,
  end_km     REAL NOT NULL,
  PRIMARY KEY (route_id, idx)
);

CREATE TABLE IF NOT EXISTS detour_calculations (
  route_id               TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  place_id               TEXT NOT NULL,
  route_km               REAL NOT NULL,
  distance_from_route_km REAL NOT NULL,
  extra_km               REAL NOT NULL,
  extra_min              REAL NOT NULL,
  strategy               TEXT NOT NULL,   -- through | out-and-back
  method                 TEXT NOT NULL,   -- road-network | estimated  (never claimed, always recorded)
  anchor_km              REAL,
  rejoin_km              REAL,
  PRIMARY KEY (route_id, place_id)
);
CREATE INDEX IF NOT EXISTS detours_place ON detour_calculations (place_id);
CREATE INDEX IF NOT EXISTS detours_method ON detour_calculations (method);

CREATE TABLE IF NOT EXISTS recommendations (
  route_id    TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  place_id    TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  score       INTEGER NOT NULL,
  reasons     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (route_id, place_id, profile_key)
);

-- ---------------------------------------------------------------- trips
CREATE TABLE IF NOT EXISTS trips (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin          TEXT NOT NULL,
  destination     TEXT NOT NULL,
  original_days   INTEGER NOT NULL,
  planned_days    INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'completed', 'archived')),
  kept_over_limit BOOLEAN NOT NULL DEFAULT false,
  route_id        TEXT REFERENCES routes(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS trips_user ON trips (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS trips_route ON trips (route_id);

CREATE TABLE IF NOT EXISTS trip_preferences (
  trip_id       TEXT PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  traveler_type TEXT NOT NULL,
  interests     JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS trip_stops (
  trip_id  TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  place_id TEXT NOT NULL,
  status   TEXT NOT NULL CHECK (status IN ('selected', 'skipped', 'visited')),
  position INTEGER NOT NULL DEFAULT 0,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, place_id)
);
CREATE INDEX IF NOT EXISTS trip_stops_place ON trip_stops (place_id);

CREATE TABLE IF NOT EXISTS saved_trips (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id  TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, trip_id)
);

-- ---------------------------------------------------------------- feedback & analytics
CREATE TABLE IF NOT EXISTS feedback (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  trip_id    TEXT,
  place_id   TEXT NOT NULL,
  visited    BOOLEAN NOT NULL,
  worth_it   BOOLEAN,
  rating     SMALLINT CHECK (rating BETWEEN 1 AND 5),
  comment    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_place ON feedback (place_id);
CREATE INDEX IF NOT EXISTS feedback_user ON feedback (user_id);

CREATE TABLE IF NOT EXISTS analytics_events (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       TEXT NOT NULL,
  user_id    TEXT,
  session_id TEXT,
  place_id   TEXT,
  props      JSONB NOT NULL,          -- no personal data, no location history
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_name_time ON analytics_events (name, created_at);
CREATE INDEX IF NOT EXISTS events_place ON analytics_events (place_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_user_time ON audit_log (user_id, created_at);

-- ---------------------------------------------------------------- spatial
-- Created only where PostGIS is installed. The geography columns are GENERATED
-- from lat/lng, so the application keeps writing plain numbers and PostgreSQL
-- keeps the spatial index in step by itself — no dual-write to get out of sync.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    ALTER TABLE places ADD COLUMN IF NOT EXISTS geog GEOGRAPHY(POINT, 4326)
      GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) STORED;
    CREATE INDEX IF NOT EXISTS places_geog_gix ON places USING GIST (geog);

    ALTER TABLE routes ADD COLUMN IF NOT EXISTS origin_geog GEOGRAPHY(POINT, 4326)
      GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(origin_lng, origin_lat), 4326)::geography) STORED;
    ALTER TABLE routes ADD COLUMN IF NOT EXISTS dest_geog GEOGRAPHY(POINT, 4326)
      GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(dest_lng, dest_lat), 4326)::geography) STORED;
    -- The driven line itself. Filled by route_geom_sync from the stored
    -- [[lat,lng],…] geometry, because a LINESTRING cannot be a generated column.
    ALTER TABLE routes ADD COLUMN IF NOT EXISTS geog GEOGRAPHY(LINESTRING, 4326);
    CREATE INDEX IF NOT EXISTS routes_geog_gix ON routes USING GIST (geog);
    CREATE INDEX IF NOT EXISTS routes_origin_gix ON routes USING GIST (origin_geog);

    CREATE OR REPLACE FUNCTION route_geom_sync() RETURNS trigger AS $fn$
    BEGIN
      SELECT ST_SetSRID(ST_MakeLine(ARRAY(
               SELECT ST_MakePoint((p->>1)::float8, (p->>0)::float8)
               FROM jsonb_array_elements(NEW.geometry) AS p)), 4326)::geography
        INTO NEW.geog;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS routes_geom_sync ON routes;
    CREATE TRIGGER routes_geom_sync BEFORE INSERT OR UPDATE OF geometry ON routes
      FOR EACH ROW EXECUTE FUNCTION route_geom_sync();
  ELSE
    -- No PostGIS: keep a great-circle index when earthdistance is present, so
    -- "places near this point" is still index-backed.
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'earthdistance') THEN
      CREATE INDEX IF NOT EXISTS places_earth_gix ON places USING GIST (ll_to_earth(lat, lng));
    END IF;
  END IF;
END $$;
