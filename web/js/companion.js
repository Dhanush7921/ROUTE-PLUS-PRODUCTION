// ON-ROAD COMPANION (Phase 3 mobile)
//
// The website is the big planning workspace; this page is the phone companion:
//   current journey → where am I on the route → current phase →
//   what is worth a stop ahead → Add / Skip → detour impact → navigate there
//
// PRIVACY: location is used only inside this page to find your position on
// the route. It is never stored, never sent to the server, and tracking stops
// as soon as you press "Stop" or leave the page.

import { buildRouteIndex } from '../../shared/engine/routeIndex.js';
import { getRecommendedPlaces, calculateRecommendationScore, DEFAULT_FILTERS } from '../../shared/engine/recommend.js';
import { scheduleJourney } from '../../shared/engine/schedule.js';
import { closingSoon } from '../../shared/engine/context.js';
import { categoryLabel } from '../../shared/taxonomy.js';
import { loadCurrentJourney, saveCurrentJourney, sanitizeJourney } from './storage.js';
import { escapeHTML, duration, km, days, clock } from './format.js';
import { placeImage } from './ui/art.js';
import { renderDetail, closeDialog, wireDialogFocus } from './ui/dialogs.js';
import { track, configureAnalytics } from './analytics.js';

const $ = id => document.getElementById(id);
const LOOKAHEAD_KM = 120;
const APPROACH_KM = 15;
const hasApi = Boolean(document.querySelector('meta[name="route-plus-api"]'));

let journey = null;
let index = null;
let position = null;         // { point:[lat,lng], source:'gps'|'preview', accuracy }
let watchId = null;
const alerted = new Set();   // one alert per place per session — no spam
const feedbackDone = new Set();

function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.classList.add('visible');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => node.classList.remove('visible'), 3000);
}

async function api(path, init = {}) {
  const res = await fetch(`api/${path}`, { credentials: 'same-origin', ...init, headers: init.body ? { 'Content-Type': 'application/json' } : undefined });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error?.message || 'Request failed');
  return res.json();
}

// ---------------------------------------------------------------- state
const stops = () => journey.plan.places.filter(p => journey.selectedStops.includes(p.id)).sort((a, b) => a.routeKm - b.routeKm);
const impact = () => scheduleJourney({ index, stops: stops(), originalDays: journey.originalDays, tripDays: journey.tripDays });
const currentKm = () => (position ? index.project(position.point).routeKm : 0);

function persist() {
  saveCurrentJourney(journey);
  if (hasApi && journey.serverTripId) {
    api('trips', { method: 'POST', body: JSON.stringify(journey) }).catch(() => { /* offline: local copy is kept */ });
  }
}

// ---------------------------------------------------------------- render
function render() {
  if (!journey) return;
  const kmNow = currentKm();
  const total = index.totalKm;
  const phase = journey.plan.phases.find(ph => kmNow >= ph.startKm && kmNow <= ph.endKm) || journey.plan.phases[0];
  const remainingMin = index.totalMin - index.timeAt(kmNow);
  const off = position ? index.project(position.point).distanceKm : 0;

  $('journey-card').innerHTML = `
    <span class="eyebrow">CURRENT JOURNEY</span>
    <h2 id="c-journey-title">${escapeHTML(journey.plan.origin.name)} → ${escapeHTML(journey.plan.destination.name)}</h2>
    <div class="progress" role="progressbar" aria-label="Journey progress" aria-valuemin="0" aria-valuemax="${Math.round(total)}" aria-valuenow="${Math.round(kmNow)}"><span style="width:${Math.min(100, kmNow / total * 100)}%"></span></div>
    <p>${position ? `${km(kmNow)} of ${km(total)} done` : `${km(total)} · ${days(journey.tripDays)} planned`}</p>
    <span class="phase-now">Phase ${phase.index + 1}: ${escapeHTML(phase.name)}</span>
    <div class="stat-row">
      <div><small>Remaining</small><strong>${km(Math.max(0, total - kmNow))}</strong></div>
      <div><small>Driving left</small><strong>${duration(remainingMin)}</strong></div>
      <div><small>Stops</small><strong>${journey.selectedStops.length}</strong></div>
    </div>
    ${off > 10 ? `<p class="caution">You appear to be ${km(off)} away from the planned route.</p>` : ''}`;

  const slider = $('preview-km');
  if (slider && document.activeElement !== slider) slider.value = String(Math.round(kmNow));
  renderNext(kmNow);
  renderNearby(kmNow);
  const im = impact();
  $('impact-card').innerHTML = `
    <span class="eyebrow">DETOUR IMPACT</span>
    <h2 id="c-impact-title">${days(im.requiredDays)} needed · ${days(journey.tripDays)} planned</h2>
    <div class="fit ${im.fit}">${{ fits: 'FITS your plan.', near: 'NEAR your time limit.', exceeds: 'EXCEEDS your plan — consider removing a stop in the planner.' }[im.fit]}</div>
    <p>Stops add +${km(im.extraDistanceKm)}, +${duration(im.extraTravelMinutes)} driving and ${duration(im.totalVisitMinutes)} of visits.</p>
    <div class="c-actions"><a class="button" href="https://www.google.com/maps/dir/?api=1&destination=${journey.plan.destination.lat},${journey.plan.destination.lng}&travelmode=driving" target="_blank" rel="noopener">Navigate to ${escapeHTML(journey.plan.destination.name)} ↗</a>
    <button class="button" data-c="finish">Finish journey</button></div>`;
  checkAlerts(kmNow);
}

