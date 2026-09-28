// OFFLINE PROVIDERS — work with no internet and no API keys.
//   OfflineGeocoder     town names → coordinates (from the road network)
//   OfflineRouter       shortest-time route over the road network (Dijkstra)
//   CuratedPlaceProvider places within the route corridor (curated list)
// They implement the same contracts as the live providers in server/providers.

import { NODES, EDGES, ROAD_TYPES } from '../data/network.js';
import { CURATED_PLACES } from '../data/places.js';
import { haversineKm, projectOntoLine, cumulativeKm, bbox, inBbox } from '../geo.js';
import { CORRIDOR } from '../config.js';
import { ProviderError } from './contracts.js';

const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

// ---------------------------------------------------------------- geocoding
export function createOfflineGeocoder(nodes = NODES) {
  const index = [];
  for (const node of nodes) {
    for (const label of [node.name, ...node.aliases]) index.push({ key: norm(label), node });
  }
  return {
    name: 'offline-network',
    async geocode(query) {
      const q = norm(query);
      if (!q) throw new ProviderError('PLACE_NOT_FOUND', 'Please enter a place name.');
      const exact = [...new Map(index.filter(e => e.key === q).map(e => [e.node.id, e.node])).values()];
      // Exact official name wins over an alias shared by several towns.
      const official = exact.filter(n => norm(n.name) === q);
      const matches = official.length === 1 ? official : exact;
      if (matches.length === 1) return toResult(matches[0], 1);
      if (matches.length > 1) {
        throw new ProviderError('AMBIGUOUS_PLACE', `“${query}” matches more than one place: ${matches.map(n => n.name).join(' or ')}. Please choose one.`, { options: matches.map(n => n.name) });
      }
      const starts = [...new Map(index.filter(e => e.key.startsWith(q) && q.length >= 4).map(e => [e.node.id, e.node])).values()];
      if (starts.length === 1) return toResult(starts[0], 0.8);
      const close = index
        .map(e => ({ ...e, d: editDistance(q, e.key) }))
        .filter(e => e.d <= Math.max(1, Math.floor(q.length / 4)))
        .sort((a, b) => a.d - b.d);
      const suggestions = [...new Set(close.map(e => e.node.name))].slice(0, 3);
      throw new ProviderError('PLACE_NOT_FOUND',
        suggestions.length ? `We couldn't find “${query}”. Did you mean ${suggestions.join(', ')}?` : `We couldn't find “${query}” in the offline map. Try a nearby larger town.`,
        { suggestions });
    },
    knownPlaces: () => nodes.map(n => n.name).sort()
  };
}
const toResult = (node, confidence) => ({ name: node.name, lat: node.lat, lng: node.lng, state: node.state, nodeId: node.id, confidence, source: 'offline-network' });

// ---------------------------------------------------------------- routing
function buildGraph(nodes, edges) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const adj = new Map(nodes.map(n => [n.id, []]));
  for (const e of edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) throw new Error(`Road network error: unknown node in ${e.from}–${e.to}`);
    const t = ROAD_TYPES[e.type];
    const km = haversineKm([a.lat, a.lng], [b.lat, b.lng]) * t.circuity;
    const min = km / t.speedKmh * 60;
    adj.get(a.id).push({ to: b.id, km, min, type: e.type });
    adj.get(b.id).push({ to: a.id, km, min, type: e.type });
  }
  return { byId, adj };
}

function dijkstra(graph, fromId, toId) {
  const dist = new Map([[fromId, 0]]);
  const prev = new Map();
  const done = new Set();
  const queue = [[0, fromId]];
  while (queue.length) {
    let bestIdx = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i][0] < queue[bestIdx][0]) bestIdx = i;
    const [d, id] = queue.splice(bestIdx, 1)[0];
    if (done.has(id)) continue;
    done.add(id);
    if (id === toId) break;
    for (const edge of graph.adj.get(id)) {
      const nd = d + edge.min;
      if (nd < (dist.get(edge.to) ?? Infinity)) { dist.set(edge.to, nd); prev.set(edge.to, { id, edge }); queue.push([nd, edge.to]); }
    }
  }
  if (!done.has(toId)) return null;
  const steps = [];
  for (let at = toId; at !== fromId; at = prev.get(at).id) steps.unshift({ from: prev.get(at).id, to: at, ...prev.get(at).edge });
  return steps;
}

