// CLOSED BETA SIGNALS — what the testers actually did.
//
//   npm run beta:signals              (last 14 days)
//   npm run beta:signals -- 30        (last 30 days)
//
// Read-only. It reads the analytics_events and feedback tables the app already
// writes (see shared/events.js for the whitelist) and prints the funnel, the
// places testers engaged with, and their "worth the detour?" answers.
//
// PRIVACY: this reports counts and place ids. The app stores no location
// history, no free-text beyond the feedback comment a tester chose to write,
// and only the whitelisted event properties — so there is nothing else here to
// print. Nothing in this report identifies a tester beyond their own comment.

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../server/config.js';
import { EVENTS } from '../shared/events.js';

const config = loadConfig();
const days = Number(process.argv[2]) || 14;
if (config.dbPath === ':memory:' || !fs.existsSync(config.dbPath)) {
  console.error(`\n  No database at ${config.dbPath}. Set ROUTE_PLUS_DB or run the beta first.\n`);
  process.exit(2);
}
const db = new DatabaseSync(config.dbPath, { readOnly: true });
const since = new Date(Date.now() - days * 86400_000).toISOString();
const count = (sql, ...args) => db.prepare(sql).get(...args)?.n ?? 0;
const bar = (n, max, width = 28) => '█'.repeat(max ? Math.max(n > 0 ? 1 : 0, Math.round(n / max * width)) : 0);

console.log(`\nROUTE+ closed beta signals — last ${days} day(s)\n`);

const events = db.prepare('SELECT name, count(*) AS n FROM analytics_events WHERE created_at >= ? GROUP BY name').all(since);
const byName = Object.fromEntries(events.map(e => [e.name, e.n]));
const total = events.reduce((a, e) => a + e.n, 0);

if (!total) {
  console.log('  No events recorded yet. Signals appear as soon as a tester plans a journey.\n');
} else {
  // The journey the product is really being tested on, in order.
  const funnel = [
    ['journeys started', 'journey_started'],
    ['routes generated', 'route_generated'],
    ['discoveries seen', 'discovery_seen'],
    ['discoveries opened', 'discovery_opened'],
    ['stops added', 'discovery_added'],
    ['stops skipped', 'discovery_skipped'],
    ['stops removed', 'discovery_removed'],
    ['trip extended', 'trip_extended'],
    ['duration kept', 'trip_kept'],
    ['journeys saved', 'trip_saved'],
    ['journeys completed', 'journey_completed'],
    ['place feedback', 'place_feedback']
  ];
  const max = Math.max(...funnel.map(([, key]) => byName[key] || 0));
  console.log('  funnel');
  for (const [label, key] of funnel) {
    const n = byName[key] || 0;
    console.log(`    ${label.padEnd(20)} ${String(n).padStart(5)}  ${bar(n, max)}`);
  }

  // The two ratios that say whether the core idea works.
  const started = byName.journey_started || 0;
  const opened = byName.discovery_opened || 0;
  const added = byName.discovery_added || 0;
  console.log('\n  ratios');
  if (opened) console.log(`    opened → added        ${(added / opened * 100).toFixed(0)}%   (did the +km / +min make the decision easy?)`);
  if (started) console.log(`    started → saved       ${((byName.trip_saved || 0) / started * 100).toFixed(0)}%   (did anyone finish planning?)`);
  if (added) console.log(`    added → removed       ${((byName.discovery_removed || 0) / added * 100).toFixed(0)}%   (high = stops cost more than testers expected)`);

  const unknown = events.filter(e => !EVENTS.includes(e.name));
  if (unknown.length) console.log(`\n  ! ${unknown.length} event name(s) outside the whitelist reached the table — investigate.`);
}

// Which places testers engaged with, and what they said.
const places = db.prepare(`SELECT place_id,
    sum(name = 'discovery_opened') AS opened,
    sum(name = 'discovery_added')  AS added,
    sum(name = 'discovery_skipped') AS skipped
  FROM analytics_events WHERE created_at >= ? AND place_id IS NOT NULL
  GROUP BY place_id ORDER BY added DESC, opened DESC LIMIT 10`).all(since);
if (places.length) {
  console.log('\n  most engaged places');
  for (const p of places) console.log(`    ${String(p.place_id).padEnd(34)} opened ${String(p.opened).padStart(3)}  added ${String(p.added).padStart(3)}  skipped ${String(p.skipped).padStart(3)}`);
}

const fb = db.prepare("SELECT count(*) AS n, sum(worth_it = 1) AS worth, sum(worth_it = 0) AS not_worth FROM feedback WHERE created_at >= ?").get(since);
if (fb.n) {
  console.log(`\n  "worth the detour?"  ${fb.worth || 0} yes / ${fb.not_worth || 0} no  (${fb.n} answer(s))`);
  const comments = db.prepare("SELECT place_id, rating, comment FROM feedback WHERE created_at >= ? AND comment IS NOT NULL AND comment != '' ORDER BY id DESC LIMIT 10").all(since);
  if (comments.length) {
    console.log('\n  recent comments');
    for (const c of comments) console.log(`    [${c.place_id}${c.rating ? ` ${c.rating}★` : ''}] ${String(c.comment).slice(0, 100)}`);
  }
}

console.log(`\n  accounts: ${count('SELECT count(*) AS n FROM users')}  ·  saved trips: ${count('SELECT count(*) AS n FROM trips')}  ·  routes planned: ${count('SELECT count(*) AS n FROM routes WHERE created_at >= ?', since)}`);
const providers = db.prepare("SELECT provider, method, count(*) AS n FROM routes WHERE created_at >= ? GROUP BY provider, method ORDER BY n DESC").all(since);
if (providers.length) {
  console.log('\n  which providers actually answered (beta honesty check)');
  for (const p of providers) console.log(`    ${p.provider.padEnd(18)} ${p.method.padEnd(14)} ${p.n} route(s)`);
}
const detours = db.prepare("SELECT method, count(*) AS n FROM detour_calculations GROUP BY method").all();
if (detours.length) console.log(`  detour figures: ${detours.map(d => `${d.method} ${d.n}`).join(', ')}`);

console.log('\n  See BETA-TEST-PLAN.md for what to do with these numbers.\n');
db.close();
