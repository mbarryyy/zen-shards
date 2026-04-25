// Tiny hash-based router for the Zen Shards app shell.
//
// Routes:
//   #/landing     → landing.js
//   #/auth        → auth.js
//   #/play        → play.js
//   #/leaderboard → leaderboard.js
//   #/profile     → profile.js
//
// Each view module exports `{ mount(container), unmount() }`. The router
// owns a single page-container element and hot-swaps views inside it with
// a 0.4s opacity cross-fade (respecting prefers-reduced-motion via CSS).
//
// Design choices:
//   - Hash routing — no server config needed, works on file:// + Vite dev.
//   - One mounted view at a time (no stack). Game state belongs to play.js,
//     leaderboard rebuilds on every mount, etc.
//   - The router is a singleton — main.js calls start() once at boot.

const FADE_MS = 400;

let activeView = null;
let activeName = null;
let pageContainer = null;
let routes = null;
let onRouteChange = null;
let pendingFadeTimer = null;

function reducedMotion() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function parseHash() {
  const raw = (window.location.hash || '').replace(/^#\/?/, '');
  // Strip any trailing query/junk; keep only the first segment.
  const seg = raw.split(/[?/]/)[0] || '';
  return seg || 'landing';
}

/**
 * Navigate to a named route. Updates the URL hash (which fires the
 * hashchange listener that does the actual mount swap).
 */
export function navigate(name) {
  const target = `#/${name}`;
  if (window.location.hash === target) {
    // Already there — re-mount so the view can refresh.
    handleHashChange();
    return;
  }
  window.location.hash = target;
}

export function currentRoute() {
  return activeName;
}

async function unmountActive() {
  if (!activeView) return;
  try {
    await activeView.unmount?.();
  } catch (err) {
    console.error('view unmount threw:', err);
  }
  activeView = null;
  activeName = null;
  if (pageContainer) pageContainer.innerHTML = '';
}

async function handleHashChange() {
  if (!routes || !pageContainer) return;
  const requested = parseHash();
  const known = Object.prototype.hasOwnProperty.call(routes, requested);
  const mod = known ? routes[requested] : routes.landing;
  if (!mod) {
    console.warn('[router] no view for route', requested);
    return;
  }
  // Unknown routes mount the landing module — so the activeName + page-class
  // should reflect what was actually mounted, not the bogus URL slug. Keeps
  // currentRoute() / nav.update() in lock-step with the rendered view (so a
  // bogus #/foo still gets aria-current on the Landing logo, etc.). The URL
  // hash is intentionally left as-typed so back/forward stay correctable.
  const name = known ? requested : 'landing';

  if (name === activeName) return;

  const rm = reducedMotion();

  // Fade out the page container, swap views, fade in.
  if (pendingFadeTimer) {
    clearTimeout(pendingFadeTimer);
    pendingFadeTimer = null;
  }
  pageContainer.classList.add('page-container--fading');

  await new Promise((res) => {
    pendingFadeTimer = setTimeout(res, rm ? 1 : FADE_MS / 2);
  });

  await unmountActive();

  // Mount the new view inside a fresh page wrapper.
  const page = document.createElement('div');
  page.className = `page page--${name}`;
  pageContainer.appendChild(page);

  try {
    const handle = await mod.mount(page);
    activeView = handle ?? mod;
    activeName = name;
  } catch (err) {
    console.error('view mount threw:', err);
    activeName = null;
    activeView = null;
  }

  // Notify listeners (top-bar nav uses this to re-render its active state)
  onRouteChange?.(name);

  // Fade back in on next frame so the new DOM has time to lay out.
  requestAnimationFrame(() => {
    pageContainer.classList.remove('page-container--fading');
  });
}

/**
 * Boot the router. `routes` is a map of routeName → view module.
 * `container` is the DOM element pages mount into.
 * `onChange` fires after each route swap with the new route name.
 */
export function start({ routes: routeMap, container, onChange }) {
  if (!container) throw new Error('router.start: container required');
  if (!routeMap) throw new Error('router.start: routes required');
  routes = routeMap;
  pageContainer = container;
  onRouteChange = onChange ?? null;

  window.addEventListener('hashchange', handleHashChange);
  // Default to #/landing on first visit.
  if (!window.location.hash) {
    window.location.hash = '#/landing';
  } else {
    handleHashChange();
  }
}

/** Tear down (mostly for tests / hot-reload). */
export async function stop() {
  window.removeEventListener('hashchange', handleHashChange);
  await unmountActive();
  routes = null;
  pageContainer = null;
  onRouteChange = null;
  if (pendingFadeTimer) clearTimeout(pendingFadeTimer);
}
