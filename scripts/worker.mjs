// Background worker — run on a schedule (e.g. hourly cron):  npm run worker
// With ROUTE_PLUS_LIVE_PROVIDERS=1 it also ingests OpenStreetMap places along
// the popular corridors (stored disabled + flagged for staff review).
//
// The worker uses the SAME database the server uses: openRuntimeDatabase reads
// ROUTE_PLUS_DB_MODE, so `ROUTE_PLUS_DB_MODE=postgres npm run worker` maintains
// the PostgreSQL database instead of quietly opening (and creating) an unused
// SQLite file beside it — which is what a hardcoded openDatabase() did.

import { loadConfig } from '../server/config.js';
import { openRuntimeDatabase } from '../server/db/runtime.js';
import { purgeSessions, aggregateMetrics, reviewPlaces, ingestPlaces } from '../server/jobs.js';
import { createOverpassPlaceProvider } from '../server/providers/overpass.js';
import { createOfflineGeocoder, createOfflineRouter } from '../shared/providers/offline.js';

const config = loadConfig();
const runtime = await openRuntimeDatabase({ sqlitePath: config.dbPath });
const db = runtime.db;

const report = { mode: runtime.mode };
let exitCode = 0;

try {
  report.sessionsPurged = await purgeSessions(db);
  report.metricDays = await aggregateMetrics(db);
  report.placesFlagged = await reviewPlaces(db);

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
      // An unreachable provider is an expected outcome, not a failed run: the
      // maintenance jobs above already did their work.
      report.ingestError = `${error.code || 'ERROR'}: ${error.message}`;
    }
  }
} catch (error) {
  report.error = `${error.code || 'ERROR'}: ${error.message}`;
  exitCode = 1;
} finally {
  // Always close: a PostgreSQL pool holds open sockets, and a worker that does
  // not release them leaves connections behind on every scheduled run.
  await runtime.close().catch(() => {});
}

console.log(JSON.stringify({ t: new Date().toISOString(), job: 'worker', ...report }));
process.exit(exitCode);