function renderLocation() {
  const kmNow = currentKm();
  const total = index.totalKm;
  $('location-card').innerHTML = `
    <span class="eyebrow">WHERE AM I?</span>
    <h2 id="c-location-title">${watchId !== null ? 'Following your location' : 'Location is off'}</h2>
    <p class="privacy-note">Your location is used only on this phone to find your place on the route. It is not saved or sent anywhere, and stops when you press Stop.</p>
    <div class="c-actions">
      ${watchId === null ? '<button class="button primary" data-c="gps-start">Use my location</button>' : '<button class="button" data-c="gps-stop">Stop using location</button>'}
      ${'Notification' in window && Notification.permission === 'default' ? '<button class="button" data-c="notify">Allow stop alerts</button>' : ''}
    </div>
    <div class="preview"><label for="preview-km">Preview a point along the route (no GPS needed)</label>
      <input id="preview-km" type="range" min="0" max="${Math.round(total)}" step="5" value="${Math.round(kmNow)}" aria-valuetext="${Math.round(kmNow)} km"></div>`;

}

function renderNext(kmNow) {
  const next = stops().find(p => (p.detour?.rejoinKm ?? p.routeKm) >= kmNow - 0.5);
  const passed = stops().filter(p => (p.detour?.rejoinKm ?? p.routeKm) < kmNow - 1 && !feedbackDone.has(p.id));
  const eta = next ? index.timeAt(next.detour?.anchorKm ?? next.routeKm) - index.timeAt(kmNow) : 0;
  $('next-card').innerHTML = `
    <span class="eyebrow">NEXT ADDED STOP</span>
    ${next ? `<h2 id="c-next-title">${escapeHTML(next.name)}</h2>
      <p>${km(Math.max(0, next.routeKm - kmNow))} ahead · about ${duration(Math.max(0, eta))} · leave near ${escapeHTML(next.detour?.anchorName || '')}</p>
      <div class="impact-row"><span>+${km(next.detourDistanceKm)}</span><span>+${duration(next.detourTimeMinutes)}</span><span class="visit">${duration(next.visitDurationMinutes)} visit</span></div>
      <div class="c-actions"><a class="button primary" href="https://www.google.com/maps/dir/?api=1&destination=${next.lat},${next.lng}&travelmode=driving" target="_blank" rel="noopener">Navigate there ↗</a>
      <button class="button" data-place="${escapeHTML(next.id)}">Details</button></div>`
    : `<h2 id="c-next-title">No added stops ahead</h2><p>Your main route continues. Discoveries ahead are listed below.</p>`}
    ${passed.map(p => `<div class="feedback-card"><p><strong>Did you visit ${escapeHTML(p.name)}?</strong> Was it worth the detour?</p>
      <div class="c-actions"><button class="button small" data-fb="${escapeHTML(p.id)}" data-worth="yes">Yes, worth it</button><button class="button small" data-fb="${escapeHTML(p.id)}" data-worth="no">Not worth it</button><button class="button small" data-fb="${escapeHTML(p.id)}" data-worth="skipped">Didn't go</button></div></div>`).join('')}`;
}

function upcoming(kmNow) {
  const state = { ...journey, currentPhaseId: 'all', filters: { ...DEFAULT_FILTERS } };
  return getRecommendedPlaces(journey.plan.places, state, impact())
    .filter(p => p.routeKm >= kmNow - 2 && p.routeKm <= kmNow + LOOKAHEAD_KM)
    .sort((a, b) => a.routeKm - b.routeKm)
    .slice(0, 6);
}

