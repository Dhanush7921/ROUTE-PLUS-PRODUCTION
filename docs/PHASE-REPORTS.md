# ROUTE+ phase reports

The work was done in order: inspect → Phase 1 → verify → Phase 2 → verify → Phase 3 → verify → Phase 4 foundations → full system test. Each phase is a git commit (`git log`), so you can check out any stage and study it.

Test totals at the end: **43 unit and integration tests + 16 real-browser tests, all passing** (Node 22.22, Chromium 141 headless).

---

## Step 1 — Audit of the uploaded ZIPs

| | Finding |
|---|---|
| Current structure | Two ZIPs. `ROUTE-plus-phase1` was the newer superset: static `dist/` site with 3 CSS files, 8 JS modules, a hero image and 4 test scripts |
| Reusable | Warm cream/terracotta visual language, page structure, recommendation rules, trip-impact idea, localStorage save/restore, sample routes |
| Broken / "raw HTML" | Renders correctly when served. The unstyled look came from opening `index.html` outside its folder (e.g. from inside the ZIP) or over `file://`, where JS modules are blocked. Nothing was inlined, so a lone HTML file had no CSS, images or behaviour |
| Asset problems | Every card photo came from Unsplash. Offline, all cards fell back to the same hero image |
| JS problems | Minified into a few very long lines (unreadable for a learner); UI, state and logic mixed in `app.js` |
| Data problems | The same 12 fictional places copied onto every route; a mock "10 h/day" trip model |
| Architecture | No provider boundary, no server, no real geography |
| Old travel-planner code | None found (no Kashi-first remnants) |

---

## Phase 1 — Fix + polish + complete web MVP ✅ COMPLETE

**What was built:** the same design, rebuilt into readable modules. It has a design-token system, header and responsive mobile menu, hero with the exact headline and CTAs, four-step How It Works, full journey form (all durations, traveller types and interests), and Load Demo Journey (Visakhapatnam → Manali, 3 days, Family, Nature/Devotional/Food). There is a schematic route map with a solid main route and dashed detours, route phases, 12 structured sample places, cards (image, category, +km, +min, visit, recommended-for, match, Explore/Add/Skip), the place detail (side panel on desktop, bottom sheet on mobile), and rule-based scoring with reasons. Add, Skip and Remove all work, with trip impact FITS / NEAR LIMIT / EXCEEDS. The "Your journey has changed" dialog offers Keep / Extend / Remove add-on. Saved journeys and auto-restore on refresh use localStorage. The trip also has an empty state, keyboard and focus handling, and a phone-only impact bar.

**Files created:** `web/index.html`, `web/css/{tokens,base,landing,dashboard,dialogs,responsive}.css`, `web/js/{app,main,state,storage,format,journeyService,analytics}.js`, `web/js/ui/{map,dashboard,dialogs,art}.js`, `shared/{taxonomy,config}.js`, `shared/engine/{recommend,tripImpact,mockPlanner}.js`, `shared/data/mockRoutes.js`, `tests/unit/phase1-engine.test.mjs`, `tests/e2e/{helpers,phase1.e2e}.mjs`.
**Files reused:** `hero.jpg` (recompressed 498 → 221 KB), the design language, and the logic ideas (ported, not copied, from the minified originals).

**Important decisions:** local SVG illustrations per category instead of remote stock photos, so an image can never be broken or show the wrong place. A `journeyService` seam separates screens from the engine, which let Phase 2 swap engines without rewriting the UI.

**Tests run:** 6 unit + 9 browser. All passing. They cover demo, second route, add/skip/remove, multiple stops, extension keep/extend, save + refresh + saved list, mobile bottom sheet and overflow, empty state, keyboard focus return, and a clean console.

**Known issues:** none blocking. Sample mode is still available at `?engine=sample`.

---

## Phase 2 — Real routing + geographic detour engine ✅ COMPLETE (offline verified; live adapters shape-tested)

