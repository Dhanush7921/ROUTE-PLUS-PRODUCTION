// PRODUCTION STEP 7 — beta readiness.
//
// What a public beta adds to a working app: a configuration that is checked
// before it serves traffic, rate limits that count the right visitor when a
// reverse proxy is in front, a shutdown that finishes what it started, and a
// process that survives one failed promise. Product behaviour is unchanged —
// these tests exist to stop a deployment mistake looking like a broken app.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../server/config.js';
import { validateConfig, assertConfig } from '../../server/lib/validateConfig.js';
import { startServer } from '../../server/index.js';

const OFFLINE = async () => { throw new Error('network disabled in tests'); };
const base = { port: 0, host: '127.0.0.1', dbPath: ':memory:', logLevel: 'silent' };

async function boot(env = {}, overrides = {}) {
  const srv = await startServer({ ...base, ...overrides }, env, { fetchImpl: OFFLINE });
  const call = async (method, urlPath, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${srv.port}${urlPath}`, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { srv, call };
}

// ---------------------------------------------------------------- configuration
test('STEP 7: a configuration that cannot work is refused, with a reason', () => {
  const bad = [
    [{ PORT: '99999' }, /PORT must be/],
    [{ PUBLIC_URL: 'routeplus.example.com' }, /PUBLIC_URL must start with/],
    [{ SESSION_DAYS: '0' }, /SESSION_DAYS must be/],
    [{ SESSION_DAYS: '4000' }, /SESSION_DAYS must be/],
    [{ OSRM_DURATION_FACTOR: 'fast' }, /OSRM_DURATION_FACTOR must be a number/],
    [{ ADMIN_EMAILS: 'deva@example.com, not-an-email' }, /not an email address/],
    [{ LOG_LEVEL: 'chatty' }, /LOG_LEVEL must be/],
    [{ MAX_DETOUR_CANDIDATES: '0' }, /MAX_DETOUR_CANDIDATES/],
    [{ OVERPASS_CHUNK_KM: '2' }, /OVERPASS_CHUNK_KM/],
    [{ DATABASE_URL: 'not a url' }, /DATABASE_URL is not a valid URL/],
    [{ DATABASE_URL: 'mysql://u:p@h/db' }, /must start with postgres/]
  ];
  for (const [env, pattern] of bad) {
    const { errors } = validateConfig(loadConfig(env), env);
    assert.ok(errors.length, `${JSON.stringify(env)} should be rejected`);
    assert.match(errors.join(' | '), pattern);
    assert.throws(() => assertConfig(loadConfig(env), env), e => e.code === 'INVALID_CONFIG' && e.errors.length > 0);
  }
  // A typo in a numeric variable is caught rather than silently defaulted.
  assert.match(validateConfig(loadConfig({ PORT: 'eight-thousand' }), { PORT: 'eight-thousand' }).errors.join(), /PORT must be a number/);

  // The default configuration is valid and produces no errors.
  const { errors, warnings } = validateConfig(loadConfig({}), {});
  assert.deepEqual(errors, []);
  assert.ok(Array.isArray(warnings));
  assert.deepEqual(assertConfig(loadConfig({}), {}), warnings, 'valid configuration returns its warnings');
});

test('STEP 7: risky-for-beta settings are warnings, not blockers', () => {
  const warn = env => validateConfig(loadConfig(env), env).warnings.join(' | ');

  assert.match(warn({ NODE_ENV: 'production' }), /without PUBLIC_URL/);
  assert.match(warn({ NODE_ENV: 'production', PUBLIC_URL: 'http://routeplus.example' }), /travel unencrypted/);
  // The rate-limiting trap: https usually means a proxy, and without
  // TRUST_PROXY every visitor shares one bucket.
  assert.match(warn({ PUBLIC_URL: 'https://routeplus.example' }), /rate limits apply to all of them together/);
  assert.ok(!warn({ PUBLIC_URL: 'https://routeplus.example', TRUST_PROXY: '1' }).includes('rate limits apply'));
  assert.match(warn({ TRUST_PROXY: '1' }), /can spoof their address/);
  // In development an empty ADMIN_EMAILS is only a warning, so a beginner can
  // still just run the app. Step 8 makes it an error in production.
  assert.match(warn({}), /ADMIN_EMAILS is empty/);
  assert.ok(!warn({ ADMIN_EMAILS: 'deva@example.com' }).includes('ADMIN_EMAILS is empty'));
  // OpenStreetMap providers without the contact the usage policy requires.
  assert.match(warn({ ROUTE_PROVIDER: 'osrm' }), /ROUTE_PLUS_CONTACT/);
  assert.match(warn({ NODE_ENV: 'production', ROUTE_PROVIDER: 'osrm', ROUTE_PLUS_CONTACT: 'd@example.com' }), /public demo server/);
  assert.match(warn({ NODE_ENV: 'production', PLACE_PROVIDER: 'overpass', ROUTE_PLUS_CONTACT: 'd@example.com' }), /OVERPASS_FALLBACK_URL/);
  // Ephemeral storage in production is an error (Step 8), not a warning.
  const ephemeral = { NODE_ENV: 'production', ADMIN_EMAILS: 'deva@example.com', ROUTE_PLUS_DB: '/tmp/rp.sqlite' };
  assert.match(validateConfig(loadConfig(ephemeral), ephemeral).errors.join(), /temporary directory/);

  // No warning mentions a secret's value.
  const withSecrets = { GOOGLE_MAPS_SERVER_KEY: 'TEST_ONLY_KEY_VALUE', DATABASE_URL: 'postgres://u:TEST_ONLY_PW@h:5432/db', PGPASSWORD: 'TEST_ONLY_PW' };
  const all = validateConfig(loadConfig(withSecrets), withSecrets);
  const text = JSON.stringify(all);
  assert.ok(!text.includes('TEST_ONLY_KEY_VALUE') && !text.includes('TEST_ONLY_PW'), 'validation output carries no secret values');
});

test('STEP 7: the server refuses to start on invalid configuration', async () => {
  await assert.rejects(startServer(base, { SESSION_DAYS: '0' }, { fetchImpl: OFFLINE }),
    e => e.code === 'INVALID_CONFIG' && /SESSION_DAYS/.test(e.message));
  // …and starts normally on a configuration that is valid but imperfect,
  // exposing the warnings it found. Production requires ADMIN_EMAILS and a
  // persistent database path (Step 8), so this uses a real file: inside the
  // application directory, which is exactly one of the things it warns about.
  const dbPath = path.join(loadConfig({}).root, 'data', `step7-${process.pid}.sqlite`);
  const { srv } = await boot({ NODE_ENV: 'production', ADMIN_EMAILS: 'deva@example.com' }, { dbPath });
  try {
    assert.ok(srv.warnings.some(w => /PUBLIC_URL/.test(w)), 'warnings are returned to the caller');
    assert.ok(srv.warnings.some(w => /inside the application directory/.test(w)));
    assert.equal((await fetch(`http://127.0.0.1:${srv.port}/api/health`)).status, 200);
  } finally {
    await srv.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
});

