// Nominatim GeocodingProvider (OpenStreetMap search).
// Usage policy: max 1 request/second, a real User-Agent with contact details,
// and caching of results. https://operations.osmfoundation.org/policies/nominatim/
// For heavy production use, self-host Nominatim or use a commercial geocoder
// behind the same interface.

import { ProviderError } from '../../shared/providers/contracts.js';
import { haversineKm } from '../../shared/geo.js';
import { fetchJson, rateLimiter } from './http.js';

const USEFUL_TYPES = new Set(['city', 'town', 'village', 'municipality', 'administrative', 'suburb', 'hamlet', 'county', 'state_district', 'tourism', 'attraction']);

export function createNominatimGeocoder({ baseUrl = 'https://nominatim.openstreetmap.org', userAgent, fetchImpl, timeoutMs = 8000, countryCodes = 'in' } = {}) {
  if (!userAgent) throw new Error('Nominatim requires a User-Agent with contact details (ROUTE_PLUS_CONTACT).');
  const wait = rateLimiter(1100);
  return {
    name: 'nominatim',
    async geocode(query) {
      const q = String(query || '').trim();
      if (!q) throw new ProviderError('PLACE_NOT_FOUND', 'Please enter a place name.');
      await wait();
      const url = `${baseUrl}/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&limit=5&countrycodes=${countryCodes}`;
      const rows = await fetchJson(url, { fetchImpl, timeoutMs, headers: { 'User-Agent': userAgent, 'Accept-Language': 'en' } });
      if (!Array.isArray(rows)) throw new ProviderError('BAD_RESPONSE', 'Unexpected geocoder response');
      const hits = rows.filter(r => USEFUL_TYPES.has(r.addresstype || r.type) || r.category === 'place' || r.category === 'boundary');
      if (!hits.length) throw new ProviderError('PLACE_NOT_FOUND', `We couldn't find “${q}” in India. Check the spelling or try a nearby larger town.`);
      const [top, second] = hits;
      const label = r => [r.address?.city || r.address?.town || r.address?.village || r.name, r.address?.state].filter(Boolean).join(', ');
      // Two similarly important places far apart → ask the traveller.
      if (second && !q.includes(',') && Math.abs((top.importance || 0) - (second.importance || 0)) < 0.05 &&
          haversineKm([+top.lat, +top.lon], [+second.lat, +second.lon]) > 50) {
        const options = [...new Set(hits.slice(0, 3).map(label))];
        throw new ProviderError('AMBIGUOUS_PLACE', `“${q}” matches more than one place: ${options.join(' or ')}. Add the state, e.g. “${options[0]}”.`, { options });
      }
      return { name: top.name || label(top), lat: +top.lat, lng: +top.lon, state: top.address?.state, confidence: top.importance || 0.5, source: 'nominatim' };
    }
  };
}
