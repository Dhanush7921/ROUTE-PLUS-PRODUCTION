// OSRM RouteProvider — real road-network routing from OpenStreetMap data.
// Works with the public demo server (fair use only, no SLA) or, for
// production, a self-hosted OSRM instance built from the India extract.
//   Docs: https://project-osrm.org/docs/v5.24.0/api/
// OSRM durations assume free-flowing traffic; `durationFactor` scales them to
// typical Indian highway conditions (configurable, default 1.2).

import { ProviderError } from '../../shared/providers/contracts.js';
import { fetchJson } from './http.js';

const coord = ([lat, lng]) => `${lng.toFixed(6)},${lat.toFixed(6)}`;

export function createOsrmRouter({ baseUrl = 'https://router.project-osrm.org', profile = 'driving', durationFactor = 1.2, fetchImpl, timeoutMs = 10000, chunk = 40 } = {}) {
  const base = baseUrl.replace(/\/$/, '');
  return {
    name: 'osrm',
    method: 'road-network',
    async route(points) {
      const url = `${base}/route/v1/${profile}/${points.map(coord).join(';')}?overview=full&geometries=geojson&steps=false&annotations=false`;
      const body = await fetchJson(url, { fetchImpl, timeoutMs, acceptErrorJson: true });
      if (body.code !== 'Ok' || !body.routes?.length) {
        if (body.code === 'NoRoute') throw new ProviderError('NO_ROUTE', 'No road route found between these places.');
        throw new ProviderError('BAD_RESPONSE', `OSRM: ${body.code || 'unknown response'}`);
      }
      const r = body.routes[0];
      return {
        distanceKm: r.distance / 1000,
        durationMin: r.duration / 60 * durationFactor,
        geometry: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
        segments: r.legs?.length > 1 ? r.legs.map(l => ({ km: l.distance / 1000, min: l.duration / 60 * durationFactor, type: 'road' })) : undefined
      };
    },
    // Batched point-to-point costs using the OSRM table service. Each chunk
    // sends k origins + k destinations and reads the diagonal of the matrix.
    async legs(pairs) {
      const out = [];
      for (let i = 0; i < pairs.length; i += chunk) {
        const slice = pairs.slice(i, i + chunk);
        const coords = [...slice.map(p => p[0]), ...slice.map(p => p[1])];
        const k = slice.length;
        const sources = slice.map((_, j) => j).join(';');
        const destinations = slice.map((_, j) => j + k).join(';');
        const url = `${base}/table/v1/${profile}/${coords.map(coord).join(';')}?sources=${sources}&destinations=${destinations}&annotations=distance,duration`;
        const body = await fetchJson(url, { fetchImpl, timeoutMs });
        if (body.code !== 'Ok') throw new ProviderError('BAD_RESPONSE', `OSRM table: ${body.code}`);
        slice.forEach((_, j) => {
          const d = body.distances?.[j]?.[j];
          const t = body.durations?.[j]?.[j];
          if (d == null || t == null) throw new ProviderError('NO_ROUTE', 'A detour leg has no road connection.');
          out.push({ distanceKm: d / 1000, durationMin: t / 60 * durationFactor });
        });
      }
      return out;
    }
  };
}
