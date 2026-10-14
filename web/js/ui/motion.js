// MOTION — scroll reveal, layered parallax and pointer tilt.
//
// Three rules this module is built around:
//
//   1. Nothing here is required for the product to work or to be readable.
//      Content is authored in its final position; `.reveal` only hides it
//      once this module has confirmed it can un-hide it again.
//   2. It writes only `transform` and `opacity` (via CSS custom properties),
//      so scrolling stays on the compositor and a low-powered phone is never
//      asked to re-layout.
//   3. `prefers-reduced-motion` and coarse pointers switch it off at the
//      source rather than animating to zero.
//
// No dependencies, no WebGL, no animation library.

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const fine = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;

/** Reveal elements once, as they enter the viewport. */
function installReveal(root) {
  const targets = root.querySelectorAll('[data-reveal]');
  if (!targets.length) return;

  // Stagger siblings: each element inside one group gets its own delay.
  const groups = new Map();
  for (const el of targets) {
    const key = el.dataset.revealGroup || el.parentElement;
    const index = groups.get(key) ?? 0;
    groups.set(key, index + 1);
    el.style.setProperty('--i', String(Math.min(index, 6)));
    el.classList.add('reveal');
  }

  // No IntersectionObserver (or reduced motion): show everything immediately.
  if (reduced() || !('IntersectionObserver' in window)) {
    for (const el of targets) el.classList.add('revealed');
    return;
  }

  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('revealed');
      io.unobserve(entry.target);          // reveal once, never re-hide
    }
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });

  for (const el of targets) io.observe(el);

  // Anything already on screen at load should not wait for a scroll event.
  requestAnimationFrame(() => {
    for (const el of targets) {
      const box = el.getBoundingClientRect();
      if (box.top < window.innerHeight * 0.92) { el.classList.add('revealed'); io.unobserve(el); }
    }
  });
}

/**
 * Scroll-driven parallax. Each [data-parallax] element declares a rate:
 * 0 is pinned to the page, 1 moves with the scroll. Distant layers take a
 * small rate, foreground layers a larger one, which is what reads as depth.
 */
function installParallax(root) {
  const layers = [...root.querySelectorAll('[data-parallax]')]
    .map(el => ({ el, rate: Number(el.dataset.parallax) || 0 }))
    .filter(l => l.rate !== 0);
  if (!layers.length || reduced()) return () => {};

  let frame = 0;
  const apply = () => {
    frame = 0;
    for (const { el, rate } of layers) {
      // Offset from the layer's own position, so a layer far down the page
      // is not already displaced when it scrolls into view.
      const box = el.getBoundingClientRect();
      const fromCentre = box.top + box.height / 2 - window.innerHeight / 2;
      el.style.transform = `translate3d(0, ${(-fromCentre * rate * 0.12).toFixed(2)}px, 0)`;
    }
  };
  const onScroll = () => { if (!frame) frame = requestAnimationFrame(apply); };

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  apply();
  return () => {
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
  };
}

/**
 * Pointer tilt on [data-tilt] surfaces. The element keeps its own rotation in
 * two custom properties; CSS decides what to do with them, so reduced motion
 * (where --tilt-max is 0) produces no rotation even if this runs.
 */
function installTilt(root) {
  if (reduced() || !fine()) return;
  const max = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tilt-max')) || 0;
  if (!max) return;

  const onMove = (event) => {
    const el = event.currentTarget;
    const box = el.getBoundingClientRect();
    const px = (event.clientX - box.left) / box.width - 0.5;   // -0.5 … 0.5
    const py = (event.clientY - box.top) / box.height - 0.5;
    el.style.setProperty('--ry', `${(px * max * 2).toFixed(2)}deg`);
    el.style.setProperty('--rx', `${(-py * max * 2).toFixed(2)}deg`);
  };
  const onLeave = (event) => {
    event.currentTarget.style.setProperty('--rx', '0deg');
    event.currentTarget.style.setProperty('--ry', '0deg');
  };

  // Delegated per element rather than globally: a card list is rebuilt often,
  // so install() is called again after each render (see below).
  for (const el of root.querySelectorAll('[data-tilt]')) {
    if (el.dataset.tiltBound) continue;
    el.dataset.tiltBound = '1';
    el.classList.add('tilt');
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('blur', onLeave, true);
  }
}

/** Mark the current section in the main navigation while scrolling. */
function installNavState() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  const map = { journey: 'start', how: 'how' };
  const sections = Object.keys(map).map(id => document.getElementById(id)).filter(Boolean);
  if (!sections.length || !('IntersectionObserver' in window)) return;

  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const action = map[entry.target.id];
      for (const button of nav.querySelectorAll('button[data-action]')) {
        button.toggleAttribute('aria-current', button.dataset.action === action);
      }
    }
  }, { rootMargin: '-45% 0px -45% 0px' });
  for (const section of sections) io.observe(section);
}

let detachParallax = () => {};

/**
 * Install (or re-install) motion. Safe to call after every render: reveal and
 * tilt skip elements they have already bound.
 */
export function installMotion(root = document) {
  installReveal(root);
  installTilt(root);
}

/** One-time setup for the page-level effects. */
export function bootMotion() {
  // If anything below throws, the class keeps `.reveal` content visible.
  document.documentElement.classList.add('no-motion');
  try {
    detachParallax();
    detachParallax = installParallax(document);
    installNavState();
    installMotion(document);
    document.documentElement.classList.remove('no-motion');
  } catch {
    /* leave `.no-motion` on: everything stays visible, just without motion */
  }
}
