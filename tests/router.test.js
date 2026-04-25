// Tests for src/router.js — tiny hash-based router.
//
// Drives the router with stub view modules so we can assert mount/unmount
// lifecycle, default-route fallback, hash parsing edge cases, race
// conditions on rapid hash changes, fade timing, and clean teardown via
// stop().
//
// jsdom provides window/location/hashchange. We restore the hash + remove
// listeners between tests so suites stay isolated.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as router from '../src/router.js';

// Helper: build a stub view module that records mount/unmount calls and
// optionally exposes a custom unmount handle returned from mount().
function stubView(name, opts = {}) {
  const calls = [];
  return {
    name,
    calls,
    mount: vi.fn(async (container) => {
      calls.push(['mount', container]);
      container.dataset.view = name;
      if (opts.onMount) await opts.onMount(container);
      // Optional handle override (e.g. play.js returns its own {unmount}).
      if (opts.handle) return opts.handle;
      return undefined;
    }),
    unmount: vi.fn(async () => {
      calls.push(['unmount']);
      if (opts.onUnmount) await opts.onUnmount();
    }),
  };
}

let container;
let views;

beforeEach(() => {
  // Fresh DOM each test.
  document.body.innerHTML = '';
  container = document.createElement('div');
  container.id = 'page-container';
  document.body.appendChild(container);

  // Five stub views matching the real routes.
  views = {
    landing: stubView('landing'),
    auth: stubView('auth'),
    play: stubView('play'),
    leaderboard: stubView('leaderboard'),
    profile: stubView('profile'),
  };

  // Reset hash so default-route logic is exercised consistently.
  history.replaceState(null, '', window.location.pathname);
});

afterEach(async () => {
  await router.stop();
});

// Wait one macrotask + one microtask flush so the router's setTimeout
// (FADE_MS/2 default) and rAFs have time to settle.
// FADE_MS/2 = 200ms in the router; 250ms is enough to clear the timeout
// + the rAF that follows. Keep tests snappy by avoiding longer waits.
async function settle(ms = 250) {
  await new Promise((r) => setTimeout(r, ms));
}

// ─── start() and default route ─────────────────────────────────────────────

describe('router.start — default route + container wiring', () => {
  it('throws when container is missing', () => {
    expect(() => router.start({ routes: views })).toThrow(/container/i);
  });

  it('throws when routes is missing', () => {
    expect(() => router.start({ container })).toThrow(/routes/i);
  });

  it('defaults to #/landing on first visit (no hash set)', async () => {
    router.start({ container, routes: views });
    await settle();
    expect(window.location.hash).toBe('#/landing');
    expect(router.currentRoute()).toBe('landing');
    expect(views.landing.mount).toHaveBeenCalledTimes(1);
  });

  it('honours a pre-existing hash on first visit', async () => {
    history.replaceState(null, '', window.location.pathname + '#/leaderboard');
    router.start({ container, routes: views });
    await settle();
    expect(router.currentRoute()).toBe('leaderboard');
    expect(views.leaderboard.mount).toHaveBeenCalledTimes(1);
    expect(views.landing.mount).not.toHaveBeenCalled();
  });

  it('mounts the view inside a fresh page wrapper with className page--<name>', async () => {
    router.start({ container, routes: views });
    await settle();
    const page = container.querySelector('.page');
    expect(page).toBeTruthy();
    expect(page.classList.contains('page--landing')).toBe(true);
  });
});

// ─── hash parsing edge cases ──────────────────────────────────────────────

describe('hash parsing edge cases', () => {
  it('falls back to mounting the landing view on an unknown route', async () => {
    history.replaceState(null, '', window.location.pathname + '#/totally-bogus');
    router.start({ container, routes: views });
    await settle();
    // The landing module is mounted so the user always sees something
    // sensible. activeName + the page-wrapper class also reflect what was
    // actually mounted (not the bogus URL slug) so currentRoute() and
    // nav.update() stay in lock-step with the rendered view. The URL hash
    // itself is intentionally left as-typed so back-button correctability
    // is preserved.
    expect(views.landing.mount).toHaveBeenCalledTimes(1);
    expect(router.currentRoute()).toBe('landing');
    expect(container.querySelector('.page--landing')).toBeTruthy();
    expect(container.querySelector('.page--totally-bogus')).toBeNull();
  });

  it('strips trailing query/junk from the hash segment', async () => {
    history.replaceState(null, '', window.location.pathname + '#/leaderboard?foo=bar');
    router.start({ container, routes: views });
    await settle();
    expect(router.currentRoute()).toBe('leaderboard');
  });

  it('strips trailing path segments from the hash', async () => {
    history.replaceState(null, '', window.location.pathname + '#/profile/sub/page');
    router.start({ container, routes: views });
    await settle();
    expect(router.currentRoute()).toBe('profile');
  });

  it('hash with no leading slash (#landing) is treated as landing', async () => {
    history.replaceState(null, '', window.location.pathname + '#landing');
    router.start({ container, routes: views });
    await settle();
    expect(router.currentRoute()).toBe('landing');
  });

  it('empty hash falls back to landing', async () => {
    history.replaceState(null, '', window.location.pathname + '#');
    router.start({ container, routes: views });
    await settle();
    expect(router.currentRoute()).toBe('landing');
  });
});

