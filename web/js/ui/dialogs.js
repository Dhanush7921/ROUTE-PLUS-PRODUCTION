// Dialog rendering: place detail, duration warning and saved journeys.
// Native <dialog> gives us keyboard focus trapping and Escape-to-close for free.

import { escapeHTML, duration, km, days, clock } from '../format.js';
import { categoryLabel } from '../../../shared/taxonomy.js';
import { placeImage } from './art.js';

const $ = id => document.getElementById(id);
let returnFocusTo = null;

export function showDialog(id) {
  const dialog = $(id);
  if (!dialog.open) {
    returnFocusTo = document.activeElement;
    dialog.showModal();
  }
}

export function closeDialog(id) {
  const dialog = $(id);
  if (dialog?.open) dialog.close();
}

// Return keyboard focus to whatever opened the dialog.
export function wireDialogFocus() {
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('close', () => {
      if (returnFocusTo && document.body.contains(returnFocusTo)) returnFocusTo.focus();
      returnFocusTo = null;
    });
    // Clicking the dimmed backdrop closes the dialog.
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
    });
  }
}

const hours = h => (h && Number.isFinite(h.open) ? `${clock(h.open)}–${clock(h.close)}` : 'Not confirmed');
const yesNo = (v, yes = 'Available', no = 'Not available') => (v === undefined || v === null ? 'Unknown' : v ? yes : no);

