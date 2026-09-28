// Builds the provider chains the server uses. WHICH vendor is used is decided
// in ONE place — ./selection.js — from environment variables:
//
//   ROUTE_PROVIDER      offline (default) | osrm      | google
//   GEOCODING_PROVIDER  offline (default) | nominatim | google
//   PLACE_PROVIDER      curated (default) | overpass  | google
//
// Every chain ends with the offline provider, so a missing key, an outage or
// an adapter that is not built yet degrades to offline data — never a crash.
// The older ROUTE_PLUS_LIVE_PROVIDERS=1 switch still selects OSRM/Nominatim/
// Overpass when the variables above are not set.

import { chain, createCache } from '../../shared/providers/registry.js';
import { createOfflineGeocoder, createOfflineRouter, createCuratedPlaceProvider } from '../../shared/providers/offline.js';
import { resolveProviderSelection } from './selection.js';
import { createOsrmRouter } from './osrm.js';
import { createNominatimGeocoder } from './nominatim.js';
import { createOverpassPlaceProvider } from './overpass.js';
import { createWeatherProvider } from './openmeteo.js';
import { createGoogleRouteProvider } from './google/routes.js';
import { createGoogleGeocodingProvider } from './google/geocoding.js';
import { createGooglePlaceProvider } from './google/places.js';

export function buildProviders(config, { onEvent, fetchImpl } = {}) {
  const selection = resolveProviderSelection(config);
  const cache = createCache({ max: 2000, ttlMs: config.cacheTtlMs });
  const serverKey = config.googleMapsServerKey || ''; // non-enumerable, never logged
  const userAgent = `ROUTE+/0.2 (${config.contact})`;

  const liveGeocoder = {
    offline: null,
    nominatim: () => createNominatimGeocoder({ baseUrl: config.nominatimUrl, userAgent, fetchImpl }),
    google: () => createGoogleGeocodingProvider({ apiKey: serverKey, fetchImpl })
  }[selection.geocoding];
  const liveRouter = {
    offline: null,
    osrm: () => createOsrmRouter({ baseUrl: config.osrmUrl, durationFactor: config.osrmDurationFactor, fetchImpl }),
    google: () => createGoogleRouteProvider({ apiKey: serverKey, fetchImpl })
  }[selection.routing];
  const livePlaces = {
    curated: null,
    overpass: () => createOverpassPlaceProvider({ baseUrl: config.overpassUrl, fallbackUrl: config.overpassFallbackUrl, chunkKm: config.overpassChunkKm, userAgent, fetchImpl, cache }),
    google: () => createGooglePlaceProvider({ apiKey: serverKey, fetchImpl })
  }[selection.places];

  // Offline versions are always last: the app never has "no answer".
  const geocoders = [liveGeocoder?.(), createOfflineGeocoder()].filter(Boolean);
  const routers = [liveRouter?.(), createOfflineRouter()].filter(Boolean);
  const livePlaceProviders = [livePlaces?.()].filter(Boolean);
  const places = [createCuratedPlaceProvider(), ...livePlaceProviders];

  return {
    geocoder: chain('geocoding', geocoders, { timeoutMs: 8000, onEvent, cache }),
    router: chain('routing', routers, { timeoutMs: 12000, onEvent, cache }),
    places: chain('places', places, { timeoutMs: 30000, onEvent }),
    // The server merges these with its DATABASE copy of the curated places.
    livePlaceProviders,
    weather: selection.weather ? createWeatherProvider({ fetchImpl, cache }) : null,
    selection,
    // Safe to log and to return from /api/health: names and booleans only.
    summary: {
      mode: [selection.routing, selection.geocoding, selection.places].some(v => !['offline', 'curated'].includes(v)) ? 'live' : 'offline',
      geocoding: geocoders.map(p => p.name),
      routing: routers.map(p => p.name),
      places: places.map(p => p.name),
      weather: selection.weather ? 'open-meteo' : 'off',
      // Frontend map display. Google Maps JS rendering is a later step.
      mapRenderer: 'routeplus-svg',
      googleMaps: { serverKeyConfigured: Boolean(config.googleServerKeyConfigured), browserKeyConfigured: Boolean(config.googleBrowserKeyConfigured) }
    }
  };
}

/** Human-readable startup lines — provider names only, never key values. */
export function describeProviders(summary, warnings = []) {
  return [
    `providers (${summary.mode} mode):`,
    `  geocoding: ${summary.geocoding.join(' → ')}`,
    `  routing:   ${summary.routing.join(' → ')}`,
    `  places:    ${summary.places.join(' + ')}`,
    `  weather:   ${summary.weather}`,
    `  google keys: server ${summary.googleMaps.serverKeyConfigured ? 'set' : 'not set'}, browser ${summary.googleMaps.browserKeyConfigured ? 'set' : 'not set'}`,
    // Say plainly which Google services actually make requests today.
    ...(summary.routing.includes('google-routes') || summary.geocoding.includes('google-geocoding')
      ? ['  note: Google geocoding and main-route requests are live; detour (+km/+min) figures still use offline estimates.'] : []),
    ...(summary.places.includes('google-places')
      ? ['  note: the Google Places adapter is a boundary only — place results come from the curated list.'] : []),
    ...warnings.map(w => `  ! ${w}`)
  ].join('\n');
}
