// ⚠️  SYNTHETIC TEST DATA — NOT REAL GOOGLE RESPONSES.
//
// These objects only have the SHAPE of Google Geocoding / Routes API replies.
// Their numbers were written by hand so the adapters can be tested without a
// key, a bill or a network. Nothing here is used by the application at run
// time: no fixture is imported outside tests/, and no fixture value is ever
// presented to a traveller as a real distance, duration or coordinate.
//
// A real Visakhapatnam → Manali answer is expected to be roughly 2,600–2,800 km
// and 45–55 hours of driving; the fixture sits in that range so the assertions
// are meaningful, but it is still made up.

/** Test-only encoder (the inverse of shared/geo.js decodePolyline). */
export function encodePolyline(points, precision = 5) {
  const factor = 10 ** precision;
  const chunk = value => {
    let v = value < 0 ? ~(value << 1) : (value << 1);
    let out = '';
    while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>>= 5; }
    return out + String.fromCharCode(v + 63);
  };
  let lat = 0, lng = 0, out = '';
  for (const [a, b] of points) {
    const la = Math.round(a * factor);
    const ln = Math.round(b * factor);
    out += chunk(la - lat) + chunk(ln - lng);
    lat = la; lng = ln;
  }
  return out;
}

export const VIZAG = [17.6868, 83.2185];
export const MANALI = [32.2396, 77.1887];

/** A coarse made-up line from Visakhapatnam to Manali (via plausible towns). */
export const FIXTURE_LINE = [
  VIZAG, [18.11, 82.64], [19.09, 82.03], [20.47, 81.87], [21.25, 81.63],
  [23.18, 80.02], [25.45, 78.57], [26.85, 78.01], [28.61, 77.21],
  [30.33, 76.39], [31.10, 77.17], [31.71, 76.93], MANALI
];

/** Routes API computeRoutes — success. Synthetic. */
export const ROUTE_OK = {
  routes: [{
    distanceMeters: 2690431,
    duration: '164700s',                 // 45.75 h
    polyline: { encodedPolyline: encodePolyline(FIXTURE_LINE) },
    legs: [{ distanceMeters: 2690431, duration: '164700s' }]
  }]
};

/** Geocoding API — success, one result. Synthetic. */
export const geocodeOk = ({ name, lat, lng, state = 'Andhra Pradesh', placeId = 'TEST_PLACE_ID' }) => ({
  status: 'OK',
  results: [{
    place_id: placeId,
    formatted_address: `${name}, ${state}, India`,
    address_components: [
      { long_name: name, short_name: name, types: ['locality', 'political'] },
      { long_name: state, short_name: state, types: ['administrative_area_level_1', 'political'] },
      { long_name: 'India', short_name: 'IN', types: ['country', 'political'] }
    ],
    geometry: { location: { lat, lng }, location_type: 'APPROXIMATE' },
    types: ['locality', 'political']
  }]
});

export const GEOCODE_VIZAG = geocodeOk({ name: 'Visakhapatnam', lat: VIZAG[0], lng: VIZAG[1], state: 'Andhra Pradesh', placeId: 'TEST_VIZAG' });
export const GEOCODE_MANALI = geocodeOk({ name: 'Manali', lat: MANALI[0], lng: MANALI[1], state: 'Himachal Pradesh', placeId: 'TEST_MANALI' });
export const GEOCODE_NONE = { status: 'ZERO_RESULTS', results: [] };

/** Two far-apart matches with the same name → the adapter must ask which one. */
export const GEOCODE_AMBIGUOUS = {
  status: 'OK',
  results: [
    ...geocodeOk({ name: 'Nagar', lat: 19.09, lng: 74.74, state: 'Maharashtra', placeId: 'TEST_A' }).results,
    ...geocodeOk({ name: 'Nagar', lat: 31.95, lng: 77.19, state: 'Himachal Pradesh', placeId: 'TEST_B' }).results
  ]
};

/**
 * Build a fake fetch for tests.
 * @param {(url: string, init: object) => object|Error} handler  returns a JSON body
 *        (optionally { __status, __body }) or throws to simulate a transport failure.
 * @returns {{ fetchImpl: Function, calls: object[] }}
 */
export function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    const out = await handler(String(url), init, calls.length);
    const status = out?.__status ?? 200;
    const body = out?.__body ?? out;
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetchImpl, calls };
}
