// Route map renderer.
// RULE: the main route is solid and dominant; optional detours are dashed and
// secondary. An added stop turns solid terracotta but the main line never moves.
//
// renderSchematic() draws the Phase 1 sample route (not to scale).
// renderGeographic() (Phase 2) projects real coordinates onto the same canvas.

import { escapeHTML } from '../format.js';
import { CATEGORIES } from '../../../shared/taxonomy.js';

const W = 1000;
const H = 460;
const MAX_DISCOVERY_MARKERS = 8;

const GLYPHS = { waterfall: '≋', temple: '⌂', pilgrimage: '⌂', river: '≈', monastery: '⌂', ashram: '❋', heritage: '♜',
  nature: '❦', viewpoint: '▲', lake: '◒', food: '☕', hidden: '◆', adventure: '△', photography: '◎', rest: '❋', local: '✦', wildlife: '❦', cave: '◠', scenic: '▲' };
export const glyph = category => GLYPHS[category] || '●';

function markersFor(plan, state, recommended) {
  const topIds = new Set(recommended.slice(0, MAX_DISCOVERY_MARKERS).map(p => p.id));
  return plan.places.filter(p => state.selectedStops.includes(p.id) || topIds.has(p.id));
}

function markerButton(place, left, top, added, compact) {
  const label = `${added ? 'Added stop' : 'Discovery'}: ${place.name}, ${CATEGORIES[place.category]?.label || ''}`;
  return `<button class="marker ${added ? 'added' : ''} ${compact ? 'compact' : ''}" data-place="${escapeHTML(place.id)}" style="left:${left}%;top:${top}%" aria-label="${escapeHTML(label)}" title="${escapeHTML(place.name)}">` +
    `<span class="pin" aria-hidden="true">${added ? '✓' : glyph(place.category)}</span><span class="marker-name">${escapeHTML(place.name)}</span></button>`;
}

function backdrop() {
  return `<defs><pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M50 0H0V50" fill="none" stroke="var(--map-grid)" stroke-width=".8"/></pattern></defs>` +
    `<rect width="${W}" height="${H}" fill="var(--map-surface)"/>` +
    `<path d="M0 90 Q180 170 290 70 T600 60 T1000 120 V0H0Z" fill="var(--map-land)"/>` +
    `<path d="M0 400 Q190 330 340 390 T640 340 T1000 400 V${H}H0Z" fill="var(--map-land)"/>` +
    `<rect width="${W}" height="${H}" fill="url(#grid)"/>`;
}

export function renderSchematic(el, plan, state, recommended) {
  const y0 = 230;
  const x0 = 80;
  const x1 = 920;
  const phaseWidth = (x1 - x0) / plan.phases.length;
  const shown = markersFor(plan, state, recommended);

  const phaseBands = plan.phases.map((ph, i) => {
    const active = state.currentPhaseId === ph.id;
    return `<rect x="${x0 + i * phaseWidth}" y="30" width="${phaseWidth}" height="${H - 60}" fill="${active ? 'var(--primary-soft)' : 'transparent'}" opacity=".7"/>` +
      `<text x="${x0 + i * phaseWidth + 10}" y="${H - 42}" font-size="12" letter-spacing="2" fill="var(--muted)">PHASE ${i + 1}</text>` +
      (i ? `<path d="M${x0 + i * phaseWidth} 40 V${H - 60}" stroke="var(--border-strong)" stroke-dasharray="2 6"/>` : '');
  }).join('');

  const detours = shown.map(p => {
    const added = state.selectedStops.includes(p.id);
    const x = p.schematic.x * 10;
    const y = p.schematic.y * (H / 100);
    return `<path d="M${x - 14} ${y0} Q ${x} ${(y0 + y) / 2} ${x} ${y} Q ${x} ${(y0 + y) / 2} ${x + 14} ${y0}" fill="none" stroke="${added ? 'var(--route-selected)' : 'var(--route-detour)'}" stroke-width="${added ? 3 : 2}" stroke-dasharray="${added ? '0' : '6 6'}" opacity="${added ? 1 : .85}"/>`;
  }).join('');

  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Schematic route from ${escapeHTML(plan.origin.name)} to ${escapeHTML(plan.destination.name)} with ${shown.length} optional detours shown dashed">` +
    backdrop() + phaseBands + detours +
    `<path d="M${x0} ${y0} H${x1}" stroke="var(--route-casing)" stroke-width="14" stroke-linecap="round"/>` +
    `<path d="M${x0} ${y0} H${x1}" stroke="var(--route-main)" stroke-width="6" stroke-linecap="round"/>` +
    `<circle cx="${x0}" cy="${y0}" r="10" fill="var(--route-main)"/><circle cx="${x1}" cy="${y0}" r="11" fill="var(--surface)" stroke="var(--route-main)" stroke-width="5"/>` +
    `<text x="${x0 - 10}" y="${y0 + 36}" font-size="16" font-weight="700" fill="var(--text)">${escapeHTML(plan.origin.name)}</text>` +
    `<text x="${x1 + 10}" y="${y0 + 36}" font-size="16" font-weight="700" fill="var(--text)" text-anchor="end">${escapeHTML(plan.destination.name)}</text>` +
    `<text x="${x0 - 10}" y="${y0 - 22}" font-size="11" letter-spacing="2" fill="var(--muted)">START</text>` +
    `<text x="${x1 + 10}" y="${y0 - 24}" font-size="11" letter-spacing="2" fill="var(--muted)" text-anchor="end">DESTINATION</text>` +
    `<text x="24" y="28" font-size="11" letter-spacing="2" fill="var(--muted)">SCHEMATIC · NOT TO SCALE</text></svg>`;

  el.classList.add('schematic');
  el.innerHTML = svg + shown.map(p => markerButton(p, p.schematic.x, p.schematic.y, state.selectedStops.includes(p.id), false)).join('');
}

