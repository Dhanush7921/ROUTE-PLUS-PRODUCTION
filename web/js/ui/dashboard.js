// Dashboard rendering: summary strip, phases, discovery cards and the
// "Your journey" panel. These functions only turn data into HTML — they
// never change state. Buttons carry data-* attributes that app.js handles.

import { escapeHTML, duration, km, days, clock } from '../format.js';
import { categoryLabel } from '../../../shared/taxonomy.js';
import { suggestRemovals } from '../../../shared/engine/tripImpact.js';
import { placeImage } from './art.js';

const $ = id => document.getElementById(id);
const FIT_LABEL = { fits: 'FITS', near: 'NEAR LIMIT', exceeds: 'EXCEEDS' };

/** Says plainly where the extra-driving minutes came from. Never overstates. */
function detourSourceNote(impact) {
  if (!impact.contributions?.length) return '';
  if (impact.detourMethod === 'road-network') return ' Extra driving is measured on the real road network.';
  if (impact.detourMethod === 'mixed') return ' Some stops’ extra driving is measured on the real road network; the rest are ROUTE+ estimates.';
  return ' Extra driving for your stops is a ROUTE+ estimate, not a road measurement.';
}

export function renderHeader(plan, state) {
  $('route-title').textContent = `${plan.origin.name} → ${plan.destination.name}`;
  $('route-meta').textContent = `${days(state.tripDays)}${state.tripDays !== state.originalDays ? ` (originally ${state.originalDays})` : ''} · ${state.travelerType} · ${state.interests.join(' · ')}`;
  $('mode-label').textContent = plan.mode === 'sample' ? 'SAMPLE ROUTE · SIMULATED DATA' : 'YOUR ROUTE. YOUR POSSIBILITIES.';
  $('map-label').textContent = plan.mode === 'sample'
    ? 'Illustrative route · not navigation'
    : `Route: ${plan.route.provider} · Places: ${plan.placeSource || 'curated'} · not turn-by-turn navigation`;
}

export function renderSummary(state, impact) {
  const cells = [
    ['Stops added', state.selectedStops.length],
    ['Extra distance', `+${km(impact.extraDistanceKm)}`],
    ['Extra driving', `+${duration(impact.extraTravelMinutes)}`],
    ['Time at stops', duration(impact.totalVisitMinutes)],
    ['Estimated trip', `${days(impact.estimatedDays)}`, `<span class="fit-pill ${impact.fit}">${FIT_LABEL[impact.fit]}</span>`]
  ];
  $('summary').innerHTML = cells.map(([label, value, extra = '']) =>
    `<div><small>${label}</small><strong>${value}</strong>${extra ? `<div>${extra}</div>` : ''}</div>`).join('');
  // Compact bar pinned to the bottom of phone screens (hidden on desktop by CSS).
  const bar = $('impact-bar');
  bar.hidden = false;
  bar.innerHTML = `<span><b>${state.selectedStops.length}</b> stops · +${km(impact.extraDistanceKm)} · +${duration(impact.extraTravelMinutes + impact.totalVisitMinutes)}</span>` +
    `<button class="fit-pill ${impact.fit}" data-action="show-journey">${days(impact.estimatedDays)} · ${FIT_LABEL[impact.fit]}</button>`;
}

export function hideImpactBar() { $('impact-bar').hidden = true; }

export function renderPhases(plan, state, countsByPhase) {
  const all = { id: 'all', name: 'Whole journey' };
  $('phases').innerHTML = [all, ...plan.phases].map((p, i) => {
    const active = state.currentPhaseId === p.id;
    const range = p.startKm !== undefined ? `${Math.round(p.startKm)}–${Math.round(p.endKm)} km · ` : '';
    const count = p.id === 'all' ? Object.values(countsByPhase).reduce((a, b) => a + b, 0) : countsByPhase[p.id] || 0;
    return `<button class="phase ${active ? 'active' : ''}" data-phase="${escapeHTML(p.id)}" aria-pressed="${active}">` +
      `<small>${i ? `PHASE ${i}` : 'EXPLORE'}</small>${escapeHTML(p.name)}<span class="phase-meta">${range}${count} ${count === 1 ? 'discovery' : 'discoveries'}</span></button>`;
  }).join('');
  const current = plan.phases.find(p => p.id === state.currentPhaseId);
  $('phase-label').textContent = current ? `EXPLORING PHASE ${current.index + 1} · ${current.name}` : 'EXPLORING THE WHOLE JOURNEY';
}

