// Trip impact: how do the chosen stops change the journey?
//
// Phase 1 ("simple" model): one day allows SIMPLE_DAY_MINUTES of driving + visits.
// Phase 2 ("daily" model): see scheduleJourney() in ./schedule.js, which
// simulates each day with start time, driving limits, rest breaks and
// opening hours. Both return the same shape so the UI does not care.

import { SIMPLE_DAY_MINUTES, DAY_MODEL } from '../config.js';

export const FIT = { FITS: 'fits', NEAR: 'near', EXCEEDS: 'exceeds' };

export function sumStops(stops) {
  return {
    extraDistanceKm: round1(stops.reduce((n, p) => n + p.detourDistanceKm, 0)),
    extraTravelMinutes: stops.reduce((n, p) => n + p.detourTimeMinutes, 0),
    totalVisitMinutes: stops.reduce((n, p) => n + p.visitDurationMinutes, 0)
  };
}

/**
 * What each selected stop costs, and what the journey costs once it is added.
 * Adding a stop only ever adds time, so the running totals are the cumulative
 * impact the traveller sees build up as they choose more stops.
 */
export function stopContributions(stops) {
  let addedMinutes = 0;
  let extraDistanceKm = 0;
  return stops.map(p => {
    const added = p.detourTimeMinutes + p.visitDurationMinutes;
    addedMinutes += added;
    extraDistanceKm += p.detourDistanceKm;
    return {
      id: p.id,
      name: p.name,
      // Provenance travels WITH the number, so a figure can never be presented
      // as road-measured when it was estimated, or as live OSM when it was not.
      source: p.source?.provider || 'unknown',
      detourMethod: p.detour?.method || 'estimated',
      detourDistanceKm: p.detourDistanceKm,
      detourTimeMinutes: p.detourTimeMinutes,
      visitDurationMinutes: p.visitDurationMinutes,
      addedMinutes: added,
      cumulativeAddedMinutes: addedMinutes,
      cumulativeExtraDistanceKm: round1(extraDistanceKm)
    };
  });
}

/**
 * Where the numbers behind this trip impact came from.
 *   detourMethod  'road-network' every stop's +min was measured on roads
 *                 'estimated'    every stop's +min is a ROUTE+ estimate
 *                 'mixed'        some of each — treat the total as estimated
 *                 null           nothing selected yet
 *   roadNetwork   true only when EVERY selected stop was road-measured
 *   placeSources  how many selected stops came from each place provider
 */
export function detourProvenance(stops) {
  const methods = new Set(stops.map(p => p.detour?.method || 'estimated'));
  const placeSources = stops.reduce((counts, p) => {
    const provider = p.source?.provider || 'unknown';
    counts[provider] = (counts[provider] || 0) + 1;
    return counts;
  }, {});
  return {
    detourMethod: !stops.length ? null : methods.size === 1 ? [...methods][0] : 'mixed',
    roadNetwork: stops.length > 0 && methods.size === 1 && methods.has('road-network'),
    placeSources
  };
}

/**
 * @param {object} input
 * @param {number} input.originalDays  what the traveller first asked for
 * @param {number} input.tripDays      current plan (may be extended)
 * @param {number} input.baseTravelMinutes main-route driving time
 * @param {object[]} input.selectedStops places with detour numbers
 * @param {number} [input.dayMinutes]  capacity of one day
 */
export function calculateTripImpact({ originalDays, tripDays = originalDays, baseTravelMinutes = 0, selectedStops = [], dayMinutes = SIMPLE_DAY_MINUTES }) {
  const totals = sumStops(selectedStops);
  const workload = baseTravelMinutes + totals.extraTravelMinutes + totals.totalVisitMinutes;
  const requiredDays = Math.max(1, Math.ceil(workload / dayMinutes));
  const availableMinutes = tripDays * dayMinutes;
  return finish({ originalDays, tripDays, requiredDays, workload, availableMinutes, totals, model: 'simple', dayMinutes, stops: selectedStops, baseDrivingMinutes: baseTravelMinutes });
}

/**
 * The journey-time arithmetic every model reports, in one place:
 *
 *   base route driving        (unchanged by any stop — it is the baseline)
 * + added road-network detour (Σ of each stop's +min)
 * + time spent at the places  (Σ of each stop's visit duration)
 * + breaks and waiting        (day model only)
 * ------------------------------------------------------------------
 * = workload  →  required days  →  FITS / NEAR LIMIT / EXCEEDS
 */
export function tripBreakdown({ stops = [], baseDrivingMinutes = 0, totals, workload, breakMinutes = 0, waitMinutes = 0 }) {
  const added = totals.extraTravelMinutes + totals.totalVisitMinutes;
  return {
    baseDrivingMinutes: Math.round(baseDrivingMinutes),
    extraDrivingMinutes: Math.round(totals.extraTravelMinutes),
    visitMinutes: Math.round(totals.totalVisitMinutes),
    addedMinutes: Math.round(added),
    breakdown: {
      baseDrivingMinutes: Math.round(baseDrivingMinutes),
      extraDrivingMinutes: Math.round(totals.extraTravelMinutes),
      visitMinutes: Math.round(totals.totalVisitMinutes),
      breakMinutes: Math.round(breakMinutes),
      waitMinutes: Math.round(waitMinutes),
      addedMinutes: Math.round(added),
      workload: Math.round(workload)
    },
    contributions: stopContributions(stops),
    ...detourProvenance(stops)
  };
}

/** Shared tail used by both models so their output is identical in shape. */
export function finish({ originalDays, tripDays, requiredDays, workload, availableMinutes, totals, model, dayMinutes, days = null, stops = [], baseDrivingMinutes = 0, breakMinutes = 0, waitMinutes = 0 }) {
  const exceedsPlannedDuration = requiredDays > tripDays;
  const ratio = workload / availableMinutes;
  const fit = exceedsPlannedDuration ? FIT.EXCEEDS : ratio > DAY_MODEL.nearLimitRatio ? FIT.NEAR : FIT.FITS;
  return {
    model,
    dayMinutes,
    originalDays,
    tripDays,
    requiredDays,
    estimatedDays: Math.max(tripDays, requiredDays),
    ...totals,
    ...tripBreakdown({ stops, baseDrivingMinutes, totals, workload, breakMinutes, waitMinutes }),
    workload,
    availableMinutes,
    remainingMinutes: availableMinutes - workload,
    exceedsOriginalDuration: requiredDays > originalDays,
    exceedsPlannedDuration,
    // How many days the traveller would have to add to keep every stop.
    extraDaysNeeded: Math.max(0, requiredDays - tripDays),
    fit,
    days
  };
}

/** Which stops would you remove to get back inside the plan? Biggest first. */
export function suggestRemovals(stops, overMinutes) {
  let recovered = 0;
  return [...stops]
    .sort((a, b) => cost(b) - cost(a))
    .filter(p => {
      if (recovered >= overMinutes) return false;
      recovered += cost(p);
      return true;
    });
}

const cost = p => p.detourTimeMinutes + p.visitDurationMinutes;
const round1 = n => Math.round(n * 10) / 10;
