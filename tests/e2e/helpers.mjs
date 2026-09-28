// Shared helpers for browser (end-to-end) tests.
// Uses Playwright if it is installed (npm i -D playwright) or found globally.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import path from 'node:path';

export async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* try global */ }
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const require = createRequire(path.join(root, 'noop.js'));
    return require('playwright');
  } catch {
    return null;
  }
}

export const BASE_URL = process.env.BASE_URL || 'http://localhost:8080/';

export async function openApp(browser, { width = 1440, height = 900, url = BASE_URL, context = {} } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, ...context });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('requestfailed', r => problems.push(`requestfailed: ${r.url()}`));
  await page.goto(url, { waitUntil: 'networkidle' });
  return { page, ctx, problems };
}

export async function planDemo(page) {
  await page.click('[data-action=demo]');
  await page.click('#generate');
  await page.waitForSelector('#dashboard:not([hidden])', { timeout: 15000 });
}

export async function summaryValue(page, label) {
  return page.$eval('#summary', (el, label) => {
    const cell = [...el.children].find(c => c.querySelector('small').textContent.toLowerCase() === label.toLowerCase());
    return cell?.querySelector('strong').textContent.trim();
  }, label);
}

export async function closeOpenDialogs(page) {
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(d => d.close()));
}
