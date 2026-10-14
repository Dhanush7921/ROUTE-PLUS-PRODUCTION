// PHASE 8 — HTTP regression against a live PostgreSQL runtime.
// Starts the real server in ROUTE_PLUS_DB_MODE=postgres, drives the public API
// to create the data the admin endpoints report on, then reads those endpoints
// and checks the SHAPE of what they return — not merely that they answer 200.

import { startServer } from '../server/index.js';

const env = {
  ...process.env,
  ROUTE_PLUS_DB_MODE: 'postgres',
  NODE_ENV: 'test',
  ADMIN_EMAILS: 'admin@routeplus.test',
  ROUTE_PLUS_CONTACT: 'admin@routeplus.test'
};

const srv = await startServer({ port: 0, host: '127.0.0.1', logLevel: 'silent' }, env);
const jar = [];
let failures = 0;

const call = async (method, p, body) => {
  const res = await fetch(`http://127.0.0.1:${srv.port}${p}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar.length ? { Cookie: jar.join('; ') } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  for (const c of (res.headers.getSetCookie?.() || [])) {
    const kv = c.split(';')[0];
    const k = kv.split('=')[0];
    const i = jar.findIndex(x => x.startsWith(`${k}=`));
    if (i >= 0) jar[i] = kv; else jar.push(kv);
  }
  return { status: res.status, json: await res.json().catch(() => null) };
};

const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------- health
const health = await call('GET', '/api/health');
check(health.status === 200, 'GET /api/health', `status ${health.status}`);
check(health.json?.database === 'ok', 'health reports the database reachable', `database=${health.json?.database}`);
check(health.json?.ok === true, 'health ok flag', `ok=${health.json?.ok}`);

// ------------------------------------------------------- admin + activity
// The target database is shared and is NOT emptied between runs, so the admin
// account may already exist from an earlier run. A 409 EMAIL_TAKEN is that
// case, not a failure: sign in instead. Either path must leave a session.
const admin = { email: 'admin@routeplus.test', password: 'Route-Plus-Phase8-2026', displayName: 'Admin' };
const signup = await call('POST', '/api/auth/signup', admin);
let session = signup;
if (signup.status === 409) {
  jar.length = 0;
  session = await call('POST', '/api/auth/login', { email: admin.email, password: admin.password });
}
check(session.status === 200, 'admin session established',
  signup.status === 200 ? 'signed up' : `account existed (${signup.status}), signed in with status ${session.status}`);

const places = await call('GET', '/api/admin/places?q=');
check(places.status === 200, 'GET /api/admin/places', `status ${places.status}, ${places.json?.places?.length ?? 0} places`);
const ids = (places.json?.places || []).map(p => p.id);
check(ids.length >= 20, 'enough places to report on', `${ids.length}`);

// A realistic spread of activity: every place that will appear in the report
// gets opened, and a subset gets added / skipped / removed.
const events = [];
ids.slice(0, 40).forEach((placeId, i) => {
  events.push({ name: 'discovery_opened', sessionId: `s${i}`, props: { placeId, category: 'Nature' } });
  if (i % 2 === 0) events.push({ name: 'discovery_added', sessionId: `s${i}`, props: { placeId, category: 'Nature' } });
  if (i % 3 === 0) events.push({ name: 'discovery_skipped', sessionId: `s${i}`, props: { placeId, category: 'Food' } });
  if (i % 7 === 0) events.push({ name: 'discovery_removed', sessionId: `s${i}`, props: { placeId, category: 'Food' } });
});
const recorded = await call('POST', '/api/events', { events: events.slice(0, 100) });
check(recorded.status === 200, 'POST /api/events (PostgreSQL insert path)', `stored ${recorded.json?.stored}`);

// BASELINE, taken after the events and before this run's feedback.
//
// Feedback rows from earlier runs are left in place — this harness never
// deletes anything — so the assertions below are about the DELTA this run
// causes, not about absolute totals. Rows are identified by id rather than by
// position, so an unrelated writer cannot make the checks pass or fail.
//
// The worthYes baseline is read here, after the events, on purpose: ids[0] now
// carries activity, so it is inside the 100-row window the endpoint returns and
// its true total is readable. Before the events it might not appear at all.
const beforeFeedback = await call('GET', '/api/admin/feedback');
check(beforeFeedback.status === 200, 'baseline read of /api/admin/feedback', `status ${beforeFeedback.status}`);
const feedbackIdsBefore = new Set((beforeFeedback.json?.feedback || []).map(f => f.id));

const beforePerf = await call('GET', '/api/admin/performance');
check(beforePerf.status === 200, 'baseline read of /api/admin/performance', `status ${beforePerf.status}`);
const worthYesBefore = Number((beforePerf.json?.places || []).find(r => r.id === ids[0])?.worthYes ?? 0);

const fbYes = await call('POST', '/api/feedback', { placeId: ids[0], visited: true, worthIt: true, rating: 5, comment: 'Worth the detour.' });
const fbNo = await call('POST', '/api/feedback', { placeId: ids[1], visited: true, worthIt: false, rating: 2 });
const fbSkip = await call('POST', '/api/feedback', { placeId: ids[2], visited: false });
check([fbYes, fbNo, fbSkip].every(r => r.status === 200), 'POST /api/feedback x3 (yes / no / not visited)');

// ------------------------------------------------- /api/admin/performance
const perf = await call('GET', '/api/admin/performance');
check(perf.status === 200, 'GET /api/admin/performance', `status ${perf.status}`);
const rows = perf.json?.places || [];
check(rows.length === 100, 'returns 100 records', `${rows.length}`);
const keys = rows[0] ? Object.keys(rows[0]) : [];
for (const k of ['id', 'name', 'category', 'active', 'flagged', 'opened', 'added', 'skipped', 'removed', 'worthYes', 'worthNo']) {
  check(keys.includes(k), `performance row exposes "${k}"`, keys.includes(k) ? '' : `keys: ${keys.join(',')}`);
}
const withActivity = rows.filter(r => r.opened || r.added || r.skipped || r.worthYes || r.worthNo);
check(withActivity.length > 0, 'rows with activity sort to the top', `${withActivity.length} rows carry counts`);
check(rows.indexOf(withActivity[0]) === 0, 'ORDER BY put an active place first');
check(rows.every(r => r.active === 0 || r.active === 1), 'active is 1/0, not a raw boolean', `sample active=${JSON.stringify(rows[0]?.active)}`);
check(rows.every(r => r.flagged === 0 || r.flagged === 1), 'flagged is 1/0, not a raw boolean', `sample flagged=${JSON.stringify(rows[0]?.flagged)}`);
const scored = rows.find(r => r.id === ids[0]);
check(Number(scored?.worthYes) === worthYesBefore + 1, 'the "worth it" answer is counted',
  `worthYes ${worthYesBefore} -> ${JSON.stringify(scored?.worthYes)} (expected +1)`);

// ---------------------------------------------------- /api/admin/feedback
const fb = await call('GET', '/api/admin/feedback');
check(fb.status === 200, 'GET /api/admin/feedback', `status ${fb.status}`);
const list = fb.json?.feedback || [];
// This run's rows are the ones the baseline did not have. Every field and value
// check below still runs, unchanged, against exactly the three rows this run
// created — pre-existing rows are excluded rather than tolerated.
const mine = list.filter(f => !feedbackIdsBefore.has(f.id));
check(mine.length === 3, 'this run added exactly 3 feedback rows',
  `${feedbackIdsBefore.size} before, ${list.length} now, ${mine.length} new`);
check(mine.every(f => typeof f.created_at === 'string' && f.created_at.includes('T')),
  'created_at is an ISO string the admin page can slice', `sample=${JSON.stringify(mine[0]?.created_at)}`);
check(mine.every(f => f.visited === 0 || f.visited === 1),
  'visited is 1/0, not a raw boolean', `values=${JSON.stringify(mine.map(f => f.visited))}`);
check(mine.every(f => f.worth_it === 0 || f.worth_it === 1 || f.worth_it === null),
  'worth_it is 1/0/null, so the admin page renders Yes/No', `values=${JSON.stringify(mine.map(f => f.worth_it))}`);
check(mine.some(f => f.place_name), 'the place name is joined in', `sample=${JSON.stringify(mine[0]?.place_name)}`);

// ------------------------------------------------------- other admin reads
const overview = await call('GET', '/api/admin/overview');
check(overview.status === 200, 'GET /api/admin/overview', `status ${overview.status}`);
check(Number.isFinite(overview.json?.product?.users), 'overview product metrics computed', `users=${overview.json?.product?.users}`);
const auditRes = await call('GET', '/api/admin/audit');
check(auditRes.status === 200 && Array.isArray(auditRes.json?.audit), 'GET /api/admin/audit', `${auditRes.json?.audit?.length} rows`);
const near = await call('GET', '/api/places/near?lat=13.0827&lng=80.2707&radiusKm=60');
check(near.status === 200, 'GET /api/places/near (spatial path)', `${near.json?.places?.length} places`);
const pers = await call('GET', '/api/personalization');
check(pers.status === 200, 'GET /api/personalization', `categories=${JSON.stringify(pers.json?.categories)}`);

await srv.close();
console.log(`\n  ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