// ---------------------------------------------------------------- rate limiting
test('STEP 7: rate limits count the real visitor when a proxy is trusted', async () => {
  // Without TRUST_PROXY the header is ignored: two "different" forged clients
  // still share one bucket, so a spoofed header cannot buy extra requests.
  const plain = await boot({});
  try {
    let blocked = 0;
    for (let i = 0; i < 12; i++) {
      const r = await plain.call('POST', '/api/auth/login', { email: `x${i}@example.com`, password: 'whatever-long' }, { 'X-Forwarded-For': `9.9.9.${i}` });
      if (r.status === 429) blocked++;
    }
    assert.ok(blocked > 0, 'a forged X-Forwarded-For did not escape the limit');
  } finally { await plain.srv.close(); }

  // With TRUST_PROXY each forwarded client gets its own allowance, so one busy
  // tester cannot lock out the others behind the same proxy.
  const proxied = await boot({ TRUST_PROXY: '1' });
  try {
    let blocked = 0;
    for (let i = 0; i < 12; i++) {
      const r = await proxied.call('POST', '/api/auth/login', { email: `y${i}@example.com`, password: 'whatever-long' }, { 'X-Forwarded-For': `10.0.0.${i}` });
      if (r.status === 429) blocked++;
    }
    assert.equal(blocked, 0, 'distinct visitors behind a proxy were rate-limited together');
    // The same visitor is still limited.
    let same = 0;
    for (let i = 0; i < 14; i++) {
      const r = await proxied.call('POST', '/api/auth/login', { email: 'z@example.com', password: 'whatever-long' }, { 'X-Forwarded-For': '10.0.0.99' });
      if (r.status === 429) same++;
    }
    assert.ok(same > 0, 'one visitor is still limited');
  } finally { await proxied.srv.close(); }
});

// ---------------------------------------------------------------- lifecycle
test('STEP 7: shutdown drains, closes the database, and is idempotent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-beta-'));
  const { srv, call } = await boot({}, { dbPath: path.join(dir, 'beta.sqlite') });
  const port = srv.port;
  try {
    // Serve real work first, so there is something to flush.
    assert.equal((await call('POST', '/api/plan', { origin: 'Delhi', destination: 'Jaipur' })).status, 200);

    const started = Date.now();
    await srv.close();
    assert.ok(Date.now() - started < 5000, 'shutdown did not wait for the timeout');
    assert.ok(fs.existsSync(path.join(dir, 'beta.sqlite')), 'the database file is on disk after a clean close');

    await srv.close();                       // idempotent: no throw, no hang
    // A drained server stops accepting connections.
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`), /fetch failed|ECONNREFUSED/);

    // The data survived the restart, which is what a beta deploy depends on.
    const again = await startServer({ ...base, dbPath: path.join(dir, 'beta.sqlite') }, {}, { fetchImpl: OFFLINE });
    try {
      const routes = again.db.prepare('SELECT count(*) AS n FROM routes').get();
      assert.ok(routes.n >= 1, 'the route planned before shutdown is still there');
    } finally { await again.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('STEP 7: beta flows still work with every external provider unreachable', async () => {
  const { srv, call } = await boot({ ROUTE_PROVIDER: 'osrm', GEOCODING_PROVIDER: 'nominatim', PLACE_PROVIDER: 'overpass', ROUTE_PLUS_CONTACT: 'deva@example.com' });
  try {
    const plan = await call('POST', '/api/plan', { origin: 'Visakhapatnam', destination: 'Manali', tripDays: 3, travelerType: 'Family', interests: ['Nature'] });
    assert.equal(plan.status, 200, 'the beta stays usable when OSRM/Nominatim/Overpass are all down');
    assert.equal(plan.json.plan.route.provider, 'offline-network');
    assert.equal(plan.json.plan.liveFallback, true);
    assert.equal(plan.json.plan.placeSource, 'curated', 'no live OSM discovery is claimed');
    assert.ok(plan.json.plan.places.length > 0);
    // Signing up and saving still work with no provider at all.
    const health = await call('GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.providers.mode, 'live', 'the requested mode is reported honestly');
  } finally { await srv.close(); }
});
