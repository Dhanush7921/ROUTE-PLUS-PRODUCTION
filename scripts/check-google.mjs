// LIVE GOOGLE ACCEPTANCE CHECK — run this on YOUR machine, with YOUR key.
//
//   npm run check:google
//   npm run check:google -- "Visakhapatnam" "Manali"
//
// It performs the ONLY thing that can prove Google is really working: three
// real requests (two geocodes + one route) through the same adapters the server
// uses, then prints what came back. Nothing is stored and the key is never
// printed. Total cost: 2 Geocoding requests + 1 Routes request.
//
// Requirements
//   • Node 22.13+
//   • a .env file (or exported variable) with GOOGLE_MAPS_SERVER_KEY=...
//   • in Google Cloud Console: Geocoding API and Routes API enabled, billing on.
//
// Exit codes:  0 = everything worked   1 = a request failed   2 = not configured

import { createGoogleGeocodingProvider } from '../server/providers/google/geocoding.js';
import { createGoogleRouteProvider } from '../server/providers/google/routes.js';
import { loadConfig } from '../server/config.js';
import { haversineKm } from '../shared/geo.js';

const config = loadConfig();
const apiKey = config.googleMapsServerKey;
if (!apiKey) {
  console.error('\n  GOOGLE_MAPS_SERVER_KEY is not set.\n  Put it in .env (never in the code, never in chat) and run this again.\n  No request was made.\n');
  process.exit(2);
}

const [, , originName = 'Visakhapatnam', destinationName = 'Manali'] = process.argv;
const geocoder = createGoogleGeocodingProvider({ apiKey });
const router = createGoogleRouteProvider({ apiKey });
const hhmm = min => `${Math.floor(min / 60)} h ${Math.round(min % 60)} min`;

async function step(label, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    console.log(`✔ ${label} (${Date.now() - started} ms)`);
    return value;
  } catch (error) {
    console.error(`✘ ${label}: ${error.code || 'ERROR'} — ${error.message}`);
    process.exitCode = 1;
    return null;
  }
}

console.log(`\nROUTE+ live Google check — ${originName} → ${destinationName}\n`);

const origin = await step(`geocode "${originName}"`, () => geocoder.geocode(originName));
if (origin) console.log(`   ${origin.name} — ${origin.latitude}, ${origin.longitude}  (${origin.formattedAddress})`);

const destination = await step(`geocode "${destinationName}"`, () => geocoder.geocode(destinationName));
if (destination) console.log(`   ${destination.name} — ${destination.latitude}, ${destination.longitude}  (${destination.formattedAddress})`);

if (origin && destination) {
  const route = await step('route (Routes API, DRIVE)', () => router.route([[origin.latitude, origin.longitude], [destination.latitude, destination.longitude]]));
  if (route) {
    const straight = haversineKm([origin.latitude, origin.longitude], [destination.latitude, destination.longitude]);
    console.log(`   distance: ${route.distanceKm.toFixed(1)} km   duration: ${hhmm(route.durationMinutes)}   geometry: ${route.geometry.length} points`);
    console.log(`   straight line would be ${straight.toFixed(1)} km — the road route is ${(route.distanceKm / straight).toFixed(2)}× that, so this is real road routing.`);
    console.log(`   provider: ${route.provider}   method: ${route.method}`);
  }
}

console.log(process.exitCode ? '\nSomething failed above. Check that Geocoding API and Routes API are enabled, billing is on, and the key restrictions allow this machine.\n'
  : '\nAll live Google checks passed.\n');
