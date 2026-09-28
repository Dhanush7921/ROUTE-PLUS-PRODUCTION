// Provider registry: fallback chains, timeouts and caching.
//
//   primary provider ──fails?──▶ fallback provider ──fails?──▶ friendly error
//
// Only "recoverable" failures (timeout, outage, rate limit) fall through.
// A real answer such as "place not found" is returned immediately.

import { ProviderError, isRecoverable, assertProvider } from './contracts.js';

export function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new ProviderError('TIMEOUT', `${label} timed out after ${ms} ms`)), ms); })
  ]).finally(() => clearTimeout(timer));
}

/** Small in-memory LRU cache with expiry. */
export function createCache({ max = 500, ttlMs = 6 * 3600 * 1000 } = {}) {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (hit.expires < Date.now()) { map.delete(key); return undefined; }
      map.delete(key); map.set(key, hit); // refresh recency
      return hit.value;
    },
    set(key, value) {
      map.set(key, { value, expires: Date.now() + ttlMs });
      while (map.size > max) map.delete(map.keys().next().value);
    },
    get size() { return map.size; }
  };
}

/**
 * Combine several providers of one kind into one that falls back in order.
 * @param {'geocoding'|'routing'|'places'} kind
 * @param {object[]} providers  in priority order
 * @param {object} options      { timeoutMs, onEvent(evt) for monitoring, cache }
 */
export function chain(kind, providers, { timeoutMs = 8000, onEvent = () => {}, cache = null } = {}) {
  providers.forEach(p => assertProvider(kind, p));
  // Identical calls that are already running share one answer instead of
  // starting a second (possibly billed) request. Cleared as soon as it settles.
  const inFlight = new Map();

  const attempt = async (method, args, cacheKey) => {
    let lastError;
    for (const provider of providers) {
      const started = Date.now();
      try {
        const raw = await withTimeout(provider[method](...args), timeoutMs, `${provider.name}.${method}`);
        onEvent({ kind, method, provider: provider.name, ok: true, ms: Date.now() - started });
        // Stamp WHICH provider answered before caching, so a cache hit keeps
        // saying "google-routes" rather than looking like an offline answer.
        const value = provider.name && raw && typeof raw === 'object' && !Array.isArray(raw)
          ? { ...raw, provider: raw.provider || provider.name, method: raw.method || provider.method }
          : raw;
        if (cache && cacheKey) cache.set(cacheKey, value);
        return value;
      } catch (error) {
        const err = error instanceof ProviderError ? error : new ProviderError('PROVIDER_UNAVAILABLE', error.message);
        onEvent({ kind, method, provider: provider.name, ok: false, ms: Date.now() - started, code: err.code });
        lastError = err;
        if (!isRecoverable(err)) throw err;
      }
    }
    throw lastError || new ProviderError('PROVIDER_UNAVAILABLE', `No ${kind} provider available`);
  };

  const call = (method, args, cacheKey) => {
    if (cache && cacheKey) {
      const hit = cache.get(cacheKey);
      if (hit) { onEvent({ kind, method, provider: 'cache', ok: true, ms: 0 }); return Promise.resolve(hit); }
    }
    if (cacheKey && inFlight.has(cacheKey)) return inFlight.get(cacheKey);
    const promise = attempt(method, args, cacheKey);
    if (cacheKey) {
      inFlight.set(cacheKey, promise);
      promise.catch(() => {}).then(() => inFlight.delete(cacheKey));
    }
    return promise;
  };

  const names = providers.map(p => p.name);
  if (kind === 'geocoding') {
    return {
      name: names.join('→'),
      geocode: query => call('geocode', [query], `geo:${String(query).trim().toLowerCase()}`),
      knownPlaces: () => providers.find(p => p.knownPlaces)?.knownPlaces() || []
    };
  }
  if (kind === 'routing') {
    // Remember which provider answered the main route so detour legs try it first.
    let lastProvider = providers[0];
    let legsProvider = null;
    return {
      name: names.join('→'),
      get method() { return lastProvider.method; },
      // Which provider actually answered the DETOUR legs. It can differ from
      // the main route (e.g. Google routes the main line, but the detour matrix
      // is not enabled yet), and the detour engine must not claim "road-network"
      // accuracy for figures the offline estimator produced.
      get legsMethod() { return legsProvider?.method || null; },
      async route(points) {
        const key = `route:${points.map(p => p.map(n => n.toFixed(4)).join(',')).join(';')}`;
        const result = await call('route', [points], key);
        lastProvider = providers.find(p => p.name === result.provider) || providers[0];
        return result;
      },
      async legs(pairs, terrains) {
        // legs are not cached as a batch; individual providers may cache internally
        const ordered = [lastProvider, ...providers.filter(p => p !== lastProvider)];
        let lastError;
        for (const provider of ordered) {
          try {
            const out = await withTimeout(provider.legs(pairs, terrains), timeoutMs * 2, `${provider.name}.legs`);
            legsProvider = provider;
            return out;
          }
          catch (error) { lastError = error; onEvent({ kind, method: 'legs', provider: provider.name, ok: false, code: error.code }); if (error.code && !isRecoverable(error)) throw error; }
        }
        throw lastError;
      }
    };
  }
  // places: combine results from ALL providers that answer (more candidates),
  // de-duplication happens later in the place pipeline.
  return {
    name: names.join('+'),
    async searchCorridor(query) {
      const results = await Promise.allSettled(providers.map(async p => {
        const started = Date.now();
        try {
          const rows = await withTimeout(p.searchCorridor(query), timeoutMs * 2, `${p.name}.searchCorridor`);
          onEvent({ kind, method: 'searchCorridor', provider: p.name, ok: true, ms: Date.now() - started, count: rows.length });
          return rows;
        } catch (error) {
          onEvent({ kind, method: 'searchCorridor', provider: p.name, ok: false, ms: Date.now() - started, code: error.code || 'PROVIDER_UNAVAILABLE' });
          throw error;
        }
      }));
      const ok = results.filter(r => r.status === 'fulfilled');
      if (!ok.length) throw new ProviderError('PROVIDER_UNAVAILABLE', 'No place source is available right now.');
      return ok.flatMap(r => r.value);
    }
  };
}
