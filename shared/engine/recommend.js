// Transparent, rule-based recommendation scoring.
// No AI: every point a place receives is listed in `breakdown`, and every
// sentence shown to the traveller in `reasons` comes from real data fields.

import { SCORING } from '../config.js';
import { CATEGORIES } from '../taxonomy.js';

const { weights: W, penalties: P, thresholds: T } = SCORING;

/** Interests a place serves = its own interests + its category's interests. */
export function placeInterests(place) {
  const fromCategory = CATEGORIES[place.category]?.interests || [];
  return [...new Set([...(place.interests || []), ...fromCategory])];
}

/**
 * Score one place for one traveller.
 * @param {object} place     ROUTE+ place (with detour numbers)
 * @param {object} profile   { travelerType, interests[] }
 * @param {object} trip      { remainingMinutes } from calculateTripImpact
 * @param {object} context   optional { conditions: [{ placeId?, severity, message }],
 *                            personalBoost: { [placeId|category]: points } }
 */
export function calculateRecommendationScore(place, profile, trip = {}, context = {}) {
  const breakdown = [];
  const reasons = [];
  const warnings = [];
  const add = (label, value) => { if (value) breakdown.push({ label, value }); };

  const matches = placeInterests(place).filter(i => profile.interests.includes(i));
  if (matches.length) {
    add('Interest match', W.interestMatch + Math.min(matches.length - 1, 2) * W.extraInterest);
    reasons.push(`Matches ${matches.slice(0, 3).join(' + ')}`);
  }

  const fits = place.suitableFor?.includes(profile.travelerType);
  if (fits) { add('Traveller fit', W.travelerFit); reasons.push(`Suitable for ${profile.travelerType}`); }
  else add('Not a strong fit for your group', P.poorTravelerFit);

  if (place.distanceFromRouteKm <= T.nearRouteKm) {
    add('Close to your route', W.routeProximity);
    reasons.push(`Only ${round1(place.distanceFromRouteKm)} km off your route`);
  }

  if (place.detourTimeMinutes <= T.efficientDetourMin) {
    add('Efficient detour', W.detourEfficiency);
    reasons.push(`Low detour: +${place.detourTimeMinutes} min driving`);
  } else if (place.detourTimeMinutes > T.largeDetourMin) {
    add('Large detour', P.largeDetour);
    warnings.push(`Large detour: +${place.detourTimeMinutes} min driving`);
  }

  if (place.rating >= T.goodRating) add('Place quality', W.placeQuality);

  if (place.openNow === false) { add('Closed', P.closed); warnings.push('Closed or unavailable'); }
  else add('Available', W.availability);

  if (place.walkingMinutes > T.longWalkMin) {
    add('Long walk', P.longWalk);
    warnings.push(`About ${place.walkingMinutes} min of walking`);
  }
  if (place.seasonalFit === false) { add('Poor seasonal fit', P.poorSeason); warnings.push('Not ideal this season'); }

  const cost = place.detourTimeMinutes + place.visitDurationMinutes;
  if (trip.remainingMinutes !== undefined) {
    if (cost > trip.remainingMinutes) { add('Exceeds your spare time', P.exceedsTime); warnings.push('May need a longer trip'); }
    else reasons.push('Fits your trip');
  }

  // Phase 4 hooks: live conditions and learned behaviour. Both are explainable.
  for (const c of context.conditions || []) {
    if (c.placeId && c.placeId !== place.id) continue;
    if (c.appliesTo && !c.appliesTo(place)) continue;
    const points = c.points ?? (c.severity === 'high' ? P.caution * 2 : P.caution);
    add(c.label || 'Current conditions', points);
    (points > 0 ? reasons : warnings).push(c.message);
  }
  const boost = context.personalBoost?.[place.id] ?? context.personalBoost?.[place.category] ?? 0;
  if (boost) {
    add('Your past choices', boost);
    if (boost > 0) reasons.push('Similar to stops you added before');
  }

  const score = breakdown.reduce((sum, row) => sum + row.value, 0);
  return {
    score,
    breakdown,
    reasons,
    warnings,
    interestMatches: matches,
    meaningful: matches.length > 0 && place.openNow !== false
  };
}

/** Filters that the traveller controls on the dashboard. */
export const DEFAULT_FILTERS = Object.freeze({ category: 'all', interest: 'all', fit: 'all', distance: 'all', time: 'all' });

function passesFilters(place, profile, filters) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  return (f.category === 'all' || place.category === f.category)
    && (f.interest === 'all' || placeInterests(place).includes(f.interest))
    && (f.fit === 'all' || place.suitableFor?.includes(profile.travelerType))
    && (f.distance === 'all' || place.detourDistanceKm <= Number(f.distance))
    && (f.time === 'all' || place.detourTimeMinutes + place.visitDurationMinutes <= Number(f.time));
}

/**
 * Rank candidate places. Skipped and already-added places are excluded,
 * the source list is never mutated.
 */
export function getRecommendedPlaces(places, state, trip, context = {}) {
  const profile = { travelerType: state.travelerType, interests: state.interests };
  return places
    .filter(p => !state.skippedPlaces.includes(p.id) && !state.selectedStops.includes(p.id))
    .map(p => ({ ...p, ...calculateRecommendationScore(p, profile, trip, context) }))
    .filter(p => p.meaningful && p.score >= SCORING.thresholds.minimumScore)
    .filter(p => !context.suppress?.(p))
    .filter(p => state.currentPhaseId === 'all' || p.routePhase === state.currentPhaseId)
    .filter(p => passesFilters(p, profile, state.filters))
    .sort((a, b) => b.score - a.score || a.detourTimeMinutes - b.detourTimeMinutes);
}

const round1 = n => Math.round(n * 10) / 10;
