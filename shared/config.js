// Tunable numbers live here instead of being scattered as "magic numbers".
// They are product assumptions, not scientific truths. Change them here and
// every screen, test and API uses the new value.

export const SCORING = {
  weights: {
    interestMatch: 30,      // place serves at least one chosen interest
    extraInterest: 5,       // each additional matching interest (max 2 extra)
    travelerFit: 25,
    routeProximity: 20,     // close to the main route
    detourEfficiency: 10,   // small extra driving time
    placeQuality: 10,
    availability: 5
  },
  penalties: {
    largeDetour: -20,
    poorTravelerFit: -20,
    closed: -30,
    longWalk: -10,
    poorSeason: -15,
    exceedsTime: -10,
    caution: -10            // context warnings such as heavy rain on a hill road
  },
  thresholds: {
    nearRouteKm: 5,         // "route proximity" bonus
    efficientDetourMin: 40, // extra driving minutes still considered efficient
    largeDetourMin: 120,    // beyond this the detour is penalised
    goodRating: 4.3,
    longWalkMin: 30,
    minimumScore: 30        // below this a place is not recommended
  }
};

// Phase 1 prototype trip model (kept for the schematic demo).
export const SIMPLE_DAY_MINUTES = 600;

// Phase 2 realistic day model used by the trip planner.
export const DAY_MODEL = {
  startTime: 7 * 60,          // leave at 07:00
  latestDriveEnd: 20 * 60,    // stop driving by 20:00
  maxDrivingMinutes: 9 * 60,  // a responsible daily driving limit
  breakEveryMinutes: 150,     // short rest after this much continuous driving
  breakMinutes: 15,
  nearLimitRatio: 0.9         // above 90 % of available time = NEAR LIMIT
};

// Route corridor: how far from the main road we look for discoveries.
export const CORRIDOR = {
  maxDistanceKm: 45,          // straight-line distance from the route line
  roadCircuity: 1.35,         // local roads are ~35 % longer than a straight line
  localRoadSpeedKmh: 35,      // typical speed on the small road to a place
  phaseCount: 4               // route is split into this many corridors
};

export const STORAGE_KEYS = {
  saved: 'route-plus-journeys-v2',
  current: 'route-plus-current-v2'
};
