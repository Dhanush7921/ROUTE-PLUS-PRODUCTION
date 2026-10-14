# ROUTE+ — production runbook

Verified on 28 September 2026 against this exact source tree.

## Verified results

| Check | Command | Result |
|---|---|---|
| Production build | `npm run build` | PASS — 34 modules, 541 KB standalone |
| Unit + integration | `npm test` | PASS — 109 tests, 104 passed, 0 failed, 5 skipped (PostgreSQL needs a server) |
| Beta readiness walk | `npm run check:beta` | PASS — 19 flows, 0 failed |
| Browser tests | `npm run test:e2e` | PASS — 19 tests, 0 failed |
| Live API (running instance) | `node verify-prod.mjs` | PASS — 20 checks: route, phases, places, detour, save, reopen, ownership, errors |
| Database | SQLite | PASS — 21 tables, migration 1 applied, 120 places seeded, trips/routes/detours persisted |

## Start it

1. `copy .env.production.example .env` and edit it.
2. `start-production.cmd` (validates the configuration, then starts the server).
3. Open `http://localhost:8080` — the health endpoint is `/api/health`.

The server refuses to start on a configuration that cannot work, and names the
problem. `npm run check:beta` runs the same validation plus every user flow.

## Two things that must be right

**The database must be on local disk.** Not a network share, not OneDrive or
Dropbox, not a mounted drive. SQLite needs file locking; those filesystems
cannot do it, and startup fails with `DB_UNAVAILABLE`. This was hit for real on
this machine: the project folder is a mounted drive, so `ROUTE_PLUS_DB` must
point somewhere like `C:\routeplus-data\`.

**HTTPS before real testers.** With `PUBLIC_URL=http://…` in production the app
starts but warns: sessions travel unencrypted. Put it behind HTTPS (a reverse
proxy, or a host that terminates TLS) and set `PUBLIC_URL=https://…`, which
turns on Secure cookies, HSTS and the same-origin check for writes.

## Choosing the database

ROUTE+ serves requests from SQLite **or** PostgreSQL. `ROUTE_PLUS_DB_MODE` is
the only thing that decides which; filling in the PG variables does not switch
it. Leave it unset (or `sqlite`) and `ROUTE_PLUS_DB` is the live database.

To move to PostgreSQL:

1. `npm run db:pg -- status` — confirms the connection, the server version and
   which spatial support is installed (PostGIS, earthdistance, or neither).
2. `npm run db:pg -- migrate` then `npm run db:pg -- seed`.
3. `npm run db:pg -- import` if an existing SQLite database should be copied in.
4. Set `ROUTE_PLUS_DB_MODE=postgres` and restart.
5. `GET /api/health` must report `"database": "ok"`, and the startup log line
   `postgres` now reports `servingRequests: postgres`.

The hourly maintenance jobs (expired sessions, daily metric roll-up, place
review) run in-process on both backends. `npm run worker` runs the same jobs
against whichever backend `ROUTE_PLUS_DB_MODE` selects, for a cron schedule.

## Backup and restore

Both commands follow `ROUTE_PLUS_DB_MODE`. You do not pass the backend, and you
cannot back up the wrong one by forgetting to.

```bash
npm run db:backup                              # → ./backups/routeplus-<stamp>.sqlite  (sqlite)
                                               # → ./backups/routeplus-<stamp>.dump    (postgres)
npm run db:backup -- /mnt/backups              # somewhere off this machine

npm run db:restore:verify                      # verify the newest backup
npm run db:restore:verify -- ./backups/x.dump   # verify a specific one
npm run db:restore:verify -- --keep            # leave the scratch database for inspection
```

Every backup is timestamped, is **never** written over an existing one, and gets
a sidecar `<file>.json` manifest recording its size, SHA-256, schema version,
extensions and per-table row counts. The manifest is what makes verification an
equality check rather than a guess. Passwords are never printed, never stored in
the manifest, and never placed on a command line — `pg_dump` receives them
through its environment, where `ps` cannot read them.

| | SQLite | PostgreSQL |
|---|---|---|
| Tool | `VACUUM INTO` | `pg_dump --format=custom` |
| File | `routeplus-<stamp>.sqlite` | `routeplus-<stamp>.dump` |
| Safe while serving | yes | yes |
| Row counts in the manifest | exact | exact — read inside pg_dump's own snapshot (`pg_export_snapshot`) |
| Needs external tools | no | `pg_dump` + `pg_restore`, **not older than the server** |
| Restore | stop ROUTE+, copy the file over `ROUTE_PLUS_DB`, delete `-wal` / `-shm`, start | `pg_restore` into a database (see below) |

