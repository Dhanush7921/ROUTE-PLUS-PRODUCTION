# ROUTE+ HTTP API

All endpoints are JSON. Writes need `Content-Type: application/json`. Errors always look like this:
`{ "error": { "code": "PLACE_NOT_FOUND", "message": "friendly text", "details": { "field": "destination" } } }`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | – | Status and active providers: `providers.mode`, `routing[]`, `geocoding[]`, `places[]`, `mapRenderer`, `googleMaps.{serverKeyConfigured, browserKeyConfigured}` (booleans only, never keys) |
| POST | `/api/auth/signup` | – | `{ email, password, displayName }` → sets the session cookie |
| POST | `/api/auth/login` | – | `{ email, password }` |
| POST | `/api/auth/logout` | – | Ends the session |
| GET | `/api/me` | optional | `{ user, preferences }` |
| PATCH | `/api/me` | user | `{ displayName }` |
| PUT | `/api/me/preferences` | user | `{ travelerType, interests[], defaultDays, locationOptIn }` |
| POST | `/api/plan` | – | `{ origin, destination }` → `{ plan }` (route, phases, places with detours) |
| GET | `/api/routes/:id` | – | A stored plan |
| GET | `/api/trips` | user | `{ trips, history }` |
| POST | `/api/trips` | user | Save a journey (include `serverTripId` to update it) |
| GET / DELETE | `/api/trips/:id` | owner | Restore or delete a trip |
| POST | `/api/trips/:id/status` | owner | `{ status: planned / active / completed / archived }` |
| POST | `/api/trips/:id/visited` | owner | `{ placeId }` |
| GET | `/api/places/near?lat=&lng=&radiusKm=` | – | Active places near a point (the location is not stored) |
| POST | `/api/feedback` | optional | `{ placeId, visited, worthIt, rating?, comment?, tripId? }` |
| POST | `/api/events` | optional | `{ events: [{ name, props, sessionId }] }` (whitelisted names and properties) |
| GET | `/api/personalization` | optional | Category boosts + crowd feedback adjustments |
| POST | `/api/context` | – | `{ phases: [{ id, lat, lng }] }` → weather per phase |
| GET | `/api/admin/overview` | admin | Product funnel + system health |
| GET | `/api/admin/places?q=` | admin | Search places (including disabled ones) |
| PATCH | `/api/admin/places/:id` | admin | Edit name, category, description, caution, visit duration, quality |
| POST | `/api/admin/places/:id/(disable, enable, flag, unflag)` | admin | Moderation |
| GET | `/api/admin/performance` | admin | Opened, added, skipped and feedback per place |
| GET | `/api/admin/feedback` · `/api/admin/audit` | admin | Review |

Common error codes: `PLACE_NOT_FOUND`, `AMBIGUOUS_PLACE`, `SAME_PLACE`, `NO_ROUTE` (422); `AUTH_REQUIRED` (401); `FORBIDDEN`, `BAD_ORIGIN` (403); `NOT_FOUND` (404); `RATE_LIMITED` (429); `PROVIDER_UNAVAILABLE` (503).

## `POST /api/plan` — provenance fields (Production Step 2)

The plan says where every number came from, so nothing estimated is ever
presented as measured:

```jsonc
{
  "origin":      { "name": "Visakhapatnam", "lat": 17.68, "lng": 83.21,
                   "provider": "google-geocoding", "formattedAddress": "…", "providerPlaceId": "…" },
  "route":       { "distanceKm": 2690.4, "durationMin": 2745, "geometry": [[lat,lng], …],
                   "provider": "google-routes", "method": "road-network" },
  "providerStatus": {
    "requested":     { "routing": "google", "geocoding": "google", "places": "curated" },
    "routingUsed":   "google-routes",
    "geocodingUsed": "google-geocoding",
    "detourMethod":  "estimated"          // detour +km/+min are still ROUTE+ estimates
  },
  "liveFallback": true,                   // only when a live provider was chosen but offline answered
  "notices": ["…"]                        // plain-language provenance for the traveller
}
```

`route.method` is `road-network` only when a real road router answered.
`providerStatus.detourMethod` reports the provider that answered the detour
legs, which can differ from the main route.
