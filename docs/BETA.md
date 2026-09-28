# ROUTE+ beta checklist

A beta is for **test users on the free/open provider stack**. No paid Google
Maps, no paid traffic or weather, no premium tiles, no payments. Those stay
behind the provider abstraction and can be switched on later without touching
the engines.

## Run the beta locally

```bash
node --version                 # needs 22.13 or newer
cp .env.example .env           # then edit — see below
npm run check:beta             # walks every beta flow and prints a verdict
npm start                      # → http://localhost:8080
```

`npm run check:beta` is the gate. It validates configuration, checks the built
files, then starts a real server on a throwaway database and exercises: health,
the landing page, route entry → planning → discovery, detour figures and their
provenance, reopening a stored plan, a friendly error for an unknown place,
sign-up / session / wrong password, adding several stops → saving → extending →
removing → restoring, ownership enforcement, rate limiting and shutdown. It
exits non-zero if anything fails.

## `.env` for a beta

```bash
NODE_ENV=production
PORT=8080
HOST=0.0.0.0                  # inside a container or behind a proxy
PUBLIC_URL=https://beta.example.com    # enables Secure cookies, HSTS, origin checks
TRUST_PROXY=1                 # ONLY if a proxy you control sets X-Forwarded-For
ROUTE_PLUS_DB=/var/lib/routeplus/routeplus.sqlite   # NOT /tmp
ADMIN_EMAILS=you@example.com  # REQUIRED in production — the address you will sign up with
LOG_LEVEL=info

# Free/open providers for beta
ROUTE_PLUS_CONTACT=you@example.com     # required by the OpenStreetMap usage policy
ROUTE_PROVIDER=osrm
GEOCODING_PROVIDER=nominatim
PLACE_PROVIDER=overpass
OVERPASS_FALLBACK_URL=https://overpass.kumi.systems/api/interpreter
ROUTE_PLUS_LIVE_PROVIDERS=1            # also enables Open-Meteo weather context
MAX_DETOUR_CANDIDATES=90               # be gentle with the public OSRM demo
```

Leave `GOOGLE_MAPS_SERVER_KEY` and `GOOGLE_MAPS_BROWSER_KEY` **empty**. With no
key the Google adapters are skipped and the free stack answers.

The server refuses to start on a configuration that cannot work and names the
problem. With `NODE_ENV=production` that includes four deployment mistakes that
would cost you your testers' data or leave the beta unmoderated:

| Refused in production | Why |
|---|---|
| empty `ADMIN_EMAILS` | nobody could moderate a bad place or read feedback while testers are using it |
| `ROUTE_PLUS_DB` under `/tmp`, `/var/tmp` or `/dev/shm` | accounts, trips and feedback would vanish on the next restart |
| `ROUTE_PLUS_DB=:memory:` | nothing would be saved at all |
| bad port, malformed `PUBLIC_URL`, unparseable numbers, invalid `DATABASE_URL` | the value cannot work |

A database path *inside* the application directory is a warning, not an error —
it works, but a redeploy that replaces the code directory would replace the
database with it. Everything else merely risky prints as a `configuration`
warning at startup and in `check:beta`.

## Before you invite testers

- [ ] `npm test` — all green (PostgreSQL tests skip unless configured)
- [ ] `npm run test:e2e` — the browser flows, including mobile layout
      (needs `npm install` + `npx playwright install chromium`; exits 2, not 0, if
      the browser is missing, so a skipped run can never pass for a green one)
- [ ] `npm run check:beta` — exits 0, and you have read every warning
- [ ] `npm run check:live -- you@example.com` — from the machine that will serve,
      to confirm Nominatim / OSRM / Overpass / Open-Meteo are reachable **and**
      that the OSM corridor query returns real places
- [ ] `npm run build` — refresh `dist/route-plus-standalone.html`
- [ ] HTTPS in front (any reverse proxy or tunnel). Sessions are cookies; do not
      run a public beta over plain http
- [ ] `ROUTE_PLUS_DB` on a persistent disk, and **backed up** — it holds users,
      trips and feedback. A copy of the file while the server is stopped is a
      complete backup
- [ ] Sign up with an address in `ADMIN_EMAILS` and open `/admin.html` once, so
      you can disable a bad place while testers are using it
- [ ] Decide what you tell testers: distances and times are estimates, place
      details are editorial, and it is not navigation

## Running it

- **Start:** `npm start`. **Stop:** `SIGTERM` or Ctrl-C — the server stops
  accepting, finishes in-flight requests, closes the database, then exits
  (`SHUTDOWN_TIMEOUT_MS`, default 10 s, caps the wait).
- **Health check:** `GET /api/health` returns provider names and modes, never a
  key. Point your uptime monitor at it.
- **Behind a proxy:** set `TRUST_PROXY=1` **and** make the proxy set
  `X-Forwarded-For`. Without it every visitor looks like the proxy and they all
  share one rate-limit bucket. With it set but no proxy, a client could forge
  the header.
- **If a provider fails:** the chain falls back to the offline road network and
  curated places, the traveller sees *"Live map services are currently
  unavailable…"*, and nothing claims live data it did not get. `/api/health`
  and the admin dashboard show provider health.
- **Logs:** one JSON line per request and per provider call. Keys, passwords,
  tokens and cookies are redacted by the logger.

## Deliberately not in the beta

Paid Google Maps / Places / Routes (the adapters exist and are dormant),
paid traffic or weather, premium tiles, payments, production cloud
infrastructure, PostgreSQL as the serving database (the layer is ready — see
`docs/DATABASE.md`), push notifications, social features.

## Known beta limitations to tell testers

- Distances and driving times are estimates. With the free stack the main route
  and detours come from OSRM road data; without it, from a simplified offline
  network (within roughly 10–15 %). Neither is navigation.
- Place details (visit times, suitability, fees, hours) are editorial. The app
  says "confirm locally", and it means it.
- Public OSRM/Nominatim/Overpass are fair-use with no SLA. Overpass may time
  out; discovery then falls back to the curated list and says so.
- Photos are drawn illustrations of the category, not photographs of the place.
