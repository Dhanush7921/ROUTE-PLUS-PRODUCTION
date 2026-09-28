// Small formatting helpers shared by every screen.

export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 95 → "1 hr 35 min" */
export function duration(minutes) {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `${h} hr${rest ? ` ${rest} min` : ''}`;
}

/** 1234.5 → "1,235 km" ; 3.24 → "3.2 km" */
export function km(value) {
  const n = Number(value) || 0;
  return `${n >= 100 ? Math.round(n).toLocaleString('en-IN') : Math.round(n * 10) / 10} km`;
}

export const days = n => `${n} ${n === 1 ? 'day' : 'days'}`;

/** 450 (minutes after midnight) → "07:30" */
export function clock(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
