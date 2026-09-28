# ROUTE+ databases — SQLite now, PostgreSQL + PostGIS for production

ROUTE+ ships with **two** database layers. Nothing forces you to choose early.

| | SQLite (default) | PostgreSQL (+ PostGIS) |
|---|---|---|
| Setup | none — a file appears | a server, a URL |
| Used by | the running server, today | migrations, seeding, import, spatial queries |
| Driver | Node's built-in `node:sqlite` | `server/db/pg/` — the wire protocol, written here, no npm packages |
| Spatial | lat/lng indexes + `shared/geo.js` maths | `geography(POINT,4326)` + GiST, or `earthdistance` when PostGIS is absent |
| Where | `server/db/schema.sql`, `server/db/database.js` | `server/db/pg/schema.sql`, `server/db/pg/migrate.js` |

**With no configuration ROUTE+ runs entirely on SQLite.** `npm test` and
`npm start` need no PostgreSQL and never contact one.

## Start a database locally

```bash
# Docker — the quickest way to get PostGIS as well
docker run --name routeplus-db -e POSTGRES_PASSWORD=devpassword \
  -e POSTGRES_USER=routeplus -e POSTGRES_DB=routeplus \
  -p 5432:5432 -d postgis/postgis:16-3.4

# …or an existing PostgreSQL
createdb routeplus && psql routeplus -c 'CREATE EXTENSION postgis;'
```

Then put the connection string in `.env` (never in source, never in chat):

```
DATABASE_URL=postgres://routeplus:devpassword@localhost:5432/routeplus?sslmode=disable
```

Managed services need `?sslmode=require`. `PGHOST` / `PGPORT` / `PGDATABASE` /
`PGUSER` / `PGPASSWORD` work instead of a URL.

## Commands

```bash
npm run db:pg -- status                 # reachable? what extensions? which migrations?
npm run db:pg -- migrate                # create/update the schema — safe to re-run
npm run db:pg -- seed                   # categories + the 120 curated places
npm run db:pg -- import                 # copy ./data/routeplus.sqlite in
npm run db:pg -- import path/to.sqlite  # …or another file
npm run db:pg -- verify                 # read rows back, including a spatial query
npm run db:pg -- rollback --yes         # DESTRUCTIVE: drop every ROUTE+ table
```

The password is never printed by any of these, never written to a log, and
never returned by the API. `scrubDsn()` removes it from error text before it
can be displayed.

## Is PostGIS required?

No. `schema.sql` asks PostgreSQL what it has:

* **PostGIS present** → `places.geog`, `routes.origin_geog`, `routes.dest_geog`
  are `GEOGRAPHY(POINT,4326)` columns **generated** from the lat/lng the
  application already writes, plus `routes.geog`, a `GEOGRAPHY(LINESTRING)`
  kept in step by the `routes_geom_sync` trigger. GiST indexes on all of them.
  Queries use `ST_DWithin` / `ST_Distance`.
* **PostGIS absent, `earthdistance` present** → a GiST index on
  `ll_to_earth(lat, lng)`; queries use `earth_box` / `earth_distance`.
* **Neither** → the lat/lng btree index and a bounding box, which is what
  SQLite does today.

`npm run db:pg -- status` prints which mode a database is in. The application
gets the same answers in all three; only the speed differs.

## Migration path, and how to undo it

Forward:

1. `npm run db:pg -- migrate` — creates tables, indexes and spatial objects.
   Idempotent: every statement is `IF NOT EXISTS`, and applied versions are
   recorded in `schema_migrations`.
2. `npm run db:pg -- import` — copies an existing SQLite database in one
   transaction, parents before children. Re-running imports nothing twice
   (`ON CONFLICT DO NOTHING`). Password hashes are **copied, never re-derived**,
   so existing logins keep working; roles, sessions, trips, feedback and the
   audit log come across unchanged.
3. `npm run db:pg -- verify` — reads rows back and runs a real spatial query.

Backward — three options, least destructive first:

* **Just stop using it.** Unset `DATABASE_URL`. SQLite is untouched by anything
  above; the import only ever reads it.
* **Drop the ROUTE+ tables:** `npm run db:pg -- rollback --yes`, which runs the
  SQL in `ROLLBACK_SQL` (`server/db/pg/migrate.js`) — children first, then
  parents, leaving extensions in place for other users of the server.
* **Drop the database**, if ROUTE+ owns it outright.

## What still runs on SQLite

The request path. `server/db/database.js` is synchronous (`node:sqlite`), and
every repository, domain and route handler calls it synchronously. PostgreSQL
is asynchronous, so serving requests from it means making that whole layer
`async` — a change to files this step was asked not to rewrite. The schema,
migrations, seed, import, spatial queries and connection layer are all real and
tested; the remaining work is threading `await` through the repositories.

## Tests

`npm test` never needs PostgreSQL — the PostgreSQL tests skip themselves. To
run them:

```bash
ROUTE_PLUS_PG_TEST_URL=postgres://routeplus:devpassword@localhost:5432/routeplus npm test
```

Each test creates its own throwaway database and drops it afterwards, so the
configured database is only used to create and drop, never written to.
