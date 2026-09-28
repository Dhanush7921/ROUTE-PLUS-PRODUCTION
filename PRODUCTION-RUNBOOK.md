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
