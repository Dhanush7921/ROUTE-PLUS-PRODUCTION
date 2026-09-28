// ROUTE+ application controller.
// Flow: form → journeyService.planJourney() → state → render().
// Every button carries a data-* attribute; one click listener routes it to a
// small handler below. Rendering lives in ./ui, calculations in /shared.

import { INTERESTS, TRAVELERS, TRIP_DURATIONS, CATEGORIES, DEMO_JOURNEY } from '../../shared/taxonomy.js';
import { getRecommendedPlaces, calculateRecommendationScore, DEFAULT_FILTERS } from '../../shared/engine/recommend.js';
import { appState as state, resetState, newJourneyId } from './state.js';
import * as service from './journeyService.js';
import * as storage from './storage.js';
import { track } from './analytics.js';
import { escapeHTML, days } from './format.js';
import { renderRouteMap, selectMapRenderer } from './ui/mapRenderer.js';
import { renderHeader, renderSummary, renderPhases, renderCards, renderPanel, hideImpactBar } from './ui/dashboard.js';
import { renderDetail, renderWarning, renderSaved, showDialog, closeDialog, wireDialogFocus } from './ui/dialogs.js';

const $ = id => document.getElementById(id);
const form = $('journey-form');
// Extension points used by account.js (Phase 3) and intelligence.js (Phase 4).
const hooks = {
  server: null, afterRender: [], context: () => ({}), mapExtras: () => ({}), onSave: null, onBehaviour: null,
  savedExtras: async () => ({}), loadAccountTrip: null, deleteAccountTrip: null, feedbackEnabled: () => false, onFeedback: null
};
let lastAddedId = null;
let visibleCards = 12;
let requestToken = 0;
let toastTimer = null;

// ---------------------------------------------------------------- helpers
export function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('visible'), 3500);
}

const options = values => values.map(v => `<option value="${escapeHTML(v.value ?? v)}">${escapeHTML(v.label ?? v)}</option>`).join('');

function current() {
  const plan = state.plan;
  const stops = service.selectedPlaces(plan, state);
  const impact = plan ? service.tripImpact(plan, state) : null;
  return { plan, stops, impact };
}

function showLanding() { $('landing').hidden = false; $('dashboard').hidden = true; hideImpactBar(); }
function showDashboard() { $('landing').hidden = true; $('dashboard').hidden = false; }

// ---------------------------------------------------------------- render
function render() {
  const { plan, stops, impact } = current();
  if (!plan) return;
  const context = hooks.context(plan, state);
  const allRecommended = getRecommendedPlaces(plan.places, { ...state, currentPhaseId: 'all', filters: { ...DEFAULT_FILTERS } }, impact, context);
  const recommended = getRecommendedPlaces(plan.places, state, impact, context);
  const countsByPhase = {};
  for (const p of allRecommended) countsByPhase[p.routePhase] = (countsByPhase[p.routePhase] || 0) + 1;

  showDashboard();
  renderHeader(plan, state);
  renderSummary(state, impact);
  renderRouteMap($('map'), plan, state, recommended.length ? recommended : allRecommended, hooks.mapExtras());
  renderPhases(plan, state, countsByPhase);
  renderCards(recommended, state, visibleCards);
  renderPanel(plan, state, impact, stops);
  if (!storage.saveCurrentJourney(state)) toast('Changes work, but this browser is not allowing storage.');
  hooks.afterRender.forEach(fn => fn({ plan, state, impact, recommended }));
}

// ---------------------------------------------------------------- form
function fillForm(values) {
  form.elements.origin.value = values.origin;
  form.elements.destination.value = values.destination;
  form.elements.tripDays.value = String(values.tripDays);
  form.elements.travelerType.value = values.travelerType;
  form.querySelectorAll('[name=interests]').forEach(input => { input.checked = values.interests.includes(input.value); });
}

