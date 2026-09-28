// CENTRALISED PROVIDER SELECTION — the only place that decides which map
// vendor ROUTE+ uses. Everything else asks this module.
//
//   .env                       →  resolveProviderSelection()  →  buildProviders()
//   ROUTE_PROVIDER=google          { routing: 'google', … }        Google adapter → offline
//   ROUTE_PROVIDER=offline         { routing: 'offline', … }       offline only
//
// Rules
//  • Defaults are OFFLINE. With no .env the app behaves exactly as before.
//  • A choice that cannot work (unknown name, Google without a server key,
//    OpenStreetMap services without a contact email) never crashes the server:
//    it falls back to the offline provider and adds a warning for the log.
//  • Offline providers are ALWAYS the last link of every chain, so a failing
//    live provider degrades to offline data instead of an error page.
//  • This module returns only names and booleans — never key values.

export const PROVIDER_OPTIONS = {
  routing:   { offline: 'offline-network', osrm: 'osrm', google: 'google-routes' },
  geocoding: { offline: 'offline-network', nominatim: 'nominatim', google: 'google-geocoding' },
  places:    { curated: 'curated', overpass: 'openstreetmap', google: 'google-places' }
};

const DEFAULTS = { routing: 'offline', geocoding: 'offline', places: 'curated' };
const LEGACY_LIVE = { routing: 'osrm', geocoding: 'nominatim', places: 'overpass' };
const NEEDS_CONTACT = new Set(['osrm', 'nominatim', 'overpass']);

/**
 * @param {object} config  from loadConfig()
 * @returns {{ routing, geocoding, places, weather: boolean, warnings: string[] }}
 */
export function resolveProviderSelection(config) {
  const requested = {
    routing: config.routeProvider,
    geocoding: config.geocodingProvider,
    places: config.placeProvider
  };
  const selection = {};
  const warnings = [];

  for (const kind of Object.keys(DEFAULTS)) {
    // Explicit setting wins; otherwise the older ROUTE_PLUS_LIVE_PROVIDERS switch; otherwise offline.
    let choice = (requested[kind] || (config.liveProviders ? LEGACY_LIVE[kind] : DEFAULTS[kind])).toLowerCase();
    if (!PROVIDER_OPTIONS[kind][choice]) {
      warnings.push(`Unknown ${kind} provider "${choice}" — using ${DEFAULTS[kind]}. Options: ${Object.keys(PROVIDER_OPTIONS[kind]).join(', ')}.`);
      choice = DEFAULTS[kind];
    }
    if (choice === 'google' && !config.googleServerKeyConfigured) {
      warnings.push(`${kind} provider "google" needs GOOGLE_MAPS_SERVER_KEY — using ${DEFAULTS[kind]} until it is set.`);
      choice = DEFAULTS[kind];
    }
    if (NEEDS_CONTACT.has(choice) && !config.contactConfigured) {
      warnings.push(`${kind} provider "${choice}" (OpenStreetMap service) needs ROUTE_PLUS_CONTACT — using ${DEFAULTS[kind]}.`);
      choice = DEFAULTS[kind];
    }
    selection[kind] = choice;
  }
  // Weather (Phase 4 context) keeps its existing switch.
  selection.weather = Boolean(config.liveProviders && config.contactConfigured);
  selection.warnings = warnings;
  return selection;
}
