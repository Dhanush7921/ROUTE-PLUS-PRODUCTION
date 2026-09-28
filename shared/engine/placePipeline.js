// Place pipeline: external records → one clean ROUTE+ place model.
//
//   raw places (curated, OpenStreetMap, partners…)
//     → normalize   fill every field the app needs, using category defaults
//     → deduplicate same place from two sources becomes one record
//     → filter      drop records that are unusable or low value
//
// Source metadata is kept on each place so we always know where it came from.

import { CATEGORIES } from '../taxonomy.js';
import { CATEGORY_DEFAULTS, DEFAULT_CAUTION } from '../data/categoryDefaults.js';
import { haversineKm } from '../geo.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "Oct–Mar", "Apr–Jun, Sep–Oct" → Set of month numbers 1–12. Unknown → null. */
export function parseMonths(text) {
  if (!text) return null;
  const set = new Set();
  const re = /([A-Za-z]{3})[a-z]*\s*[–-]\s*([A-Za-z]{3})/g;
  let m;
  while ((m = re.exec(text))) {
    const a = MONTHS.indexOf(m[1].toLowerCase());
    const b = MONTHS.indexOf(m[2].toLowerCase());
    if (a < 0 || b < 0) continue;
    for (let i = a; ; i = (i + 1) % 12) { set.add(i + 1); if (i === b) break; }
  }
  return set.size ? set : null;
}

export function normalizePlace(raw, { travelMonth = new Date().getMonth() + 1 } = {}) {
  const d = CATEGORY_DEFAULTS[raw.category] || CATEGORY_DEFAULTS.scenic;
  const months = parseMonths(raw.bestMonths);
  const visit = raw.visitDurationMinutes ?? d.visit;
  const walk = raw.walkingMinutes ?? d.walk;
  const lessSuitable = raw.lessSuitableFor ?? [...d.lessSuitableFor, ...(walk > 45 ? ['Travellers avoiding long walks'] : [])];
  return {
    id: raw.id,
    name: raw.name.trim(),
    category: raw.category,
    lat: raw.lat,
    lng: raw.lng,
    locality: raw.locality || '',
    description: raw.description || `${CATEGORIES[raw.category]?.label || 'Place'} near ${raw.locality || 'your route'}.`,
    whyVisit: raw.whyVisit,
    interests: [...new Set([...(CATEGORIES[raw.category]?.interests || []), ...(raw.extraInterests || [])])],
    suitableFor: raw.suitableFor ?? d.suitableFor,
    lessSuitableFor: [...new Set(lessSuitable)],
    visitDurationMinutes: visit,
    walkingMinutes: walk,
    walkingRequired: walk > 0,
    bestTime: raw.bestTime || d.bestTime,
    bestMonths: raw.bestMonths,
    seasonal: Boolean(months),
    seasonalFit: months ? months.has(travelMonth) : true,
    openingHours: raw.openingHours || (d.hours ? { open: d.hours[0], close: d.hours[1] } : null),
    closedNote: raw.closedNote,
    openNow: raw.openNow !== false && raw.permanentlyClosed !== true,
    entryFee: raw.entryFee || 'Varies — confirm locally',
    parking: raw.parking ?? true,
    foodAvailable: raw.foodAvailable ?? Boolean(d.food),
    facilities: raw.facilities || d.facilities || ['Parking'],
    caution: [raw.caution || d.caution || DEFAULT_CAUTION, raw.closedNote].filter(Boolean).join(' '),
    rating: raw.quality ?? raw.rating ?? 4.0,
    terrain: raw.terrain || 'plain',
    sponsored: raw.sponsored === true, // Phase 4: shown with a label, never scored
    image: raw.image,
    source: raw.source || { provider: 'unknown', verified: false },
    sources: [raw.source?.provider].filter(Boolean)
  };
}

const key = name => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Merge records describing the same place (similar name within 1.5 km). */
export function dedupePlaces(places) {
  const out = [];
  for (const p of places) {
    const twin = out.find(q => (q.id === p.id) ||
      (haversineKm([q.lat, q.lng], [p.lat, p.lng]) < 1.5 && (key(q.name).includes(key(p.name)) || key(p.name).includes(key(q.name)))));
    if (!twin) { out.push(p); continue; }
    // Keep the richer record (curated beats OSM), remember both sources.
    for (const [k, v] of Object.entries(p)) if (twin[k] === undefined || twin[k] === null || twin[k] === '') twin[k] = v;
    twin.sources = [...new Set([...twin.sources, ...p.sources])];
  }
  return out;
}

export function isUsable(p) {
  return Boolean(p.name && Number.isFinite(p.lat) && Number.isFinite(p.lng) && CATEGORIES[p.category] && p.openNow !== undefined);
}

export function runPlacePipeline(raw, options) {
  const ranked = [...raw].sort((a, b) => (a.source?.provider === 'curated' ? -1 : 0) - (b.source?.provider === 'curated' ? -1 : 0));
  return dedupePlaces(ranked.filter(r => r?.name && CATEGORIES[r.category]).map(r => normalizePlace(r, options))).filter(isUsable);
}
