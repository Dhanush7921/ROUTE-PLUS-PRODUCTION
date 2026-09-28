// Overpass PlaceProvider — candidate places from OpenStreetMap.
// Query: named attractions within `bufferKm` of the route polyline, in chunks
// so long routes do not time out. Only places with a Wikipedia/Wikidata link
// (or naturally notable types like waterfalls and viewpoints) are kept — a
// simple, transparent quality filter against low-value records.
// Data © OpenStreetMap contributors, ODbL. Attribution is shown in the app.
//
// WHY THE QUERY IS SHAPED THIS WAY (public Overpass is a shared, free service)
// `around:radius,lat,lng,lat,lng,…` searches a BUFFER AROUND THE POLYLINE those
// points describe, and the query repeats that filter once per tag group. The
// work therefore grows with the buffered area — radius × length of road — and
// with the number of vertices the server has to buffer. A whole 300 km stretch
// at a 40 km radius is roughly 30,000 km² scanned seven times: that is what
// times out. So each request now covers a SHORTER stretch of road (configurable
// `chunkKm`, was 300) described by FEWER vertices (simplified to a tolerance
// that is negligible inside the buffer, with a hard vertex cap). Requests stay
// strictly sequential with a short pause between them — never parallel, never a
// retry storm. The fix is a cheaper question, not a longer timeout: the client
// timeout and the Overpass-side `[timeout:]` both went DOWN.

import { fetchJson } from './http.js';
import { simplify, cumulativeKm, sliceLine } from '../../shared/geo.js';
import { isRecoverable } from '../../shared/providers/contracts.js';

export const OVERPASS_DEFAULTS = {
  chunkKm: 120,             // was 300 — shorter stretch of road per request
  toleranceFactor: 0.15,    // vertex tolerance = 0.15 × radius (invisible in the buffer)
  minToleranceKm: 3,        // never coarser-grained than the previous behaviour
  maxVerticesPerQuery: 24,  // hard ceiling on polyline vertices in one request
  queryTimeoutS: 25,        // Overpass-side budget, inside the client timeout (was 40)
  timeoutMs: 30000,         // client timeout (lower than the previous 45 s, not higher)
  delayMs: 1000             // polite pause BETWEEN sequential chunk requests
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * The polyline sent in one `around:` filter: the same stretch of road, drawn
 * with as few vertices as the buffer can't tell apart. A deviation of a few km
 * is immaterial inside a 15–45 km buffer, and every vertex removed is geometry
 * the public server does not have to buffer.
 */
export function corridorPoints(line, radiusKm, {
  toleranceFactor = OVERPASS_DEFAULTS.toleranceFactor,
  minToleranceKm = OVERPASS_DEFAULTS.minToleranceKm,
  maxVerticesPerQuery = OVERPASS_DEFAULTS.maxVerticesPerQuery
} = {}) {
  if (line.length < 3) return line.slice();
  let tolerance = Math.max(minToleranceKm, radiusKm * toleranceFactor);
  let points = simplify(line, tolerance);
  // Still too many vertices (a very winding stretch)? Coarsen until it fits.
  for (let i = 0; points.length > maxVerticesPerQuery && i < 8; i++) {
    tolerance *= 2;
    points = simplify(line, tolerance);
  }
  return points;
}

export function tagsToCategory(t = {}) {
  if (t.natural === 'waterfall' || t.waterway === 'waterfall') return 'waterfall';
  if (t.natural === 'cave_entrance') return 'cave';
  if (t.tourism === 'viewpoint' || t.natural === 'peak') return 'viewpoint';
  if (t.boundary === 'national_park' || t.leisure === 'nature_reserve') return 'wildlife';
  if (t.amenity === 'place_of_worship') {
    if (t.religion === 'buddhist') return 'monastery';
    if (t.religion === 'hindu' || t.religion === 'jain') return 'temple';
    return 'pilgrimage';
  }
  if (['fort', 'castle', 'monument', 'ruins', 'archaeological_site', 'palace', 'memorial'].includes(t.historic)) return 'heritage';
  if (t.natural === 'water' || t.water === 'lake') return 'lake';
  if (t.tourism === 'museum') return 'heritage';
  if (t.tourism === 'attraction') return 'scenic';
  return null;
}

function parseHours(value) {
  const m = /^(?:Mo-Su\s+)?(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})$/.exec(String(value || '').trim());
  return m ? { open: +m[1] * 60 + +m[2], close: +m[3] * 60 + +m[4] } : undefined;
}

export function elementToPlace(el) {
  const t = el.tags || {};
  const category = tagsToCategory(t);
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (!category || !t.name || lat == null) return null;
  const notable = t.wikidata || t.wikipedia || ['waterfall', 'viewpoint', 'cave'].includes(category);
  if (!notable) return null;
  const quality = 3.8 + (t.wikipedia ? 0.4 : 0) + (t.heritage ? 0.3 : 0) + (t['heritage:operator'] === 'asi' ? 0.2 : 0);
  return {
    id: `osm:${el.type}/${el.id}`,
    name: t['name:en'] || t.name,
    category, lat, lng,
    locality: t['addr:city'] || t['is_in'] || '',
    description: t.description || undefined,
    openingHours: parseHours(t.opening_hours),
    quality: Math.min(4.8, Math.round(quality * 10) / 10),
    entryFee: t.fee === 'no' ? 'Free' : undefined,
    source: { provider: 'openstreetmap', label: '© OpenStreetMap contributors (ODbL)', ref: `https://www.openstreetmap.org/${el.type}/${el.id}`, verified: false }
  };
}