/** Cost of a short local-road leg that is not part of the highway network. */
export function localLeg(a, b, terrain = 'plain') {
  const factor = { plain: 1, ghat: 1.12, hill: 1.2 }[terrain] || 1;
  const speed = { plain: CORRIDOR.localRoadSpeedKmh, ghat: 28, hill: 24 }[terrain] || CORRIDOR.localRoadSpeedKmh;
  const distanceKm = Math.max(0.3, haversineKm(a, b) * CORRIDOR.roadCircuity * factor);
  return { distanceKm, durationMin: distanceKm / speed * 60 };
}

export function createOfflineRouter(nodes = NODES, edges = EDGES) {
  const graph = buildGraph(nodes, edges);
  const nearestNode = point => {
    let best = null;
    for (const n of nodes) {
      const d = haversineKm(point, [n.lat, n.lng]);
      if (!best || d < best.d) best = { node: n, d };
    }
    return best;
  };

  async function routeBetween(a, b) {
    const sa = nearestNode(a);
    const sb = nearestNode(b);
    const steps = sa.node.id === sb.node.id ? [] : dijkstra(graph, sa.node.id, sb.node.id);
    if (!steps) throw new ProviderError('NO_ROUTE', 'No road connection found between these places in the offline network.');
    const geometry = [a];
    const segments = [];
    const waypoints = [];
    const pushLocal = (p, q) => {
      if (haversineKm(p, q) < 0.5) return;
      const leg = localLeg(p, q);
      segments.push({ km: leg.distanceKm, min: leg.durationMin, type: 'local' });
      geometry.push(q);
    };
    pushLocal(a, [sa.node.lat, sa.node.lng]);
    waypoints.push({ name: sa.node.name, lat: sa.node.lat, lng: sa.node.lng });
    for (const s of steps) {
      const n = graph.byId.get(s.to);
      segments.push({ km: s.km, min: s.min, type: s.type });
      geometry.push([n.lat, n.lng]);
      waypoints.push({ name: n.name, lat: n.lat, lng: n.lng });
    }
    pushLocal(geometry[geometry.length - 1], b);
    return {
      distanceKm: segments.reduce((n, s) => n + s.km, 0),
      durationMin: segments.reduce((n, s) => n + s.min, 0),
      geometry, segments, waypoints
    };
  }

  return {
    name: 'offline-network',
    method: 'estimated',
    async route(points) {
      if (!Array.isArray(points) || points.length < 2) throw new ProviderError('NO_ROUTE', 'A route needs at least two points.');
      let result = null;
      for (let i = 0; i < points.length - 1; i++) {
        const leg = await routeBetween(points[i], points[i + 1]);
        if (!result) { result = leg; continue; }
        result.distanceKm += leg.distanceKm;
        result.durationMin += leg.durationMin;
        result.geometry.push(...leg.geometry.slice(1));
        result.segments.push(...leg.segments);
        result.waypoints.push(...leg.waypoints.filter(w => w.name !== result.waypoints.at(-1)?.name));
      }
      return result;
    },
    // Short off-highway legs (to a place and back) use local-road estimates.
    async legs(pairs, terrains = []) {
      return pairs.map(([a, b], i) => localLeg(a, b, terrains[i]));
    }
  };
}

// ---------------------------------------------------------------- places
export function createCuratedPlaceProvider(places = CURATED_PLACES) {
  return {
    name: 'curated',
    async searchCorridor({ geometry, bufferKm = CORRIDOR.maxDistanceKm }) {
      const box = bbox(geometry, bufferKm);
      const cum = cumulativeKm(geometry);
      return places
        .filter(p => inBbox([p.lat, p.lng], box))
        .filter(p => projectOntoLine([p.lat, p.lng], geometry, cum).distanceKm <= bufferKm)
        .map(p => ({ ...p }));
    }
  };
}
