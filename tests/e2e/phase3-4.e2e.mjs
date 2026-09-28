// PHASE 3–4 browser tests against the real server (temporary database).
// Includes the CRITICAL END-TO-END PATH from the product brief.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { loadPlaywright, summaryValue, openApp, BASE_URL } from './helpers.mjs';
import { startServer } from '../../server/index.js';

const pw = await loadPlaywright();
const skip = !pw && 'Playwright not installed';
let browser;
let srv;
let BASE;
const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'routeplus-')), 'e2e.sqlite');

test.before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', dbPath: dbFile, adminEmails: ['admin@example.com'], logLevel: 'silent' });
  BASE = `http://127.0.0.1:${srv.port}/`;
  if (pw) browser = await pw.chromium.launch();
});
test.after(async () => { await browser?.close(); await srv?.close(); });

async function open(url, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: opts.width || 1440, height: opts.height || 900 }, ...opts.context });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push(e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
  await page.goto(url, { waitUntil: 'networkidle' });
  return { ctx, page, problems };
}

async function fillJourney(page, origin, destination, days, traveler, interests) {
  await page.fill('[name=origin]', origin);
  await page.fill('[name=destination]', destination);
  await page.selectOption('[name=tripDays]', days);
  await page.selectOption('[name=travelerType]', traveler);
  for (const box of await page.$$('[name=interests]')) {
    const v = await box.getAttribute('value');
    if (interests.includes(v) !== await box.isChecked()) await box.click({ force: true });
  }
}

async function signUp(page, email) {
  await page.click('#account-button');
  await page.click('[data-auth-mode=signup]');
  await page.fill('#auth-form [name=displayName]', 'Deva');
  await page.fill('#auth-form [name=email]', email);
  await page.fill('#auth-form [name=password]', 'a-good-password');
  await page.click('#auth-form [type=submit]');
  await page.waitForFunction(() => document.querySelector('#account-button').textContent.includes('My account'));
}

test('CRITICAL PATH: origin → destination → route → candidates → place → detour → add → second add → recalculation → duration warning → save → restore', { skip }, async () => {
  const { page, ctx, problems } = await open(BASE);
  assert.equal(await page.isVisible('#account-button'), true, 'server mode shows accounts');
  await signUp(page, 'deva@example.com');

  // origin → destination
  await fillJourney(page, 'Bengaluru', 'Coorg', '1', 'Family', ['Nature', 'Devotional', 'Food']);
  await page.click('#generate');
  // route + candidates
  await page.waitForSelector('#dashboard:not([hidden])');
  const plan = await page.evaluate(() => window.routePlus.state.plan);
  assert.equal(plan.mode, 'geo');
  assert.ok(plan.routeId, 'plan came from the server API');
  assert.ok((await page.$$('.card')).length >= 3);
  // place + detour
  const firstId = await page.$eval('.card [data-place]', b => b.dataset.place);
  await page.click(`.card [data-place="${firstId}"]`);
  await page.waitForSelector('#detail[open]');
  assert.match(await page.textContent('#detail'), /Extra distance/);
  assert.match(await page.textContent('#detail'), /Transparent score/);
  // add
  await page.click('#detail [data-add]');
  if (await page.$('#warning[open]')) await page.click('[data-action=keep]');
  assert.equal(await summaryValue(page, 'Stops added'), '1');
  // second add → recalculation
  const extraBefore = await summaryValue(page, 'Extra driving');
  const secondId = await page.$eval('.card [data-add]', b => b.dataset.add);
  await page.click(`.card [data-add="${secondId}"]`);
  assert.equal(await summaryValue(page, 'Stops added'), '2');
  assert.notEqual(await summaryValue(page, 'Extra driving'), extraBefore, 'totals recalculated');
  // keep adding until the 1-day plan is exceeded → duration warning
  let warned = await page.$('#warning[open]');
  for (let i = 0; i < 8 && !warned; i++) {
    const id = await page.$eval('.card [data-add]', b => b.dataset.add).catch(() => null);
    if (!id) break;
    await page.click(`.card [data-add="${id}"]`);
    warned = await page.$('#warning[open]');
  }
  assert.ok(warned, 'duration warning appeared');
  const warning = await page.textContent('#warning');
  assert.match(warning, /Your journey has changed/);
  assert.match(warning, /Original\s*1 day/);
  await page.click('[data-action=extend]');
  const stopsCount = await page.evaluate(() => window.routePlus.state.selectedStops.length);
  const days = await page.evaluate(() => window.routePlus.state.tripDays);
  assert.ok(days >= 2);
  // save to account
  await page.click('.dashboard-top [data-action=save]');
  await page.waitForFunction(() => Boolean(window.routePlus.state.serverTripId));
  const tripId = await page.evaluate(() => window.routePlus.state.serverTripId);
  assert.deepEqual(problems, []);
  await ctx.close();

  // restore in a completely fresh browser (no localStorage): sign in → My Trips → open
  const fresh = await open(BASE);
  await fresh.page.click('#account-button');
  await fresh.page.fill('#auth-form [name=email]', 'deva@example.com');
  await fresh.page.fill('#auth-form [name=password]', 'a-good-password');
  await fresh.page.click('#auth-form [type=submit]');
  await fresh.page.waitForFunction(() => document.querySelector('#account-button').textContent.includes('My account'));
  await fresh.page.click('nav [data-action=saved]');
  await fresh.page.waitForSelector(`#saved [data-load="${tripId}"]`);
  await fresh.page.click(`#saved [data-load="${tripId}"]`);
  await fresh.page.waitForSelector('#dashboard:not([hidden])');
  assert.equal(await fresh.page.textContent('#route-title'), 'Bengaluru → Coorg (Madikeri)');
  assert.equal(await fresh.page.evaluate(() => window.routePlus.state.selectedStops.length), stopsCount);
  assert.equal(await fresh.page.evaluate(() => window.routePlus.state.tripDays), days);
  assert.equal(await fresh.page.evaluate(() => window.routePlus.state.originalDays), 1);
  await fresh.ctx.close();
});

