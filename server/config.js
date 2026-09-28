// Server configuration from environment variables, with safe defaults.
// Secrets never live in code or in the frontend. See .env.example.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bool = v => ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== undefined ? Number(v) : d);

export function loadConfig(env = process.env) {
  const config = {
    root,
    env: env.NODE_ENV || 'development',
    port: num(env.PORT, 8080),
    host: env.HOST || '127.0.0.1',
    publicUrl: env.PUBLIC_URL || '',
    dbPath: env.ROUTE_PLUS_DB || path.join(root, 'data', 'routeplus.sqlite'),
    webRoot: path.join(root, 'web'),
    sharedRoot: path.join(root, 'shared'),
    secureCookies: bool(env.SECURE_COOKIES) || (env.PUBLIC_URL || '').startsWith('https://'),
    // Behind a reverse proxy (nginx, Caddy, a PaaS router) every request arrives
    // from the proxy's address, so rate limits would apply to all visitors
    // together. Set TRUST_PROXY=1 ONLY when a proxy you control sets
    // X-Forwarded-For — otherwise a client could spoof it and dodge the limits.
    trustProxy: bool(env.TRUST_PROXY),
    shutdownTimeoutMs: num(env.SHUTDOWN_TIMEOUT_MS, 10000),
    sessionDays: num(env.SESSION_DAYS, 30),
    adminEmails: (env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    // External providers (off by default so the app runs with no internet)
    liveProviders: bool(env.ROUTE_PLUS_LIVE_PROVIDERS),
    contact: env.ROUTE_PLUS_CONTACT || 'set ROUTE_PLUS_CONTACT to your email',
    osrmUrl: env.OSRM_URL || 'https://router.project-osrm.org',
    osrmDurationFactor: num(env.OSRM_DURATION_FACTOR, 1.2),
    nominatimUrl: env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org',
    overpassUrl: env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter',
    overpassFallbackUrl: (env.OVERPASS_FALLBACK_URL || '').trim(), // tried only after the primary fails
    overpassChunkKm: num(env.OVERPASS_CHUNK_KM, 120),              // km of route per Overpass request
    maxDetourCandidates: num(env.MAX_DETOUR_CANDIDATES, 120),      // corridor places given a real road-network detour (3 legs each)
    // PRODUCTION DATABASE (Step 6). Empty = SQLite only, which is the default
    // and needs no configuration. The connection details (and never the
    // password) are read by server/db/pg/client.js → pgConfig().
    postgresConfigured: Boolean((env.DATABASE_URL || env.POSTGRES_URL || env.PGHOST || '').trim()),
    postgresUrlPresent: Boolean((env.DATABASE_URL || env.POSTGRES_URL || '').trim()),
    contactConfigured: Boolean(env.ROUTE_PLUS_CONTACT),
    cacheTtlMs: num(env.CACHE_TTL_HOURS, 12) * 3600 * 1000,
    logLevel: env.LOG_LEVEL || 'info',
    // Provider selection (see server/providers/selection.js). Empty = offline default.
    routeProvider: (env.ROUTE_PROVIDER || '').trim(),
    geocodingProvider: (env.GEOCODING_PROVIDER || '').trim(),
    placeProvider: (env.PLACE_PROVIDER || '').trim(),
    googleServerKeyConfigured: Boolean((env.GOOGLE_MAPS_SERVER_KEY || '').trim()),
    googleBrowserKeyConfigured: Boolean((env.GOOGLE_MAPS_BROWSER_KEY || '').trim())
  };
  // Keys are stored NON-ENUMERABLE: they never appear in JSON.stringify(config),
  // Object.keys(config), spread copies ({...config}) or logs. Only the Google
  // adapters read them, and the server key never leaves the server.
  Object.defineProperty(config, 'googleMapsServerKey', { value: (env.GOOGLE_MAPS_SERVER_KEY || '').trim(), enumerable: false });
  Object.defineProperty(config, 'googleMapsBrowserKey', { value: (env.GOOGLE_MAPS_BROWSER_KEY || '').trim(), enumerable: false });
  return config;
}