function readForm() {
  return {
    origin: form.elements.origin.value.trim(),
    destination: form.elements.destination.value.trim(),
    tripDays: Number(form.elements.tripDays.value),
    travelerType: form.elements.travelerType.value,
    interests: [...form.querySelectorAll('[name=interests]:checked')].map(i => i.value)
  };
}

function validate(values) {
  const errors = {};
  if (!values.origin) errors.origin = 'Where does your journey start?';
  else if (values.origin.length > 80) errors.origin = 'Please use a shorter place name.';
  if (!values.destination) errors.destination = 'Where are you heading?';
  else if (values.destination.length > 80) errors.destination = 'Please use a shorter place name.';
  if (values.origin && values.origin.toLowerCase() === values.destination.toLowerCase()) errors.destination = 'Choose a destination different from your start.';
  if (!TRIP_DURATIONS.some(d => d.value === values.tripDays)) errors.tripDays = 'Choose your trip duration.';
  if (!TRAVELERS.includes(values.travelerType)) errors.travelerType = 'Choose who is travelling.';
  if (!values.interests.length) errors.interests = 'Choose at least one interest.';

  for (const key of ['origin', 'destination', 'tripDays', 'travelerType', 'interests']) {
    $(`error-${key}`).textContent = errors[key] || '';
    const field = form.elements[key];
    if (field instanceof HTMLElement) {
      field.setAttribute('aria-invalid', String(Boolean(errors[key])));
      field.setAttribute('aria-describedby', `error-${key}`);
    }
  }
  const first = Object.keys(errors)[0];
  if (first) (first === 'interests' ? form.querySelector('[name=interests]') : form.elements[first]).focus();
  return !first;
}

function setBusy(busy, message = '') {
  const button = $('generate');
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  $('form-status').textContent = message;
}

async function onSubmit(event) {
  event.preventDefault();
  const values = readForm();
  if (!validate(values)) return;
  const token = ++requestToken;
  track('journey_started', { origin: values.origin, destination: values.destination, tripDays: values.tripDays, travelerType: values.travelerType });
  setBusy(true, 'Finding your main route…');
  const slowNotice = setTimeout(() => { if (token === requestToken) $('form-status').textContent = 'Checking places along each part of the route…'; }, 700);
  try {
    const plan = await service.planJourney(values);
    if (token !== requestToken) return; // a newer request replaced this one
    startJourney(plan, values);
  } catch (error) {
    if (token !== requestToken) return;
    setBusy(false, friendlyError(error));
    if (error.details?.suggestions?.length || error.code === 'ROUTE_NOT_SUPPORTED') $('sample-block').open = true;
    const field = error.details?.field;
    if (field && form.elements[field]) {
      $(`error-${field}`).textContent = error.message;
      form.elements[field].setAttribute('aria-invalid', 'true');
      form.elements[field].focus();
    }
  } finally {
    clearTimeout(slowNotice);
  }
}

function friendlyError(error) {
  const messages = {
    ROUTE_NOT_SUPPORTED: 'This route is not available yet. Try one of the routes below.',
    PLACE_NOT_FOUND: error.message,
    AMBIGUOUS_PLACE: error.message,
    SAME_PLACE: 'Start and destination are the same place. Choose a different destination.',
    NO_ROUTE: 'We could not find a road route between these places.',
    PROVIDER_UNAVAILABLE: 'Our route service is not responding right now. Please try again in a moment.',
    RATE_LIMITED: 'Our map service is busy right now. Please try again in a moment.',
    BAD_RESPONSE: 'Our route service sent something we could not read. Please try again.',
    TIMEOUT: 'The route took too long to calculate. Please try again.'
  };
  return messages[error.code] || 'Something went wrong while planning. Please try again.';
}

