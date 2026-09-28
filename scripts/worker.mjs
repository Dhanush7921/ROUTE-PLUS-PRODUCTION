// Background worker — run on a schedule (e.g. hourly cron):  npm run worker
// With ROUTE_PLUS_LIVE_PROVIDERS=1 it also ingests OpenStreetMap places along
// the popular corridors (stored disabled + flagged for staff review).

import { loadConfig } from '../server/config.js';
import { openDatabase } from '../server/db/database.js';
import { purgeSessions, aggregateMetrics, reviewPlaces, ingestPlaces } from '../server/jobs.js';
import { createOverpassPlaceProvider } from '../server/providers/overpass.js';
import { createOfflineGeocoder, createOfflineRouter } from '../shared/providers/offline.js';

const config = loadConfig();
const db = openDatabase(config.dbPath);
const report = { sessionsPurged: purgeSessions(db), metricDays: aggregateMetrics(db), placesFlagged: reviewPlaces(db) };

if (config.liveProviders || process.argv.includes('--ingest')) {
  const pairs = [['Visakhapatnam', 'Manali'], ['Hyderabad', 'Goa'], ['Chennai', 'Ooty'], ['Delhi', 'Jaipur'], ['Mumbai', 'Goa'], ['Bengaluru', 'Coorg'], ['Kolkata', 'Darjeeling']];
  const geocoder = createOfflineGeocoder();
  const router = createOfflineRouter();
  const corridors = [];
  for (const [a, b] of pairs) {
    const A = await geocoder.geocode(a);
    const B = await geocoder.geocode(b);
    corridors.push((await router.route([[A.lat, A.lng], [B.lat, B.lng]])).geometry);
  }
  try {
    report.placesIngested = await ingestPlaces(db, { provider: createOverpassPlaceProvider({ baseUrl: config.overpassUrl }), corridors });
  } catch (error) {
    report.ingestError = `${error.code || 'ERROR'}: ${error.message}`;
  }
}

console.log(JSON.stringify({ t: new Date().toISOString(), job: 'worker', ...report }));
db.close();