export function renderDetail(place, rank, { selected, feedbackEnabled = false } = {}) {
  const practical = [
    ['Best time', place.bestTime],
    ['Entry fee', place.entryFee || 'Confirm locally'],
    ['Opening hours', hours(place.openingHours)],
    ['Status', place.openNow === false ? 'Closed / unavailable' : 'Open (typical hours)'],
    ['Parking', yesNo(place.parking)],
    ['Walking', place.walkingMinutes ? `About ${duration(place.walkingMinutes)}` : 'Minimal'],
    ['Food', yesNo(place.foodAvailable)],
    ['Facilities', place.facilities?.length ? place.facilities.join(', ') : 'Basic / unknown'],
    ['Season', place.bestMonths ? `Best: ${place.bestMonths}` : place.seasonalFit === false ? 'Poor seasonal fit now' : 'Year-round']
  ];
  const source = place.source || {};
  $('detail').innerHTML = `
    <button class="close" data-close="detail" aria-label="Close place details">×</button>
    <img class="detail-image" src="${placeImage(place)}" alt="${escapeHTML(place.imageAlt || `Illustration of a ${categoryLabel(place.category).toLowerCase()}`)}">
    <div class="detail-content">
      <span class="eyebrow">${escapeHTML(categoryLabel(place.category))}${place.locality ? ` · ${escapeHTML(place.locality)}` : ''}</span>
      <h2 id="detail-title">${escapeHTML(place.name)}</h2>
      <p>${escapeHTML(place.description)}</p>

      <div class="detail-impact" aria-label="What this detour costs">
        <div><small>Extra distance</small><strong>+${km(place.detourDistanceKm)}</strong></div>
        <div><small>Extra driving</small><strong>+${duration(place.detourTimeMinutes)}</strong></div>
        <div><small>Visit duration</small><strong>${duration(place.visitDurationMinutes)}</strong></div>
        <div><small>From your route</small><strong>${km(place.distanceFromRouteKm)}</strong></div>
      </div>

      <h3>Why visit</h3>
      <ul>${[place.whyVisit, ...rank.reasons].filter(Boolean).map(r => `<li>${escapeHTML(r)}</li>`).join('')}</ul>
      ${rank.warnings.length ? `<h3>Keep in mind</h3><ul>${rank.warnings.map(w => `<li>${escapeHTML(w)}</li>`).join('')}</ul>` : ''}

      <h3>Who it suits</h3>
      <p><strong>Best for:</strong> ${escapeHTML(place.suitableFor.join(', '))}</p>
      <p><strong>Less suitable for:</strong> ${escapeHTML((place.lessSuitableFor || []).join(', ') || '—')}</p>

      <h3>Practical details</h3>
      <div class="detail-grid">${practical.map(([k, v]) => `<div><small>${k}</small>${escapeHTML(v ?? 'Unknown')}</div>`).join('')}</div>
      <p class="caution"><strong>Safety & caution:</strong> ${escapeHTML(place.caution)}</p>

      ${place.detour?.anchorName ? `<h3>How the detour works</h3><p>Leave the main route near <strong>${escapeHTML(place.detour.anchorName)}</strong>, visit, and rejoin near <strong>${escapeHTML(place.detour.rejoinName)}</strong>. Road distance with the stop minus the same stretch without it = +${km(place.detourDistanceKm)}, +${duration(place.detourTimeMinutes)}.</p>` : ''}

      <details><summary class="text-link">Transparent score · ${rank.score} points</summary>
        <table class="score-table"><tbody>${rank.breakdown.map(b => `<tr><td>${escapeHTML(b.label)}</td><td>${b.value > 0 ? '+' : ''}${b.value}</td></tr>`).join('')}</tbody></table>
      </details>
      <p class="source-note">Source: ${escapeHTML(source.label || source.provider || 'sample data')}${source.verified ? '' : ' · details not independently verified — confirm locally before travelling'}.</p>
      ${feedbackEnabled && selected ? `<h3>After your visit</h3><div class="feedback-row">
        <button class="button small" data-feedback="${escapeHTML(place.id)}" data-worth="yes">Visited — worth it</button>
        <button class="button small" data-feedback="${escapeHTML(place.id)}" data-worth="no">Visited — not worth it</button>
        <button class="button small" data-feedback="${escapeHTML(place.id)}" data-worth="skipped">Didn't go</button></div>` : ''}
    </div>
    <div class="detail-actions">${selected
      ? `<button class="button primary" data-remove="${escapeHTML(place.id)}">Remove from journey</button><button class="button" data-skip="${escapeHTML(place.id)}">Skip</button>`
      : `<button class="button primary" data-add="${escapeHTML(place.id)}" ${place.openNow === false ? 'disabled' : ''}>Add to journey</button><button class="button" data-skip="${escapeHTML(place.id)}">Skip</button>`}
      ${place.lat && selected ? `<a class="button" href="https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}" target="_blank" rel="noopener">Navigate ↗</a>` : ''}
    </div>`;
  showDialog('detail');
  $('detail').scrollTop = 0;
}

export function renderWarning(state, impact, stops, lastAddedId, plan) {
  const lastAdded = stops.find(p => p.id === lastAddedId) || stops[stops.length - 1];
  const routeOnly = !stops.length;
  const perDay = impact.model === 'daily' ? impact.assumptions.maxDrivingMinutes : impact.dayMinutes;
  const why = [
    `Main route: ${duration(plan.route.durationMin)} of driving; we plan at most ${duration(perDay)} of driving${impact.model === 'daily' ? '' : ' and visits'} per day`,
    ...stops.map(p => `${p.name}: +${duration(p.detourTimeMinutes)} driving, ${duration(p.visitDurationMinutes)} visit`),
    ...(impact.notes || [])
  ];
  $('warning').innerHTML = `
    <button class="close" data-close="warning" aria-label="Close duration warning">×</button>
    <span class="eyebrow">TRIP IMPACT</span>
    <h2 id="warning-title">${routeOnly ? 'Your route needs more time.' : 'Your journey has changed.'}</h2>
    <div class="compare">
      <div><small>${routeOnly ? 'You planned' : 'Original'}</small><strong>${days(routeOnly ? state.tripDays : state.originalDays)}</strong></div>
      <span aria-hidden="true">→</span>
      <div class="updated"><small>${routeOnly ? 'Needed' : 'Updated'}</small><strong>${days(impact.requiredDays)}</strong></div>
    </div>
    <p>${routeOnly
      ? `Driving ${plan.origin.name} → ${plan.destination.name} responsibly takes about ${days(impact.requiredDays)}, even before any stops.`
      : `Your ${stops.length} added ${stops.length === 1 ? 'stop adds' : 'stops add'} ${duration(impact.extraTravelMinutes)} of extra driving and ${duration(impact.totalVisitMinutes)} at the stops. That no longer fits in ${days(state.tripDays)}.`}</p>
    <details open><summary>Why</summary><ul class="why-list">${why.map(w => `<li>${escapeHTML(w)}</li>`).join('')}</ul></details>
    <div class="actions">
      <button class="button" data-action="keep">Keep ${days(state.tripDays)}</button>
      <button class="button primary" data-action="extend">Extend to ${days(impact.requiredDays)}</button>
      ${lastAdded ? `<button class="button danger" data-remove="${escapeHTML(lastAdded.id)}">Remove ${escapeHTML(lastAdded.name)}</button>` : ''}
    </div>`;
  showDialog('warning');
}

export function renderSaved(journeys, { accountTrips = null, signedIn = false } = {}) {
  const row = (j, source) => `<div class="saved-row"><div><strong>${escapeHTML(j.origin)} → ${escapeHTML(j.destination)}</strong>
      <p>${days(j.tripDays)} · ${escapeHTML(j.travelerType)} · ${j.selectedStops.length} ${j.selectedStops.length === 1 ? 'stop' : 'stops'}${j.savedAt ? ` · saved ${new Date(j.savedAt).toLocaleDateString('en-IN')}` : ''}</p></div>
      <div class="actions"><button class="button small primary" data-load="${escapeHTML(j.journeyId || j.id)}" data-source="${source}">Open</button>
      <button class="button small" data-delete-journey="${escapeHTML(j.journeyId || j.id)}" data-source="${source}" aria-label="Delete saved journey ${escapeHTML(j.origin)} to ${escapeHTML(j.destination)}">Delete</button></div></div>`;
  const account = accountTrips === null ? '' : `<h3>In your account</h3>${accountTrips.length ? accountTrips.map(t => row(t, 'account')).join('') : '<p>No journeys in your account yet.</p>'}`;
  $('saved').innerHTML = `
    <button class="close" data-close="saved" aria-label="Close saved journeys">×</button>
    <span class="eyebrow">PICK UP WHERE YOU LEFT OFF</span>
    <h2 id="saved-title">Saved Journeys</h2>
    ${account}
    <h3>On this device</h3>
    ${journeys.length ? journeys.map(j => row(j, 'local')).join('') : '<p>No journeys saved on this device yet. Plan a route, then choose Save Journey.</p>'}
    ${signedIn ? '' : '<p class="source-note">Saved on this browser only. Sign in to keep journeys across devices.</p>'}
    <div class="actions"><button class="button primary" data-action="new">Start New Journey</button></div>`;
  showDialog('saved');
}
