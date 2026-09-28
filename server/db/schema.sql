-- ROUTE+ relational schema (SQLite edition, used by the zero-install server).
-- The production PostgreSQL + PostGIS version is docs/postgis-schema.sql;
-- table and column names are identical so moving is a data migration only.
-- Geography here: lat/lng columns + indexes, distance maths in shared/geo.js.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

-- ---------------------------------------------------------------- auth / users
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'traveller' CHECK (role IN ('traveller', 'admin')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,            -- sha256 of the cookie value; the raw token is never stored
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  traveler_type  TEXT,
  interests      TEXT NOT NULL DEFAULT '[]',   -- JSON array
  default_days   INTEGER,
  location_opt_in INTEGER NOT NULL DEFAULT 0,  -- user allowed GPS features
  updated_at     TEXT NOT NULL
);

-- ---------------------------------------------------------------- places
CREATE TABLE IF NOT EXISTS place_categories (
  id     TEXT PRIMARY KEY,
  label  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS places (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  category_id     TEXT NOT NULL REFERENCES place_categories(id),
  lat             REAL NOT NULL,
  lng             REAL NOT NULL,
  locality        TEXT,
  description     TEXT,
  why_visit       TEXT,
  quality         REAL,
  active          INTEGER NOT NULL DEFAULT 1,  -- admins can disable a place
  flagged         INTEGER NOT NULL DEFAULT 0,  -- needs review (user reports, provider change)
  flag_reason     TEXT,
  sponsored       INTEGER NOT NULL DEFAULT 0,  -- displayed with a label; NEVER used in scoring
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS places_latlng ON places(lat, lng);
CREATE INDEX IF NOT EXISTS places_active ON places(active);

CREATE TABLE IF NOT EXISTS place_attributes (
  place_id   TEXT PRIMARY KEY REFERENCES places(id) ON DELETE CASCADE,
  visit_minutes     INTEGER,
  walking_minutes   INTEGER,
  suitable_for      TEXT,      -- JSON array
  less_suitable_for TEXT,      -- JSON array
  extra_interests   TEXT,      -- JSON array
  parking           INTEGER,
  food_available    INTEGER,
  facilities        TEXT,      -- JSON array
  caution           TEXT,
  terrain           TEXT,
  entry_fee         TEXT,
  -- Phase 4 place intelligence (0–1 fit scores, learned or curated)
  family_fit REAL, couple_fit REAL, solo_fit REAL, nature_fit REAL, devotional_fit REAL, photography_fit REAL,
  walking_difficulty REAL, practicality REAL, safety_note TEXT
);

CREATE TABLE IF NOT EXISTS place_sources (
  place_id   TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,       -- curated | openstreetmap | partner:…
  external_ref TEXT,
  label      TEXT,
  verified   INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (place_id, provider)
);

CREATE TABLE IF NOT EXISTS place_opening_hours (
  place_id  TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  weekday   INTEGER NOT NULL DEFAULT -1,   -- -1 = every day, 0 = Sunday … 6 = Saturday
  open_min  INTEGER NOT NULL,
  close_min INTEGER NOT NULL,
  note      TEXT,
  PRIMARY KEY (place_id, weekday)
);

CREATE TABLE IF NOT EXISTS place_seasonality (
  place_id    TEXT PRIMARY KEY REFERENCES places(id) ON DELETE CASCADE,
  best_months TEXT NOT NULL      -- human text, e.g. "Oct–Mar"
);

-- ---------------------------------------------------------------- trips
CREATE TABLE IF NOT EXISTS trips (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin         TEXT NOT NULL,
  destination    TEXT NOT NULL,
  original_days  INTEGER NOT NULL,
  planned_days   INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'completed', 'archived')),
  kept_over_limit INTEGER NOT NULL DEFAULT 0,
  route_id       TEXT REFERENCES routes(id),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  completed_at   TEXT
);
CREATE INDEX IF NOT EXISTS trips_user ON trips(user_id, updated_at);

CREATE TABLE IF NOT EXISTS trip_preferences (
  trip_id       TEXT PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  traveler_type TEXT NOT NULL,
  interests     TEXT NOT NULL      -- JSON array
);

CREATE TABLE IF NOT EXISTS trip_stops (
  trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  place_id   TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('selected', 'skipped', 'visited')),
  position   INTEGER NOT NULL DEFAULT 0,
  added_at   TEXT NOT NULL,
  PRIMARY KEY (trip_id, place_id)
);

CREATE TABLE IF NOT EXISTS saved_trips (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id   TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  saved_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, trip_id)
);

-- ---------------------------------------------------------------- routes & calculations
CREATE TABLE IF NOT EXISTS routes (
  id            TEXT PRIMARY KEY,
  origin_name   TEXT NOT NULL, origin_lat REAL NOT NULL, origin_lng REAL NOT NULL,
  dest_name     TEXT NOT NULL, dest_lat REAL NOT NULL, dest_lng REAL NOT NULL,
  distance_km   REAL NOT NULL,
  duration_min  REAL NOT NULL,
  provider      TEXT NOT NULL,
  method        TEXT NOT NULL,
  geometry      TEXT NOT NULL,     -- JSON [[lat,lng],…] (PostGIS: LINESTRING)
  plan_json     TEXT NOT NULL,     -- full JourneyPlan snapshot for restore
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS route_segments (
  route_id  TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  idx       INTEGER NOT NULL,
  phase_name TEXT,
  start_km  REAL NOT NULL,
  end_km    REAL NOT NULL,
  PRIMARY KEY (route_id, idx)
);

CREATE TABLE IF NOT EXISTS detour_calculations (
  route_id        TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  place_id        TEXT NOT NULL,
  route_km        REAL NOT NULL,
  distance_from_route_km REAL NOT NULL,
  extra_km        REAL NOT NULL,
  extra_min       REAL NOT NULL,
  strategy        TEXT NOT NULL,
  method          TEXT NOT NULL,
  anchor_km       REAL, rejoin_km REAL,
  PRIMARY KEY (route_id, place_id)
);

CREATE TABLE IF NOT EXISTS recommendations (
  route_id   TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  place_id   TEXT NOT NULL,
  profile_key TEXT NOT NULL,        -- traveller type + interests
  score      INTEGER NOT NULL,
  reasons    TEXT NOT NULL,         -- JSON
  created_at TEXT NOT NULL,
  PRIMARY KEY (route_id, place_id, profile_key)
);

-- ---------------------------------------------------------------- feedback & analytics
CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  trip_id    TEXT,
  place_id   TEXT NOT NULL,
  visited    INTEGER NOT NULL,
  worth_it   INTEGER,              -- 1 yes, 0 no, NULL not visited
  rating     INTEGER CHECK (rating BETWEEN 1 AND 5),
  comment    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_place ON feedback(place_id);

CREATE TABLE IF NOT EXISTS analytics_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  user_id    TEXT,
  session_id TEXT,
  place_id   TEXT,
  props      TEXT NOT NULL,        -- JSON, no personal data, no location history
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_name_time ON analytics_events(name, created_at);
CREATE INDEX IF NOT EXISTS events_place ON analytics_events(place_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   TEXT,
  action    TEXT NOT NULL,
  target    TEXT,
  detail    TEXT,
  created_at TEXT NOT NULL
);
