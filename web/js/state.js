// The single place where the traveller's current journey lives.
// Screens READ from this object and app.js is the only module that CHANGES it.

import { DEFAULT_FILTERS } from '../../shared/engine/recommend.js';

export function createState() {
  return {
    journeyId: null,
    origin: '',
    destination: '',
    tripDays: 3,          // current plan (changes when the traveller extends)
    originalDays: 3,      // what was first requested — never changes
    travelerType: 'Family',
    interests: [],
    plan: null,           // JourneyPlan from the journey service
    selectedStops: [],    // place ids, in the order they were added
    skippedPlaces: [],    // place ids; source data is never modified
    currentPhaseId: 'all',
    filters: { ...DEFAULT_FILTERS },
    keptOverLimit: false, // traveller chose "keep original duration" despite the warning
    serverTripId: null    // set when the journey is stored in an account (Phase 3)
  };
}

export const appState = createState();

export function resetState() {
  Object.assign(appState, createState());
}

export function newJourneyId() {
  return `j-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
