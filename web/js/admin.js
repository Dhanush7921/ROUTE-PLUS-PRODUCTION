// OPERATIONS DASHBOARD (Phase 4) — for authorised staff (role = admin).
// View / edit / disable places, review flagged places, see which places earn
// their spot, read feedback, and monitor provider health and errors.
// All authorisation happens on the server; this page only displays results.

import { escapeHTML } from './format.js';
import { CATEGORIES } from '../../shared/taxonomy.js';

const $ = id => document.getElementById(id);
const main = $('admin');

async function api(path, init = {}) {
  const res = await fetch(`api/${path}`, { credentials: 'same-origin', ...init, headers: init.body ? { 'Content-Type': 'application/json' } : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error?.message || 'Request failed'), { status: res.status });
  return data;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('visible');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('visible'), 2500);
}

const kpi = (label, value, sub = '') => `<div class="kpi"><small>${escapeHTML(label)}</small><strong>${escapeHTML(value)}</strong>${sub ? `<span class="kpi-sub">${escapeHTML(sub)}</span>` : ''}</div>`;

function overview({ product, system }) {
  const f = product.funnel;
  return `<section id="overview" aria-labelledby="ov-title"><span class="eyebrow">LAST ${product.windowDays} DAYS</span><h2 id="ov-title">Is route discovery valuable?</h2>
    <div class="kpis">
      ${kpi('Journeys started', product.counts.journey_started)}${kpi('Routes generated', product.counts.route_generated)}
      ${kpi('Discoveries shown', product.counts.discovery_seen)}${kpi('Opened', product.counts.discovery_opened, `${f.openRate}% of shown`)}
      ${kpi('Added', product.counts.discovery_added, `${f.addRate}% of shown`)}${kpi('Skipped', product.counts.discovery_skipped, `${f.skipRate}% of decisions`)}
      ${kpi('Removed after add', `${f.removeAfterAdd}%`)}${kpi('Trip extensions', product.counts.trip_extended, `${f.extensionRate}% of routes`)}
      ${kpi('Saved journeys', product.counts.trip_saved, `${f.saveRate}% of routes`)}${kpi('Completed journeys', product.counts.journey_completed)}
      ${kpi('Feedback', product.counts.place_feedback)}${kpi('Users', product.users, `${product.repeatTravellers} planned more than one trip`)}
    </div>
    <p class="note">Funnel: shown → opened → added → kept. A healthy product keeps the add rate high and "removed after add" low.</p></section>
    <section id="system" aria-labelledby="sys-title"><h2 id="sys-title">System health</h2>
    <div class="kpis">${kpi('Uptime', `${Math.round(system.uptimeSec / 60)} min`)}${kpi('Errors', system.counters.errors_total || 0)}</div>
    <h3>Providers</h3><div class="table-wrap"><table class="data"><thead><tr><th>Kind</th><th>Provider</th><th>OK</th><th>Failed</th><th>Avg ms</th><th>Status</th><th>Last error</th></tr></thead><tbody>
    ${system.providers.map(p => `<tr><td>${escapeHTML(p.kind)}</td><td>${escapeHTML(p.provider)}</td><td class="num">${p.ok}</td><td class="num">${p.failed}</td><td class="num">${p.avgMs}</td><td><span class="pill ${p.healthy ? 'ok' : 'bad'}">${p.healthy ? 'Healthy' : 'Degraded'}</span></td><td>${escapeHTML(p.lastError || '—')}</td></tr>`).join('') || '<tr><td colspan="7">No provider calls yet.</td></tr>'}
    </tbody></table></div>
    <h3>API latency</h3><div class="table-wrap"><table class="data"><thead><tr><th>Endpoint</th><th>Calls</th><th>Avg ms</th><th>p95 ms</th><th>Max ms</th></tr></thead><tbody>
    ${Object.entries(system.latencyMs).map(([k, v]) => `<tr><td>${escapeHTML(k)}</td><td class="num">${v.count}</td><td class="num">${v.avg}</td><td class="num">${v.p95}</td><td class="num">${v.max}</td></tr>`).join('')}
    </tbody></table></div>
    <h3>Recent errors</h3>${system.recentErrors.length ? `<div class="table-wrap"><table class="data"><tbody>${system.recentErrors.map(e => `<tr><td>${escapeHTML(e.at)}</td><td>${escapeHTML(e.context)}</td><td>${escapeHTML(e.code)}</td><td>${escapeHTML(e.message)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="note">No errors recorded.</p>'}
    </section>`;
}

function placesSection(places, q) {
  return `<section id="places" aria-labelledby="pl-title"><h2 id="pl-title">Places</h2>
    <form class="toolbar" id="place-search"><label>Search places<input name="q" value="${escapeHTML(q)}" placeholder="Name contains…"></label><button class="button" type="submit">Search</button></form>
    <div class="table-wrap"><table class="data"><thead><tr><th>Name</th><th>Category</th><th>Locality</th><th>Quality</th><th>Status</th><th>Source</th><th>Actions</th></tr></thead><tbody>
    ${places.map(p => `<tr data-row="${escapeHTML(p.id)}"><td>${escapeHTML(p.name)}${p.sponsored ? ' <span class="pill warn">Sponsored</span>' : ''}</td><td>${escapeHTML(CATEGORIES[p.category]?.label || p.category)}</td><td>${escapeHTML(p.locality)}</td><td class="num">${p.quality ?? '—'}</td>
      <td>${p.active ? '<span class="pill ok">Active</span>' : '<span class="pill bad">Disabled</span>'} ${p.flagged ? `<span class="pill warn" title="${escapeHTML(p.flagReason || '')}">Flagged</span>` : ''}</td>
      <td>${escapeHTML(p.source.label || p.source.provider)}</td>
      <td class="row-actions"><button data-edit="${escapeHTML(p.id)}">Edit</button><button data-op="${p.active ? 'disable' : 'enable'}" data-id="${escapeHTML(p.id)}">${p.active ? 'Disable' : 'Enable'}</button><button data-op="${p.flagged ? 'unflag' : 'flag'}" data-id="${escapeHTML(p.id)}">${p.flagged ? 'Resolve flag' : 'Flag'}</button></td></tr>`).join('')}
    </tbody></table></div><p class="note">Disabled places disappear from recommendations immediately. Every change is written to the audit log.</p></section>`;
}

function performance(rows, feedback) {
  return `<section id="performance" aria-labelledby="pf-title"><h2 id="pf-title">Recommendation performance</h2>
    <div class="table-wrap"><table class="data"><thead><tr><th>Place</th><th>Opened</th><th>Added</th><th>Skipped</th><th>Removed</th><th>Worth it</th><th>Not worth it</th></tr></thead><tbody>
    ${rows.filter(r => r.opened || r.added || r.skipped || r.worthYes || r.worthNo).map(r => `<tr><td>${escapeHTML(r.name)}</td><td class="num">${r.opened || 0}</td><td class="num">${r.added || 0}</td><td class="num">${r.skipped || 0}</td><td class="num">${r.removed || 0}</td><td class="num">${r.worthYes || 0}</td><td class="num">${r.worthNo || 0}</td></tr>`).join('') || '<tr><td colspan="7">No traveller activity yet.</td></tr>'}
    </tbody></table></div></section>
    <section id="feedback" aria-labelledby="fb-title"><h2 id="fb-title">Traveller feedback</h2>
    ${feedback.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>When</th><th>Place</th><th>Visited</th><th>Worth it?</th><th>Comment</th></tr></thead><tbody>${feedback.map(f => `<tr><td>${escapeHTML(f.created_at.slice(0, 16).replace('T', ' '))}</td><td>${escapeHTML(f.place_name || f.place_id)}</td><td>${f.visited ? 'Yes' : 'No'}</td><td>${f.worth_it === 1 ? 'Yes' : f.worth_it === 0 ? 'No' : '—'}</td><td>${escapeHTML(f.comment || '')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="note">No feedback yet.</p>'}</section>`;
}

let query = '';
async function load() {
  try {
    const [ov, pl, perf, fb] = await Promise.all([api('admin/overview'), api(`admin/places?q=${encodeURIComponent(query)}`), api('admin/performance'), api('admin/feedback')]);
    main.innerHTML = overview(ov) + placesSection(pl.places, query) + performance(perf.places, fb.feedback);
    $('place-search').addEventListener('submit', e => { e.preventDefault(); query = e.currentTarget.q.value; load(); });
    window.adminPlaces = pl.places;
  } catch (error) {
    main.innerHTML = `<p id="admin-status" role="alert">${error.status === 401 ? 'Please <a class="text-link" href="index.html">sign in</a> with an admin account.' : error.status === 403 ? 'This page is for ROUTE+ staff only.' : escapeHTML(error.message)}</p>`;
  }
}

function editDialog(place) {
  const d = $('edit-place');
  d.innerHTML = `<button class="close" data-close-edit aria-label="Close">×</button><span class="eyebrow">EDIT PLACE</span><h2 id="edit-title">${escapeHTML(place.name)}</h2>
    <form id="edit-form">
      <label>Name<input name="name" value="${escapeHTML(place.name)}" required></label>
      <label>Category<select name="category">${Object.entries(CATEGORIES).map(([id, c]) => `<option value="${id}" ${id === place.category ? 'selected' : ''}>${escapeHTML(c.label)}</option>`).join('')}</select></label>
      <label>Description<textarea name="description" rows="3">${escapeHTML(place.description || '')}</textarea></label>
      <label>Visit duration (minutes)<input name="visit" type="number" min="5" max="600" value="${place.visitDurationMinutes ?? ''}"></label>
      <label>Quality (1–5)<input name="quality" type="number" min="1" max="5" step="0.1" value="${place.quality ?? ''}"></label>
      <label>Safety / caution<textarea name="caution" rows="2">${escapeHTML(place.caution || '')}</textarea></label>
      <button class="button primary" type="submit">Save changes</button>
    </form>`;
  d.showModal();
  d.querySelector('#edit-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.currentTarget;
    const body = { name: f.name.value, category: f.category.value, description: f.description.value, caution: f.caution.value };
    if (f.visit.value) body.visitDurationMinutes = Number(f.visit.value);
    if (f.quality.value) body.quality = Number(f.quality.value);
    await api(`admin/places/${encodeURIComponent(place.id)}`, { method: 'PATCH', body: JSON.stringify(body) });
    d.close(); toast('Place updated.'); load();
  });
}

document.addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.closeEdit !== undefined) { $('edit-place').close(); return; }
  if (b.dataset.edit) editDialog(window.adminPlaces.find(p => p.id === b.dataset.edit));
  if (b.dataset.op) {
    const reason = b.dataset.op === 'flag' ? 'Flagged for review by staff' : null;
    await api(`admin/places/${encodeURIComponent(b.dataset.id)}/${b.dataset.op}`, { method: 'POST', body: JSON.stringify({ reason }) });
    toast('Done.'); load();
  }
});

load();