function startJourney(plan, values) {
  resetState();
  Object.assign(state, {
    journeyId: newJourneyId(),
    origin: plan.origin.name,
    destination: plan.destination.name,
    tripDays: values.tripDays,
    originalDays: values.tripDays,
    travelerType: values.travelerType,
    interests: values.interests,
    plan
  });
  lastAddedId = null;
  resetFilterControls();
  setBusy(false);
  track('route_generated', { planId: plan.id, mode: plan.mode, distanceKm: plan.route.distanceKm, candidates: plan.places.length });
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
  $('route-title').focus({ preventScroll: true });
  // Say so whenever the figures did not come from where they normally would:
  // the server falling back to offline data, or the browser planning it itself
  // because the server could not be reached at all.
  if (plan.liveFallback || plan.offlineFallback) toast(plan.notices?.[0] || 'Live map services are currently unavailable. ROUTE+ is using offline route data.');
  const { impact } = current();
  if (impact.exceedsPlannedDuration) renderWarning(state, impact, [], null, plan);
}

// ---------------------------------------------------------------- journey actions
function findPlace(id) { return state.plan?.places.find(p => p.id === id); }

function openPlace(id) {
  const place = findPlace(id);
  if (!place) return;
  const { impact } = current();
  const rank = calculateRecommendationScore(place, state, impact, hooks.context(state.plan, state));
  track('discovery_opened', { placeId: id, score: rank.score });
  renderDetail(place, rank, { selected: state.selectedStops.includes(id), feedbackEnabled: hooks.feedbackEnabled() });
}

function addStop(id) {
  const place = findPlace(id);
  if (!place || place.openNow === false) { toast('This stop is unavailable right now. Try another discovery.'); return; }
  if (state.selectedStops.includes(id)) return;
  const before = current().impact;
  state.selectedStops.push(id);
  state.skippedPlaces = state.skippedPlaces.filter(p => p !== id);
  lastAddedId = id;
  closeDialog('detail');
  track('discovery_added', { placeId: id, category: place.category, extraMin: place.detourTimeMinutes, extraKm: place.detourDistanceKm });
  hooks.onBehaviour?.('added', place);
  render();
  const { impact, stops } = current();
  const newlyExceeds = impact.exceedsPlannedDuration && (!before.exceedsPlannedDuration || !state.keptOverLimit || impact.requiredDays > before.requiredDays);
  if (newlyExceeds) renderWarning(state, impact, stops, lastAddedId, state.plan);
  else toast(`${place.name} added. ${impact.fit === 'near' ? 'You are near your time limit.' : 'Still fits your trip.'}`);
}

function removeStop(id) {
  if (!state.selectedStops.includes(id)) return;
  state.selectedStops = state.selectedStops.filter(p => p !== id);
  if (lastAddedId === id) lastAddedId = null;
  closeDialog('detail');
  closeDialog('warning');
  track('discovery_removed', { placeId: id, category: findPlace(id)?.category });
  hooks.onBehaviour?.('removed', findPlace(id));
  render();
  if (!current().impact.exceedsPlannedDuration) state.keptOverLimit = false;
  toast('Stop removed. Totals updated.');
}

function skipPlace(id) {
  state.selectedStops = state.selectedStops.filter(p => p !== id);
  if (!state.skippedPlaces.includes(id)) state.skippedPlaces.push(id);
  closeDialog('detail');
  track('discovery_skipped', { placeId: id, category: findPlace(id)?.category });
  hooks.onBehaviour?.('skipped', findPlace(id));
  render();
  toast('Skipped for this journey.');
}

function resetFilterControls() {
  visibleCards = 12;
  state.filters = { ...DEFAULT_FILTERS };
  document.querySelectorAll('#filters select').forEach(s => { s.value = 'all'; });
}

function newJourney() {
  requestToken++;
  setBusy(false);
  resetState();
  resetFilterControls();
  storage.clearCurrentJourney();
  form.reset();
  fillForm({ origin: '', destination: '', tripDays: 3, travelerType: 'Family', interests: [] });
  document.querySelectorAll('.error').forEach(node => { node.textContent = ''; });
  form.querySelectorAll('[aria-invalid]').forEach(node => node.setAttribute('aria-invalid', 'false'));
  lastAddedId = null;
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  showLanding();
  $('journey').scrollIntoView({ behavior: 'instant' });
  form.elements.origin.focus({ preventScroll: true });
}