function cardHTML(p, index) {
  const who = p.suitableFor.slice(0, 3).join(', ');
  return `<article class="card" style="animation-delay:${Math.min(index, 6) * 40}ms" aria-labelledby="card-${escapeHTML(p.id)}">
    <div class="card-image">
      <img src="${placeImage(p)}" alt="${escapeHTML(p.imageAlt || `Illustration of a ${categoryLabel(p.category).toLowerCase()}`)}" loading="lazy">
      <span class="tag">${escapeHTML(categoryLabel(p.category))}</span>
      <span class="score-badge" title="Recommendation score">${p.score} pts</span>
    </div>
    <div class="card-body">
      <h3 id="card-${escapeHTML(p.id)}">${escapeHTML(p.name)}</h3>
      ${p.locality ? `<p class="place-sub">${escapeHTML(p.locality)}</p>` : ''}
      <div class="impact-row" aria-label="Detour cost">
        <span>+${km(p.detourDistanceKm)}</span><span>+${duration(p.detourTimeMinutes)}</span><span class="visit">${duration(p.visitDurationMinutes)} visit</span>
      </div>
      <ul class="reasons">${p.reasons.slice(0, 3).map(r => `<li>${escapeHTML(r)}</li>`).join('')}</ul>
      ${p.warnings.length ? `<ul class="warnings">${p.warnings.slice(0, 2).map(w => `<li>${escapeHTML(w)}</li>`).join('')}</ul>` : ''}
      <p class="recommended-for">Recommended for: ${escapeHTML(who)}</p>
      <div class="card-actions">
        <button class="button explore" data-place="${escapeHTML(p.id)}" aria-label="Explore ${escapeHTML(p.name)}">Explore</button>
        <button class="button primary" data-add="${escapeHTML(p.id)}" aria-label="Add ${escapeHTML(p.name)} to journey">Add +</button>
        <button class="button" data-skip="${escapeHTML(p.id)}" aria-label="Skip ${escapeHTML(p.name)}">Skip</button>
      </div>
    </div>
  </article>`;
}

const PAGE_SIZE = 12;

export function renderCards(recommended, state, visible = PAGE_SIZE) {
  $('result-count').textContent = `${recommended.length} ${recommended.length === 1 ? 'discovery' : 'discoveries'}`;
  if (recommended.length) {
    const shown = recommended.slice(0, visible);
    $('cards').innerHTML = shown.map(cardHTML).join('') + (recommended.length > shown.length
      ? `<div class="more-row"><button class="button" data-action="more-cards">Show ${Math.min(PAGE_SIZE, recommended.length - shown.length)} more of ${recommended.length - shown.length} remaining</button></div>` : '');
    return;
  }
  const filtered = Object.values(state.filters).some(v => v !== 'all');
  $('cards').innerHTML = `<div class="empty">
    <h3>Nothing worth detouring for here.</h3>
    <p>${filtered ? 'No discoveries match these filters.' : 'No meaningful stops match your interests in this part of the route.'} Your main route continues normally — that is a good outcome too.</p>
    <div class="actions">
      ${filtered ? '<button class="button" data-action="clear-filters">Clear filters</button>' : ''}
      ${state.currentPhaseId !== 'all' ? '<button class="button" data-phase="all">Show whole journey</button>' : ''}
      ${state.skippedPlaces.length ? `<button class="button" data-action="restore-skipped">Restore ${state.skippedPlaces.length} skipped</button>` : ''}
    </div></div>`;
}

