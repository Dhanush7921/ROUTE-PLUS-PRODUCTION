// Runs every browser test: starts the ROUTE+ server on a free port with a
// throwaway database, points the tests at it, then shuts everything down.
//
//   npm run test:e2e
//
// Needs Playwright, which is a DEV dependency (the application itself still has
// none):
//   npm install                       # installs playwright
//   npx playwright install chromium   # downloads the browser
//
// Exit codes:  0 = browser tests ran and passed
//              1 = browser tests ran and something failed
//              2 = Playwright/Chromium is missing, so NOTHING was tested
// Exit 2 is deliberate: a suite that could not run must never read as a pass.

import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Is Playwright importable — locally, or from a global install? */
async function findPlaywright() {
  try { return { module: await import('playwright'), where: 'node_modules' }; } catch { /* try global */ }
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const require = createRequire(path.join(globalRoot, 'noop.js'));
    return { module: require('playwright'), where: globalRoot };
  } catch { return null; }
}

const found = await findPlaywright();
if (!found) {
  console.error([
    '',
    '  Browser tests were NOT run: Playwright is not installed.',
    '',
    '    npm install                       (installs the playwright dev dependency)',
    '    npx playwright install chromium   (downloads the browser it drives)',
    '',
    '  Then run  npm run test:e2e  again. Everything else is unaffected:',
    '  npm test and npm run check:beta do not need a browser.',
    ''
  ].join('\n'));
  process.exit(2);
}

// The browser BINARY can be missing even when the package is installed —
// `executablePath()` reports where Chromium should be, not that it is there.
// Without this check the suite runs and every test fails at launch, which looks
// like 18 broken tests instead of one missing download.
let chromium = null;
try { chromium = found.module.chromium.executablePath(); } catch (error) { chromium = null; }
if (!chromium || !fs.existsSync(chromium)) {
  console.error([
    '',
    '  Browser tests were NOT run: Playwright is installed, but Chromium is not.',
    '',
    '    npx playwright install chromium',
    '',
    chromium ? `  (expected it at ${chromium})` : '  (Playwright could not say where it expects the browser)',
    ''
  ].join('\n'));
  process.exit(2);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routeplus-e2e-'));
const srv = await startServer({ port: 0, host: '127.0.0.1', dbPath: path.join(dir, 'e2e.sqlite'), logLevel: 'silent' });
const testDir = path.join(root, 'tests', 'e2e');
const files = fs.readdirSync(testDir).filter(f => f.endsWith('.e2e.mjs')).map(f => path.join(testDir, f));

console.log(`  running ${files.length} browser test file(s) against http://127.0.0.1:${srv.port}/  (playwright from ${found.where})\n`);

// spawn (not spawnSync) so this process keeps serving requests while tests run.
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', '--test-concurrency=1', ...files], {
  stdio: 'inherit',
  cwd: root,
  env: { ...process.env, BASE_URL: `http://127.0.0.1:${srv.port}/` }
});
const { code, signal } = await new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));

// Always tidy up, whatever the tests did. maxRetries rides out a lingering
// Windows file handle rather than failing the run on cleanup.
await srv.close().catch(() => {});
try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
catch (error) { console.error(`  (could not remove ${dir}: ${error.code || error.message})`); }

if (signal) { console.error(`\n  Browser tests were interrupted (${signal}).\n`); process.exit(1); }
process.exit(code ?? 1);
