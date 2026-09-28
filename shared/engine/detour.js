// DETOUR ENGINE — the core of ROUTE+.
//
// For every candidate place we answer: "compared with just driving the main
// route, how much EXTRA distance and time does visiting this place cost?"
//
//   1. project the place onto the route        → nearest route point P (routeKm)
//   2. choose where you would leave the route  → anchor A (a little before P)
//   3. choose where you would rejoin           → rejoin  B (a little after P)
//   4. ask the RouteProvider for road costs    A→place, place→B, P→place
//   5. baseline = main-route cost from A to B  (what you would drive anyway)
//   6. strategy "through":      A→place→B  minus baseline
//      strategy "out-and-back": P→place→P  (there and back on the same road)
//   7. keep the cheaper strategy
//
//   EXTRA DISTANCE = detour route distance − baseline route distance
//   EXTRA TIME     = detour route time     − baseline route time
//
// Nothing here knows which vendor is used: `router.legs()` may be the offline
// estimator or real OSRM road routing. The maths is the same.

import { round } from '../geo.js';

const MIN_STOP_OVERHEAD_MIN = 5; // slowing down, turning, parking

export async function computeDetours(index, candidates, router) {
  if (!candidates.length) return [];
  const plans = candidates.map(place => {
    const point = [place.lat, place.lng];
    const proj = index.project(point);
    // Leave and rejoin roughly as far along the road as the place is from it.
    const spread = Math.min(Math.max(proj.distanceKm, 2), 25);
    const anchorKm = Math.max(0, proj.routeKm - spread);
    const rejoinKm = Math.min(index.totalKm, proj.routeKm + spread);
    return { place, point, proj, anchorKm, rejoinKm, anchor: index.pointAt(anchorKm), rejoin: index.pointAt(rejoinKm), nearest: index.pointAt(proj.routeKm) };
  });

  // One batched call: 3 legs per candidate.
  const pairs = [];
  const terrains = [];
  for (const p of plans) {
    pairs.push([p.anchor, p.point], [p.point, p.rejoin], [p.nearest, p.point]);
    terrains.push(p.place.terrain, p.place.terrain, p.place.terrain);
  }
  const legs = await router.legs(pairs, terrains);
  // The method of the provider that actually answered the LEGS — not the main
  // route. Google may route the main line while these short local legs are
  // still offline estimates; the figures must say which they are.
  const legsMethod = router.legsMethod || router.method || 'estimated';

  return plans.map((p, i) => {
    const [toPlace, fromPlace, spur] = legs.slice(i * 3, i * 3 + 3);
    const baselineKm = p.rejoinKm - p.anchorKm;
    const baselineMin = index.timeAt(p.rejoinKm) - index.timeAt(p.anchorKm);
    const through = {
      strategy: 'through',
      extraKm: toPlace.distanceKm + fromPlace.distanceKm - baselineKm,
      extraMin: toPlace.durationMin + fromPlace.durationMin - baselineMin,
      detourKm: toPlace.distanceKm + fromPlace.distanceKm
    };
    const outAndBack = { strategy: 'out-and-back', extraKm: spur.distanceKm * 2, extraMin: spur.durationMin * 2, detourKm: spur.distanceKm * 2 };
    const best = through.extraMin <= outAndBack.extraMin ? through : outAndBack;
    const isThrough = best.strategy === 'through';
    const extraKm = Math.max(0, best.extraKm);
    const extraMin = Math.max(MIN_STOP_OVERHEAD_MIN, best.extraMin);
    return {
      ...p.place,
      routeKm: round(p.proj.routeKm, 1),
      distanceFromRouteKm: round(p.proj.distanceKm, 1),
      detourDistanceKm: round(extraKm, 1),
      detourTimeMinutes: Math.round(extraMin),
      detour: {
        strategy: best.strategy,
        method: legsMethod,
        anchor: isThrough ? p.anchor : p.nearest,
        rejoin: isThrough ? p.rejoin : p.nearest,
        anchorKm: round(isThrough ? p.anchorKm : p.proj.routeKm, 1),
        rejoinKm: round(isThrough ? p.rejoinKm : p.proj.routeKm, 1),
        anchorName: index.nearestTown(isThrough ? p.anchorKm : p.proj.routeKm),
        rejoinName: index.nearestTown(isThrough ? p.rejoinKm : p.proj.routeKm),
        detourRouteKm: round(best.detourKm, 1),
        baselineKm: round(isThrough ? baselineKm : 0, 1),
        baselineMin: Math.round(isThrough ? baselineMin : 0)
      }
    };
  });
}
