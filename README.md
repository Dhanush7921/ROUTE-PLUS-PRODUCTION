# ROUTE+

**Route-aware discovery and detour decisions for Indian road trips.**

> Keep the route. Discover more. Understand the cost. Choose your experience.

You already know where you are going. ROUTE+ keeps that **main route** as the plan and shows **optional** places worth discovering beside it. For each one you see the extra kilometres, the extra driving, the visit time, who it suits, and whether it still fits your trip. Then you decide.

---

## 1. Run it (pick one)

| You want to… | Do this | What you get |
|---|---|---|
| **Just look at it** | Double-click `dist/route-plus-standalone.html` | The full planner in one file: offline road network, 120 curated places, real detour maths. No accounts. |
| **Run the full product** | Install **Node.js 22.13+** (nodejs.org), then in this folder run `npm start` and open http://localhost:8080 | Accounts, My Trips, the on-road companion (`/companion.html`), the admin dashboard (`/admin.html`), analytics and personalisation. |
| **Use OpenStreetMap live services** | Copy `.env.example` to `.env`, set `ROUTE_PROVIDER=osrm`, `GEOCODING_PROVIDER=nominatim`, `PLACE_PROVIDER=overpass` and `ROUTE_PLUS_CONTACT=you@example.com`, then `npm start` | Real OSRM road routing, Nominatim geocoding and OpenStreetMap places. If any of them fails, ROUTE+ falls back to the offline versions. |
| **Turn on real Google geocoding + routing** | See section 6 below | `ROUTE_PROVIDER=google`, `GEOCODING_PROVIDER=google` and a server key. Detours are still ROUTE+ estimates |

There are **no npm dependencies**. You do not need to run `npm install` to use the app. The server uses only Node's built-in `http`, `crypto` and `sqlite` modules.

To make yourself an admin, set `ADMIN_EMAILS=you@example.com` in `.env` before you sign up with that email.

### Why the old version looked like "raw HTML"
The previous project split its styles, images and JavaScript into separate files. If you open `index.html` straight from the ZIP, or double-click it outside its folder, the browser loads only that one file. JavaScript modules are also blocked on `file://` pages. The fixes are:
1. `npm run build` creates **one self-contained file** that works when double-clicked.
2. `npm start` serves everything properly.

## 2. Going to beta

```bash
npm run check:beta        # validates configuration and walks every beta flow
```

See `docs/BETA.md` for the `.env` to use, the checklist, and what is deliberately
left out of a beta (paid Google/traffic/tiles/payments). The free stack —
OSRM, Nominatim, Overpass, Open-Meteo — is what a beta runs on.

## 3. Test it

Browser tests need Playwright, the project's only dev dependency (the
application itself still has none):

```bash
npm install                       # installs playwright
npx playwright install chromium   # downloads the browser it drives
```

Without it `npm run test:e2e` exits 2 and says so — it never reports a browser
pass that did not happen. `npm test` and `npm run check:beta` need no browser.


```bash
npm test            # 54 unit + integration tests (engine, providers, provider selection, key safety, API, database, security)
npm run test:e2e    # 17 real-browser tests (needs Playwright: npm i -D playwright && npx playwright install chromium)
npm run check:live -- you@example.com   # calls the real map services from YOUR machine
```

## 4. How the project is organised

```
shared/   The brain. Pure JavaScript that runs in the browser AND on the server.
  taxonomy.js        interests, traveller types, categories (data, not code)
  config.js          every tunable number (scoring weights, day model, corridor size)
  geo.js             distances, projection onto a route, simplification
  data/              offline road network (182 towns, 209 roads), 120 curated places, Phase 1 sample data
  providers/         contracts + offline providers + fallback/caching registry
  engine/            geoPlanner → routeIndex → placePipeline → detour → recommend → schedule
                     + personalize (Phase 4) + context (weather cautions)
web/      The website (planner), on-road companion, admin dashboard. Vanilla JS modules.
server/   Zero-dependency Node server: domains (auth, trips, journeys, insights),
          SQLite database, live providers (OSRM, Nominatim, Overpass, Open-Meteo), jobs.
tests/    unit/, integration/ (real HTTP + DB), e2e/ (real Chromium)
scripts/  build-standalone, worker (background jobs), check-live-providers, run-e2e
docs/     ARCHITECTURE.md, PHASE-REPORTS.md, API.md, postgis-schema.sql
```

