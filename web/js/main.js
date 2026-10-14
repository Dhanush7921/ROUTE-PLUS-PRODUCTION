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
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
