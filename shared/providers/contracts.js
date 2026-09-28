// PROVIDER CONTRACTS
// ROUTE+ never talks to a map vendor directly. It talks to three small
// interfaces. Any vendor (OSRM, Google, Mapbox, Mappls, our offline network)
// can be plugged in by implementing them. Swap vendors without touching the
// engine or the screens.
//
// GeocodingProvider
//   name: string
//   geocode(query: string) → Promise<{ name, lat, lng, state?, confidence, source }>
//     throws ProviderError PLACE_NOT_FOUND | AMBIGUOUS_PLACE (with details.options)
//   knownPlaces?() → string[]          (optional: autocomplete list)
//
// RouteProvider
//   name: string, method: 'road-network' | 'estimated'
//   route(points: [lat,lng][]) → Promise<Route>
//     Route = { distanceKm, durationMin, geometry: [lat,lng][],
//               waypoints?: [{ name, lat, lng }], segments?: [{ km, min, type }] }
//     throws ProviderError NO_ROUTE
//   legs(pairs: [[lat,lng],[lat,lng]][]) → Promise<[{ distanceKm, durationMin }]>
//     many point-to-point costs in one call (batched for efficiency)
//
// PlaceProvider
//   name: string
//   searchCorridor({ geometry, bufferKm }) → Promise<RawPlace[]>
//     RawPlace needs at least { id, name, category, lat, lng, source }
//
// Every provider error is a ProviderError with a stable `code`, so the UI can
// show a friendly message and the registry can fall back to another provider.

export class ProviderError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.details = details;
  }
}

export const ERROR_CODES = ['PLACE_NOT_FOUND', 'AMBIGUOUS_PLACE', 'NO_ROUTE', 'PROVIDER_UNAVAILABLE', 'TIMEOUT', 'RATE_LIMITED', 'BAD_RESPONSE', 'PROVIDER_NOT_CONFIGURED', 'PROVIDER_NOT_READY'];

/** Errors that mean "this provider is broken right now — try the next one". */
// PROVIDER_NOT_CONFIGURED / PROVIDER_NOT_READY: a selected live adapter (e.g. Google)
// has no key or is not built yet — fall back to offline instead of failing.
export const isRecoverable = error => ['PROVIDER_UNAVAILABLE', 'TIMEOUT', 'RATE_LIMITED', 'BAD_RESPONSE', 'PROVIDER_NOT_CONFIGURED', 'PROVIDER_NOT_READY'].includes(error?.code);

export function assertProvider(kind, provider) {
  const required = { geocoding: ['geocode'], routing: ['route', 'legs'], places: ['searchCorridor'] }[kind];
  for (const fn of required) {
    if (typeof provider?.[fn] !== 'function') throw new TypeError(`${provider?.name || 'provider'} is not a valid ${kind} provider: missing ${fn}()`);
  }
  return provider;
}
