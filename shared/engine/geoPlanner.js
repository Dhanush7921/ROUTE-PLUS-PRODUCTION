// GEOGRAPHIC PLANNER (Phase 2)
//
//   journey request
//     → geocode origin + destination           (GeocodingProvider)
//     → main route with geometry               (RouteProvider)
//     → split into route phases / corridors
//     → candidate places inside the corridor   (PlaceProvider)
//     → normalise, de-duplicate, filter        (placePipeline)
//     → detour cost for every candidate        (detour engine)
//     → JourneyPlan (same shape as Phase 1, so the UI just works)

import { CORRIDOR } from '../config.js';
import { simplify, sliceLine, round } from '../geo.js';
import { buildRouteIndex } from './routeIndex.js';
import { runPlacePipeline } from './placePipeline.js';
import { computeDetours } from './detour.js';
import { PlanError } from './mockPlanner.js';
import { ProviderError } from '../providers/contracts.js';

const MAX_DETOUR_MIN = 300;      // longer detours are day trips, not stops
const MAX_CANDIDATES = 120;      // keep the page fast on very long routes

function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

/** Geocoded endpoint → the plan's origin/destination shape. */
const endpoint = g => ({
  name: g.name,
  lat: g.lat ?? g.latitude,
  lng: g.lng ?? g.longitude,
  provider: g.provider || g.source || 'offline-network',
  ...(g.formattedAddress ? { formattedAddress: g.formattedAddress } : {}),
  ...(g.providerPlaceId ? { providerPlaceId: g.providerPlaceId } : {})
});

const PLACES_NOTICE = 'Place details are editorial and may change — confirm hours and access locally.';
/**
 * Honest provenance for the two numbers travellers read. The main route and the
 * detour (+km / +min) figures can come from DIFFERENT providers, so they are
 * described separately — a real Google route must never imply that the detour
 * estimates are real road measurements too.
 */
export function routeNotices(routeMethod, detourMethod) {
  const realRoute = routeMethod === 'road-network';
  const realDetours = detourMethod === 'road-network';
  if (realRoute && realDetours) return ['Route and detours calculated on the real road network.', PLACES_NOTICE];
  if (realRoute) return ['Main route distance and driving time come from real road routing. Detour (+km / +min) figures are still ROUTE+ estimates.', PLACES_NOTICE];
  return ['Route and detour distances are estimated from a simplified road network (typically within ~10 %). Not for navigation.', PLACES_NOTICE];
}

export function buildPhases(index, planId, count = CORRIDOR.phaseCount) {
  const total = index.totalKm;
  const n = total < 150 ? 2 : total < 400 ? 3 : count;
  return Array.from({ length: n }, (_, i) => {
    const startKm = total * i / n;
    const endKm = total * (i + 1) / n;
    const from = index.nearestTown(startKm) || `km ${Math.round(startKm)}`;
    const to = index.nearestTown(endKm) || `km ${Math.round(endKm)}`;
    return {
      id: `${planId}-phase-${i + 1}`,
      index: i,
      name: from === to ? `Around ${from}` : `${from} – ${to}`,
      startKm: round(startKm, 0),
      endKm: round(endKm, 0),
      geometry: sliceLine(index.geometry, index.cum, startKm * index.cum.at(-1) / total, endKm * index.cum.at(-1) / total)
    };
  });
}

/**
 * @param {number} [o.maxCandidates]  how many corridor places get a (real,
 *   road-network) detour calculation. Each one costs three legs on the routing
 *   provider, so this is the knob that keeps live discovery practical.
 */
