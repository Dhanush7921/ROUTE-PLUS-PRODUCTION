// CONFIGURATION VALIDATION — catch a bad deployment before it serves traffic.
//
// Two kinds of finding:
//   errors    the value cannot work. The server refuses to start.
//   warnings  the value works but is probably wrong for a public beta. Logged
//             at startup, and listed by `npm run check:beta`.
//
// Nothing here reads a secret's VALUE — only whether it is set.

const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

/**
 * @param {object} config  from loadConfig()
 * @param {object} env     the raw environment, for variables config does not keep
 * @returns {{ errors: string[], warnings: string[], production: boolean }}
 */
export function validateConfig(config, env = process.env) {
  const errors = [];
  const warnings = [];
  const production = config.env === 'production';

  // ---- values that simply cannot work
  // loadConfig() falls back to a default for anything unparseable, which is
  // right at runtime but would hide a typo: asking for PORT=eigth000 and
  // silently listening on 8080 is exactly the kind of deployment surprise this
  // check exists to prevent. So the RAW value is checked as well.
  for (const [name, min, max] of [['PORT', 0, 65535], ['SESSION_DAYS', 1, 365], ['CACHE_TTL_HOURS', 0, 24 * 365],
    ['MAX_DETOUR_CANDIDATES', 1, 1000], ['OVERPASS_CHUNK_KM', 10, 2000], ['OSRM_DURATION_FACTOR', 0.5, 5],
    ['SHUTDOWN_TIMEOUT_MS', 0, 120000], ['PGPORT', 1, 65535]]) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) errors.push(`${name} must be a number (got "${raw}").`);
    else if (value < min || value > max) errors.push(`${name} must be between ${min} and ${max} (got "${raw}").`);
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    errors.push(`PORT must be a whole number between 0 and 65535 (got "${env.PORT ?? ''}").`);
  }
  if (config.publicUrl && !/^https?:\/\/[^\s/]+/i.test(config.publicUrl)) {
    errors.push(`PUBLIC_URL must start with http:// or https:// (got "${config.publicUrl}").`);
  }
  if (!Number.isFinite(config.sessionDays) || config.sessionDays < 1 || config.sessionDays > 365) {
    errors.push(`SESSION_DAYS must be between 1 and 365 (got "${env.SESSION_DAYS ?? ''}").`);
  }
  for (const email of config.adminEmails) {
    if (!EMAIL.test(email)) errors.push(`ADMIN_EMAILS contains "${email}", which is not an email address.`);
  }
  if (!Number.isFinite(config.maxDetourCandidates) || config.maxDetourCandidates < 1) {
    errors.push('MAX_DETOUR_CANDIDATES must be a positive number.');
  }
  if (!Number.isFinite(config.overpassChunkKm) || config.overpassChunkKm < 10) {
    errors.push('OVERPASS_CHUNK_KM must be at least 10 (km of route per Overpass request).');
  }
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(config.logLevel)) {
    errors.push(`LOG_LEVEL must be debug, info, warn, error or silent (got "${config.logLevel}").`);
  }
  const dsn = (env.DATABASE_URL || env.POSTGRES_URL || '').trim();
  if (dsn) {
    try {
      const u = new URL(dsn);
      if (!/^postgres(ql)?:$/.test(u.protocol)) errors.push('DATABASE_URL must start with postgres:// or postgresql://');
    } catch {
      errors.push('DATABASE_URL is not a valid URL. (Special characters in the password must be percent-encoded.)');
    }
  }

  // ---- fine locally, worth a second look before a public beta
  if (production && !config.publicUrl) {
    warnings.push('NODE_ENV=production without PUBLIC_URL: cookies will not be marked Secure and HSTS is off. Set PUBLIC_URL to your https:// address.');
  }
  if (config.publicUrl.startsWith('http://') && production) {
    warnings.push('PUBLIC_URL uses http:// in production. Sessions travel unencrypted — put the beta behind HTTPS.');
  }
  if (config.publicUrl.startsWith('https://') && !config.trustProxy) {
    warnings.push('An https:// PUBLIC_URL usually means a reverse proxy sits in front. Without TRUST_PROXY=1 every visitor looks like the proxy, so rate limits apply to all of them together.');
  }
  if (config.trustProxy && !config.publicUrl) {
    warnings.push('TRUST_PROXY=1 without PUBLIC_URL: only enable it when a proxy you control really sets X-Forwarded-For, or clients can spoof their address.');
  }
  if (!config.adminEmails.length) {
    const message = 'ADMIN_EMAILS is empty, so nobody can reach the admin dashboard to moderate places or read beta feedback. Add the address you will sign up with.';
    // In production this is a deployment mistake, not a preference: a beta with
    // no reachable admin cannot be moderated while testers are using it.
    if (production) errors.push(message);
    else warnings.push(message);
  }
  if (config.liveProviders || ['osrm', 'nominatim', 'overpass'].some(p => [config.routeProvider, config.geocodingProvider, config.placeProvider].includes(p))) {
    if (!config.contactConfigured) warnings.push('OpenStreetMap services require ROUTE_PLUS_CONTACT (your email) by their usage policy. Without it ROUTE+ stays on offline data.');
    if (production && /router\.project-osrm\.org/.test(config.osrmUrl)) {
      warnings.push('OSRM_URL is the public demo server: fair use, no SLA, and it can rate-limit a beta. Fine to start with; self-host before real traffic.');
    }
    if (production && /overpass-api\.de/.test(config.overpassUrl)) {
      warnings.push('OVERPASS_URL is the public instance: fair use, no SLA. Set OVERPASS_FALLBACK_URL as a second option.');
    }
  }
  if (production && /(^|\/)(tmp|var\/tmp|dev\/shm)\//.test(config.dbPath)) {
    errors.push(`ROUTE_PLUS_DB points inside a temporary directory (${config.dbPath}). Users, trips and feedback would be lost on the next restart — use a persistent volume (see docs/DEPLOY.md).`);
  }
  if (production && config.dbPath.startsWith(config.root)) {
    warnings.push(`ROUTE_PLUS_DB is inside the application directory (${config.dbPath}). A redeploy that replaces the app directory would replace the database with it — point it at a volume outside the code.`);
  }
  if (production && config.dbPath === ':memory:') {
    errors.push('ROUTE_PLUS_DB is :memory: — nothing would be saved. Use a file on a persistent volume.');
  }
  if (config.postgresConfigured && !config.postgresUrlPresent && !env.PGPASSWORD) {
    warnings.push('PostgreSQL host is set but no password is configured (PGPASSWORD or DATABASE_URL).');
  }

  return { errors, warnings, production };
}

/** Throw when the configuration cannot work; returns the warnings to log. */
export function assertConfig(config, env = process.env) {
  const { errors, warnings } = validateConfig(config, env);
  if (errors.length) {
    const error = new Error(`ROUTE+ cannot start — the configuration has ${errors.length} problem(s):\n  • ${errors.join('\n  • ')}`);
    error.code = 'INVALID_CONFIG';
    error.errors = errors;
    throw error;
  }
  return warnings;
}
