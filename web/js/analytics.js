// Product analytics — records what travellers do so we can learn whether
// route discovery is valuable (Phase 4). Events carry no location history and
// no personal data: just the event name, ids and small numbers.
//
// Without a server, events stay in memory (visible via window.routePlusEvents
// for learning/debugging). With the server they are sent in small batches.

import { EVENTS } from '../../shared/events.js';

export { EVENTS };

const buffer = [];
let endpoint = null;
let timer = null;
const sessionId = Math.random().toString(36).slice(2, 12);

export function configureAnalytics({ url }) { endpoint = url; }

export function track(name, props = {}) {
  if (!EVENTS.includes(name)) return;
  const event = { name, props, at: new Date().toISOString(), sessionId };
  buffer.push(event);
  if (typeof window !== 'undefined') (window.routePlusEvents ||= []).push(event);
  if (endpoint) { clearTimeout(timer); timer = setTimeout(flush, 800); }
}

export async function flush() {
  if (!endpoint || !buffer.length) return;
  const batch = buffer.splice(0, buffer.length);
  try {
    await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: batch }), keepalive: true, credentials: 'same-origin' });
  } catch {
    // Analytics must never break the journey. Drop the batch quietly.
  }
}
