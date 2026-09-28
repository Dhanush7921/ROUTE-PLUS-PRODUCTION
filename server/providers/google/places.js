// GooglePlaceProvider — implements the ROUTE+ PlaceProvider contract
// (searchCorridor) on top of Google Places API (New).
// Step 1: adapter boundary only. Real requests arrive in Production Step 3.
// Note for Step 3: Google Places terms restrict caching/storing most place
// content — keep only place IDs long-term and refresh details when shown.

import { googleGuard, GOOGLE_ENDPOINTS } from './common.js';

export function createGooglePlaceProvider({ apiKey = '', fetchImpl } = {}) {
  const guard = googleGuard('places', apiKey);
  void fetchImpl;
  const provider = {
    name: 'google-places',
    status: guard.configured ? 'adapter-ready' : 'not-configured',
    endpoints: { searchText: GOOGLE_ENDPOINTS.placesSearchText, searchNearby: GOOGLE_ENDPOINTS.placesSearchNearby, details: GOOGLE_ENDPOINTS.placeDetails },

    /** Text or nearby search → raw ROUTE+ places (id, name, category, lat, lng, source). */
    async searchPlaces(query) { return guard.notReady('searchPlaces', 'Production Step 3 — real place data'); },

    /** Full details for one place id (hours, rating, photos attribution…). */
    async getPlaceDetails(placeId) { return guard.notReady('getPlaceDetails', 'Production Step 3 — real place data'); },

    // ---- PlaceProvider contract used by the existing engine
    searchCorridor({ geometry, bufferKm }) { return provider.searchPlaces({ geometry, bufferKm }); }
  };
  return provider;
}