**What was built:**
- Provider contracts (`RouteProvider`, `GeocodingProvider`, `PlaceProvider`) and a registry with fallback chains, timeouts, an LRU cache and health events.
- Offline providers: a geocoder over 182 real towns (aliases like Vizag / Bangalore / Coorg, typo suggestions, ambiguity detection), a Dijkstra router over 209 highway links with road-type speeds and circuity, and a curated list of 120 real places.
- Live providers: OSRM (route + batched table legs, duration factor), Nominatim (User-Agent, 1 req/s, ambiguity), Overpass (chunked polyline corridor query, notability filter, tag → category mapping) and Open-Meteo.
- Engine: route index, phases, corridor search, the normalise → dedupe → filter pipeline, the **detour engine** (anchor/rejoin, baseline subtraction, through vs out-and-back) and a day-by-day **trip scheduler**.
- UI: a geographic map (projected, shape-adaptive, label collision avoidance), phases with km ranges, "How the detour works", day-by-day plan, field-level geocoding errors, and card paging.

**Important decisions and honest results:**
- Visakhapatnam → Manali is ~2,630 km / ~50 h of driving. At 9 h/day that is **6 days**, so the 3-day demo now truthfully shows "Your route needs more time" first. That is the correct product behaviour.
- The offline router is within ±15 % of real distances on the tested corridors (checked in tests). It is labelled "estimated road network, not navigation".

**Tests run:** 19 geo/engine unit tests, 6 live-adapter tests (fake fetch with real response shapes: unit conversion, matrix diagonal, 4xx/429/5xx/timeout mapping, ambiguity) and 3 browser tests. All passing.

**Known issues:** the live services could not be reached from the build sandbox (no internet), so real OSRM/Nominatim/Overpass responses are **not verified**. Run `npm run check:live -- you@example.com` on your machine. If they fail, the app keeps working offline.

---

## Phase 3 — Production beta + accounts + mobile ✅ COMPLETE (beta-grade)

**What was built:**
- A zero-dependency Node server organised by domain: auth, users/preferences, trips, journeys (routes + detours + recommendations), insights (analytics, feedback, personalisation, context, admin).
- SQLite schema with every required entity: users, user_preferences, trips, trip_preferences, routes, route_segments, places, place_categories, place_attributes, place_sources, place_opening_hours, place_seasonality, recommendations, detour_calculations, trip_stops, saved_trips, feedback, analytics_events, plus sessions and audit_log. There is a PostGIS twin in `docs/postgis-schema.sql`.
- Authentication (sign up / in / out, sessions, profile), My Trips, saved journeys synced to the account, preferences that pre-fill the form, trip history, and visited stops.
- **Mobile companion PWA**: current journey and progress, current phase, discoveries in the next 120 km, quick details, Add/Skip, detour impact, "navigate there" handoff, optional GPS with a clear privacy promise, preview mode, spam-free alerts (approaching, closing soon, likely closed), post-stop feedback, and finish journey.
- Security: see ARCHITECTURE.md. Also a service worker for offline, and structured logs, metrics and provider health.

**Tests run:** 12 API integration tests over real HTTP + real SQLite (ownership isolation, validation, rate limiting, CSRF origin block, path traversal, outage fallback, total-outage friendly 503, graceful degradation in live mode) and 2 browser tests (the **critical end-to-end path**, and the companion with mocked GPS). All passing.

**Known issues / next:** email verification and password reset are not built yet (they need an email provider). Push notifications only work while the page is open (true background push needs a push service). Native apps are not built; the PWA covers mobile.

---

## Phase 4 — Intelligence + scale + business foundations ✅ FOUNDATIONS COMPLETE