**One journey, start to finish:**

```
form ─▶ journeyService.planJourney()
          ├─ server running? POST /api/plan ─▶ server provider chains
          └─ no server?      in-browser geoPlanner with offline providers
geoPlanner: geocode ─▶ main route ─▶ phases ─▶ corridor places ─▶ clean/dedupe ─▶ detours
dashboard: recommend (score + reasons) ─▶ Add / Skip / Remove ─▶ schedule (days) ─▶ warning
```

## 5. Learning guide: the big decisions (WHAT · WHERE · WHY · HOW · HOW TO TEST)

**1. The shared engine**
- **What:** all the planning logic lives in `shared/`, not in the screens.
- **Where:** `shared/engine/*`.
- **Why:** the browser, the server and the tests all run the *same* code. Fixing a bug fixes it everywhere, and the standalone file works without a server.
- **How:** these are pure functions with no DOM and no network calls. They take data in and give data back.
- **How to test:** `npm run test:unit`.

**2. Provider abstraction (RouteProvider / GeocodingProvider / PlaceProvider)**
- **What:** three tiny interfaces. OSRM, Nominatim and Overpass implement them, and so do the offline versions.
- **Where:** `shared/providers/contracts.js` (the contracts), `server/providers/*` (live), `shared/providers/offline.js` (offline).
- **Why:** you can switch to Google, Mapbox or Mappls later by adding one file. Nothing else in the product changes.
- **How:** `registry.chain()` tries providers in order. On a timeout or outage it falls back to the next one. It caches results and records provider health.
- **How to test:** `tests/unit/phase2-live-providers.test.mjs`, and the "graceful degradation" test in `tests/integration`.

**3. The detour engine (the core)**
- **What:** extra distance = *(route with the stop)* − *(the same stretch of route without it)*. Extra time works the same way.
- **Where:** `shared/engine/detour.js`.
- **Why:** "8 km away" is misleading. What you actually pay is the extra driving compared with the road you were taking anyway.
- **How:** project the place onto the route, then pick where you would leave the route (anchor) and rejoin it. Ask the router for the costs of *anchor → place → rejoin*, subtract the baseline, and compare that with going *there and back*. Keep the cheaper option.
- **How to test:** open any card's **Explore** panel. "How the detour works" shows the anchor and rejoin towns. The maths is checked in `phase2-geo.test.mjs`.

**4. The realistic trip model**
- **What:** a day-by-day simulation. You start at 07:00, drive at most 9 hours, take a 15-minute break every 2.5 hours, and stop driving by 20:00. Visits must fit opening hours.
- **Where:** `shared/engine/schedule.js` (settings live in `shared/config.js` → `DAY_MODEL`).
- **Why:** "total hours ÷ 10" hides overnight stops and closed gates.
- **How to test:** open "Day-by-day estimate" in the Your Journey panel.

**5. Transparent recommendations (no AI)**
- **What:** rule-based points (interest +30, traveller fit +25, near route +20 …). Every point is listed.
- **Where:** `shared/engine/recommend.js`. The weights are in `shared/config.js`.
- **How to test:** Explore → "Transparent score".

**6. Accounts and security**
- **What:** scrypt-hashed passwords, and HttpOnly SameSite cookies where the database stores only a hash of the session token. Every trip query is checked against its owner. The server also has rate limits, a strict Content Security Policy, origin checks and an audit log.
- **Where:** `server/domains/auth.js`, `server/app.js`, `server/lib/http.js`.
- **How to test:** `npm run test:integration` (ownership, rate limits, path traversal, CSRF).