If the client tools are missing, the backup fails with exit code **3** and says
how to install them. If they are installed but not on `PATH` — the usual case on
Windows, and when PostgreSQL only exists inside Docker — name the binaries
instead of installing anything:

```
set PG_DUMP=C:\Program Files\PostgreSQL\16\bin\pg_dump.exe
set PG_RESTORE=C:\Program Files\PostgreSQL\16\bin\pg_restore.exe
``` It does not write a partial file: a PostgreSQL dump is
written as `.dump.part` and only renamed once `pg_dump` has succeeded, so nothing
in `backups/` is ever a truncated file that looks usable.

### Test restore procedure

`npm run db:restore:verify` is the whole procedure, and it is safe to run against
production credentials because it never restores into the production database:

1. Checks the file against the size and SHA-256 in its manifest.
2. Creates `routeplus_restorecheck_<pid>_<stamp>` — a fresh, disposable database.
3. `pg_restore --no-owner --no-privileges --exit-on-error` into that database.
4. Verifies: every extension the source had is present; the schema version
   matches; `users`, `places`, `routes`, `trips`, `feedback` and
   `analytics_events` all exist and hold **exactly** the row counts the manifest
   recorded; no trip lost its owner; and a real "places near me" query runs on
   the restored rows in the same spatial mode the source used.
5. Drops the disposable database again (keep it with `--keep`).

Three independent refusals stop it touching anything real: the target name must
match `routeplus_restorecheck_*`, it must not equal the configured database, and
it must not already exist. The `DROP` at the end can only name the database that
run created. The configured database is used for one thing — as the connection
that issues `CREATE DATABASE` / `DROP DATABASE` — and no statement is ever run
against its contents.

In SQLite mode the same command opens the **backup file** read-only (never the
live database), runs `PRAGMA integrity_check`, and compares the same six tables
against the manifest.

### Two things worth knowing before you rely on it

- **A PostGIS dump needs PostGIS on the restore target.** `pg_dump` records
  `CREATE EXTENSION postgis`; restoring onto a server without the PostGIS
  libraries installed fails at that line. The verifier reports this explicitly
  rather than leaving you with a half-restored database.
- **Restoring for real is a separate, deliberate act.** `db:restore:verify`
  proves a backup is good; it does not put it back. To actually restore, create
  or empty the target database yourself and run
  `pg_restore --no-owner --dbname=<target> <file>`, then start ROUTE+ and check
  `GET /api/health`.

Schedule `npm run db:backup` (cron, Task Scheduler, or a systemd timer), keep a
copy off the server, and run `npm run db:restore:verify` against the newest
backup at least as often as you would be sorry to lose a day of data.

## Deploying somewhere public

The app is a zero-dependency Node 22.13+ server. Any of these work unchanged:

- **Docker** — `Dockerfile` and `docker-compose.yml` are in this folder.
  `docker compose up -d` gives you the app plus a named volume for the data.
- **Any Node host** (a small VM, Render, Railway, Fly, App Service): copy the
  folder, set the environment variables, run `node server/index.js`, and put a
  reverse proxy with TLS in front.
- **PostgreSQL** instead of SQLite: `docs/DATABASE.md`. The layer is complete;
  its five integration tests are reported as *skipped* until a server is given
  to them — run them before relying on it.

## Live map data

The app runs fully on offline route data and the 120-place curated catalogue,
and says so on screen. To use live data, uncomment the provider lines in `.env`:

- **Free stack** (OpenStreetMap): `ROUTE_PROVIDER=osrm`,
  `GEOCODING_PROVIDER=nominatim`, `PLACE_PROVIDER=overpass`, plus
  `ROUTE_PLUS_CONTACT` — required by the OSM usage policy.
- **Google**: `GOOGLE_MAPS_SERVER_KEY` with `ROUTE_PROVIDER=google` and
  `GEOCODING_PROVIDER=google`. The server key never reaches the browser.

Verify with `npm run check:live -- you@example.com` (free stack) or
`npm run check:google` (Google). Both make real calls and report what answered.
If a provider fails, ROUTE+ falls back to offline data and labels it.

## Android

`ROUTE_PLUS_ANDROID_APP` builds a debug APK with
`gradlew.bat assembleDebug`; the output is
`app\build\outputs\apk\debug\app-debug.apk`. On first launch the app asks for
the ROUTE+ server URL — use the PC's IPv4 address (for example
`http://192.168.1.10:8080`) while the phone is on the same Wi-Fi, or the public
HTTPS address once deployed. Install with `adb install -r app-debug.apk`.