test('mobile companion: phase, discoveries ahead, add, approaching alert, feedback, GPS', { skip }, async () => {
  const context = { geolocation: { latitude: 12.70, longitude: 77.25 }, permissions: ['geolocation'] };
  const { page, ctx, problems } = await open(BASE, { width: 390, height: 844, context });
  await fillJourney(page, 'Delhi', 'Jaipur', '2', 'Family', ['Heritage', 'Food', 'Nature']);
  await page.click('#generate');
  await page.waitForSelector('#dashboard:not([hidden])');
  const amberRouteKm = await page.evaluate(() => window.routePlus.state.plan.places.find(p => p.name === 'Amber Fort').routeKm);
  await page.goto(`${BASE}companion.html`, { waitUntil: 'networkidle' });
  assert.match(await page.textContent('#journey-card'), /Delhi → Jaipur/);
  assert.match(await page.textContent('#journey-card'), /Phase 1/);
  assert.match(await page.textContent('#nearby-card'), /ahead/);

  // add Amber Fort from the phone
  await page.evaluate(k => window.routePlusCompanion.setPreviewKm(k - 60), amberRouteKm);
  await page.waitForSelector('#nearby-card [data-add="curated:amber-fort"]');
  await page.click('#nearby-card [data-add="curated:amber-fort"]');
  assert.match(await page.textContent('#next-card'), /Amber Fort/);
  assert.match(await page.textContent('#next-card'), /Navigate there/);
  // approach it → one alert, not repeated
  await page.evaluate(k => window.routePlusCompanion.setPreviewKm(k - 8), amberRouteKm);
  await page.evaluate(k => window.routePlusCompanion.setPreviewKm(k - 6), amberRouteKm);
  const approaching = await page.$$eval('.alert', els => els.filter(e => /Approaching Amber Fort/.test(e.textContent)).length);
  assert.equal(approaching, 1, 'exactly one approaching alert');
  // pass it → feedback prompt
  await page.evaluate(k => window.routePlusCompanion.setPreviewKm(k + 30), amberRouteKm);
  await page.waitForSelector('[data-fb="curated:amber-fort"][data-worth=yes]');
  await page.click('[data-fb="curated:amber-fort"][data-worth=yes]');
  await page.waitForFunction(() => !document.querySelector('[data-fb="curated:amber-fort"]'));

  // GPS (mocked location near Delhi–Jaipur start)
  await ctx.setGeolocation({ latitude: 28.46, longitude: 77.03 });
  await page.click('[data-c=gps-start]');
  await page.waitForFunction(() => /Following your location/.test(document.querySelector('#location-card').textContent));
  await page.click('[data-c=gps-stop]');
  assert.match(await page.textContent('#location-card'), /Location is off/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 0, 'no horizontal scroll on phone');
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('admin dashboard: metrics, provider health, disable a place', { skip }, async () => {
  const { page, ctx, problems } = await open(`${BASE}admin.html`);
  assert.match(await page.textContent('#admin'), /sign in/i);
  await page.goto(BASE);
  await signUp(page, 'admin@example.com');
  await page.goto(`${BASE}admin.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#overview');
  assert.match(await page.textContent('#overview'), /Journeys started/);
  assert.match(await page.textContent('#system'), /offline-network|No provider calls/);
  await page.fill('#place-search [name=q]', 'Neemrana');
  await page.click('#place-search [type=submit]');
  await page.waitForSelector('[data-row="curated:neemrana"]');
  await page.click('[data-row="curated:neemrana"] [data-op=disable]');
  await page.waitForFunction(() => /Disabled/.test(document.querySelector('[data-row="curated:neemrana"]').textContent));
  assert.deepEqual(problems.filter(p => !/401/.test(p)), []);
  await ctx.close();
});

test('STEP 1 / TEST E: demo journey (Visakhapatnam → Manali, 3 days, Family, Nature/Devotional/Food) through the server, offline providers', { skip }, async () => {
  const { page, ctx, problems } = await open(BASE);
  await page.click('[data-action=demo]');
  assert.equal(await page.inputValue('[name=origin]'), 'Visakhapatnam');
  assert.equal(await page.inputValue('[name=destination]'), 'Manali');
  assert.equal(await page.inputValue('[name=tripDays]'), '3');
  assert.equal(await page.inputValue('[name=travelerType]'), 'Family');
  assert.deepEqual((await page.$$eval('[name=interests]:checked', els => els.map(e => e.value))).sort(), ['Devotional', 'Food', 'Nature']);
  await page.click('#generate');
  await page.waitForSelector('#dashboard:not([hidden])');
  const plan = await page.evaluate(() => window.routePlus.state.plan);
  assert.ok(plan.routeId, 'answered by the server');
  assert.equal(plan.route.provider, 'offline-network');
  assert.equal(await page.textContent('#route-title'), 'Visakhapatnam → Manali');
  await page.waitForSelector('#warning[open]');
  await page.click('[data-action=extend]');
  assert.ok((await page.$$('.card')).length >= 5);
  const id = await page.$eval('.card [data-add]', b => b.dataset.add);
  await page.click(`.card [data-add="${id}"]`);
  if (await page.$('#warning[open]')) await page.click('[data-action=extend]');
  assert.equal(await summaryValue(page, 'Stops added'), '1');
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('BETA POLISH: page structure, landmarks and tap targets on every page', { skip }, async () => {
  // These are the findings of the beta UI audit, kept as a test so a future
  // change cannot quietly undo them. Nothing here asserts a visual style — only
  // structure a screen reader and a thumb depend on.
  for (const [page, url] of [['planner', BASE_URL], ['companion', new URL('companion.html', BASE_URL).href], ['admin', new URL('admin.html', BASE_URL).href]]) {
    const { page: p, ctx } = await openApp(browser, { width: 390, height: 844, url });
    const shape = await p.evaluate(() => {
      const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'; };
      // The planner is one document with two screens (landing and dashboard),
      // so count the h1 that is actually on screen, not every h1 in the DOM.
      const h1s = [...document.querySelectorAll('h1')].filter(h => visible(h) || h.classList.contains('sr-only'));
      return {
        h1: h1s.length,
        h1Text: (h1s[0]?.textContent || '').trim(),
        landmarks: ['header', 'nav', 'main'].filter(t => document.querySelector(t)).join(','),
        docWidth: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
        // Links and buttons a thumb has to hit, excluding the map markers,
        // which are positioned dots rather than controls in a row.
        smallTargets: [...document.querySelectorAll('header a, header button, nav a, nav button')]
          .filter(visible).map(el => { const r = el.getBoundingClientRect(); return { h: Math.round(r.height), t: (el.textContent || '').trim().slice(0, 18) }; })
          .filter(x => x.h < 40)
      };
    });
    assert.equal(shape.h1, 1, `${page} has exactly one h1 (found ${shape.h1})`);
    assert.ok(shape.h1Text.length > 2, `${page} h1 says something: "${shape.h1Text}"`);
    assert.equal(shape.landmarks, 'header,nav,main', `${page} has header, nav and main landmarks (found ${shape.landmarks})`);
    assert.ok(shape.docWidth <= shape.viewport + 1, `${page} does not scroll sideways at 390px (${shape.docWidth} > ${shape.viewport})`);
    assert.deepEqual(shape.smallTargets, [], `${page} header/nav tap targets are at least 40px tall`);
    await ctx.close();
  }
});