export function createGeoPlanner({ geocoder, router, places, knownTowns = [], now = () => new Date(), maxCandidates = MAX_CANDIDATES }) {
  async function locate(query, field) {
    try {
      const r = await geocoder.geocode(query);
      // Accept either naming (offline: lat/lng, normalised contract: latitude/longitude).
      const lat = r.lat ?? r.latitude;
      const lng = r.lng ?? r.longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new ProviderError('BAD_RESPONSE', 'The place lookup returned no usable coordinates.');
      }
      return { ...r, lat, lng, latitude: lat, longitude: lng };
    } catch (error) {
      if (error instanceof ProviderError) throw new PlanError(error.code, error.message, { ...error.details, field });
      throw error;
    }
  }

  return {
    name: 'geo',
    async plan(request) {
      const [origin, destination] = await Promise.all([locate(request.origin, 'origin'), locate(request.destination, 'destination')]);
      if (Math.abs(origin.lat - destination.lat) < 0.01 && Math.abs(origin.lng - destination.lng) < 0.01) {
        throw new PlanError('SAME_PLACE', 'Start and destination are the same place.', { field: 'destination' });
      }

      let route;
      try {
        route = await router.route([[origin.lat, origin.lng], [destination.lat, destination.lng]]);
      } catch (error) {
        throw new PlanError(error.code || 'NO_ROUTE', error.message, {});
      }
      // Live routes have no town names: label them with known towns near the line.
      if (!route.waypoints?.length && knownTowns.length) {
        const temp = buildRouteIndex(route);
        route.waypoints = knownTowns.filter(t => temp.distanceTo([t.lat, t.lng]) < 8);
      }
      const index = buildRouteIndex(route);
      const id = `${slug(origin.name)}-${slug(destination.name)}`;
      const phases = buildPhases(index, id);

      const bufferKm = Math.min(CORRIDOR.maxDistanceKm, Math.max(15, route.distanceKm * 0.15));
      const raw = await places.searchCorridor({ geometry: route.geometry, bufferKm });
      const month = now().getMonth() + 1;
      const pipeline = runPlacePipeline(raw, { travelMonth: month });

      // CANDIDATE SELECTION — before the road-network detour calls.
      //
      // Live discovery (OpenStreetMap) can return far more candidates than the
      // route corridor really contains, and every candidate costs three legs on
      // the road-network router. So the corridor is applied here, with cheap
      // local geometry (no provider calls): project each place onto the main
      // route, drop anything outside the corridor, and keep the ones closest to
      // the road first. Truncation is therefore by distance from the route —
      // never "whichever provider happened to answer first".
      const candidates = pipeline
        .map(p => ({ p, d: index.project([p.lat, p.lng]).distanceKm }))
        .filter(x => x.d <= bufferKm + 0.5)
        .sort((a, b) => a.d - b.d)
        .slice(0, maxCandidates)
        .map(x => x.p);

      const withDetours = (await computeDetours(index, candidates, router))
        .filter(p => p.detourTimeMinutes <= MAX_DETOUR_MIN)
        .sort((a, b) => a.routeKm - b.routeKm)
        .map(p => {
          const phase = phases.find(ph => p.routeKm >= ph.startKm && p.routeKm <= ph.endKm) || phases.at(-1);
          return { ...p, routePhase: phase.id, phaseIndex: phase.index };
        });

      return {
        id,
        mode: 'geo',
        generatedAt: now().toISOString(),
        // `provider` / `formattedAddress` let the app say honestly WHERE the
        // coordinates came from. The UI still reads only `name`, `lat`, `lng`.
        origin: endpoint(origin),
        destination: endpoint(destination),
        route: {
          distanceKm: round(route.distanceKm, 1),
          durationMin: Math.round(route.durationMin),
          geometry: simplify(route.geometry, 0.3).map(([a, b]) => [round(a, 5), round(b, 5)]),
          waypoints: index.waypoints.map(w => ({ name: w.name, lat: w.lat, lng: w.lng, routeKm: round(w.routeKm, 1) })),
          segments: route.segments?.map(s => ({ km: round(s.km, 2), min: round(s.min, 2), type: s.type })),
          provider: route.provider || router.name,
          method: route.method || router.method || 'estimated'
        },
        phases: phases.map(({ geometry, ...ph }) => ({ ...ph, geometry: simplify(geometry, 0.5) })),
        places: withDetours,
        placeSource: [...new Set(withDetours.flatMap(p => p.sources))].join(' + ') || 'none',
        // Exactly how many places each source contributed. Counted from the
        // places themselves, so it can never claim a live discovery that did
        // not happen: if OpenStreetMap failed or found nothing, it is absent.
        placeCounts: withDetours.reduce((counts, p) => {
          const provider = p.source?.provider || 'unknown';
          counts[provider] = (counts[provider] || 0) + 1;
          return counts;
        }, {}),
        candidatesConsidered: candidates.length,
        corridorKm: round(bufferKm, 0),
        notices: routeNotices(route.method || router.method, withDetours[0]?.detour?.method || router.legsMethod || router.method)
      };
    }
  };
}