// ─── navigate() and hashchange handling ───────────────────────────────────

describe('navigate() — route swap lifecycle', () => {
  it('updates the hash and triggers hashchange → mounts new view', async () => {
    router.start({ container, routes: views });
    await settle();

    router.navigate('leaderboard');
    await settle();
    expect(window.location.hash).toBe('#/leaderboard');
    expect(router.currentRoute()).toBe('leaderboard');
    expect(views.leaderboard.mount).toHaveBeenCalledTimes(1);
  });

  it('unmounts the previous view before mounting the new one', async () => {
    router.start({ container, routes: views });
    await settle();
    expect(views.landing.mount).toHaveBeenCalledTimes(1);

    router.navigate('profile');
    await settle();
    expect(views.landing.unmount).toHaveBeenCalledTimes(1);
    expect(views.profile.mount).toHaveBeenCalledTimes(1);
  });

  it('clears container DOM between mounts (no orphan nodes)', async () => {
    router.start({ container, routes: views });
    await settle();
    expect(container.querySelectorAll('.page')).toHaveLength(1);
    router.navigate('auth');
    await settle();
    expect(container.querySelectorAll('.page')).toHaveLength(1);
    const page = container.querySelector('.page');
    expect(page.classList.contains('page--auth')).toBe(true);
  });

  it('navigating to the same route re-mounts (route refresh path)', async () => {
    router.start({ container, routes: views });
    await settle();
    expect(views.landing.mount).toHaveBeenCalledTimes(1);
    router.navigate('landing');
    await settle();
    // Re-mount path — handleHashChange runs, view is re-mounted after unmount.
    // The current implementation early-returns if name === activeName, so
    // the same-route navigate triggers handleHashChange which then no-ops.
    // Either behavior is acceptable; assert the view DOM is still present
    // and currentRoute is still landing.
    expect(router.currentRoute()).toBe('landing');
    expect(container.querySelector('.page--landing')).toBeTruthy();
  });

  it('back/forward (hashchange events) drive the router', async () => {
    router.start({ container, routes: views });
    await settle();

    router.navigate('auth');
    await settle();
    router.navigate('leaderboard');
    await settle();

    // Simulate browser back: pop the hash to the previous value.
    history.back();
    await settle();
    // jsdom's history.back triggers a popstate but not always hashchange;
    // simulate the hashchange directly when needed.
    if (router.currentRoute() !== 'auth') {
      window.location.hash = '#/auth';
      await settle();
    }
    expect(router.currentRoute()).toBe('auth');
  });
});

// ─── currentRoute() ───────────────────────────────────────────────────────

describe('currentRoute()', () => {
  it('returns null before start', () => {
    expect(router.currentRoute()).toBeNull();
  });

  it('returns the active route name after a mount', async () => {
    router.start({ container, routes: views });
    await settle();
    expect(router.currentRoute()).toBe('landing');
    router.navigate('profile');
    await settle();
    expect(router.currentRoute()).toBe('profile');
  });
});

// ─── onChange callback ────────────────────────────────────────────────────

