// Route index: answers "how far along?" and "how long to drive?" questions
// about the MAIN route. Built once per plan and reused by the corridor,
// detour engine and day scheduler.

import { cumulativeKm, pointAtKm, projectOntoLine, haversineKm } from '../geo.js';

export function buildRouteIndex(route) {
  const geometry = route.geometry;
  const cum = cumulativeKm(geometry);
  const geomKm = cum[cum.length - 1] || 1;
  // Providers report road distance, geometry is often simplified. Scale
  // geometry kilometres to road kilometres so numbers stay consistent.
  const roadScale = route.distanceKm / geomKm;

  // Time profile: cumulative minutes at cumulative road km, from segments if
  // the provider gave them (varying speeds), otherwise a constant average.
  let timeKm = [0];
  let timeMin = [0];
  if (route.segments?.length) {
    for (const s of route.segments) {
      timeKm.push(timeKm.at(-1) + s.km);
      timeMin.push(timeMin.at(-1) + s.min);
    }
    const k = route.distanceKm / timeKm.at(-1);
    timeKm = timeKm.map(v => v * k);
  } else {
    timeKm = [0, route.distanceKm];
    timeMin = [0, route.durationMin];
  }

  const lerp = (xs, ys, x) => {
    if (x <= xs[0]) return ys[0];
    for (let i = 1; i < xs.length; i++) {
      if (x <= xs[i]) {
        const span = xs[i] - xs[i - 1] || 1;
        return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / span;
      }
    }
    return ys.at(-1);
  };

  const waypoints = (route.waypoints || []).map(w => ({ ...w, routeKm: projectOntoLine([w.lat, w.lng], geometry, cum).routeKm * roadScale }));

  return {
    geometry,
    cum,
    totalKm: route.distanceKm,
    totalMin: route.durationMin,
    /** road km along the route → [lat, lng] */
    pointAt: km => pointAtKm(geometry, cum, km / roadScale),
    /** project any point onto the route; routeKm is in road km */
    project(point) {
      const p = projectOntoLine(point, geometry, cum);
      return { ...p, routeKm: p.routeKm * roadScale };
    },
    /** minutes of main-route driving from the start to `km` */
    timeAt: km => lerp(timeKm, timeMin, km),
    /** inverse of timeAt */
    kmAtTime: min => lerp(timeMin, timeKm, min),
    waypoints,
    /** name of the nearest town on the route to a road-km position */
    nearestTown(km) {
      if (!waypoints.length) return null;
      return waypoints.reduce((best, w) => (Math.abs(w.routeKm - km) < Math.abs(best.routeKm - km) ? w : best)).name;
    },
    /** towns within `maxKm` of a point, for labelling live-provider routes */
    distanceTo: point => projectOntoLine(point, geometry, cum).distanceKm,
    straightKm: haversineKm
  };
}
