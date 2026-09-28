// CONTEXT-AWARE CAUTIONS (Phase 4)
// Turns live conditions into explainable score penalties and warnings.
// Example from the product brief: a place that normally scores well, but
// heavy rain + a hill road + a large detour → suppress it or show caution.

const RISKY_IN_RAIN = new Set(['waterfall', 'adventure', 'cave', 'viewpoint', 'wildlife']);

/**
 * @param {object[]} phaseWeather [{ phaseId, rainMm, date }]
 * @returns conditions for calculateRecommendationScore(context.conditions)
 */
export function weatherConditions(phaseWeather = []) {
  const conditions = [];
  for (const w of phaseWeather) {
    if (w.rainMm >= 20) {
      conditions.push({
        label: 'Heavy rain forecast',
        severity: 'high',
        message: `Heavy rain forecast (${Math.round(w.rainMm)} mm) on this stretch — hill roads, waterfalls and treks can be unsafe.`,
        appliesTo: p => p.routePhase === w.phaseId && (RISKY_IN_RAIN.has(p.category) || ['hill', 'ghat'].includes(p.terrain))
      });
    } else if (w.rainMm >= 7) {
      conditions.push({
        label: 'Rain forecast',
        severity: 'moderate',
        message: `Rain forecast (${Math.round(w.rainMm)} mm) on this stretch — expect slippery paths and slower roads.`,
        appliesTo: p => p.routePhase === w.phaseId && (RISKY_IN_RAIN.has(p.category) || p.terrain !== 'plain')
      });
    }
  }
  return conditions;
}

/** A large detour on a hill road in the rain is suppressed entirely. */
export function shouldSuppress(place, conditions) {
  return conditions.some(c => c.severity === 'high' && (!c.appliesTo || c.appliesTo(place))) && place.detourTimeMinutes > 90 && place.terrain !== 'plain';
}

/** Is the place closing within `withinMin` of the given clock time (minutes after midnight)? */
export function closingSoon(place, clockMin, withinMin = 60) {
  const h = place.openingHours;
  if (!h) return false;
  return clockMin < h.close && h.close - clockMin <= withinMin;
}
