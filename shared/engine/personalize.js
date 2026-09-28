// PERSONALISATION (Phase 4) — rules + real behaviour, not a black box.
//
// Input: counts of what a traveller (or all travellers) actually did.
// Output: small, capped score adjustments with a plain-language reason.
// The base rules still dominate; behaviour can only nudge by ±10 points.
// Sponsored status is never an input here or anywhere in scoring.

const CAP = 10;
const MIN_SIGNALS = 3; // do not personalise from one or two clicks

/**
 * @param {object} byCategory { [category]: { added, skipped, removed, opened, worthYes, worthNo } }
 * @returns {object} { [category]: points }
 */
export function categoryBoosts(byCategory = {}) {
  const out = {};
  for (const [category, c] of Object.entries(byCategory)) {
    const total = (c.added || 0) + (c.skipped || 0) + (c.removed || 0) + (c.worthYes || 0) + (c.worthNo || 0);
    if (total < MIN_SIGNALS) continue;
    const signal = (c.added || 0) * 3 + (c.worthYes || 0) * 4 - (c.skipped || 0) - (c.removed || 0) * 2 - (c.worthNo || 0) * 3;
    const points = Math.round(Math.max(-CAP, Math.min(CAP, signal / total * 4)));
    if (points) out[category] = points;
  }
  return out;
}

/**
 * Crowd signal per place from "was it worth the detour?" feedback.
 * @param {object} byPlace { [placeId]: { yes, no } }
 */
export function placeFeedbackAdjustments(byPlace = {}) {
  const out = {};
  for (const [id, f] of Object.entries(byPlace)) {
    const n = (f.yes || 0) + (f.no || 0);
    if (n < MIN_SIGNALS) continue;
    const rate = f.yes / n;
    if (rate >= 0.8) out[id] = { points: 5, label: `${Math.round(rate * 100)}% of ${n} travellers said it was worth the detour` };
    else if (rate <= 0.4) out[id] = { points: -10, label: `Only ${Math.round(rate * 100)}% of ${n} travellers said it was worth the detour` };
  }
  return out;
}

/** Convert adjustments into the `context` object the scorer understands. */
export function toScoringContext({ categories = {}, places = {} } = {}) {
  const personalBoost = { ...categories };
  const conditions = Object.entries(places).map(([placeId, a]) => ({
    placeId, label: 'Traveller feedback', points: a.points, message: a.label
  }));
  return { personalBoost, conditions };
}