**7. The mobile companion**
- **What:** `companion.html` is an installable web app (PWA). It works out which route phase you are in, lists discoveries ahead, lets you Add or Skip, shows the detour impact, and hands off to navigation. It also asks for feedback after each stop.
- **Why a PWA, not a native app yet:** it runs on every phone today and reuses 100% of the engine. A native app (for example Expo/React Native) can call the same `/api/*` later.
- **Privacy:** your location stays in the page memory only. It is never stored or sent anywhere.
- **How to test:** plan a route, press **On the Road ↗**, then drag "Preview a point along the route".

**8. Intelligence (Phase 4)**
- **What:** analytics events, behaviour-based boosts (capped at ±10 and explained), crowd "worth the detour?" feedback, weather cautions, and suppression of risky stops.
- **Guard:** sponsored places are labelled but **never** scored differently. A test enforces this.
- **Where:** `shared/engine/personalize.js`, `shared/engine/context.js`, `server/domains/insights.js`, `web/js/intelligence.js`.

## 6. Map providers & Google Maps Platform (Production Step 2)

> **What is live now:** real **Google geocoding** (place name → coordinates) and real **Google road routing** (the main route: distance, driving time, road geometry).
> **What is still ROUTE+'s own:** place discovery (curated list), the detour +km / +min figures (offline estimates), trip impact, recommendations. Real Places, the real detour engine, the production trip model and PostgreSQL + PostGIS are future steps.

### How provider selection works

```
.env ──▶ server/config.js ──▶ server/providers/selection.js ──▶ server/providers/index.js
         (reads variables)      (decides, ONE place)              (builds the chains)

ROUTE_PROVIDER      offline (default) | osrm      | google   →  chain: [chosen] → offline-network
GEOCODING_PROVIDER  offline (default) | nominatim | google   →  chain: [chosen] → offline-network
PLACE_PROVIDER      curated (default) | overpass  | google   →  merged: curated + [chosen]
```

- **Offline mode (default):** no `.env` needed. ROUTE+ uses the offline road network and the curated places, exactly as before.
- **Google mode:** set `ROUTE_PROVIDER=google` (and/or the other two) **plus** `GOOGLE_MAPS_SERVER_KEY`. The Google adapters are put at the front of each chain, with offline behind them.
- **Something wrong?** If Google is chosen without a key, or the provider name is a typo, the server still starts. It logs a warning and uses offline. If a selected provider fails during a request, the chain falls back to offline. The traveller sees *"Live map services are currently unavailable. ROUTE+ is using offline route data."* and never a raw vendor error.
- **Startup log:** shows the active mode, for example:
  ```
  providers (offline mode):
    geocoding: offline-network
    routing:   offline-network
    places:    curated
    google keys: server not set, browser not set
  ```
  It shows **names and "set / not set" only, never key values.** `GET /api/health` returns the same safe summary.

### The Google adapters (`server/providers/google/`)

| Adapter | Method | ROUTE+ contract | Google API | Status |
|---|---|---|---|---|
| `GoogleGeocodingProvider` (`geocoding.js`) | `geocode()` | `geocode()` | Geocoding API — `GET /maps/api/geocode/json` | **live** |
| `GoogleRouteProvider` (`routes.js`) | `calculateRoute()` | `route()` | Routes API — `POST /directions/v2:computeRoutes`, `travelMode: DRIVE` | **live** |
| `GoogleRouteProvider` | `calculateRouteMatrix()` | `legs()` (detour costs) | Routes API — computeRouteMatrix | boundary only (Step 4) |
| `GooglePlaceProvider` (`places.js`) | `searchPlaces()`, `getPlaceDetails()` | `searchCorridor()` | Places API (New) | boundary only (Step 3) |

The two boundary methods still return a **controlled error** (`PROVIDER_NOT_READY`, or `Google … provider not configured.` with no key). They make no network call and return no fake data, and both errors are "recoverable", so the registry moves on to the offline provider.

**What one journey costs:** 2 geocoding requests + 1 Routes request. There is no retry loop, identical requests in flight share one answer, and results are cached for `CACHE_TTL_HOURS` (default 12), so planning the same journey twice costs nothing the second time.

**How a Google answer is normalised** — the raw response never leaves the adapter:

