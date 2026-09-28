// PRODUCTION STEP 2 — the EXISTING ROUTE+ screen showing a Google-provided
// route. This test starts its own server with ROUTE_PROVIDER/GEOCODING_PROVIDER
// set to google and an INJECTED transport that returns synthetic fixtures, so
// the browser renders a route whose distance, duration and geometry came from
// the Google adapters. It proves the UI needed no redesign — not that the live
// Google API works (only `npm run check:google` with a real key can show that).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPlaywright, openApp, summaryValue } from './helpers.mjs';
import { startServer } from '../../server/index.js';
import { fakeFetch, ROUTE_OK, GEOCODE_VIZAG, GEOCODE_MANALI } from '../fixtures/google-responses.mjs';

const pw = await loadPlaywright();
const skip = !pw && 'Playwright not installed';

let browser, srv, dir;
const { fetchImpl, calls } = fakeFetch(url => {
  if (url.includes('/geocode/')) return url.includes('Manali') ? GEOCODE_MANALI : GEOCODE_VIZAG;
  return ROUTE_OK;
});

test.before(async () => {
  if (!pw) return;
  browser = await pw.chromium.launch();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routeplus-step2-'));
  srv = await startServer(
    { port: 0, host: '127.0.0.1', dbPath: path.join(dir, 'step2.sqlite'), logLevel: 'silent' },
    { ROUTE_PROVIDER: 'google', GEOCODING_PROVIDER: 'google', PLACE_PROVIDER: 'curated', GOOGLE_MAPS_SERVER_KEY: 'TEST_ONLY_SERVER_PLACEHOLDER_not_a_key' },
    { fetchImpl }
  );
});
// Everything here is optional: when Playwright is missing, before() returns
// early and none of it exists. `dir` in particular must be checked — rmSync
// throws on undefined, which turned a skipped suite into a runner crash.
test.after(async () => {
  await browser?.close();
  await srv?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

test('STEP 2: the existing map and summary show the route returned by the Google adapters', { skip }, async () => {
  const { page, ctx, problems } = await openApp(browser, { url: `http://127.0.0.1:${srv.port}/` });

  await page.fill('[name=origin]', 'Visakhapatnam');
  await page.fill('[name=destination]', 'Manali');
  await page.selectOption('[name=tripDays]', '3');
  for (const box of await page.$$('[name=interests]')) {
    const value = await box.getAttribute('value');
    if (['Nature', 'Devotional', 'Food'].includes(value) !== await box.isChecked()) await box.click({ force: true });
  }
  await page.click('#generate');
  await page.waitForSelector('#dashboard:not([hidden])', { timeout: 20000 });

  const plan = await page.evaluate(() => window.routePlus.state.plan);
  assert.equal(plan.route.provider, 'google-routes', 'the route on screen came from the Google adapter');
  assert.equal(plan.origin.provider, 'google-geocoding');
  assert.equal(plan.route.distanceKm, 2690.4);
  assert.equal(plan.route.durationMin, 2745);
  assert.ok(plan.route.geometry.length >= 2);

  // The unchanged UI renders those numbers.
  const map = await page.textContent('#map svg');
  assert.match(map, /2,690 KM/, 'the existing SVG map shows the real distance');
  assert.match(map, /ROAD NETWORK/);
  assert.match(await page.textContent('#selected .baseline'), /Visakhapatnam → Manali/, 'the journey panel names the real endpoints');
  assert.match(await page.textContent('#selected .baseline'), /2,690 km/, 'and the real main-route distance');
  assert.match(await page.textContent('#map-label'), /google-routes/);
  assert.equal(await summaryValue(page, 'Stops added'), '0');
  assert.match(await page.textContent('#phases'), /km/);
  assert.ok((await page.$$('.card')).length > 0, 'discovery cards still render');

  // One journey stays one route request plus two geocodes.
  assert.equal(calls.length, 3);
  assert.ok(!(await page.content()).includes('TEST_ONLY_SERVER_PLACEHOLDER'), 'no key in the page');
  assert.deepEqual(problems, []);
  await ctx.close();
});
