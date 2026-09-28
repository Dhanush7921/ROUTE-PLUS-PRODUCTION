// PHASE 2 browser tests: the geographic engine inside the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPlaywright, openApp, summaryValue, BASE_URL } from './helpers.mjs';

const pw = await loadPlaywright();
const APP_URL = new URL('?engine=geo', BASE_URL).href;
let browser;
test.before(async () => { if (pw) browser = await pw.chromium.launch(); });
test.after(async () => { await browser?.close(); });
const skip = !pw && 'Playwright not installed';

async function plan(page, origin, destination, days = '2', interests = ['Heritage', 'Food', 'Nature']) {
  await page.fill('[name=origin]', origin);
  await page.fill('[name=destination]', destination);
  await page.selectOption('[name=tripDays]', days);
  for (const box of await page.$$('[name=interests]')) {
    const v = await box.getAttribute('value');
    if (interests.includes(v) !== await box.isChecked()) await box.click({ force: true });
  }
  await page.click('#generate');
}

test('real geography: route, map geometry, phases with km ranges, detours from data', { skip }, async () => {
  const { page, ctx, problems } = await openApp(browser, { url: APP_URL });
  await plan(page, 'Delhi', 'Jaipur', '1');
  await page.waitForSelector('#dashboard:not([hidden])');
  const planData = await page.evaluate(() => window.routePlus.state.plan);
  assert.equal(planData.mode, 'geo');
  assert.ok(planData.route.distanceKm > 240 && planData.route.distanceKm < 330);
  assert.ok(planData.route.geometry.length >= 5);
  assert.match(await page.textContent('#phases'), /km/);
  assert.match(await page.textContent('#map svg'), /KM/);

  const first = await page.$eval('.card [data-add]', b => b.dataset.add);
  const place = planData.places.find(p => p.id === first);
  await page.click(`.card [data-add="${first}"]`);
  if (await page.$('#warning[open]')) await page.click('[data-action=extend]');
  const mins = place.detourTimeMinutes;
  const expected = mins < 60 ? `+${mins} min` : `+${Math.floor(mins / 60)} hr${mins % 60 ? ` ${mins % 60} min` : ''}`;
  assert.equal(await summaryValue(page, 'Extra driving'), expected);
  const extraKm = await summaryValue(page, 'Extra distance');
  assert.equal(extraKm, `+${place.detourDistanceKm} km`);
  // detail explains anchor and rejoin
  await page.click(`#selected [data-place="${first}"]`);
  await page.waitForSelector('#detail[open]');
  assert.match(await page.textContent('#detail'), /Leave the main route near|Road distance with the stop/);
  await page.keyboard.press('Escape');
  // day-by-day plan exists
  assert.match(await page.textContent('#selected'), /Day-by-day estimate/);
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('invalid, misspelt and ambiguous places show helpful messages next to the field', { skip }, async () => {
  const { page, ctx } = await openApp(browser, { url: APP_URL });
  await plan(page, 'Visakapatnam', 'Manali');
  await page.waitForFunction(() => document.querySelector('#error-origin').textContent.length > 0);
  assert.match(await page.textContent('#error-origin'), /Did you mean Visakhapatnam/);
  await plan(page, 'Delhi', 'Bilaspur');
  await page.waitForFunction(() => /more than one/.test(document.querySelector('#error-destination').textContent));
  await plan(page, 'Delhi', 'Atlantis');
  await page.waitForFunction(() => /couldn't find/.test(document.querySelector('#error-destination').textContent));
  await ctx.close();
});

test('demo route: base route needs more days → honest warning, extend, then add stops', { skip }, async () => {
  const { page, ctx } = await openApp(browser, { url: APP_URL });
  await page.click('[data-action=demo]');
  await page.click('#generate');
  await page.waitForSelector('#warning[open]');
  assert.match(await page.textContent('#warning'), /Your route needs more time/);
  await page.click('[data-action=extend]');
  const days = await page.evaluate(() => window.routePlus.state.tripDays);
  assert.ok(days >= 5);
  for (let i = 0; i < 3; i++) {
    const id = await page.$eval('.card [data-add]', b => b.dataset.add);
    await page.click(`.card [data-add="${id}"]`);
    if (await page.$('#warning[open]')) {
      assert.match(await page.textContent('#warning'), /Your journey has changed/);
      await page.click('[data-action=extend]');
    }
  }
  assert.equal(await summaryValue(page, 'Stops added'), '3');
  assert.ok((await page.$$('#map .marker.added')).length === 3);
  await ctx.close();
});