function renderNearby(kmNow) {
  const list = upcoming(kmNow);
  $('nearby-card').innerHTML = `
    <span class="eyebrow">WORTH A STOP AHEAD · NEXT ${LOOKAHEAD_KM} KM</span>
    <h2 id="c-nearby-title">${list.length ? `${list.length} ${list.length === 1 ? 'discovery' : 'discoveries'} ahead` : 'Nothing worth detouring for just ahead'}</h2>
    ${list.length ? '' : '<p>Your main route continues normally. We will show stops as you move along.</p>'}
    <ul class="nearby-list">${list.map(p => `<li class="nearby">
      <img src="${placeImage(p)}" alt="">
      <div><span class="ahead">${p.routeKm - kmNow < 1 ? 'Here' : `${km(p.routeKm - kmNow)} ahead`}</span>
        <h3>${escapeHTML(p.name)}</h3><p class="place-sub">${escapeHTML(categoryLabel(p.category))} · ${escapeHTML(p.reasons[0] || '')}</p>
        <div class="impact-row"><span>+${km(p.detourDistanceKm)}</span><span>+${duration(p.detourTimeMinutes)}</span><span class="visit">${duration(p.visitDurationMinutes)}</span></div></div>
      <div class="c-actions"><button class="button" data-place="${escapeHTML(p.id)}">Details</button><button class="button primary" data-add="${escapeHTML(p.id)}" aria-label="Add ${escapeHTML(p.name)}">Add</button><button class="button" data-skip="${escapeHTML(p.id)}" aria-label="Skip ${escapeHTML(p.name)}">Skip</button></div>
    </li>`).join('')}</ul>`;
}

// ---------------------------------------------------------------- alerts (no spam)
function alertOnce(key, message, kind = 'warn') {
  if (alerted.has(key)) return;
  alerted.add(key);
  const node = document.createElement('div');
  node.className = `alert ${kind === 'info' ? 'info' : ''}`;
  node.innerHTML = `<span>${escapeHTML(message)}</span><button aria-label="Dismiss">×</button>`;
  node.querySelector('button').addEventListener('click', () => node.remove());
  $('alerts').prepend(node);
  if ($('alerts').children.length > 3) $('alerts').lastElementChild.remove();
  if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState === 'hidden') {
    try { new Notification('ROUTE+', { body: message, tag: key }); } catch { /* some browsers need a service worker */ }
  }
}

function checkAlerts(kmNow) {
  if (!position) return;
  const nowClock = new Date().getHours() * 60 + new Date().getMinutes();
  for (const p of stops()) {
    const ahead = p.routeKm - kmNow;
    if (ahead >= 0 && ahead <= APPROACH_KM) alertOnce(`approach:${p.id}`, `Approaching ${p.name} — leave the route in about ${km(Math.max(0, (p.detour?.anchorKm ?? p.routeKm) - kmNow))}.`, 'info');
    const arrive = nowClock + (index.timeAt(p.routeKm) - index.timeAt(kmNow)) + p.detourTimeMinutes / 2;
    if (ahead >= 0 && closingSoon(p, arrive, 45)) alertOnce(`closing:${p.id}`, `${p.name} closes at ${clock(p.openingHours.close)}. You would arrive around ${clock(arrive)}.`);
    if (ahead >= 0 && p.openingHours && arrive > p.openingHours.close && ahead < 200) alertOnce(`closed:${p.id}`, `${p.name} will likely be closed when you arrive (closes ${clock(p.openingHours.close)}).`);
  }
  const top = upcoming(kmNow).find(p => p.routeKm - kmNow <= APPROACH_KM && p.score >= 90);
  if (top) alertOnce(`suggest:${top.id}`, `Worth a stop: ${top.name} is ${km(Math.max(0, top.routeKm - kmNow))} ahead (+${duration(top.detourTimeMinutes)} detour).`, 'info');
}

// ---------------------------------------------------------------- actions
function setPosition(point, source, accuracy = null) {
  position = { point, source, accuracy };
  render();
}

function startGps() {
  if (!('geolocation' in navigator)) { toast('This device does not support location.'); return; }
  watchId = navigator.geolocation.watchPosition(
    pos => setPosition([pos.coords.latitude, pos.coords.longitude], 'gps', pos.coords.accuracy),
    err => {
      watchId !== null && navigator.geolocation.clearWatch(watchId);
      watchId = null;
      toast(err.code === err.PERMISSION_DENIED ? 'Location permission was declined. You can still preview points along the route.' : 'Could not get your location right now.');
      renderLocation();
      render();
    },
    { enableHighAccuracy: false, maximumAge: 60_000, timeout: 20_000 }
  );
  renderLocation();
}