export function buildQuery(line, radiusM, queryTimeoutS = OVERPASS_DEFAULTS.queryTimeoutS) {
  const pts = line.map(([lat, lng]) => `${lat.toFixed(4)},${lng.toFixed(4)}`).join(',');
  const a = `around:${radiusM},${pts}`;
  return `[out:json][timeout:${queryTimeoutS}];(
nwr(${a})["tourism"~"^(attraction|viewpoint|museum)$"]["name"];
nwr(${a})["natural"~"^(waterfall|cave_entrance)$"]["name"];
nwr(${a})["waterway"="waterfall"]["name"];
nwr(${a})["historic"~"^(fort|castle|monument|ruins|archaeological_site|palace)$"]["name"];
nwr(${a})["amenity"="place_of_worship"]["name"]["wikidata"];
nwr(${a})["leisure"="nature_reserve"]["name"];
nwr(${a})["boundary"="national_park"]["name"];
);out center tags 400;`;
}

/**
 * @param {object} o
 * @param {string} [o.baseUrl]      OVERPASS_URL — any Overpass instance or mirror
 * @param {string} [o.fallbackUrl]  OVERPASS_FALLBACK_URL — tried ONLY after the
 *   primary fails for a chunk, one request at a time. Never both at once.
 * @param {string} [o.userAgent]    identifying User-Agent (from ROUTE_PLUS_CONTACT)
 * @param {string} [o.contact]      used to build the User-Agent when none is given
 * @param {number} [o.chunkKm]      km of route per request (OVERPASS_CHUNK_KM)
 * @param {number} [o.delayMs]      pause between sequential chunk requests
 */
export function createOverpassPlaceProvider({
  baseUrl = 'https://overpass-api.de/api/interpreter', fallbackUrl = '', fetchImpl, cache, userAgent, contact,
  timeoutMs = OVERPASS_DEFAULTS.timeoutMs,
  chunkKm = OVERPASS_DEFAULTS.chunkKm,
  delayMs = OVERPASS_DEFAULTS.delayMs,
  queryTimeoutS = OVERPASS_DEFAULTS.queryTimeoutS,
  toleranceFactor = OVERPASS_DEFAULTS.toleranceFactor,
  minToleranceKm = OVERPASS_DEFAULTS.minToleranceKm,
  maxVerticesPerQuery = OVERPASS_DEFAULTS.maxVerticesPerQuery
} = {}) {
  // Public Overpass instances sit behind a front end that refuses requests
  // without a real, identifying User-Agent — that rejection arrives as
  // HTTP 406 Not Acceptable, not 403. Node's fetch sends no useful agent of its
  // own, so ROUTE+ always sends one (same contact convention as Nominatim), and
  // states the response format it can read.
  const agent = userAgent || `ROUTE+/0.2 (${contact || 'set ROUTE_PLUS_CONTACT to your email'})`;
  const headers = {
    'User-Agent': agent,
    Accept: 'application/json',
    // Overpass reads the query from a urlencoded `data` field; the charset is
    // part of what the endpoint negotiates on.
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
  };
  // Endpoints are tried IN ORDER, one request at a time, and only after the
  // previous one failed recoverably. No Overpass request ever runs in parallel
  // with another — not across endpoints, not across chunks.
  const endpoints = [baseUrl, fallbackUrl].filter(Boolean);

  async function ask(query) {
    let lastError;
    for (const url of endpoints) {
      try {
        return await fetchJson(url, { fetchImpl, timeoutMs, method: 'POST', headers, body: `data=${encodeURIComponent(query)}` });
      } catch (error) {
        lastError = error;
        if (!isRecoverable(error)) throw error;   // a real refusal is not retried elsewhere
      }
    }
    throw lastError;
  }

  return {
    name: 'openstreetmap',
    endpoint: baseUrl,
    endpoints,
    async searchCorridor({ geometry, bufferKm }) {
      const simple = simplify(geometry, 3);
      const cum = cumulativeKm(simple);
      const total = cum.at(-1);
      const places = [];
      let asked = 0;
      for (let from = 0; from < total; from += chunkKm) {
        const part = sliceLine(simple, cum, from, Math.min(total, from + chunkKm));
        const points = corridorPoints(part, bufferKm, { toleranceFactor, minToleranceKm, maxVerticesPerQuery });
        const query = buildQuery(points, Math.round(bufferKm * 1000), queryTimeoutS);
        const key = `overpass:${query.length}:${points[0]}:${points.at(-1)}:${bufferKm}`;
        let rows = cache?.get(key);
        if (!rows) {
          // Sequential and paced: wait before every request after the first one
          // that actually reached the network (cache hits cost nothing).
          if (asked > 0 && delayMs > 0) await sleep(delayMs);
          asked++;
          const body = await ask(query);
          rows = (body.elements || []).map(elementToPlace).filter(Boolean);
          cache?.set(key, rows);
        }
        places.push(...rows);
      }
      return places;
    }
  };
}