export function renderPanel(plan, state, impact, stops) {
  const fitText = {
    fits: `Fits within your ${days(state.tripDays)}.`,
    near: `Close to the limit of your ${days(state.tripDays)}.`,
    exceeds: `Needs about ${days(impact.requiredDays)} — more than your ${days(state.tripDays)}.`
  };
  const over = -impact.remainingMinutes;
  const removals = impact.exceedsPlannedDuration && stops.length ? suggestRemovals(stops, over) : [];
  const baseOnlyTooLong = impact.exceedsPlannedDuration && !stops.length;

  const stopList = stops.length
    ? `<ol class="stops">${stops.map(p => `<li class="stop">
        <h3>✓ ${escapeHTML(p.name)}</h3>
        <small>${escapeHTML(categoryLabel(p.category))} · +${km(p.detourDistanceKm)} · +${duration(p.detourTimeMinutes)} drive · ${duration(p.visitDurationMinutes)} visit</small>
        <div class="stop-actions"><button data-place="${escapeHTML(p.id)}">Details</button><button data-remove="${escapeHTML(p.id)}" aria-label="Remove ${escapeHTML(p.name)}">Remove</button></div>
      </li>`).join('')}</ol>`
    : '<p class="stop">No add-ons yet. Your journey is exactly your main route. Explore a discovery to see if it earns a place.</p>';

  const dayPlan = impact.days?.length ? `<details><summary>Day-by-day estimate</summary><ol class="day-plan">${impact.days.map(d =>
    `<li><b>Day ${d.day}</b> · ${clock(d.start)}–${clock(d.end)} · ${duration(d.drivingMinutes)} driving${d.stops.length ? ` · ${d.stops.map(escapeHTML).join(', ')}` : ''}${d.overnightNear ? `<br>Overnight near ${escapeHTML(d.overnightNear)}` : ''}</li>`).join('')}</ol></details>` : '';

  $('selected').innerHTML = `
    <span class="eyebrow">YOUR JOURNEY</span>
    <h2>The plan, with more.</h2>
    <div class="baseline"><strong>Main route: ${escapeHTML(plan.origin.name)} → ${escapeHTML(plan.destination.name)}</strong>
      ${km(plan.route.distanceKm)} · ${duration(plan.route.durationMin)} driving · unchanged</div>
    ${stopList}
    <div class="fit ${impact.fit}" role="status"><strong>${FIT_LABEL[impact.fit]}</strong> — ${fitText[impact.fit]}${state.keptOverLimit && impact.exceedsPlannedDuration ? ' You chose to keep your original duration.' : ''}</div>
    ${removals.length ? `<p>To stay within ${days(state.tripDays)}, consider removing:</p><div class="removal-list">${removals.map(p => `<button data-remove="${escapeHTML(p.id)}">Remove ${escapeHTML(p.name)} (saves ${duration(p.detourTimeMinutes + p.visitDurationMinutes)})</button>`).join('')}</div>` : ''}
    ${baseOnlyTooLong ? '<p>The main route alone needs more driving time than your plan allows.</p>' : ''}
    ${impact.exceedsPlannedDuration ? '<div class="panel-actions"><button class="button primary" data-action="review-warning">Review trip duration</button></div>' : ''}
    ${dayPlan}
    <details><summary>How we estimate this</summary><p>${impact.model === 'daily'
      ? `Each day starts at ${clock(impact.assumptions.startTime)} with at most ${duration(impact.assumptions.maxDrivingMinutes)} of driving, a ${impact.assumptions.breakMinutes}-minute break every ${duration(impact.assumptions.breakEveryMinutes)}, and no driving after ${clock(impact.assumptions.latestDriveEnd)}. Visits must fit inside opening hours. Traffic and road closures are not included.`
      : `Prototype rule: ${duration(impact.dayMinutes)} of driving plus visits per day. Detours are added independently. Traffic and real road conditions are not included.`}</p>
      <p>${duration(impact.baseDrivingMinutes)} main route + ${duration(impact.extraDrivingMinutes)} extra driving + ${duration(impact.visitMinutes)} at your stops.${detourSourceNote(impact)}</p></details>`;
}

