# ROUTE+ — Production Step 2: real Google geocoding + real Google routing

**Scope:** only the two things asked for. Real Places, real place discovery, the
route corridor via Google, the real detour engine, the real trip-impact model,
PostgreSQL, PostGIS, Redis, GPS, mobile changes, AI/ML and any UI redesign were
**not** implemented.

**Honesty statement up front:** the code makes real Google requests, but **no
real Google request was successfully completed during development.** The build
sandbox has no outbound access to `maps.googleapis.com` / `routes.googleapis.com`
(the egress proxy refuses the connection) and no API key exists here. Every test
uses an injected transport with clearly-labelled synthetic fixtures. To confirm
the live services, run `npm run check:google` on your own machine with your key.

---

## What was already present

- The provider abstraction (`shared/providers/contracts.js`) with three
  interfaces — `GeocodingProvider`, `RouteProvider`, `PlaceProvider`.
- The fallback registry (`shared/providers/registry.js`): chains, timeouts, LRU
  cache, recoverable-vs-final error classification.
- Offline providers: 182-town geocoder, Dijkstra router over 209 roads, curated
  place list.
- Central provider selection (`server/providers/selection.js`) driven by
  `ROUTE_PROVIDER` / `GEOCODING_PROVIDER` / `PLACE_PROVIDER`.
- Google adapter **boundaries** (`server/providers/google/*.js`) that returned
  `PROVIDER_NOT_CONFIGURED` / `PROVIDER_NOT_READY` and made no network calls.
- Key separation: `GOOGLE_MAPS_SERVER_KEY` / `GOOGLE_MAPS_BROWSER_KEY` stored as
  non-enumerable config properties, logger redaction, source scans in tests.
- The geographic planner, detour estimator, scheduler, recommendation engine,
  SQLite persistence and the CEO-approved UI.

Baseline before any change: **54 unit + integration tests, 17 browser tests, all passing.**

## What was changed

1. **Real Google geocoding.** `GoogleGeocodingProvider.geocode()` now calls the
   Geocoding API, biased to India (`region=in`, `components=country:IN`), and
   normalises the answer inside the adapter. The raw Google body never travels.
2. **Real Google routing.** `GoogleRouteProvider.calculateRoute()` now calls the
   Routes API `computeRoutes` with `travelMode: DRIVE`, a strict field mask and
   no alternative routes, and returns Google's own distance, duration and
   decoded road geometry. No straight-line substitution anywhere.
3. **A shared Google request helper** — key in the `X-Goog-Api-Key` header, hard
   timeout, HTTP status → `ProviderError`, **no retry loop**, and every message
   scrubbed of anything key-shaped before it can reach a log or a response.
4. **An encoded-polyline decoder** in `shared/geo.js`, verified against Google's
   published example string.
5. **Truthful provenance.** The registry now also tracks which provider answered
   the *detour legs*. A real Google main route no longer makes the offline detour
   estimates claim road-network accuracy: the notice says so, and
   `plan.providerStatus.detourMethod` reports `estimated`.
6. **Two correctness fixes in the registry** found while wiring this up: a cached
   result lost its provider stamp (a cached Google route looked offline), and
   identical concurrent requests each started their own (billable) call.
7. **A live acceptance script** (`npm run check:google`) and Step 2 tests.

### Files changed

| File | Change |
|---|---|
| `server/providers/google/request.js` | **new** — shared Google request handling |
| `server/providers/google/geocoding.js` | real Geocoding API implementation |
| `server/providers/google/routes.js` | real Routes API `computeRoutes` implementation |
| `server/providers/google/common.js` | status comments, endpoint notes |
| `server/providers/index.js` | accurate startup description of what is live |
| `server/domains/journeys.js` | fallback provenance also covers geocoding |
| `server/index.js` | optional injected transport (tests only) |
| `shared/geo.js` | `decodePolyline()` |
| `shared/providers/registry.js` | in-flight de-duplication, provider stamping before cache, `legsMethod` |
| `shared/engine/detour.js` | label detour figures by the provider that answered the legs |
| `shared/engine/geoPlanner.js` | endpoint provenance, coordinate normalisation, honest notices |
| `web/js/app.js` | two extra friendly error messages (no visual change) |
| `scripts/check-google.mjs` | **new** — live acceptance check |
| `tests/fixtures/google-responses.mjs` | **new** — clearly-labelled synthetic fixtures |
| `tests/unit/step2-google.test.mjs`, `tests/integration/step2-google.test.mjs`, `tests/e2e/step2-google.e2e.mjs` | **new** |
| `tests/unit/step1-google-foundation.test.mjs`, `tests/integration/step1-providers.test.mjs` | updated for Step 2 reality; no test touches the network |
| `.env.example`, `README.md`, `docs/*`, `package.json`, `dist/` | documentation and rebuild |

## Google services used

| Service | Endpoint | Method | Per journey |
|---|---|---|---|
| Geocoding API | `GET https://maps.googleapis.com/maps/api/geocode/json` | header key | 2 requests (origin, destination) |
| Routes API | `POST https://routes.googleapis.com/directions/v2:computeRoutes` | `X-Goog-Api-Key`, `X-Goog-FieldMask` | 1 request |

No Places API, no route matrix, no Maps JavaScript API.

## Status

| Item | Status |
|---|---|
| Real geocoding | **Implemented**, contract-tested with an injected transport. **Not live-verified here.** |
| Real routing | **Implemented**, contract-tested with an injected transport. **Not live-verified here.** |
| Offline fallback | **Working and verified** — missing key, denied key, outage and timeout all degrade to offline with a friendly notice; the server never crashes. |
| UI | **Unchanged** — screenshots before/after are byte-identical at 1440 px and 390 px. |
| Detours (+km / +min) | still ROUTE+ offline estimates, and now labelled as such |

## Tests

- `npm test` — **68 passed, 0 failed** (baseline 54).
- `npm run test:e2e` — **18 passed, 0 failed** (baseline 17).
- Pixel comparison of landing and dashboard, desktop and mobile: identical.
- `npm start` + demo journey (Visakhapatnam → Manali, 3 days, Family,
  Nature/Devotional/Food): 200 OK, 46 discoveries, offline providers.
- `npm run check:google` with no key: exits 2, makes no request.
- **Not run:** a successful live Google request (no key, no network here).

## Next step

Run `npm run check:google` with a real restricted key to confirm the live
services, then set `ROUTE_PROVIDER=google` and `GEOCODING_PROVIDER=google`.
After that, Production Step 3 is real place discovery (Places API New), and
Step 4 is the real detour engine (`computeRouteMatrix`).
