// Tiny HTTP helper for live providers: timeouts, polite rate limiting and
// mapping every failure to a ProviderError the rest of ROUTE+ understands.
// Raw vendor errors never reach the traveller.

import { ProviderError } from '../../shared/providers/contracts.js';

export async function fetchJson(url, { fetchImpl = globalThis.fetch, timeoutMs = 8000, acceptErrorJson = false, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    throw new ProviderError(error.name === 'AbortError' ? 'TIMEOUT' : 'PROVIDER_UNAVAILABLE', `Request failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429) throw new ProviderError('RATE_LIMITED', 'Provider rate limit reached');
  if (res.status >= 500) throw new ProviderError('PROVIDER_UNAVAILABLE', `Provider error ${res.status}`);
  let body;
  try { body = await res.json(); } catch {
    throw new ProviderError(res.ok ? 'BAD_RESPONSE' : 'PROVIDER_UNAVAILABLE', res.ok ? 'Provider returned invalid JSON' : `Provider refused the request (HTTP ${res.status})`);
  }
  // Some APIs (OSRM) explain 4xx errors in a JSON body; let the adapter read it.
  if (!res.ok && !(acceptErrorJson && body && typeof body === 'object')) throw new ProviderError('BAD_RESPONSE', `Provider rejected request (${res.status})`, { status: res.status, body });
  return body;
}

/** Ensures at least `intervalMs` between calls (e.g. Nominatim: 1 request/second). */
export function rateLimiter(intervalMs) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + intervalMs;
    if (wait) await new Promise(r => setTimeout(r, wait));
  };
}