function loadJourney(journey) {
  requestToken++;
  resetState();
  Object.assign(state, journey);
  resetFilterControls();
  lastAddedId = null;
  closeDialog('saved');
  render();
  window.scrollTo({ top: 0 });
  toast(`${journey.origin} → ${journey.destination} restored.`);
}

// ---------------------------------------------------------------- button actions
const actions = {
  home() { showLanding(); window.scrollTo({ top: 0 }); },
  start() {
    showLanding();
    $('journey').scrollIntoView({ behavior: 'smooth' });
    form.elements.origin.focus({ preventScroll: true });
  },
  demo() {
    showLanding();
    fillForm(DEMO_JOURNEY);
    ['origin', 'destination', 'interests'].forEach(k => { $(`error-${k}`).textContent = ''; });
    $('form-status').textContent = 'Demo journey loaded: Visakhapatnam → Manali, 3 days, Family. Choose “Discover Along My Route”.';
    $('generate').focus();
  },
  new: newJourney,
  explore() {
    if (state.plan) { render(); $('cards').scrollIntoView({ behavior: 'smooth' }); }
    else actions.start();
  },
  how() { showLanding(); $('how').scrollIntoView({ behavior: 'smooth' }); },
  about() { showDialog('about'); },
  async saved() {
    const extras = await hooks.savedExtras();
    renderSaved(storage.loadJourneys(), extras);
  },
  async save() {
    if (!state.plan) return;
    try {
      storage.saveJourney(state);
      track('trip_saved', { planId: state.plan.id, stops: state.selectedStops.length });
      if (hooks.onSave) await hooks.onSave(state);
      else toast('Journey saved on this browser.');
    } catch {
      toast('Could not save — browser storage is unavailable or full.');
    }
  },
  keep() {
    state.keptOverLimit = true;
    closeDialog('warning');
    track('trip_kept', { days: state.tripDays });
    render();
    $('selected').scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast(`Keeping ${days(state.tripDays)}. See suggested removals in Your Journey.`);
  },
  extend() {
    const { impact } = current();
    state.tripDays = impact.requiredDays;
    state.keptOverLimit = false;
    closeDialog('warning');
    track('trip_extended', { from: state.originalDays, to: state.tripDays });
    render();
    toast(`Journey extended to ${days(state.tripDays)}.`);
  },
  'review-warning'() { const { impact, stops } = current(); renderWarning(state, impact, stops, lastAddedId, state.plan); },
  'more-cards'() { visibleCards += 12; render(); },
  'show-journey'() { $('selected').scrollIntoView({ behavior: 'smooth', block: 'start' }); },
  'clear-filters'() { resetFilterControls(); render(); },
  'restore-skipped'() { state.skippedPlaces = []; render(); toast('Skipped places are back.'); }
};

function closeMenu() {
  $('nav').classList.remove('open');
  $('menu-toggle').setAttribute('aria-expanded', 'false');
}

async function onClick(event) {
  const el = event.target.closest('button, a[data-action]');
  if (!el) return;
  const d = el.dataset;
  if (d.action) { event.preventDefault(); closeMenu(); await actions[d.action]?.(); return; }
  if (d.close) { closeDialog(d.close); return; }
  if (d.sample) {
    const [origin, destination] = d.sample.split('|');
    form.elements.origin.value = origin;
    form.elements.destination.value = destination;
    $('form-status').textContent = '';
    form.elements.origin.focus();
    return;
  }
  if (d.place) { openPlace(d.place); return; }
  if (d.add) { addStop(d.add); return; }
  if (d.remove) { removeStop(d.remove); return; }
  if (d.skip) { skipPlace(d.skip); return; }
  if (d.phase) { state.currentPhaseId = d.phase; visibleCards = 12; render(); return; }
  if (d.load) {
    const journey = d.source === 'account' && hooks.loadAccountTrip
      ? await hooks.loadAccountTrip(d.load)
      : storage.loadJourneys().find(j => j.journeyId === d.load);
    if (journey) loadJourney(journey); else toast('That journey could not be opened.');
    return;
  }
  if (d.deleteJourney) {
    if (d.source === 'account' && hooks.deleteAccountTrip) await hooks.deleteAccountTrip(d.deleteJourney);
    else storage.deleteJourney(d.deleteJourney);
    await actions.saved();
    return;
  }
  if (d.feedback && hooks.onFeedback) { await hooks.onFeedback(d.feedback, d.worth); }
}

