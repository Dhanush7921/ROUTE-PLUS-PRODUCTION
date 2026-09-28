// JOURNEYS domain: routes + detours + recommendations planning endpoint.
// POST /api/plan runs the shared geographic planner with the server's
// provider chains (live providers when enabled, offline fallbacks always),
// then stores the route, its segments and every detour calculation.

import { HttpError } from '../lib/http.js';
import { createGeoPlanner } from '../../shared/engine/geoPlanner.js';
import { createCuratedPlaceProvider } from '../../shared/providers/offline.js';
import { chain } from '../../shared/providers/registry.js';
import { NODES } from '../../shared/data/network.js';
import { INTERESTS, TRAVELERS } from '../../shared/taxonomy.js';
import { now, newId, tx, placesRepo } from '../db/database.js';

export const LIVE_FALLBACK_MESSAGE = 'Live map services are currently unavailable. ROUTE+ is using offline route data.';

export function createJourneys({ db, providers, extraPlaceProviders = [], onEvent, config = {} }) {
  const repo = placesRepo(db);
  // Places come from the database (so admin edits and disables apply at once),
  // merged with any live place providers.
  const dbPlaces = { name: 'curated', searchCorridor: query => createCuratedPlaceProvider(repo.listActive()).searchCorridor(query) };
  // Live place providers come from the central selection (providers/index.js).
  const places = chain('places', [dbPlaces, ...(providers.livePlaceProviders || []), ...extraPlaceProviders], { timeoutMs: 30000, onEvent });
  const planner = createGeoPlanner({ geocoder: providers.geocoder, router: providers.router, places, knownTowns: NODES, maxCandidates: config.maxDetourCandidates });

  function validate(body) {
    const origin = String(body.origin || '').trim();
    const destination = String(body.destination || '').trim();
    if (!origin || origin.length > 100) throw new HttpError(400, 'INVALID_ORIGIN', 'Please enter where your journey starts.', { field: 'origin' });
    if (!destination || destination.length > 100) throw new HttpError(400, 'INVALID_DESTINATION', 'Please enter your destination.', { field: 'destination' });
    const request = { origin, destination };
    if (body.travelerType && !TRAVELERS.includes(body.travelerType)) throw new HttpError(400, 'INVALID_TRAVELER', 'Unknown traveller type.');
    if (body.interests && (!Array.isArray(body.interests) || body.interests.some(i => !INTERESTS.includes(i)))) throw new HttpError(400, 'INVALID_INTERESTS', 'Unknown interest.');
    return request;
  }

  function persist(plan) {
    const routeId = newId('rte');
    tx(db, () => {
      db.prepare(`INSERT INTO routes (id, origin_name, origin_lat, origin_lng, dest_name, dest_lat, dest_lng, distance_km, duration_min, provider, method, geometry, plan_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(routeId, plan.origin.name, plan.origin.lat, plan.origin.lng, plan.destination.name, plan.destination.lat, plan.destination.lng,
          plan.route.distanceKm, plan.route.durationMin, plan.route.provider, plan.route.method, JSON.stringify(plan.route.geometry), JSON.stringify({ ...plan, routeId }), now());
      const seg = db.prepare('INSERT INTO route_segments (route_id, idx, phase_name, start_km, end_km) VALUES (?, ?, ?, ?, ?)');
      plan.phases.forEach(ph => seg.run(routeId, ph.index, ph.name, ph.startKm, ph.endKm));
      const det = db.prepare(`INSERT INTO detour_calculations (route_id, place_id, route_km, distance_from_route_km, extra_km, extra_min, strategy, method, anchor_km, rejoin_km)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const p of plan.places) det.run(routeId, p.id, p.routeKm, p.distanceFromRouteKm, p.detourDistanceKm, p.detourTimeMinutes, p.detour.strategy, p.detour.method, p.detour.anchorKm, p.detour.rejoinKm);
    });
    return routeId;
  }

  // If a live provider (e.g. Google) was selected but offline data answered,
  // say so plainly — never with the raw vendor error.
  const OFFLINE = new Set(['offline-network', 'curated']);
  function markFallback(plan) {
    const selection = providers.selection;
    if (!selection) return;
    const wantedLiveRouting = selection.routing !== 'offline';
    const wantedLiveGeocoding = selection.geocoding !== 'offline';
    const usedOfflineRouting = OFFLINE.has(plan.route.provider);
    const geocodingUsed = plan.origin?.provider || 'offline-network';
    const usedOfflineGeocoding = OFFLINE.has(geocodingUsed) || OFFLINE.has(plan.destination?.provider || 'offline-network');
    plan.providerStatus = {
      requested: { routing: selection.routing, geocoding: selection.geocoding, places: selection.places },
      routingUsed: plan.route.provider,
      geocodingUsed,
      detourMethod: plan.places?.[0]?.detour?.method || null
    };
    if ((wantedLiveRouting && usedOfflineRouting) || (wantedLiveGeocoding && usedOfflineGeocoding)) {
      plan.liveFallback = true;
      plan.notices = [LIVE_FALLBACK_MESSAGE, ...(plan.notices || [])];
    }
  }

  return {
    async plan(body) {
      const request = validate(body);
      try {
        const plan = await planner.plan(request);
        markFallback(plan);
        plan.routeId = persist(plan);
        return plan;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        const status = { PLACE_NOT_FOUND: 422, AMBIGUOUS_PLACE: 422, SAME_PLACE: 422, NO_ROUTE: 422 }[error.code] || 503;
        // Never pass raw provider text through for outages.
        const message = status === 503 ? 'Our route service is not responding right now. Please try again shortly.' : error.message;
        throw new HttpError(status, error.code || 'PROVIDER_UNAVAILABLE', message, error.details);
      }
    },
    getRoute(id) {
      const row = db.prepare('SELECT plan_json FROM routes WHERE id = ?').get(id);
      if (!row) throw new HttpError(404, 'NOT_FOUND', 'Route not found.');
      return JSON.parse(row.plan_json);
    }
  };
}
