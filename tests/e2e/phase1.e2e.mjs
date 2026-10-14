// PHASE 1 browser acceptance tests (sample engine, schematic map).
// Run: BASE_URL=http://localhost:8080/ node --test tests/e2e/phase1.e2e.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPlaywright, openApp, planDemo, summaryValue, BASE_URL } from './helpers.mjs';

const pw = await loadPlaywright();
const APP_URL = new URL('?engine=sample', BASE_URL).href;
let browser;

test.before(async () => { if (pw) browser = await pw.chromium.launch(); });
test.after(async () => { await browser?.close(); });
const skip = !pw && 'Playwright not installed';

async function plan(page, origin, destination, { days = '3', traveler = 'Family', interests = ['Nature', 'Food'] } = {}) {
  await page.fill('[name=origin]', origin);
  await page.fill('[name=destination]', destination);
  await page.selectOption('[name=tripDays]', days);
  await page.selectOption('[name=travelerType]', traveler);
  for (const box of await page.$$('[name=interests]')) {
    const v = await box.getAttribute('value');
    if (interests.includes(v) !== await box.isChecked()) await box.click({ force: true });
  }
  await page.click('#generate');
}

test('landing page is fully styled with a working hero image', { skip }, async () => {
  const { page, problems, ctx } = await openApp(browser, { url: APP_URL });
  const font = await page.$eval('h1', el => getComputedStyle(el).fontFamily);
  assert.match(font, /Georgia/);
  // Compare against the TOKENS, not a frozen palette. What this check is for
  // is that tokens.css loaded and the components resolve it — which stays true
  // across a re-tint. Hard-coded literals only proved what the palette was in
  // the week the test was written.
  const tone = await page.evaluate(() => {
    const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const asRgb = value => {
      const probe = document.createElement('i');
      probe.style.color = value;
      document.body.append(probe);
      const out = getComputedStyle(probe).color;
      probe.remove();
      return out;
    };
    return {
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bgToken: asRgb(token('--bg')),
      primaryBg: getComputedStyle(document.querySelector('.hero .button.primary')).backgroundColor,
      primaryToken: asRgb(token('--primary'))
    };
  });
  assert.notEqual(tone.bgToken, 'rgba(0, 0, 0, 0)', 'tokens.css actually loaded');
  assert.equal(tone.bodyBg, tone.bgToken, 'the page background is the --bg token');
  const heroLoaded = await page.$eval('.hero-image img', img => img.complete && img.naturalWidth > 0);
  assert.ok(heroLoaded, 'hero image loads');
  assert.equal(tone.primaryBg, tone.primaryToken, 'the primary action is the --primary token');
  assert.equal((await page.$$('.how article')).length, 4);
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('1. demo journey fills the form and builds the dashboard', { skip }, async () => {
  const { page, problems, ctx } = await openApp(browser, { url: APP_URL });
  await page.click('[data-action=demo]');
  assert.equal(await page.inputValue('[name=origin]'), 'Visakhapatnam');
  assert.equal(await page.inputValue('[name=destination]'), 'Manali');
  assert.equal(await page.inputValue('[name=tripDays]'), '3');
  assert.equal(await page.inputValue('[name=travelerType]'), 'Family');
  const checked = await page.$$eval('[name=interests]:checked', els => els.map(e => e.value));
  assert.deepEqual(checked.sort(), ['Devotional', 'Food', 'Nature']);
  await page.click('#generate');
  await page.waitForSelector('#dashboard:not([hidden])');
  assert.equal(await page.textContent('#route-title'), 'Visakhapatnam → Manali');
  assert.equal((await page.$$('.phase')).length, 5, 'whole journey + 4 phases');
  assert.ok((await page.$$('.card')).length >= 5);
  assert.ok(await page.$('#map svg'), 'map drawn');
  assert.ok((await page.$$('#map .marker')).length > 0, 'discovery markers');
  const dashed = await page.$$eval('#map svg path[stroke-dasharray="6 6"]', els => els.length);
  assert.ok(dashed > 0, 'optional detours are dashed');
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('2. a second route gives different discoveries', { skip }, async () => {
  const { page, ctx } = await openApp(browser, { url: APP_URL });
  await plan(page, 'Hyderabad', 'Goa', { days: '2', traveler: 'Friends', interests: ['Food', 'Adventure'] });
  await page.waitForSelector('#dashboard:not([hidden])');
  assert.equal(await page.textContent('#route-title'), 'Hyderabad → Goa');
  const names = await page.$$eval('.card h3', els => els.map(e => e.textContent));
  assert.ok(names.includes('Local kitchen'));
  assert.ok(!names.includes('Riverside temple'), 'devotional stop not shown for Food+Adventure friends');
  await ctx.close();
});

test('3–6. add, skip, remove and multiple stops update totals and map', { skip }, async () => {
  const { page, ctx } = await openApp(browser, { url: APP_URL });
  await plan(page, 'Delhi', 'Jaipur', { days: '3', traveler: 'Family', interests: ['Nature', 'Food', 'Devotional'] });
  await page.waitForSelector('#dashboard:not([hidden])');
  await page.click('[data-add="delhi-jaipur-place-1"]'); // Forest waterfall: +12 km, +25 min
  assert.equal(await summaryValue(page, 'Stops added'), '1');
  assert.equal(await summaryValue(page, 'Extra distance'), '+12 km');
  assert.equal(await summaryValue(page, 'Extra driving'), '+25 min');
  assert.ok(await page.$('#map .marker.added'), 'added marker styled');
  assert.ok(await page.$('#map svg path[stroke-dasharray="0"]'), 'selected detour solid');

  await page.click('[data-add="delhi-jaipur-place-2"]'); // Riverside temple: +8 km, +20 min
  assert.equal(await summaryValue(page, 'Stops added'), '2');
  assert.equal(await summaryValue(page, 'Extra distance'), '+20 km');
  assert.equal(await summaryValue(page, 'Extra driving'), '+45 min');
  assert.equal(await summaryValue(page, 'Time at stops'), '1 hr 50 min');

  // Skip removes from list but keeps source data
  const before = (await page.$$('.card')).length;
  const skipId = await page.$eval('.card [data-skip]', b => b.dataset.skip);
  await page.click(`.card [data-skip="${skipId}"]`);
  assert.equal((await page.$$('.card')).length, before - 1);
  assert.equal(await page.evaluate(id => window.routePlus.state.plan.places.some(p => p.id === id), skipId), true);

  // Remove
  await page.click('#selected [data-remove="delhi-jaipur-place-1"]');
  assert.equal(await summaryValue(page, 'Stops added'), '1');
  assert.equal(await summaryValue(page, 'Extra distance'), '+8 km');
  await ctx.close();
});

test('7–9. trip extension warning: keep and extend', { skip }, async () => {
  const { page, ctx } = await openApp(browser, { url: APP_URL });
  await planDemo(page); // 1740 min route in 3 × 600 min days
  await page.click('[data-place="vizag-manali-place-1"]');
  await page.waitForSelector('#detail[open]');
  assert.match(await page.textContent('#detail'), /\+12 km/);
  await page.click('#detail [data-add]');
  await page.waitForSelector('#warning[open]');
  const warning = await page.textContent('#warning');
  assert.match(warning, /Your journey has changed/);
  assert.match(warning, /Original\s*3 days/);
  assert.match(warning, /Updated\s*4 days/);
  await page.click('[data-action=keep]');
  assert.match(await page.textContent('#selected'), /EXCEEDS/);
  assert.match(await page.textContent('#selected'), /consider removing/);
  assert.equal(await page.evaluate(() => window.routePlus.state.tripDays), 3);

  await page.click('[data-action=review-warning]');
  await page.click('[data-action=extend]');
  assert.equal(await page.evaluate(() => window.routePlus.state.tripDays), 4);
  assert.equal(await page.evaluate(() => window.routePlus.state.originalDays), 3);
  assert.match(await page.textContent('#route-meta'), /4 days \(originally 3\)/);
  await ctx.close();
});

test('10–11. save, reopening starts on the landing page, saved list opens the journey', { skip }, async () => {
  const { page, ctx } = await openApp(browser, { url: APP_URL });
  await plan(page, 'Chennai', 'Ooty', { days: '2', traveler: 'Couple', interests: ['Nature', 'Relaxation'] });
  await page.waitForSelector('#dashboard:not([hidden])');
  const addId = await page.$eval('.card [data-add]', b => b.dataset.add);
  await page.click(`.card [data-add="${addId}"]`);
  await page.click('.dashboard-top [data-action=save]');

  // Reopening the site starts on the landing page. The journey is NOT reopened
  // automatically — that is the traveller's choice, made through Saved
  // Journeys below. (This used to assert the opposite, which was the bug.)
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#landing');
  assert.equal(await page.isHidden('#dashboard'), true, 'the previous journey must not reopen by itself');
  assert.equal(await page.isVisible('.hero'), true, 'the landing hero is what a visitor sees first');

  // Starting a new journey from the landing page still works.
  await page.click('.hero [data-action=start]');
  assert.equal(await page.isVisible('[name=origin]'), true, 'Start Your Journey reaches the form');
  await page.click('nav [data-action=saved]');
  await page.waitForSelector('#saved[open]');
  assert.match(await page.textContent('#saved'), /Chennai → Ooty/);
  await page.click('#saved [data-load]');
  await page.waitForSelector('#dashboard:not([hidden])');
  assert.equal(await summaryValue(page, 'Stops added'), '1');
  await ctx.close();
});

test('12. mobile layout: menu, bottom sheet, no horizontal page scroll', { skip }, async () => {
  const { page, ctx, problems } = await openApp(browser, { url: APP_URL, width: 390, height: 844 });
  assert.equal(await page.isVisible('#menu-toggle'), true);
  await page.click('#menu-toggle');
  assert.equal(await page.isVisible('nav [data-action=saved]'), true);
  await page.keyboard.press('Escape');
  await planDemo(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `page overflows by ${overflow}px`);
  await page.click('.card [data-place]');
  await page.waitForSelector('#detail[open]');
  await page.waitForTimeout(400); // let the slide-up animation finish
  const box = await page.$eval('#detail', el => { const r = el.getBoundingClientRect(); return { bottom: r.bottom, width: r.width }; });
  assert.ok(Math.abs(box.bottom - 844) < 2, 'sheet anchored to bottom');
  assert.ok(box.width >= 388, 'sheet uses full width');
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#detail'), false);
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('13. empty discovery state and validation', { skip }, async () => {
  const { page, ctx } = await openApp(browser, { url: APP_URL });
  await page.click('#generate');
  assert.match(await page.textContent('#error-origin'), /start/);
  assert.match(await page.textContent('#error-interests'), /interest/);
  await plan(page, 'Pune', 'Mars', {});
  assert.match(await page.textContent('#form-status'), /not available/);
  await planDemo(page);
  await page.selectOption('#filter-category', 'food');
  await page.selectOption('#filter-interest', 'Mountains');
  await page.waitForSelector('.empty');
  assert.match(await page.textContent('.empty'), /Nothing worth detouring/);
  await page.click('[data-action=clear-filters]');
  assert.ok((await page.$$('.card')).length > 0);
  await ctx.close();
});

test('14. keyboard: detail dialog opens with Enter, closes with Escape, focus returns', { skip }, async () => {
  const { page, ctx, problems } = await openApp(browser, { url: APP_URL });
  await planDemo(page);
  const explore = await page.$('.card [data-place]');
  await explore.focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('#detail[open]');
  await page.keyboard.press('Escape');
  const focused = await page.evaluate(() => document.activeElement?.dataset.place || null);
  assert.ok(focused, 'focus returned to the Explore button');
  assert.deepEqual(problems, []);
  await ctx.close();
});
