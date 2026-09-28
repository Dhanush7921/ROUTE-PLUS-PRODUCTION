// PHASE 1 planner: turns a journey request into a JourneyPlan using the
// simulated sample routes. Phase 2's geoPlanner returns the SAME shape, which
// is why the dashboard did not need rewriting when real geography arrived.

import { MOCK_ROUTES } from '../data/mockRoutes.js';

export class PlanError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const normalize = value => String(value || '').trim().toLowerCase();

export function createMockPlanner() {
  return {
    name: 'sample',
    async plan(request) {
      const route = MOCK_ROUTES.find(r =>
        normalize(r.origin.name) === normalize(request.origin) &&
        normalize(r.destination.name) === normalize(request.destination));
      if (!route) {
        throw new PlanError('ROUTE_NOT_SUPPORTED', 'This route is not in the sample data yet.', {
          suggestions: MOCK_ROUTES.map(r => `${r.origin.name} → ${r.destination.name}`)
        });
      }
      return {
        id: route.id,
        mode: 'sample',
        origin: route.origin,
        destination: route.destination,
        route: { distanceKm: route.distanceKm, durationMin: route.durationMin, geometry: null, provider: 'sample', schematic: true },
        phases: route.phases,
        places: route.places,
        notices: ['Sample data: routes, places and distances are simulated.']
      };
    },
    suggestions() {
      return MOCK_ROUTES.map(r => ({ origin: r.origin.name, destination: r.destination.name }));
    }
  };
}