```
Geocoding  → { provider, providerPlaceId, name, latitude, longitude, formattedAddress }
Routes     → { id, provider, origin, destination, distanceKm, durationMinutes, geometry, legs }
```
`geometry` is Google's encoded polyline decoded to `[lat, lng]` points by `decodePolyline()` in `shared/geo.js` (verified against Google's published example). Distance and duration are Google's own `distanceMeters` / `duration` — never a straight-line calculation.

**Errors travellers can act on, never vendor text:** no such place → `PLACE_NOT_FOUND`; two far-apart matches → `AMBIGUOUS_PLACE` with the options; quota → `RATE_LIMITED`; denied key, outage or timeout → `PROVIDER_UNAVAILABLE` / `TIMEOUT`. The last three are recoverable, so the journey still plans from offline data with the notice *"Live map services are currently unavailable…"*.

**Check it live from your machine:** `npm run check:google` (needs `GOOGLE_MAPS_SERVER_KEY` in `.env`). It makes the three real requests, prints the coordinates, distance, duration and geometry size, and stores nothing.

The map display goes through **`web/js/ui/mapRenderer.js`**, a rendering adapter. Today it always uses the ROUTE+ SVG map, so the UI is unchanged. Later, Google Maps JavaScript API can become the base map *underneath* the same ROUTE+ layers (solid main route, dashed detours, stops, phases). Google supplies the geography, and ROUTE+ keeps discovery, detour decisions, recommendations and trip impact.

### Two keys, kept separate

| Variable | Used by | Where it may go | Restrict it in Google Cloud Console |
|---|---|---|---|
| `GOOGLE_MAPS_BROWSER_KEY` | Maps JavaScript API (map display, later step) | May reach the browser. It is public by design | **Websites (HTTP referrers)** = your domain(s); **API** = Maps JavaScript API only |
| `GOOGLE_MAPS_SERVER_KEY` | Routes API, Places API (New), Geocoding API | **Server only.** Never in frontend code, API responses or logs | **IP addresses** = your server; **APIs** = Routes, Places (New), Geocoding |

How the code enforces this:
- Keys are stored as non-enumerable config properties, so `JSON.stringify(config)` and `{...config}` can't leak them.
- Adapters keep the key in a closure, not as an object property.
- The logger masks any `*Key`, `secret` or `token` field and anything shaped like `AIza…`.
- Tests scan the whole source for key-shaped strings, and check that the frontend never mentions the server key.
- `.env` is in `.gitignore`. Never commit it, and never paste a real key into source files. Also set a **billing budget with alerts** and per-API quotas.

### Not implemented yet (by design)
Real Google place discovery, Google map display (the base map is still the ROUTE+ SVG), the route corridor via Google, real +KM / +MIN detours from Google, the production trip model, PostgreSQL / PostGIS, Redis, GPS changes, auth changes, AI/ML. **Next: Production Step 3, real place discovery.**

## 7. Honest limits

- **Offline network:** town centres ±2 km, and road length is estimated from road type (usually within ~10–15 %). It is fine for decisions, not for navigation. With live providers on, OSRM supplies the real road network.
- **Curated places:** the places are real, but the coordinates are approximate. Visit times and suitability are editorial estimates. Hours and fees are "confirm locally". The app shows this on every place.
- **Live providers (including Google):** the adapters were tested against recorded/synthetic response shapes with an injected transport, **not** against the live services — the build sandbox has no internet access and no API key. Run `npm run check:google` (Google) or `npm run check:live` (OpenStreetMap services) on your own machine to see them work for real.
- **Detour figures with Google on:** the main route is Google's, but every `+km` / `+min` is still a ROUTE+ local-road estimate. The app says so in its notices, and `plan.providerStatus.detourMethod` reports `estimated`.
- **SQLite:** what serves requests today, and it is enough for a beta. PostgreSQL + PostGIS is implemented alongside it (schema, migrations, seed, SQLite import, spatial queries, zero-dependency driver — see `docs/DATABASE.md` and `npm run db:pg`), but the request path is still SQLite: making it serve from PostgreSQL means turning the synchronous repository layer async.
- **Photos:** each place shows a drawn illustration of its category, not a photo of the actual place.
