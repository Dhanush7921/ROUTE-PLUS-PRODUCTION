// Journey service — the ONE doorway between the screens and the planning engine.
// The dashboard asks this module for a plan and for the trip impact. Which
// engine answers is decided here, so screens never contain provider code:
//
//   'server'  the ROUTE+ API (live providers + fallbacks, accounts)  — Phase 3
//   'geo'     the same geographic engine running inside the browser   — Phase 2
//   'sample'  the Phase 1 simulated routes (?engine=sample)
//
// If the server is not running (e.g. the standalone file), 'geo' is used.

import { createMockPlanner, PlanError } from '../../shared/engine/mockPlanner.js';
import { createGeoPlanner } from '../../shared/engine/geoPlanner.js';
import { createOfflineGeocoder, createOfflineRouter, createCuratedPlaceProvider } from '../../shared/providers/offline.js';
import { NODES } from '../../shared/data/network.js';
import { calculateTripImpact } from '../../shared/engine/tripImpact.js';
import { buildRouteIndex } from '../../shared/engine/routeIndex.js';
import { scheduleJourney } from '../../shared/engine/schedule.js';

const offlineGeocoder = createOfflineGeocoder();
const planners = {
  sample: createMockPlanner(),
  geo: createGeoPlanner({ geocoder: offlineGeocoder, router: createOfflineRouter(), places: createCuratedPlaceProvider(), knownTowns: NODES }),
  server: {
    name: 'server',
    async plan(request) {
      let res;
      try {
        res = await fetch('api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(request) });
      } catch {
        // Network hiccup or no signal → plan it in the browser instead. The
        // traveller must be told: these figures come from the offline network
        // and the curated list, not from the live services the server uses.
        const plan = await planners.geo.plan(request);
        plan.offlineFallback = true;
        plan.notices = ['You appear to be offline. ROUTE+ planned this journey on your device, from its offline road network and curated places.', ...(plan.notices || [])];
        return plan;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new PlanError(body.error?.code || 'PROVIDER_UNAVAILABLE', body.error?.message || 'Planning failed.', body.error?.details || {});
      return body.plan;
    }
  }
};

const requested = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('engine') : null;
let activeMode = requested && planners[requested] ? requested : 'geo';
let serverInfo = null;

/** Detect the API once at start-up. Returns server info or null. */
export async function detectServer() {
  if (requested && requested !== 'server') return null;
  // The ROUTE+ server marks pages it serves; static hosting has no API to probe.
  if (!document.querySelector('meta[name="route-plus-api"]')) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch('api/health', { signal: controller.signal, credentials: 'same-origin' });
    clearTimeout(timer);
    if (!res.ok) return null;
    serverInfo = await res.json();
    activeMode = 'server';
    return serverInfo;
  } catch {
    return null;
  }
}

export function engineMode() { return activeMode; }
export function getServerInfo() { return serverInfo; }

export async function planJourney(request) {
  return planners[activeMode].plan(request);
}

export function suggestedRoutes() {
  if (activeMode === 'sample') return planners.sample.suggestions();
  return [
    ['Visakhapatnam', 'Manali'], ['Vijayawada', 'Manali'], ['Hyderabad', 'Goa'], ['Chennai', 'Ooty'],
    ['Delhi', 'Jaipur'], ['Mumbai', 'Goa'], ['Bengaluru', 'Coorg'], ['Kolkata', 'Darjeeling']
  ].map(([origin, destination]) => ({ origin, destination }));
}

export function knownPlaces() {
  if (activeMode === 'sample') return [...new Set(planners.sample.suggestions().flatMap(r => [r.origin, r.destination]))];
  return offlineGeocoder.knownPlaces();
}

/** Places the traveller added, in route order. */
export function selectedPlaces(plan, state) {
  if (!plan) return [];
  return plan.places
    .filter(p => state.selectedStops.includes(p.id))
    .sort((a, b) => (a.routeKm ?? a.phaseIndex ?? 0) - (b.routeKm ?? b.phaseIndex ?? 0));
}

const indexCache = new WeakMap();
export function routeIndexFor(plan) {
  if (!indexCache.has(plan)) indexCache.set(plan, buildRouteIndex(plan.route));
  return indexCache.get(plan);
}

export function tripImpact(plan, state) {
  const stops = selectedPlaces(plan, state);
  if (plan?.route.geometry?.length > 1) {
    return scheduleJourney({ index: routeIndexFor(plan), stops, originalDays: state.originalDays, tripDays: state.tripDays });
  }
  return calculateTripImpact({
    originalDays: state.originalDays,
    tripDays: state.tripDays,
    baseTravelMinutes: plan?.route.durationMin || 0,
    selectedStops: stops
  });
}
