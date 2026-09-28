// Observability: structured logs, in-memory metrics, error tracking and
// provider health. In production, ship the JSON log lines to your log
// platform and scrape /api/admin/metrics (or swap in OpenTelemetry).

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

// Defence in depth: even if someone logs a config object or an error that
// contains a key, it is masked before it reaches the log.
const SECRET_FIELD = /(key|secret|password|token|authorization|cookie)s?$/i; // e.g. apiKey, googleMapsServerKey
const GOOGLE_KEY = /AIza[0-9A-Za-z_-]{20,}/g;
// A credential can also hide inside a VALUE whose field name looks innocent:
// databaseUrl, dsn, connection, or the text of an error that echoes one. So
// every string is scrubbed of embedded URL credentials and key=… parameters,
// whatever it is called.
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]+:)[^\s@/]+@/gi;
const KEY_PARAM = /\b(key|api[_-]?key|password|pwd|token|access[_-]?token)=[^&\s"']+/gi;
export function redact(key, value) {
  if (key && SECRET_FIELD.test(key) && !/configured$/i.test(key) && typeof value !== 'boolean') return '[redacted]';
  if (typeof value !== 'string') return value;
  return value.replace(GOOGLE_KEY, '[redacted-key]').replace(URL_CREDENTIALS, '$1[redacted]@').replace(KEY_PARAM, (m, name) => `${name}=[redacted]`);
}

export function createLogger(level = 'info', write = line => process.stdout.write(`${line}\n`)) {
  const min = LEVELS[level] ?? 20;
  const log = (lvl, msg, fields = {}) => {
    if (LEVELS[lvl] < min) return;
    write(JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...fields }, redact));
  };
  return { debug: (m, f) => log('debug', m, f), info: (m, f) => log('info', m, f), warn: (m, f) => log('warn', m, f), error: (m, f) => log('error', m, f) };
}

export function createMetrics() {
  const counters = new Map();
  const timings = new Map();
  const recentErrors = [];
  const providers = new Map();
  const startedAt = Date.now();
  return {
    inc(name, by = 1) { counters.set(name, (counters.get(name) || 0) + by); },
    time(name, ms) {
      const t = timings.get(name) || { count: 0, total: 0, max: 0, samples: [] };
      t.count++; t.total += ms; t.max = Math.max(t.max, ms);
      t.samples.push(ms); if (t.samples.length > 200) t.samples.shift();
      timings.set(name, t);
    },
    error(context, error) {
      recentErrors.unshift({ at: new Date().toISOString(), context, code: error.code || 'INTERNAL', message: String(error.message).slice(0, 300) });
      recentErrors.length = Math.min(recentErrors.length, 50);
      this.inc('errors_total');
    },
    provider(evt) {
      const key = `${evt.kind}:${evt.provider}`;
      const p = providers.get(key) || { kind: evt.kind, provider: evt.provider, ok: 0, failed: 0, lastError: null, lastOkAt: null, totalMs: 0 };
      if (evt.ok) { p.ok++; p.lastOkAt = new Date().toISOString(); } else { p.failed++; p.lastError = `${evt.code || 'ERROR'} @ ${new Date().toISOString()}`; }
      p.totalMs += evt.ms || 0;
      providers.set(key, p);
    },
    snapshot() {
      const pct = (arr, q) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
      return {
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        counters: Object.fromEntries(counters),
        latencyMs: Object.fromEntries([...timings].map(([k, t]) => [k, { count: t.count, avg: Math.round(t.total / t.count), p95: Math.round(pct(t.samples, 0.95)), max: Math.round(t.max) }])),
        providers: [...providers.values()].map(p => ({ ...p, avgMs: Math.round(p.totalMs / Math.max(1, p.ok + p.failed)), healthy: p.failed === 0 || p.ok >= p.failed })),
        recentErrors
      };
    }
  };
}

/** Fixed-window rate limiter keyed by client + bucket (e.g. 'auth', 'plan'). */
export function createRateLimiter(rules) {
  const hits = new Map();
  return (bucket, client) => {
    const rule = rules[bucket];
    if (!rule) return { ok: true };
    const now = Date.now();
    const key = `${bucket}:${client}`;
    let h = hits.get(key);
    if (!h || h.reset <= now) { h = { count: 0, reset: now + rule.windowMs }; hits.set(key, h); }
    h.count++;
    if (hits.size > 50_000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    return h.count <= rule.max ? { ok: true } : { ok: false, retryAfterSec: Math.ceil((h.reset - now) / 1000) };
  };
}
