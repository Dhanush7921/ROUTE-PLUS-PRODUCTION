// Checks the LIVE map providers from YOUR machine (needs internet):
//   npm run check:live -- you@example.com
// Calls Nominatim, OSRM, Overpass and Open-Meteo through the same adapters the
// server uses and prints what came back. Nothing is stored.

import { createNominatimGeocoder } from '../server/providers/nominatim.js';
import { createOsrmRouter } from '../server/providers/osrm.js';
import { createOverpassPlaceProvider } from '../server/providers/overpass.js';
import { createWeatherProvider } from '../server/providers/openmeteo.js';
import { createGeoPlanner } from '../shared/engine/geoPlanner.js';
import { chain } from '../shared/providers/registry.js';
import { createCuratedPlaceProvider } from '../shared/providers/offline.js';
import { NODES } from '../shared/data/network.js';

const contact = process.argv[2] || process.env.ROUTE_PLUS_CONTACT;
if (!contact) {
  console.error('Please pass your email (OpenStreetMap services require contact details):  npm run check:live -- you@example.com');
  process.exit(1);
}
const step = async (label, fn) => {
  const t = Date.now();
  try { const out = await fn(); console.log(`✔ ${label} (${Date.now() - t} ms)`, out); return true; }
  catch (e) { console.log(`✘ ${label}: ${e.code || ''} ${e.message}`); return false; }
};

const geocoder = createNominatimGeocoder({ userAgent: `ROUTE+/0.2 (${contact})` });
const osrm = createOsrmRouter();
// Same identifying User-Agent as the server sends (Overpass refuses requests
// without one with HTTP 406). OVERPASS_URL switches to another instance/mirror;
// OVERPASS_FALLBACK_URL is tried only after the primary fails, never alongside it.
const overpass = createOverpassPlaceProvider({
  userAgent: `ROUTE+/0.2 (${contact})`,
  baseUrl: process.env.OVERPASS_URL || undefined,
  fallbackUrl: process.env.OVERPASS_FALLBACK_URL || '',
  chunkKm: Number(process.env.OVERPASS_CHUNK_KM) || undefined
});
// Fallback coordinates let the other checks run even if geocoding fails.
let delhi = { lat: 28.6139, lng: 77.209 };
let jaipur = { lat: 26.9124, lng: 75.7873 };
await step('Nominatim geocode Delhi', async () => { delhi = await geocoder.geocode('Delhi'); return delhi; });
await step('Nominatim geocode Jaipur', async () => { jaipur = await geocoder.geocode('Jaipur'); return jaipur; });
let route = { geometry: [[delhi.lat, delhi.lng], [jaipur.lat, jaipur.lng]] };
await step('OSRM route Delhi → Jaipur', async () => { route = await osrm.route([[delhi.lat, delhi.lng], [jaipur.lat, jaipur.lng]]); return { km: Math.round(route.distanceKm), minutes: Math.round(route.durationMin), points: route.geometry.length }; });
await step('OSRM table (detour legs)', async () => osrm.legs([[[delhi.lat, delhi.lng], [27.0966, 76.2903]], [[27.0966, 76.2903], [jaipur.lat, jaipur.lng]]]));
await step('Overpass places near the route', async () => { const rows = await overpass.searchCorridor({ geometry: route.geometry, bufferKm: 15 }); return `${rows.length} places, e.g. ${rows.slice(0, 5).map(r => r.name).join(', ')}`; });
await step('Open-Meteo forecast (Jaipur)', async () => createWeatherProvider().forecast([jaipur.lat, jaipur.lng]));
await step('Full live plan Delhi → Jaipur', async () => {
  const planner = createGeoPlanner({ geocoder, router: chain('routing', [osrm]), places: chain('places', [createCuratedPlaceProvider(), overpass]), knownTowns: NODES });
  const plan = await planner.plan({ origin: 'Delhi', destination: 'Jaipur' });
  return plan.places.slice(0, 5).map(p => `${p.name}: +${p.detourDistanceKm} km, +${p.detourTimeMinutes} min (${p.detour.method})`);
});

// STEP 3 + 4 acceptance: at least one REAL OpenStreetMap place with a REAL
// road-network detour. This is the only check that can prove both milestones.
await step('STEP 3+4 acceptance: a real OSM place with a road-network detour', async () => {
  const planner = createGeoPlanner({ geocoder, router: chain('routing', [osrm]), places: chain('places', [createCuratedPlaceProvider(), overpass]), knownTowns: NODES });
  const plan = await planner.plan({ origin: 'Delhi', destination: 'Jaipur' });
  const counts = Object.entries(plan.placeCounts).map(([k, v]) => `${k}=${v}`).join(', ');
  const osm = plan.places.filter(p => p.source.provider === 'openstreetmap');
  if (!osm.length) return `NO live OSM places this run (sources: ${counts}). Curated fallback answered — the plan does not claim OSM discovery.`;
  const best = osm.find(p => p.detour.method === 'road-network' && p.detourDistanceKm > 0 && p.detourTimeMinutes > 0) || osm[0];
  return {
    sources: counts,
    name: best.name,
    category: best.category,
    source: best.source.provider,
    osmRef: best.source.ref,
    distanceFromRouteKm: best.distanceFromRouteKm,
    detourDistanceKm: best.detourDistanceKm,
    detourTimeMinutes: best.detourTimeMinutes,
    detourMethod: best.detour.method,
    strategy: best.detour.strategy,
    entersRouteNear: best.detour.anchorName,
    rejoinsRouteNear: best.detour.rejoinName
  };
});
