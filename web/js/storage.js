// Browser storage for journeys (localStorage).
// Two separate records:
//   current  — auto-saved after every change, restored after refresh
//   saved    — explicit "Save Journey" list, kept until the traveller deletes it
// Stored data can be old or edited by hand, so every record is validated.

import { INTERESTS, TRAVELERS } from '../../shared/taxonomy.js';
import { STORAGE_KEYS } from '../../shared/config.js';
import { createState } from './state.js';

const MAX_SAVED = 12;

function validPlan(plan) {
  return plan && typeof plan === 'object' && typeof plan.id === 'string' &&
    Array.isArray(plan.places) && Array.isArray(plan.phases) && plan.route &&
    Number.isFinite(plan.route.durationMin);
}

/** Returns a clean state object or null if the record is unusable. */
export function sanitizeJourney(raw) {
  if (!raw || typeof raw !== 'object' || !validPlan(raw.plan)) return null;
  const intDays = n => Number.isInteger(n) && n >= 1 && n <= 60;
  if (!intDays(raw.tripDays) || !TRAVELERS.includes(raw.travelerType) || !Array.isArray(raw.interests)) return null;
  const interests = [...new Set(raw.interests.filter(i => INTERESTS.includes(i)))];
  if (!interests.length) return null;

  const placeIds = new Set(raw.plan.places.map(p => p.id));
  const openIds = new Set(raw.plan.places.filter(p => p.openNow !== false).map(p => p.id));
  const ids = list => [...new Set(Array.isArray(list) ? list.filter(id => placeIds.has(id)) : [])];
  const selectedStops = ids(raw.selectedStops).filter(id => openIds.has(id));
  const skippedPlaces = ids(raw.skippedPlaces).filter(id => !selectedStops.includes(id));

  return {
    ...createState(),
    journeyId: typeof raw.journeyId === 'string' ? raw.journeyId : `j-${raw.plan.id}`,
    origin: raw.plan.origin?.name || raw.origin,
    destination: raw.plan.destination?.name || raw.destination,
    tripDays: raw.tripDays,
    originalDays: intDays(raw.originalDays) ? raw.originalDays : raw.tripDays,
    travelerType: raw.travelerType,
    interests,
    plan: raw.plan,
    selectedStops,
    skippedPlaces,
    keptOverLimit: raw.keptOverLimit === true,
    serverTripId: typeof raw.serverTripId === 'string' ? raw.serverTripId : null,
    savedAt: raw.savedAt || null
  };
}

/** Only the fields worth keeping; filters and open dialogs are not stored. */
export function serializeJourney(state) {
  const { journeyId, origin, destination, tripDays, originalDays, travelerType, interests,
    plan, selectedStops, skippedPlaces, keptOverLimit, serverTripId } = state;
  return { journeyId, origin, destination, tripDays, originalDays, travelerType, interests,
    plan, selectedStops, skippedPlaces, keptOverLimit, serverTripId, savedAt: new Date().toISOString() };
}

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
  catch { return fallback; }
}

export function loadJourneys() {
  const rows = read(STORAGE_KEYS.saved, []);
  return Array.isArray(rows) ? rows.map(sanitizeJourney).filter(Boolean) : [];
}

/** Throws if storage is unavailable, so the caller can tell the traveller. */
export function saveJourney(state) {
  const record = serializeJourney(state);
  if (!sanitizeJourney(record)) throw new Error('Create a journey before saving.');
  const others = read(STORAGE_KEYS.saved, []).filter(j => j?.journeyId !== record.journeyId);
  localStorage.setItem(STORAGE_KEYS.saved, JSON.stringify([record, ...others].slice(0, MAX_SAVED)));
}

export function deleteJourney(journeyId) {
  try {
    const rows = read(STORAGE_KEYS.saved, []).filter(j => j?.journeyId !== journeyId);
    localStorage.setItem(STORAGE_KEYS.saved, JSON.stringify(rows));
    return true;
  } catch { return false; }
}

export function saveCurrentJourney(state) {
  try {
    const record = serializeJourney(state);
    if (!sanitizeJourney(record)) return false;
    localStorage.setItem(STORAGE_KEYS.current, JSON.stringify(record));
    return true;
  } catch { return false; }
}

export function loadCurrentJourney() {
  return sanitizeJourney(read(STORAGE_KEYS.current, null));
}

export function clearCurrentJourney() {
  try { localStorage.removeItem(STORAGE_KEYS.current); return true; } catch { return false; }
}
