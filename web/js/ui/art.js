// Local, dependency-free illustrations for place categories.
// WHY: remote stock photos fail offline and can show the wrong place.
// Each card instead gets a warm SVG scene drawn for its category, so an
// image can never be "broken". A seeded variation keeps cards from looking
// identical. Real, licensed photos can be added later via place.image.

import { CATEGORIES } from '../../../shared/taxonomy.js';

const C = {
  cream: '#fbf3e4', sand: '#f1dcb4', amber: '#e6ae58', orange: '#d9793a',
  terracotta: '#b54d23', brown: '#7a4a2a', deep: '#3b2f25', sage: '#a7b08a',
  forest: '#5f7352', pine: '#46583f', water: '#8fb3b0', waterDeep: '#6f9795', snow: '#fffaf0'
};

const skies = [
  ['#f8e3bd', '#fbf3e4'], ['#f5d3a8', '#fcefdc'], ['#f2e0c7', '#fdf6ea'], ['#efc9a0', '#fbead3']
];

function hash(text) {
  let h = 2166136261;
  for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return Math.abs(h);
}

const hills = (y, color, amp = 30) =>
  `<path d="M0 ${y} Q 70 ${y - amp} 140 ${y - 6} T 280 ${y - amp / 2} T 400 ${y - 10} V240 H0Z" fill="${color}"/>`;
const mountains = (base, color, snow) =>
  `<path d="M-10 ${base} L70 ${base - 95} L120 ${base - 55} L190 ${base - 125} L260 ${base - 60} L320 ${base - 100} L410 ${base} Z" fill="${color}"/>` +
  (snow ? `<path d="M190 ${base - 125} L172 ${base - 100} L185 ${base - 104} L196 ${base - 96} L208 ${base - 104} Z M70 ${base - 95} L58 ${base - 78} L72 ${base - 82} L82 ${base - 76} Z" fill="${C.snow}"/>` : '');
const pine = (x, y, s = 1, color = C.pine) =>
  `<path d="M${x} ${y - 46 * s} L${x - 14 * s} ${y - 12 * s} H${x - 5 * s} L${x - 17 * s} ${y + 6 * s} H${x + 17 * s} L${x + 5 * s} ${y - 12 * s} H${x + 14 * s} Z" fill="${color}"/><rect x="${x - 2 * s}" y="${y + 6 * s}" width="${4 * s}" height="${8 * s}" fill="${C.brown}"/>`;

