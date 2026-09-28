// GoogleRouteProvider — implements the ROUTE+ RouteProvider contract
// (route + legs) on top of the Google Routes API.
//
//   Visakhapatnam → Manali  →  real road distance, driving time and geometry
//
// Endpoint:  POST https://routes.googleapis.com/directions/v2:computeRoutes
// Key:       X-Goog-Api-Key header (see ./request.js).
// Mode:      DRIVE, TRAFFIC_UNAWARE (one predictable call, no live-traffic
//            pricing tier), HIGH_QUALITY polyline, no alternative routes.
// Fields:    a strict X-Goog-FieldMask — Google bills by the fields you ask
//            for, so we ask for distance, duration, the polyline and leg costs
//            and nothing else.
//
// ONE journey = ONE computeRoutes request. There is no retry loop here: a
// failure returns a recoverable ProviderError and the registry falls back to
// the offline road network, so the app keeps working and the bill does not.
//
// The raw Google response never leaves this file. Callers get the normalised
// ROUTE+ route:
//   { id, provider, origin, destination, distanceKm, durationMinutes,
//     geometry: [[lat, lng], …], legs: [{ distanceKm, durationMinutes }] }
// plus durationMin / segments / method for the existing engine and UI.
//
// NOT in this step: calculateRouteMatrix (the real detour engine, Step 4).
// It still returns a controlled PROVIDER_NOT_READY error, so detour +km/+min
// figures keep coming from the offline estimator and are labelled "estimated".

import { ProviderError } from '../../../shared/providers/contracts.js';
import { decodePolyline } from '../../../shared/geo.js';
import { googleGuard, GOOGLE_ENDPOINTS } from './common.js';
import { googleJson, durationToMinutes } from './request.js';

const FIELD_MASK = 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.legs.distanceMeters,routes.legs.duration';
const point = ([lat, lng]) => ({ location: { latLng: { latitude: lat, longitude: lng } } });
const valid = p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;

/** One Google route → the ROUTE+ route model. Throws BAD_RESPONSE if unusable. */
export function normalizeGoogleRoute(route, points) {
  const distanceKm = Number(route?.distanceMeters) / 1000;
  const durationMinutes = durationToMinutes(route?.duration);
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) throw new ProviderError('BAD_RESPONSE', 'Google returned a route without a usable distance.');
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) throw new ProviderError('BAD_RESPONSE', 'Google returned a route without a usable duration.');

  let geometry;
  try {
    geometry = decodePolyline(route?.polyline?.encodedPolyline ?? '');
  } catch {
    throw new ProviderError('BAD_RESPONSE', 'Google returned road geometry that could not be read.');
  }
  if (geometry.length < 2 || !geometry.every(valid)) throw new ProviderError('BAD_RESPONSE', 'Google returned road geometry that could not be read.');

  const legs = (route?.legs || []).map(l => {
    const km = Number(l?.distanceMeters) / 1000;
    const min = durationToMinutes(l?.duration);
    return { distanceKm: Number.isFinite(km) ? km : 0, durationMinutes: Number.isFinite(min) ? min : 0, durationMin: Number.isFinite(min) ? min : 0, type: 'road' };
  });

  const origin = { latitude: points[0][0], longitude: points[0][1] };
  const destination = { latitude: points.at(-1)[0], longitude: points.at(-1)[1] };
  const fix = n => n.toFixed(4);
  return {
    // normalised contract
    id: `google:${fix(origin.latitude)},${fix(origin.longitude)}->${fix(destination.latitude)},${fix(destination.longitude)}`,
    provider: 'google-routes',
    origin,
    destination,
    distanceKm,
    durationMinutes,
    geometry,
    legs,
    // fields the existing ROUTE+ engine and UI already read
    durationMin: durationMinutes,
    method: 'road-network',
    segments: legs.length > 1 ? legs.map(l => ({ km: l.distanceKm, min: l.durationMinutes, type: 'road' })) : undefined
  };
}

export function createGoogleRouteProvider({ apiKey = '', fetchImpl, timeoutMs = 12000, region = 'IN' } = {}) {
  const guard = googleGuard('route', apiKey);
  const provider = {
    name: 'google-routes',
    method: 'road-network',
    status: guard.configured ? 'live' : 'not-configured',
    endpoints: { route: GOOGLE_ENDPOINTS.computeRoutes, matrix: GOOGLE_ENDPOINTS.computeRouteMatrix },

    /** Main route with real road geometry, distance and duration. */
    async calculateRoute(points) {
      if (!guard.configured) guard.notReady('calculateRoute', 'configuration');
      if (!Array.isArray(points) || points.length < 2 || !points.every(valid)) {
        throw new ProviderError('NO_ROUTE', 'A route needs at least two valid points.');
      }
      if (points.length > 12) throw new ProviderError('NO_ROUTE', 'Too many waypoints for one route request.');

      const body = await googleJson({
        url: GOOGLE_ENDPOINTS.computeRoutes,
        method: 'POST',
        apiKey, fetchImpl, timeoutMs,
        label: 'Google routing',
        headers: { 'X-Goog-FieldMask': FIELD_MASK },
        body: {
          origin: point(points[0]),
          destination: point(points.at(-1)),
          intermediates: points.slice(1, -1).map(point),
          travelMode: 'DRIVE',
          routingPreference: 'TRAFFIC_UNAWARE',
          polylineQuality: 'HIGH_QUALITY',
          polylineEncoding: 'ENCODED_POLYLINE',
          computeAlternativeRoutes: false,
          units: 'METRIC',
          languageCode: 'en-IN',
          regionCode: region
        }
      });
      if (!Array.isArray(body.routes) || !body.routes.length) {
        throw new ProviderError('NO_ROUTE', 'Google could not find a driving route between these places.');
      }
      return normalizeGoogleRoute(body.routes[0], points);
    },

    /** Many origin→destination costs in one call (Routes API computeRouteMatrix). */
    async calculateRouteMatrix(pairs) { return guard.notReady('calculateRouteMatrix', 'Production Step 4 — real detour engine'); },

    // ---- RouteProvider contract used by the existing engine
    route(points) { return provider.calculateRoute(points); },
    legs(pairs) { return provider.calculateRouteMatrix(pairs); }
  };
  return provider;
}