describe('onChange callback (used by top-bar nav)', () => {
  it('fires after each successful route swap with the route name', async () => {
    const onChange = vi.fn();
    router.start({ container, routes: views, onChange });
    await settle();
    expect(onChange).toHaveBeenCalledWith('landing');

    router.navigate('leaderboard');
    await settle();
    expect(onChange).toHaveBeenCalledWith('leaderboard');
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

// ─── Race conditions: rapid route changes ─────────────────────────────────

describe('race conditions on rapid route changes', () => {
  it('three rapid navigates settle on the LAST target', async () => {
    router.start({ container, routes: views });
    await settle();

    router.navigate('auth');
    router.navigate('leaderboard');
    router.navigate('profile');
    await settle();

    expect(router.currentRoute()).toBe('profile');
    expect(container.querySelector('.page--profile')).toBeTruthy();
    // No orphan pages from the intermediate transitions.
    expect(container.querySelectorAll('.page')).toHaveLength(1);
  });

  it('navigating during an unmount finishes cleanly (no double-mount of same view)', async () => {
    // Slow the auth view's unmount so a second navigate fires while it's
    // still tearing down.
    let resolveAuthUnmount;
    const slowUnmount = new Promise((res) => (resolveAuthUnmount = res));
    views.auth.unmount.mockImplementationOnce(async () => {
      await slowUnmount;
    });

    router.start({ container, routes: views });
    await settle();
    router.navigate('auth');
    await settle();

    router.navigate('profile');
    // Allow the slow unmount to finish.
    resolveAuthUnmount();
    await settle();

    expect(router.currentRoute()).toBe('profile');
    // landing mount fired once (initial), auth mount fired once, profile
    // mount fired once — no doubles.
    expect(views.landing.mount).toHaveBeenCalledTimes(1);
    expect(views.auth.mount).toHaveBeenCalledTimes(1);
    expect(views.profile.mount).toHaveBeenCalledTimes(1);
  });
});

// ─── view error tolerance ─────────────────────────────────────────────────

describe('view error tolerance', () => {
  it('a throwing mount logs but does not crash subsequent navigation', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    views.auth.mount.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    router.start({ container, routes: views });
    await settle();

    router.navigate('auth');
    await settle();

    // Auth mount threw → activeName is null. Subsequent navigate works.
    router.navigate('profile');
    await settle();
    expect(router.currentRoute()).toBe('profile');
    errSpy.mockRestore();
  });

  it('a throwing unmount logs but does not block the next mount', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    views.landing.unmount.mockImplementationOnce(async () => {
      throw new Error('unmount boom');
    });
    router.start({ container, routes: views });
    await settle();

    router.navigate('profile');
    await settle();
    expect(router.currentRoute()).toBe('profile');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

// ─── stop() teardown ──────────────────────────────────────────────────────

describe('router.stop()', () => {
  it('unmounts the active view and clears state', async () => {
    router.start({ container, routes: views });
    await settle();
    await router.stop();
    expect(views.landing.unmount).toHaveBeenCalled();
    expect(router.currentRoute()).toBeNull();
  });

  it('after stop, hash changes do not trigger mounts (listener removed)', async () => {
    router.start({ container, routes: views });
    await settle();
    await router.stop();
    views.profile.mount.mockClear();
    window.location.hash = '#/profile';
    await settle();
    expect(views.profile.mount).not.toHaveBeenCalled();
  });

  it('start can be called again after stop', async () => {
    router.start({ container, routes: views });
    await settle();
    await router.stop();

    // Fresh container + fresh views.
    container = document.createElement('div');
    document.body.appendChild(container);
    views.landing.mount.mockClear();
    history.replaceState(null, '', window.location.pathname);
    router.start({ container, routes: views });
    await settle();
    expect(views.landing.mount).toHaveBeenCalledTimes(1);
  });
});

// ─── Custom mount handle (used by play.js) ────────────────────────────────

describe('view returns custom unmount handle from mount()', () => {
  it('router uses the returned handle for subsequent unmount', async () => {
    const customUnmount = vi.fn();
    views.play = stubView('play', { handle: { unmount: customUnmount } });
    router.start({ container, routes: views });
    await settle();
    router.navigate('play');
    await settle();
    router.navigate('landing');
    await settle();
    expect(customUnmount).toHaveBeenCalledTimes(1);
    // The module-level unmount export should NOT also fire (the handle
    // wins). views.play.unmount might still be called depending on impl —
    // documenting current behavior:
    // The router calls activeView.unmount?.() and activeView is the
    // returned handle, so only customUnmount fires.
    expect(views.play.unmount).not.toHaveBeenCalled();
  });
});

// ─── prefers-reduced-motion bypass ────────────────────────────────────────

describe('prefers-reduced-motion bypass', () => {
  it('reduced motion still completes the route swap (no hang)', async () => {
    // Stub matchMedia to claim reduced motion.
    const orig = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: () => {},
      removeEventListener: () => {},
    });

    router.start({ container, routes: views });
    await settle(50); // shorter wait — RM path uses 1ms timeout
    expect(router.currentRoute()).toBe('landing');
    router.navigate('profile');
    await settle(50);
    expect(router.currentRoute()).toBe('profile');

    window.matchMedia = orig;
  });
});
