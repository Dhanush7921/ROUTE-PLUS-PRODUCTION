# ROUTE+ architecture

## Principles
1. **The main route is the plan. Discoveries are opportunities.** The main route is drawn solid and never changes. Optional detours are dashed. An added stop turns solid, but the main line stays the same.
2. **Data-driven.** Routes, places, categories, interests and weights are data. Nothing in the code says `if destination === 'Manali'`.
3. **One engine, many hosts.** `shared/` runs in the browser, on the server and in tests.
4. **Providers are replaceable.** Vendor code lives only in `server/providers/` and `shared/providers/offline.js`.
5. **Explainable.** Every score has a breakdown, and every warning has a reason.
6. **Graceful.** If an external service fails, ROUTE+ falls back and shows a friendly message. Raw vendor errors never reach users.

## System diagram

```
                 ┌───────────────────────── browser ─────────────────────────┐
                 │ web/index.html (planner) · companion.html · admin.html    │
                 │   app.js ─ journeyService ─┬─ /api/* (server mode)        │
                 │                            └─ shared/engine (offline mode)│
                 └───────────────────────────────┬───────────────────────────┘
                                                 │ HTTPS (JSON, cookie session)
┌──────────────────────────── server (Node, zero deps) ─────────────────────────┐
│ app.js: security headers · rate limits · origin check · auth · router · logs  │
│ domains: auth · trips/preferences · journeys(plan) · insights(analytics,       │
│          feedback, personalisation, context, admin reports)                   │
│ providers/selection.js decides (ROUTE_/GEOCODING_/PLACE_PROVIDER):            │
│ providers/index.js → chain(geocoding: [google|nominatim] → offline)           │
│                      chain(routing:   [google|osrm] → offline)                │
│                      chain(places:    DB curated + [google|overpass])         │
│                      weather: Open-Meteo                                      │
│ db/ SQLite (node:sqlite) — schema mirrors docs/postgis-schema.sql             │
│ jobs.js + scripts/worker.mjs — sessions, metrics roll-up, place review, ingest│
└───────────────────────────────────────────────────────────────────────────────┘
```

## Planning pipeline (`shared/engine/geoPlanner.js`)

| Step | Module | Notes |
|---|---|---|
| Geocode origin and destination | GeocodingProvider | Handles not found, ambiguous (e.g. "Bilaspur"), typos (suggests the closest name), timeouts |
| Main route | RouteProvider | Geometry, distance, duration, segments; the original route is preserved |
| Route index | `routeIndex.js` | Road-km ↔ point, time along the route, nearest town |
| Phases | `buildPhases` | 2–4 corridors by distance, named after the towns at each end |
| Corridor search | PlaceProvider | Buffer = min(45 km, max(15 km, 15 % of route length)) |
| Normalise → dedupe → filter | `placePipeline.js` | Category defaults, seasonality, source metadata, merged duplicates |
| Detours | `detour.js` | Batched `router.legs()`; through-route vs out-and-back, whichever is cheaper |
| Output | JourneyPlan | Same shape as Phase 1, so the UI did not need rewriting |

### Detour maths
```
P  = nearest point on route (routeKm = s, perpendicular distance d)
A  = point at s − w,  B = point at s + w,  w = clamp(d, 2, 25) km
through:      extra = leg(A→place) + leg(place→B) − route(A→B)
out-and-back: extra = 2 × leg(P→place)
extra time   = same, using minutes (main-route minutes come from segment speeds)
minimum      = 5 min (slowing, turning, parking)
```

## Trip impact (`shared/engine/schedule.js`)
The day simulation (07:00 start, ≤ 9 h driving, 15-min breaks every 2.5 h, no driving after 20:00, opening hours respected) gives:
- `requiredDays`: how many days the plan really takes.
- `fit`: FITS / NEAR LIMIT / EXCEEDS.
- `remainingMinutes`: spare time, which feeds the "fits your trip" score.
- `days[]`: the day-by-day plan with overnight towns.
- `notes[]`: for example, "closes before you arrive — visit moved to next morning".

