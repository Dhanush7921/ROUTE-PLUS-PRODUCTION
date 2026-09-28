// Shared foundation for the Google Maps Platform adapters.
//
// STATUS (Production Step 2): GEOCODING and main ROUTING now make real Google
// requests. Everything else (route matrix / detour legs, Places) is still an
// adapter boundary that returns a controlled ProviderError, which the registry
// treats as "recoverable", so ROUTE+ falls back to its offline providers.
// No fake geographic data is ever returned by any of them.
//
// KEY SAFETY
//  • Only GOOGLE_MAPS_SERVER_KEY is used here (server → Google web services).
//  • The key lives in a closure. It is not a property of the provider object,
//    so it cannot leak through JSON.stringify, logs, errors or API responses.
//  • Requests send it as the X-Goog-Api-Key header (see ./request.js), never
//    in a URL we log.
//  • In Google Cloud Console restrict this key to: API restrictions = Routes
//    API, Places API (New), Geocoding API; application restriction = your
//    server's IP addresses. Rotate it if it is ever exposed.

import { ProviderError } from '../../../shared/providers/contracts.js';

// Endpoints. computeRoutes + geocode are LIVE (Step 2); the rest are reserved
// for later steps and are not called.
export const GOOGLE_ENDPOINTS = Object.freeze({
  computeRoutes: 'https://routes.googleapis.com/directions/v2:computeRoutes',            // Routes API
  computeRouteMatrix: 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', // Routes API
  geocode: 'https://maps.googleapis.com/maps/api/geocode/json',                           // Geocoding API
  placesSearchText: 'https://places.googleapis.com/v1/places:searchText',                // Places API (New)
  placesSearchNearby: 'https://places.googleapis.com/v1/places:searchNearby',            // Places API (New)
  placeDetails: 'https://places.googleapis.com/v1/places/'                                // + {placeId}
});

/**
 * Builds the guard every Google adapter method calls first.
 * @param {string} label   e.g. 'route' → messages "Google route provider …"
 * @param {string} apiKey  server key (kept in the caller's closure)
 */
export function googleGuard(label, apiKey) {
  const configured = Boolean(apiKey);
  return {
    configured,
    /** Throws the controlled error for a method that is not built yet. */
    notReady(method, step) {
      if (!configured) throw new ProviderError('PROVIDER_NOT_CONFIGURED', `Google ${label} provider not configured.`, { provider: `google-${label}` });
      throw new ProviderError('PROVIDER_NOT_READY', `Google ${label} provider: ${method}() is not implemented yet (${step}).`, { provider: `google-${label}`, method });
    }
  };
}