const scenes = {
  waterfall: () => mountains(200, C.sage) +
    `<path d="M150 70 H250 V240 H150Z" fill="${C.brown}" opacity=".85"/><path d="M178 70 h44 v130 h-44z" fill="${C.water}"/>` +
    [184, 196, 208].map(x => `<path d="M${x} 72 v126" stroke="${C.snow}" stroke-width="3" opacity=".8"/>`).join('') +
    `<ellipse cx="200" cy="210" rx="95" ry="20" fill="${C.waterDeep}"/>` + pine(110, 200, 1.1) + pine(300, 205, 1.3),
  temple: () => hills(215, C.sage) +
    `<path d="M200 48 L228 110 H172Z" fill="${C.terracotta}"/><rect x="165" y="110" width="70" height="70" fill="${C.orange}"/>` +
    `<path d="M186 180 v-34 a14 14 0 0 1 28 0 v34z" fill="${C.deep}"/><path d="M200 48 v-22 l18 7 -18 7" fill="none" stroke="${C.terracotta}" stroke-width="3"/>` +
    `<rect x="140" y="180" width="120" height="10" fill="${C.sand}"/><rect x="128" y="190" width="144" height="10" fill="${C.amber}"/>`,
  ghat: () => `<rect y="150" width="400" height="90" fill="${C.water}"/>` +
    [0, 1, 2, 3].map(i => `<rect x="${40 + i * 12}" y="${108 + i * 12}" width="${320 - i * 24}" height="12" fill="${i % 2 ? C.sand : C.amber}"/>`).join('') +
    `<path d="M300 60 L318 96 H282Z" fill="${C.terracotta}"/><rect x="286" y="96" width="28" height="12" fill="${C.orange}"/>` +
    `<path d="M20 205 q30 -8 60 0 t60 0" stroke="${C.snow}" fill="none" opacity=".7"/>`,
  monastery: () => mountains(190, C.sage, true) +
    `<rect x="150" y="120" width="100" height="70" fill="${C.cream}"/><rect x="140" y="112" width="120" height="10" fill="${C.terracotta}"/>` +
    `<rect x="170" y="90" width="60" height="22" fill="${C.cream}"/><rect x="162" y="84" width="76" height="8" fill="${C.terracotta}"/>` +
    `<path d="M20 70 L380 110" stroke="${C.brown}" stroke-width="1"/>` +
    ['#d9793a', '#e6ae58', '#8fb3b0', '#b54d23', '#a7b08a'].map((c, i) => `<rect x="${50 + i * 64}" y="${73 + i * 7}" width="16" height="12" fill="${c}"/>`).join('') +
    hills(225, C.forest, 16),
  ashram: () => hills(200, C.sage) + `<path d="M130 130 L200 90 L270 130Z" fill="${C.brown}"/><rect x="145" y="130" width="110" height="60" fill="${C.sand}"/>` +
    `<rect x="190" y="150" width="20" height="40" fill="${C.deep}"/><circle cx="320" cy="120" r="38" fill="${C.forest}"/><rect x="316" y="150" width="8" height="45" fill="${C.brown}"/>`,
  fort: () => hills(220, C.sage, 20) +
    `<rect x="70" y="110" width="260" height="95" fill="${C.amber}"/>` +
    Array.from({ length: 13 }, (_, i) => `<rect x="${70 + i * 20}" y="100" width="12" height="12" fill="${C.amber}"/>`).join('') +
    `<rect x="60" y="85" width="40" height="120" fill="${C.orange}"/><rect x="300" y="85" width="40" height="120" fill="${C.orange}"/>` +
    `<path d="M175 205 v-45 a25 25 0 0 1 50 0 v45z" fill="${C.deep}"/>`,
  forest: () => hills(185, C.sage) + [40, 90, 150, 215, 270, 330, 375].map((x, i) => pine(x, 200 + (i % 2) * 14, 1 + (i % 3) * 0.25)).join('') + hills(240, C.forest, 10),
  viewpoint: () => mountains(200, '#c9a27e', true) + mountains(235, C.sage) +
    `<path d="M0 222 H400" stroke="${C.brown}" stroke-width="4"/>` + [30, 90, 150, 210, 270, 330, 390].map(x => `<path d="M${x} 222 v18" stroke="${C.brown}" stroke-width="4"/>`).join(''),
  lake: () => mountains(160, C.sage) + `<rect y="160" width="400" height="80" fill="${C.water}"/>` +
    `<path d="M-10 160 L70 205 L120 180 L190 215 L260 180 L320 205 L410 160Z" fill="${C.waterDeep}" opacity=".45"/>` +
    [60, 150, 240, 330].map(x => `<path d="M${x} 196 h36" stroke="${C.snow}" opacity=".7"/>`).join(''),
  food: () => `<rect y="150" width="400" height="90" fill="${C.brown}"/><ellipse cx="200" cy="165" rx="130" ry="46" fill="${C.cream}"/>` +
    [[140, 158, C.orange], [195, 145, C.amber], [250, 160, C.terracotta], [175, 182, C.sage], [230, 184, C.sand]].map(([x, y, c]) => `<ellipse cx="${x}" cy="${y}" rx="26" ry="11" fill="${c}"/>`).join('') +
    [175, 200, 225].map(x => `<path d="M${x} 110 q-8 -14 0 -26 t0 -26" stroke="${C.brown}" fill="none" opacity=".35" stroke-width="3"/>`).join(''),
  village: () => hills(205, C.sage) + [[70, 150], [165, 140], [260, 155]].map(([x, y]) =>
    `<rect x="${x}" y="${y}" width="70" height="${205 - y}" fill="${C.sand}"/><path d="M${x - 8} ${y} L${x + 35} ${y - 30} L${x + 78} ${y}Z" fill="${C.terracotta}"/><rect x="${x + 28}" y="${y + 22}" width="14" height="${183 - y - 22}" fill="${C.deep}"/>`).join('') + pine(360, 200, .9),
  trail: () => mountains(215, C.sage) + `<path d="M60 240 Q170 200 120 170 T230 120 T270 70" stroke="${C.cream}" stroke-width="7" fill="none" stroke-dasharray="14 9"/>` +
    `<path d="M270 70 v-30 l22 8 -22 8" fill="${C.terracotta}"/>` + pine(330, 215) + pine(40, 205, .9),
  garden: () => hills(200, C.sage, 14) + [[90, 150, 36], [200, 135, 48], [310, 150, 36]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${C.forest}"/><rect x="${x - 4}" y="${y + r - 6}" width="8" height="${200 - y - r + 8}" fill="${C.brown}"/>`).join('') +
    `<rect x="160" y="200" width="80" height="8" fill="${C.brown}"/>` + [0, 1, 2, 3, 4].map(i => `<circle cx="${40 + i * 80}" cy="228" r="6" fill="${C.orange}"/>`).join(''),
  cave: () => hills(230, C.sage) + `<path d="M40 240 Q60 90 200 80 Q340 90 360 240Z" fill="${C.brown}"/><path d="M140 240 Q150 150 200 145 Q250 150 260 240Z" fill="${C.deep}"/>`
};

/** Returns a data: URI for the illustration of a place. */
export function placeArt(place) {
  const art = CATEGORIES[place.category]?.art || 'viewpoint';
  const seed = hash(place.id || place.name);
  const [top, bottom] = skies[seed % skies.length];
  const sunX = 60 + (seed % 280);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 240" preserveAspectRatio="xMidYMid slice">` +
    `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>` +
    `<rect width="400" height="240" fill="url(#s)"/><circle cx="${sunX}" cy="52" r="22" fill="${C.amber}" opacity=".75"/>` +
    (scenes[art] || scenes.viewpoint)() + `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function placeImage(place) {
  return place.image || placeArt(place);
}