## Security
| Concern | Implementation |
|---|---|
| Passwords | scrypt (N=16384) with a per-user salt; timing-safe compare; a dummy hash for unknown emails |
| Sessions | 256-bit random token in an HttpOnly + SameSite=Lax (+ Secure on HTTPS) cookie; only its SHA-256 is stored |
| Authorisation | Every trip query includes `user_id`; admin routes check `role` on the server |
| Input validation | Per-endpoint validation, whitelisted analytics properties, body size limits, JSON-only writes |
| CSRF | SameSite cookies + JSON content type + Origin check when `PUBLIC_URL` is set |
| Headers | CSP (`script-src 'self'`), X-Frame-Options DENY, nosniff, Referrer-Policy, HSTS on HTTPS |
| Rate limits | auth 10/min, planning 30/min, writes 120/min, events 240/min per IP |
| Secrets | Environment variables only (`.env`, never committed); no provider keys in frontend code |
| Static files | Path normalisation blocks `..` (including encoded) traversal |
| Audit | Sign-ups, logins, trip changes and every admin action are written to `audit_log` |

For production: put it behind HTTPS (Caddy or nginx), run `sqlite3 routeplus.sqlite ".backup backup.sqlite"` nightly (or use managed PostgreSQL backups), and ship the JSON logs to your log platform.

## Caching
- Geocoding and main routes: an LRU cache in memory (TTL `CACHE_TTL_HOURS`), keyed by the query or the rounded coordinates.
- Overpass results: cached per corridor chunk (ODbL allows this with attribution, which the app shows).
- Weather: cached per ~10 km cell per hour.
- The OSRM demo and Nominatim have fair-use policies. For real traffic, self-host them or use a commercial provider behind the same contract.

## Observability
- Structured JSON logs for every API request (method, path, status, ms, user id).
- `/api/admin/overview` shows product funnel metrics, API latency (avg / p95 / max), provider health (ok, failed, average ms, last error) and recent errors.

## Background processing
`npm run worker` (for example, hourly via cron) purges sessions, rolls up daily metrics, flags places travellers say are not worth it, and (with live providers on) ingests OpenStreetMap places along popular corridors. New places are stored **disabled and flagged** until staff review them. The server also runs the cheap jobs hourly.

## Mobile strategy
The companion is a PWA: installable, works offline through the service worker, and uses optional geolocation with a clear permission explanation. A native app can reuse `/api/*` unchanged. The website stays the large planning workspace, and the phone is the on-road companion.

## Scaling path
1. SQLite → PostgreSQL + PostGIS (`docs/postgis-schema.sql`; the corridor search becomes `ST_DWithin`).
2. Self-hosted OSRM (India extract) + Nominatim, or a commercial provider behind the same contracts.
3. Move `/api/plan` detour computation to a job queue for very long routes; cache plans by (origin, destination, day).
4. Serve `web/` and `shared/` from a CDN; run several API instances behind a load balancer (sessions are already in the database).

## Provider selection & Google integration (Production Step 2)
- Selection lives in ONE module: `server/providers/selection.js` (env → names). `server/providers/index.js` builds the chains from it. Nothing else chooses a vendor.
- Google adapters: `server/providers/google/{routes,geocoding,places}.js` over a shared request helper `server/providers/google/request.js` (header-carried key, AbortController timeout, status → `ProviderError`, no retries, scrubbed messages).
  - **Live:** `geocoding.geocode()` (Geocoding API) and `routes.calculateRoute()` (Routes API `computeRoutes`, `travelMode: DRIVE`, strict `X-Goog-FieldMask`). Responses are normalised inside the adapter — the raw body never travels.
  - **Boundaries:** `routes.calculateRouteMatrix()` (detour legs, Step 4) and the Places adapter (Step 3) still return `PROVIDER_NOT_READY`; recoverable, so offline answers.
- Provenance: the routing chain tracks the provider that answered the main route AND the one that answered the detour legs (`legsMethod`), so a real Google route can never imply that the offline detour estimates are real measurements. `plan.providerStatus` and the plan notices carry this to the UI.
- Cost control: one journey = 2 geocodes + 1 route. The registry de-duplicates identical in-flight calls and caches answers (`CACHE_TTL_HOURS`).
- Keys: `GOOGLE_MAPS_SERVER_KEY` is server-only (non-enumerable config property, kept in adapter closures, logger redaction). `GOOGLE_MAPS_BROWSER_KEY` is reserved for the Maps JavaScript renderer and is not sent to the browser yet.
- Map display: `web/js/ui/mapRenderer.js` is the adapter between the ROUTE+ map area and a renderer. Today that renderer is the ROUTE+ SVG map. When Google Maps JS is added, the CSP in `server/lib/http.js` must allow `maps.googleapis.com` and `maps.gstatic.com`.
