// Geographic helpers. Points are [lat, lng] arrays in degrees.
// All distances are kilometres. These functions are pure (no network), so the
// same code runs in the browser, on the server and in tests.

const R = 6371.0088; // mean Earth radius, km
const rad = d => d * Math.PI / 180;

/** Great-circle ("straight line") distance between two points. */
export function haversineKm(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Cumulative distance (km) at every vertex of a polyline. */
export function cumulativeKm(line) {
  const out = [0];
  for (let i = 1; i < line.length; i++) out.push(out[i - 1] + haversineKm(line[i - 1], line[i]));
  return out;
}

// Local flat projection around a latitude: good to well under 1 % for the
// short segment lengths we project onto.
function toXY([lat, lng], lat0) {
  return [rad(lng) * Math.cos(rad(lat0)) * R, rad(lat) * R];
}

/**
 * Nearest point on a polyline to `point`.
 * Returns { distanceKm, routeKm, segmentIndex, t, point }.
 * routeKm = distance along the route from its start to that nearest point.
 */
export function projectOntoLine(point, line, cum = cumulativeKm(line)) {
  let best = { distanceKm: Infinity };
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const lat0 = (a[0] + b[0]) / 2;
    const [ax, ay] = toXY(a, lat0);
    const [bx, by] = toXY(b, lat0);
    const [px, py] = toXY(point, lat0);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const d = Math.hypot(px - cx, py - cy);
    if (d < best.distanceKm) {
      const segKm = cum[i + 1] - cum[i];
      best = { distanceKm: d, routeKm: cum[i] + t * segKm, segmentIndex: i, t, point: interpolate(a, b, t) };
    }
  }
  return best;
}

export function interpolate(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** The point `km` kilometres along the polyline. */
export function pointAtKm(line, cum, km) {
  const target = Math.max(0, Math.min(km, cum[cum.length - 1]));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < target) i++;
  const span = cum[i] - cum[i - 1];
  const t = span ? (target - cum[i - 1]) / span : 0;
  return interpolate(line[i - 1], line[i], t);
}

/** Portion of the polyline between two distances along it. */
export function sliceLine(line, cum, fromKm, toKm) {
  const out = [pointAtKm(line, cum, fromKm)];
  for (let i = 0; i < line.length; i++) if (cum[i] > fromKm && cum[i] < toKm) out.push(line[i]);
  out.push(pointAtKm(line, cum, toKm));
  return out;
}

/** Bounding box [minLat, minLng, maxLat, maxLng] grown by `padKm`. */
export function bbox(points, padKm = 0) {
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
  for (const [lat, lng] of points) {
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
  }
  const dLat = padKm / 111;
  const dLng = padKm / (111 * Math.cos(rad((minLat + maxLat) / 2)));
  return [minLat - dLat, minLng - dLng, maxLat + dLat, maxLng + dLng];
}

export const inBbox = ([lat, lng], [a, b, c, d]) => lat >= a && lat <= c && lng >= b && lng <= d;

/** Douglas–Peucker simplification (tolerance in km) to keep payloads small. */
export function simplify(line, toleranceKm = 0.5) {
  if (line.length < 3) return line.slice();
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = projectOntoLine(line[i], [line[s], line[e]]).distanceKm;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > toleranceKm && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return line.filter((_, i) => keep[i]);
}

/** Evenly spaced sample points along a line (used for provider corridor queries). */
export function samplePoints(line, everyKm) {
  const cum = cumulativeKm(line);
  const total = cum[cum.length - 1];
  const out = [];
  for (let km = 0; km <= total; km += everyKm) out.push(pointAtKm(line, cum, km));
  out.push(line[line.length - 1]);
  return out;
}

export const round = (n, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;

/**
 * Decode a Google "encoded polyline" string into [lat, lng] points.
 *
 * Google (and OSRM) compress a road line into a short ASCII string: each
 * coordinate is stored as the DIFFERENCE from the previous one, multiplied by
 * 10^precision, zig-zag encoded, then split into 5-bit chunks offset by 63.
 * This is the published algorithm — see Google's "Encoded Polyline Algorithm
 * Format". precision 5 = ~1 m accuracy (default), 6 = ~0.1 m.
 *
 * Returns [] for an empty string; throws on a malformed string so the caller
 * can report BAD_RESPONSE instead of drawing a broken line.
 */
export function decodePolyline(encoded, precision = 5) {
  if (typeof encoded !== 'string') throw new TypeError('decodePolyline expects a string');
  const factor = 10 ** precision;
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    const delta = () => {
      let result = 0, shift = 0, byte;
      do {
        if (index >= encoded.length) throw new Error('truncated polyline');
        byte = encoded.charCodeAt(index++) - 63;
        if (byte < 0 || byte > 63) throw new Error('invalid polyline character');
        result |= (byte & 0x1f) << shift;
        shift += 5;
        if (shift > 35) throw new Error('invalid polyline value');
      } while (byte >= 0x20);
      return (result & 1) ? ~(result >>> 1) : (result >>> 1); // zig-zag → signed
    };
    lat += delta();
    lng += delta();
    points.push([lat / factor, lng / factor]);
  }
  return points;
}