// ---------------------------------------------------------------- start-up
function initForm() {
  form.elements.tripDays.innerHTML = options(TRIP_DURATIONS);
  form.elements.travelerType.innerHTML = options(TRAVELERS);
  $('interest-options').innerHTML = INTERESTS.map(i =>
    `<label class="chip"><input type="checkbox" name="interests" value="${escapeHTML(i)}"> ${escapeHTML(i)}</label>`).join('');
  fillForm({ origin: '', destination: '', tripDays: 3, travelerType: 'Family', interests: [] });
  refreshSuggestions();

  $('filter-category').innerHTML = '<option value="all">All categories</option>' +
    options(Object.entries(CATEGORIES).map(([value, c]) => ({ value, label: c.label })));
  $('filter-interest').innerHTML = '<option value="all">All interests</option>' + options(INTERESTS);
}

export function refreshSuggestions() {
  const routes = service.suggestedRoutes();
  const cities = service.knownPlaces?.() || [...new Set(routes.flatMap(r => [r.origin, r.destination]))];
  $('cities').innerHTML = options(cities);
  $('sample-routes').innerHTML = routes.map(r =>
    `<button type="button" class="chip" data-sample="${escapeHTML(r.origin)}|${escapeHTML(r.destination)}">${escapeHTML(r.origin)} → ${escapeHTML(r.destination)}</button>`).join('');
}

function wireEvents() {
  form.addEventListener('submit', onSubmit);
  document.addEventListener('click', onClick);
  $('filters').addEventListener('change', event => {
    const key = event.target.id.replace('filter-', '');
    if (key in state.filters) { state.filters[key] = event.target.value; render(); }
  });
  $('menu-toggle').addEventListener('click', event => {
    const open = $('nav').classList.toggle('open');
    event.currentTarget.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
  // Any image that fails to load is replaced by the category illustration.
  document.addEventListener('error', event => {
    const img = event.target;
    if (img.tagName !== 'IMG' || img.dataset.fallback) return;
    img.dataset.fallback = 'true';
    if (img.closest('.hero-image')) img.remove(); // the gradient behind it stays
  }, true);
  wireDialogFocus();
}

export const app = { state, render, current, hooks, toast, actions, refreshSuggestions, startJourney };

export async function boot() {
  const server = await service.detectServer();
  hooks.server = server;
  selectMapRenderer(server);
  initForm();
  $('engine-note').textContent = service.engineMode() === 'sample'
    ? '✧ Sample mode: simulated routes and places.'
    : server?.providers?.routing?.includes('osrm')
      ? '✧ Live road routing. Every stop shows its real extra kilometres and minutes.'
      : '✧ Offline road network + curated places. Every stop shows its extra kilometres and minutes.';
  wireEvents();
  // Opening the site always starts on the landing page. The last journey is
  // still saved (storage.saveCurrentJourney on every change, which the on-road
  // companion reads), but reopening it is the traveller's decision, made through
  // Saved Journeys — not something that happens to them on arrival.
  window.routePlus = app; // handy for learning in the browser console
}

// Extensions (server, companion, analytics) import `app` and add hooks before
// boot() runs. main.js decides which extensions to load.
