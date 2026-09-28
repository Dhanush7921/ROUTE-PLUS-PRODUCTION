// INTELLIGENCE (Phase 4, browser side)
//  • analytics events → server (when running)
//  • personalisation: your own add/skip/remove behaviour (+ crowd feedback)
//  • live context: weather per route phase → cautions, suppression
// Everything feeds the same transparent scorer via app.hooks.context, so each
// adjustment appears as a labelled line in the place's score breakdown.

import { configureAnalytics, track } from './analytics.js';
import { categoryBoosts, toScoringContext } from '../../shared/engine/personalize.js';
import { weatherConditions, shouldSuppress } from '../../shared/engine/context.js';
import { api } from './account.js';

const BEHAVIOUR_KEY = 'route-plus-behaviour-v1';
let serverAdjustments = { categories: {}, places: {} };
let weather = [];
let weatherPlanId = null;
const seen = new Set();

function readBehaviour() {
  try { return JSON.parse(localStorage.getItem(BEHAVIOUR_KEY) || '{}'); } catch { return {}; }
}
function recordBehaviour(category, kind) {
  if (!category) return;
  try {
    const b = readBehaviour();
    (b[category] ||= {})[kind] = (b[category][kind] || 0) + 1;
    localStorage.setItem(BEHAVIOUR_KEY, JSON.stringify(b));
  } catch { /* storage blocked: personalisation simply stays off */ }
}

export function installIntelligence(app) {
  const server = app.hooks.server;
  if (server) configureAnalytics({ url: 'api/events' });

  // Learn from this device's own behaviour, even without an account.
  const originalAdd = app.hooks.onBehaviour;
  app.hooks.onBehaviour = (kind, place) => {
    recordBehaviour(place?.category, kind);
    originalAdd?.(kind, place);
  };

  app.hooks.context = plan => {
    const local = categoryBoosts(readBehaviour());
    const merged = toScoringContext({ categories: { ...local, ...serverAdjustments.categories }, places: serverAdjustments.places });
    const conditions = [...merged.conditions, ...weatherConditions(weatherPlanId === plan?.id ? weather : [])];
    return { personalBoost: merged.personalBoost, conditions, suppress: p => shouldSuppress(p, conditions) };
  };

  // "discovery_seen": the cards actually rendered (each once per plan).
  app.hooks.afterRender.push(({ plan, recommended }) => {
    for (const p of recommended.slice(0, 12)) {
      const key = `${plan.id}:${p.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      track('discovery_seen', { placeId: p.id, category: p.category, score: p.score });
    }
    if (server && plan.id !== weatherPlanId && plan.route.geometry) loadWeather(app, plan);
  });

  if (server) {
    api('personalization').then(adj => { serverAdjustments = adj; if (app.state.plan) app.render(); }).catch(() => {});
  }
}

async function loadWeather(app, plan) {
  weatherPlanId = plan.id;
  weather = [];
  if (!app.hooks.server?.providers?.weather || app.hooks.server.providers.weather === 'off') return;
  const phases = plan.phases.filter(ph => ph.geometry?.length).map(ph => {
    const mid = ph.geometry[Math.floor(ph.geometry.length / 2)];
    return { id: ph.id, lat: mid[0], lng: mid[1] };
  });
  try {
    const res = await api('context', { method: 'POST', body: { phases } });
    if (weatherPlanId !== plan.id) return;
    weather = res.phases;
    if (weather.some(w => w.rainMm >= 7)) { app.render(); app.toast('Rain is forecast on part of your route — affected stops now show a caution.'); }
  } catch { /* weather is optional */ }
}
