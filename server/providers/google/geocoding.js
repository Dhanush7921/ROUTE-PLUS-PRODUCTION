// GoogleGeocodingProvider — implements the ROUTE+ GeocodingProvider contract
// (geocode) on top of the Google Geocoding API.
//
//   "Visakhapatnam"  →  real coordinates from Google
//
// Endpoint:  GET https://maps.googleapis.com/maps/api/geocode/json
// Key:       X-Goog-Api-Key header (see ./request.js) — never in a logged URL.
// Bias:      region=in, components=country:IN — ROUTE+ plans Indian road trips.
//
// The raw Google response NEVER leaves this file. Callers receive the
// normalised ROUTE+ result:
//   { provider, providerPlaceId, name, latitude, longitude, formattedAddress }
// plus the lat / lng / state / confidence / source fields the existing engine
// and the offline geocoder already use, so nothing downstream had to change.
//
// Errors are ROUTE+ errors, never vendor text:
//   ZERO_RESULTS             → PLACE_NOT_FOUND   (not recoverable: Google knows
//                              far more places than the offline list, so a real
//                              "no such place" must not silently fall back)
//   two far-apart matches    → AMBIGUOUS_PLACE   (with { options } for the UI)
//   OVER_QUERY_LIMIT / 429   → RATE_LIMITED      ┐ recoverable: the registry
//   REQUEST_DENIED / 401/403 → PROVIDER_UNAVAILABLE │ falls back to the offline
//   timeout                  → TIMEOUT           │ geocoder and the app keeps
//   malformed / no coords    → BAD_RESPONSE      ┘ working.

import { ProviderError } from '../../../shared/providers/contracts.js';
import { haversineKm } from '../../../shared/geo.js';
import { googleGuard, GOOGLE_ENDPOINTS } from './common.js';
import { googleJsonWithKeyFallback } from './request.js';

// Google's own status words → ROUTE+ codes.
const STATUS_CODES = {
  ZERO_RESULTS: 'PLACE_NOT_FOUND',
  OVER_QUERY_LIMIT: 'RATE_LIMITED',
  OVER_DAILY_LIMIT: 'RATE_LIMITED',
  REQUEST_DENIED: 'PROVIDER_UNAVAILABLE',
  INVALID_REQUEST: 'BAD_RESPONSE',
  UNKNOWN_ERROR: 'PROVIDER_UNAVAILABLE'
};
const CONFIDENCE = { ROOFTOP: 1, RANGE_INTERPOLATED: 0.9, GEOMETRIC_CENTER: 0.85, APPROXIMATE: 0.75 };
const AMBIGUOUS_KM = 50; // two matches further apart than this are different towns

const component = (result, type) => result.address_components?.find(c => c.types?.includes(type))?.long_name;

/** One Google result → the ROUTE+ geocode model. */
export function normalizeGoogleGeocode(result) {
  const loc = result?.geometry?.location;
  const latitude = Number(loc?.lat);
  const longitude = Number(loc?.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw new ProviderError('BAD_RESPONSE', 'Google returned a place without usable coordinates.');
  }
  const name = component(result, 'locality') || component(result, 'administrative_area_level_3')
    || component(result, 'administrative_area_level_2') || String(result.formatted_address || '').split(',')[0].trim();
  return {
    // normalised contract
    provider: 'google-geocoding',
    providerPlaceId: result.place_id || null,
    name,
    latitude,
    longitude,
    formattedAddress: result.formatted_address || name,
    // fields the existing ROUTE+ engine already reads
    lat: latitude,
    lng: longitude,
    state: component(result, 'administrative_area_level_1'),
    confidence: (CONFIDENCE[result.geometry?.location_type] ?? 0.8) * (result.partial_match ? 0.6 : 1),
    source: 'google-geocoding'
  };
}

export function createGoogleGeocodingProvider({ apiKey = '', fetchImpl, timeoutMs = 8000, region = 'in', country = 'IN' } = {}) {
  const guard = googleGuard('geocoding', apiKey);
  const state = {}; // remembers how this endpoint accepts the key (header vs ?key=)

  return {
    name: 'google-geocoding',
    status: guard.configured ? 'live' : 'not-configured',
    endpoints: { geocode: GOOGLE_ENDPOINTS.geocode },

    /** Place name → normalised geocode result (India-biased). */
    async geocode(query) {
      if (!guard.configured) guard.notReady('geocode', 'configuration');
      const q = String(query || '').trim();
      if (!q) throw new ProviderError('PLACE_NOT_FOUND', 'Please enter a place name.');
      if (q.length > 100) throw new ProviderError('PLACE_NOT_FOUND', 'That place name is too long.');

      const params = new URLSearchParams({ address: q, region, components: `country:${country}`, language: 'en' });
      const body = await googleJsonWithKeyFallback(state, {
        url: `${GOOGLE_ENDPOINTS.geocode}?${params}`,
        apiKey, fetchImpl, timeoutMs, label: 'Google geocoding'
      });

      // A vendor status that means "the service said no" is mapped first — it
      // must never be mistaken for "that place does not exist".
      const status = body.status;
      if (status !== 'OK') {
        if (status !== 'ZERO_RESULTS' && STATUS_CODES[status]) {
          throw new ProviderError(STATUS_CODES[status], `Google geocoding is not available right now (${String(status).slice(0, 30)}).`);
        }
        if (status === 'ZERO_RESULTS' || !body.results?.length) {
          throw new ProviderError('PLACE_NOT_FOUND', `We couldn't find “${q}” in India. Check the spelling or try a nearby larger town.`);
        }
        throw new ProviderError('BAD_RESPONSE', `Google geocoding returned an unexpected status (${String(status).slice(0, 30)}).`);
      }
      const results = body.results.filter(r => r?.geometry?.location);
      if (!results.length) throw new ProviderError('PLACE_NOT_FOUND', `We couldn't find “${q}” in India. Check the spelling or try a nearby larger town.`);

      const top = normalizeGoogleGeocode(results[0]);
      // Two genuinely different places with the same name → ask the traveller,
      // rather than silently planning a journey to the wrong one.
      const other = results.slice(1, 4).map(normalizeGoogleGeocode)
        .find(r => haversineKm([top.latitude, top.longitude], [r.latitude, r.longitude]) > AMBIGUOUS_KM);
      if (other && !q.includes(',')) {
        const options = [...new Set([top.formattedAddress, other.formattedAddress])];
        throw new ProviderError('AMBIGUOUS_PLACE', `“${q}” matches more than one place: ${options.join(' or ')}. Add the state, e.g. “${options[0]}”.`, { options });
      }
      return top;
    }
  };
}