function stopGps() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  position = null; // forget the last position too
  renderLocation();
  render();
}

async function onClick(event) {
  const b = event.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  const place = id => journey.plan.places.find(p => p.id === id);
  if (d.close) { closeDialog(d.close); return; }
  if (d.c === 'gps-start') return startGps();
  if (d.c === 'gps-stop') return stopGps();
  if (d.c === 'notify') { await Notification.requestPermission(); renderLocation(); return; }
  if (d.c === 'finish') {
    track('journey_completed', { planId: journey.plan.id, stops: journey.selectedStops.length });
    if (hasApi && journey.serverTripId) await api(`trips/${journey.serverTripId}/status`, { method: 'POST', body: JSON.stringify({ status: 'completed' }) }).catch(() => {});
    stopGps();
    toast('Journey completed. Safe travels!');
    return;
  }
  if (d.place) {
    const p = place(d.place);
    renderDetail(p, calculateRecommendationScore(p, journey, impact()), { selected: journey.selectedStops.includes(p.id) });
    return;
  }
  if (d.add) {
    const p = place(d.add);
    if (p && !journey.selectedStops.includes(p.id)) {
      const before = impact().requiredDays;
      journey.selectedStops.push(p.id);
      journey.skippedPlaces = journey.skippedPlaces.filter(id => id !== p.id);
      track('discovery_added', { placeId: p.id, category: p.category });
      persist();
      closeDialog('detail');
      const after = impact().requiredDays;
      toast(after > before ? `${p.name} added — your trip now needs ${days(after)}.` : `${p.name} added. Still fits.`);
      render();
    }
    return;
  }
  if (d.skip || d.remove) {
    const id = d.skip || d.remove;
    journey.selectedStops = journey.selectedStops.filter(x => x !== id);
    if (d.skip && !journey.skippedPlaces.includes(id)) journey.skippedPlaces.push(id);
    track(d.skip ? 'discovery_skipped' : 'discovery_removed', { placeId: id });
    persist();
    closeDialog('detail');
    render();
    return;
  }
  if (d.fb) {
    feedbackDone.add(d.fb);
    const visited = d.worth !== 'skipped';
    track('place_feedback', { placeId: d.fb, worth: d.worth });
    if (hasApi) await api('feedback', { method: 'POST', body: JSON.stringify({ placeId: d.fb, visited, worthIt: d.worth === 'yes' ? true : d.worth === 'no' ? false : null, tripId: journey.serverTripId }) }).catch(() => {});
    toast('Thanks for the feedback!');
    render();
  }
}

// ---------------------------------------------------------------- start
async function loadJourney() {
  const tripId = new URLSearchParams(location.search).get('trip');
  if (tripId && hasApi) {
    try { return sanitizeJourney((await api(`trips/${encodeURIComponent(tripId)}`)).trip); } catch { /* fall back to local */ }
  }
  return loadCurrentJourney();
}

async function start() {
  wireDialogFocus();
  if (hasApi) configureAnalytics({ url: 'api/events' });
  journey = await loadJourney();
  if (!journey || !(journey.plan.route.geometry?.length > 1)) {
    $('journey-card').innerHTML = `<div class="empty-state"><span class="eyebrow">NO ACTIVE JOURNEY</span><h2 id="c-journey-title">Plan your route first</h2>
      <p>The companion follows a journey planned on the ROUTE+ website (sample-data journeys are not supported here).</p>
      <div class="c-actions"><a class="button primary" href="index.html">Open the planner</a></div></div>`;
    ['location-card', 'next-card', 'nearby-card', 'impact-card'].forEach(id => { $(id).hidden = true; });
    return;
  }
  index = buildRouteIndex(journey.plan.route);
  document.addEventListener('click', onClick);
  document.addEventListener('input', e => {
    if (e.target.id !== 'preview-km') return;
    if (watchId !== null) stopGps();
    setPosition(index.pointAt(Number(e.target.value)), 'preview');
  });
  window.addEventListener('pagehide', stopGps);
  renderLocation();
  render();
  window.routePlusCompanion = { get journey() { return journey; }, setPreviewKm: kmv => setPosition(index.pointAt(kmv), 'preview') };
}

start();
