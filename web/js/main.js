// Entry point: core app → optional extensions → first render.
// Extensions only attach behaviour through app.hooks, so the core app works
// on its own (e.g. the standalone file with no server).
import { app, boot } from './app.js';
import { installAccount } from './account.js';
import { installIntelligence } from './intelligence.js';
import { bootMotion, installMotion } from './ui/motion.js';

await boot();
installIntelligence(app);
await installAccount(app);

// Depth and motion. afterRender fires on every dashboard render, so discovery
// cards built later get the same reveal and tilt treatment as the landing.
// installMotion skips elements it has already bound.
app.hooks.afterRender.push(() => installMotion(document));
bootMotion();

if (app.state.plan) app.render();

// Offline support for the planner and the on-road companion.
//
// The STANDALONE build is a single file with no sw.js beside it, so registering
// one there is a guaranteed 404. On file:// the guard below already skipped it;
// served over https (GitHub Pages, any static host) it logged a console error
// instead. The standalone build carries no <link rel="manifest">, so that is
// the reliable way to tell the two apart — and a service worker would be no use
// to a single self-contained file anyway.
const servedAsApp = Boolean(document.querySelector('link[rel="manifest"]'));
if (servedAsApp && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