// ---------------------------------------------------------------------------
// Phase 2: geographic renderer. Projects latitude/longitude with a simple
// equirectangular projection (accurate enough at road-trip scale), fits the
// route into the canvas and picks a canvas height that suits its shape.

export function projector(points, width = W, pad = 56, maxHeight = 620) {
  const lats = points.map(p => p[0]);
  const lngs = points.map(p => p[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const spanX = Math.max((maxLng - minLng) * kx, 0.05);
  const spanY = Math.max(maxLat - minLat, 0.05);
  // Tall routes (north–south) get a taller canvas, wide routes a shorter one.
  const height = Math.round(Math.min(maxHeight, Math.max(Math.min(400, maxHeight), (width - 2 * pad) * spanY / spanX + 2 * pad)));
  const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
  const offX = (width - spanX * scale) / 2;
  const offY = (height - spanY * scale) / 2;
  const project = ([lat, lng]) => [offX + (lng - minLng) * kx * scale, offY + (maxLat - lat) * scale];
  project.height = height;
  return project;
}

/** Keep only labels that do not collide with already placed ones. */
function placeLabels(items, minGap = 34) {
  const placed = [];
  return items.filter(item => {
    if (placed.some(p => Math.abs(p[0] - item.x) < minGap * 2.2 && Math.abs(p[1] - item.y) < minGap * 0.6)) return false;
    placed.push([item.x, item.y]);
    return true;
  });
}

export function renderGeographic(el, plan, state, recommended, extras = {}) {
  const geometry = plan.route.geometry;
  const shown = markersFor(plan, state, recommended);
  // Phones get a narrower, taller canvas so long north–south routes stay legible.
  const narrow = el.clientWidth > 0 && el.clientWidth < 600;
  const W = narrow ? 520 : 1000;
  const fs = n => Math.round(n * (narrow ? 1.35 : 1));
  const project = projector([...geometry, ...shown.map(p => [p.lat, p.lng])], W, narrow ? 40 : 56, narrow ? 880 : 620);
  const H2 = project.height;
  const path = pts => pts.map((pt, i) => { const [x, y] = project(pt); return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`; }).join(' ');

  const phaseLines = plan.phases.map(ph => {
    if (!ph.geometry || state.currentPhaseId !== ph.id) return '';
    return `<path d="${path(ph.geometry)}" stroke="var(--amber)" stroke-width="20" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity=".45"/>`;
  }).join('');

  const detours = shown.map(p => {
    const added = state.selectedStops.includes(p.id);
    const legs = [p.detour?.anchor, [p.lat, p.lng], p.detour?.rejoin].filter(Boolean);
    return `<path d="${path(legs)}" fill="none" stroke="${added ? 'var(--route-selected)' : 'var(--route-detour)'}" stroke-width="${added ? 3 : 2}" stroke-dasharray="${added ? '0' : '6 6'}" stroke-linejoin="round"/>`;
  }).join('');

  const [sx, sy] = project(geometry[0]);
  const [ex, ey] = project(geometry[geometry.length - 1]);
  const markerPts = shown.map(p => project([p.lat, p.lng]));
  const reserved = [[sx, sy], [ex, ey], ...markerPts].map(([x, y]) => ({ x, y, reserved: true }));
  const townItems = (plan.route.waypoints || []).slice(1, -1).map(w => { const [x, y] = project([w.lat, w.lng]); return { x, y, name: w.name }; });
  const towns = placeLabels([...reserved, ...townItems]).filter(t => !t.reserved).map(t =>
    `<circle cx="${t.x}" cy="${t.y}" r="3.5" fill="var(--surface)" stroke="var(--brown)" stroke-width="1.5"/>` +
    `<text x="${t.x + 8}" y="${t.y + 4}" font-size="${fs(12)}" fill="var(--muted)" paint-order="stroke" stroke="var(--map-surface)" stroke-width="3">${escapeHTML(t.name)}</text>`).join('');
  const smallDots = townItems.map(t => `<circle cx="${t.x}" cy="${t.y}" r="2" fill="var(--brown)" opacity=".5"/>`).join('');

  const endLabel = (x, y, text, sub) => {
    const right = x > W * 0.62;
    const tx = right ? x - 16 : x + 16;
    const anchor = right ? 'end' : 'start';
    return `<text x="${tx}" y="${y - 2}" font-size="${fs(10)}" letter-spacing="2" fill="var(--muted)" text-anchor="${anchor}">${sub}</text>` +
      `<text x="${tx}" y="${y + 15}" font-size="${fs(16)}" font-weight="700" fill="var(--text)" text-anchor="${anchor}" paint-order="stroke" stroke="var(--map-surface)" stroke-width="4">${escapeHTML(text)}</text>`;
  };

  const svg = `<svg viewBox="0 0 ${W} ${H2}" role="img" aria-label="Map of the main route from ${escapeHTML(plan.origin.name)} to ${escapeHTML(plan.destination.name)}, ${Math.round(plan.route.distanceKm)} km, with ${shown.length} optional detours shown dashed">` +
    `<defs><pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M50 0H0V50" fill="none" stroke="var(--map-grid)" stroke-width=".8"/></pattern></defs>` +
    `<rect width="${W}" height="${H2}" fill="var(--map-surface)"/><rect width="${W}" height="${H2}" fill="url(#grid)"/>` +
    phaseLines + detours +
    `<path d="${path(geometry)}" stroke="var(--route-casing)" stroke-width="11" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="${path(geometry)}" stroke="var(--route-main)" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` +
    smallDots + towns +
    `<circle cx="${sx}" cy="${sy}" r="9" fill="var(--route-main)"/><circle cx="${ex}" cy="${ey}" r="10" fill="var(--surface)" stroke="var(--route-main)" stroke-width="5"/>` +
    endLabel(sx, sy, plan.origin.name, 'START') + endLabel(ex, ey, plan.destination.name, 'DESTINATION') +
    `<text x="20" y="26" font-size="${fs(11)}" letter-spacing="2" fill="var(--muted)">N ↑ · ${Math.round(plan.route.distanceKm).toLocaleString('en-IN')} KM · ${plan.route.method === 'road-network' ? 'ROAD NETWORK' : 'ESTIMATED ROAD NETWORK'}</text></svg>`;

  const compact = shown.length > 4;
  const pct = ([x, y]) => [x / W * 100, y / H2 * 100];
  let html = svg + shown.map((p, i) => {
    const [l, t] = pct(markerPts[i]);
    const added = state.selectedStops.includes(p.id);
    return markerButton(p, l, t, added, compact && !added);
  }).join('');
  if (extras.currentPosition) {
    const [l, t] = pct(project(extras.currentPosition));
    html += `<span class="you-are-here" style="left:${l}%;top:${t}%" role="img" aria-label="Your current location"></span>`;
  }
  el.classList.remove('schematic');
  el.innerHTML = html;
}

export function renderMap(el, plan, state, recommended, extras) {
  if (plan.route.geometry?.length > 1) renderGeographic(el, plan, state, recommended, extras);
  else renderSchematic(el, plan, state, recommended);
}
