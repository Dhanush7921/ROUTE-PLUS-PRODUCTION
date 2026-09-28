// SHARED GOOGLE REQUEST HELPER (Production Step 2)
//
// One place that knows how to talk to Google Maps Platform safely:
//
//   • the API key travels in the X-Goog-Api-Key HEADER, never in a URL.
//     (Google's classic web services — Geocoding — historically documented the
//     `key=` query parameter. If the header is refused we retry ONCE with the
//     parameter and remember that choice for the process, so at most one extra
//     request is ever made. The URL is never logged, and the key is scrubbed
//     from every message before it can reach a log or an API response.)
//   • a hard timeout (AbortController) so a stalled request cannot hang a page.
//   • every failure becomes a ProviderError with a stable code, so the registry
//     can fall back to the offline providers and the traveller sees a friendly
//     message instead of a vendor error.
//   • NO retries on failure (a retry loop is how an API bill explodes) and no
//     vendor response body in error details.

import { ProviderError } from '../../../shared/providers/contracts.js';

/** Remove anything that looks like a key from text before it can be logged. */
export const scrub = (text, key) => {
  let out = String(text ?? '');
  if (key) out = out.split(key).join('[redacted]');
  return out.replace(/key=[^&\s]+/gi, 'key=[redacted]').replace(/AIza[0-9A-Za-z_-]{10,}/g, '[redacted]');
};

/** HTTP status → ProviderError code. 4xx auth/quota problems stay recoverable
 *  so a misconfigured key degrades to offline data instead of an error page. */
function codeForStatus(status) {
  if (status === 429) return 'RATE_LIMITED';
  if (status === 401 || status === 403) return 'PROVIDER_UNAVAILABLE';
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  return 'BAD_RESPONSE';
}

/**
 * One JSON request to a Google endpoint.
 * @param {object} o
 * @param {string} o.url        endpoint (no key in it)
 * @param {string} o.apiKey     server key — header only
 * @param {'GET'|'POST'} o.method
 * @param {object} [o.body]     JSON body for POST
 * @param {object} [o.headers]  extra headers (e.g. X-Goog-FieldMask)
 * @param {string} o.label      'geocoding' | 'routing' — used in messages only
 * @returns {Promise<object>} parsed JSON body
 */
export async function googleJson({ url, apiKey, method = 'GET', body, headers = {}, label = 'Google', timeoutMs = 10000, fetchImpl = globalThis.fetch, keyInQuery = false }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const target = keyInQuery ? `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}` : url;
  let res;
  try {
    res = await fetchImpl(target, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(keyInQuery ? {} : { 'X-Goog-Api-Key': apiKey }),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (error) {
    throw new ProviderError(error?.name === 'AbortError' ? 'TIMEOUT' : 'PROVIDER_UNAVAILABLE',
      error?.name === 'AbortError' ? `${label} request timed out after ${timeoutMs} ms.` : `${label} request failed: ${scrub(error?.message, apiKey)}`);
  } finally {
    clearTimeout(timer);
  }

  let json;
  try { json = await res.json(); } catch { json = null; }
  if (!res.ok) {
    // Google explains errors in a JSON body; keep only the short status word,
    // never the full vendor text (it can echo the request, including the key).
    const status = json?.error?.status || json?.status || '';
    const err = new ProviderError(codeForStatus(res.status), `${label} rejected the request (HTTP ${res.status}${status ? ` ${status}` : ''}).`, { httpStatus: res.status, googleStatus: String(status).slice(0, 40) });
    err.authProblem = res.status === 401 || res.status === 403;
    throw err;
  }
  if (!json || typeof json !== 'object') throw new ProviderError('BAD_RESPONSE', `${label} returned an unreadable response.`);
  return json;
}

/**
 * Wraps googleJson with the header → query-parameter fallback described above.
 * The working mode is remembered per adapter instance (`state`), so the extra
 * request happens at most once per process.
 */
export async function googleJsonWithKeyFallback(state, options) {
  if (state.keyInQuery) return googleJson({ ...options, keyInQuery: true });
  try {
    return await googleJson({ ...options, keyInQuery: false });
  } catch (error) {
    if (!error.authProblem || state.triedQuery) throw error;
    state.triedQuery = true;
    const viaQuery = await googleJson({ ...options, keyInQuery: true }); // throws on its own if this also fails
    state.keyInQuery = true; // remember: this endpoint wants ?key=
    return viaQuery;
  }
}

/** "1234s" (Routes API duration) → minutes. */
export function durationToMinutes(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value / 60;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(String(value || ''));
  return m ? Number(m[1]) / 60 : NaN;
}
