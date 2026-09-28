// The single-file build must work when simply double-clicked (file://) —
// the fix for the original "raw HTML" problem.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPlaywright } from './helpers.mjs';

const pw = await loadPlaywright();

test('standalone file: styled, images inline, full journey works offline via file://', { skip: !pw && 'Playwright not installed' }, async () => {
  execFileSync(process.execPath, ['scripts/build-standalone.mjs']);
  const browser = await pw.chromium.launch();
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push(e.message));
  page.on('requestfailed', r => problems.push(`failed: ${r.url().slice(0, 60)}`));
  await page.goto(pathToFileURL(path.resolve('dist/route-plus-standalone.html')).href);
  assert.equal(await page.$eval('body', el => getComputedStyle(el).backgroundColor), 'rgb(251, 248, 241)');
  assert.ok(await page.$eval('.hero-image img', img => img.naturalWidth > 0));
  await page.fill('[name=origin]', 'Chennai');
  await page.fill('[name=destination]', 'Ooty');
  await page.click('[name=interests][value=Food]', { force: true });
  await page.click('#generate');
  await page.waitForSelector('#dashboard:not([hidden])');
  assert.ok((await page.$$('.card')).length > 0);
  await page.click('.card [data-add]');
  assert.equal(await page.evaluate(() => window.routePlus.state.selectedStops.length), 1);
  assert.deepEqual(problems, []);
  await browser.close();
});