As the brief says, this phase needs real users and data before it can go further. The foundations are in place:
- **Behaviour data:** all 12 events (journey_started … place_feedback) are tracked. The server whitelists event names and properties, and never stores location.
- **Personalisation:** your own behaviour (on the device, plus the server when signed in) gives category boosts that need at least 3 signals and are capped at ±10. Crowd "worth the detour?" feedback (at least 3 answers) adds +5 or −10. Every adjustment appears as a labelled line in the score.
- **Context:** weather per phase. Heavy rain adds a caution. Heavy rain + hill/ghat road + a detour over 90 minutes **suppresses** the stop. The companion adds "closing soon" logic.
- **Place intelligence:** fit and difficulty columns in `place_attributes`, the source table, seasonality, and hours.
- **Admin dashboard:** funnel KPIs, provider health, API latency, recent errors, place search/edit/disable/flag, per-place performance, feedback and the audit log.
- **Background jobs:** session purge, daily metric roll-up, auto-flagging places travellers say are not worth it, and OSM ingestion that stores new places disabled and flagged for review.
- **Monetisation guard:** a `sponsored` flag exists for labelling only. A unit test proves sponsored and unsponsored places score identically.

**Tests run:** 6 unit tests and 1 browser test for the admin dashboard. All passing.

**Next (when there is real usage):** measure the funnel (open → add → keep). Tune `SCORING` weights using real add and skip rates. Add traffic and road-condition providers behind new contracts. Consider learning-to-rank only once there are thousands of decisions, and keep the explanations.

---

## Full system test (final run)

| Suite | Result |
|---|---|
| `npm test` (unit + integration) | **43 / 43 passed** |
| `npm run test:e2e` (Chromium, against the real server) | **16 / 16 passed** — Phase 1 ×9, Phase 2 ×3, critical path, companion, admin, standalone file |
| Standalone file via `file://` | Styled, image inline, journey works, no failed requests |
| Browser console | Checked in every browser test: no errors |
| Live provider check | ✘ Not run here: the sandbox returns HTTP 403 for all external hosts. Needs your machine |

---

## Production Step 1 — Google / map provider foundation ✅ COMPLETE (foundation only)

- **Built:** central provider selection (`ROUTE_PROVIDER`, `GEOCODING_PROVIDER`, `PLACE_PROVIDER`, offline by default); Google adapter boundaries for routes, geocoding and places, which return controlled errors and make no network calls; separate browser and server keys with leak protection; startup log of the active providers; a friendly fallback notice; and a map rendering adapter. Live place providers now reach `/api/plan` through the same selection.
- **UI:** unchanged. Pixel comparison before and after: identical landing, warning dialog and dashboard at 1440 px and 390 px.
- **Tests:** 54 unit + integration and 17 browser tests pass. Baseline before the change was 43 + 16.
- **Not real yet:** every Google call. **Next:** Production Step 2, real routing and geocoding (Routes API computeRoutes + Geocoding API behind the existing adapters).

---

## Production Step 2 — real Google geocoding + real Google routing ✅ IMPLEMENTED (not live-verified here)

- **Built:** `GoogleGeocodingProvider.geocode()` on the Geocoding API and `GoogleRouteProvider.calculateRoute()` on the Routes API (`computeRoutes`, `DRIVE`), both behind the existing provider contracts; a shared Google request helper (header key, timeout, no retries, scrubbed errors); an encoded-polyline decoder in `shared/geo.js`; in-flight de-duplication and provider stamping in the registry; honest route-vs-detour provenance in the notices, `plan.providerStatus` and `detour.method`; `npm run check:google` for a real live check.
- **UI:** unchanged. The existing SVG map, summary strip, cards and mobile layout render the Google route as-is.
- **Tests:** 68 unit + integration and 18 browser tests pass (baseline before the change: 54 + 17). Every Google test uses an injected transport with clearly-labelled synthetic fixtures.
- **Not verified live:** no real Google request was made during development — the build sandbox has no internet access and no API key. Run `npm run check:google` with a real restricted key to confirm.
- **Still ROUTE+'s own:** place discovery, detour +km/+min, trip impact, recommendations. **Next:** Production Step 3, real place discovery.
