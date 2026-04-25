// Tests for src/views/{landing,auth,leaderboard,profile,nav}.js — Phase 10.
//
// Each view is a small DOM-only module exporting {mount, unmount}.
// We exercise mount → DOM structure + ARIA + interactions, and unmount →
// listener cleanup (no orphan handlers left on the container).
//
// Router/navigate is stubbed via vi.spyOn so we can assert routing intent
// without driving the actual router (covered by router.test.js).
//
// Mock-data is the real implementation — jsdom provides localStorage,
// each test wipes state via _resetMockData() + a localStorage scrub.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as router from '../src/router.js';
import * as landing from '../src/views/landing.js';
import * as authView from '../src/views/auth.js';
import * as leaderboardView from '../src/views/leaderboard.js';
import * as profileView from '../src/views/profile.js';
import * as navView from '../src/views/nav.js';
import {
  signIn,
  signOut,
  addScore,
  _resetMockData,
} from '../src/mock-data.js';
import { ZEN_TIERS } from '../src/calm-index.js';

let container;

beforeEach(() => {
  // Wipe storage so seed + signed-in state are predictable.
  try { localStorage.removeItem('zen.user'); } catch { /* ignore */ }
  try { localStorage.removeItem('zen.scores'); } catch { /* ignore */ }
  try { sessionStorage.clear(); } catch { /* ignore */ }
  _resetMockData();

  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Landing view ──────────────────────────────────────────────────────────

describe('landing view', () => {
  it('exports {mount, unmount}', () => {
    expect(typeof landing.mount).toBe('function');
    expect(typeof landing.unmount).toBe('function');
  });

  it('mounts the hero with title, tagline, and three CTAs', () => {
    landing.mount(container);
    expect(container.querySelector('.landing__title')?.textContent).toBe('Zen Shards');
    expect(container.querySelector('.landing__tagline')?.textContent).toMatch(
      /Memorise\. Recall\. Bloom\./,
    );
    const buttons = container.querySelectorAll('button[data-route]');
    expect(buttons).toHaveLength(3);
  });

  it('section has aria-labelledby pointing at the title id', () => {
    landing.mount(container);
    const section = container.querySelector('.landing');
    expect(section?.getAttribute('aria-labelledby')).toBe('landing-title');
    expect(container.querySelector('#landing-title')).toBeTruthy();
  });

  it('CTA labels include Play, Leaderboard, and Sign In when signed out', () => {
    landing.mount(container);
    const labels = [...container.querySelectorAll('button[data-route]')].map(
      (b) => b.textContent.trim(),
    );
    expect(labels).toEqual(['Play', 'Leaderboard', 'Sign In']);
  });

  it('third CTA shows "Profile" (not "Sign In") when signed in', () => {
    signIn('hello@example.com');
    landing.mount(container);
    const labels = [...container.querySelectorAll('button[data-route]')].map(
      (b) => b.textContent.trim(),
    );
    expect(labels[2]).toBe('Profile');
    // Third CTA points at #/profile when signed in.
    expect(
      container.querySelectorAll('button[data-route]')[2].dataset.route,
    ).toBe('profile');
  });

  it('renders welcome-back greeting only when signed in', () => {
    landing.mount(container);
    expect(container.querySelector('.landing__hello')).toBeNull();
    landing.unmount();

    signIn('Cedar@example.com');
    container.innerHTML = '';
    landing.mount(container);
    const hello = container.querySelector('.landing__hello');
    expect(hello).toBeTruthy();
    expect(hello.textContent).toMatch(/Welcome back, Cedar\./);
  });

  it('escapes user names to avoid HTML injection in the greeting', () => {
    signIn('<script>alert(1)</script>@x.io');
    landing.mount(container);
    const hello = container.querySelector('.landing__hello');
    // The escaped form should NOT contain a real <script> child.
    expect(hello.querySelector('script')).toBeNull();
    // The literal text should appear escaped.
    expect(hello.innerHTML).toMatch(/&lt;script&gt;/);
  });

  it('clicking a CTA delegates to router.navigate with the data-route', () => {
    const nav = vi.spyOn(router, 'navigate').mockImplementation(() => {});
    landing.mount(container);
    container.querySelector('button[data-route="leaderboard"]').click();
    expect(nav).toHaveBeenCalledWith('leaderboard');
  });

  it('unmount removes the click delegation listener', () => {
    const nav = vi.spyOn(router, 'navigate').mockImplementation(() => {});
    landing.mount(container);
    landing.unmount();
    container.querySelector('button[data-route="play"]')?.click();
    expect(nav).not.toHaveBeenCalled();
  });
});

// ─── Auth view ────────────────────────────────────────────────────────────

describe('auth view', () => {
  it('exports {mount, unmount, setRedirectAfterAuth}', () => {
    expect(typeof authView.mount).toBe('function');
    expect(typeof authView.unmount).toBe('function');
    expect(typeof authView.setRedirectAfterAuth).toBe('function');
  });

  it('mounts a form with email field, submit button, and ARIA label', () => {
    authView.mount(container);
    const section = container.querySelector('.auth');
    expect(section?.getAttribute('aria-labelledby')).toBe('auth-title');
    expect(container.querySelector('#auth-email')).toBeTruthy();
    expect(container.querySelector('button[type="submit"]')).toBeTruthy();
    // Error region with role=alert.
    const err = container.querySelector('#auth-error');
    expect(err?.getAttribute('role')).toBe('alert');
  });

  it('email input has type=email and inputmode=email for accessibility', () => {
    authView.mount(container);
    const input = container.querySelector('#auth-email');
    expect(input.getAttribute('type')).toBe('email');
    expect(input.getAttribute('inputmode')).toBe('email');
    expect(input.getAttribute('autocomplete')).toBe('email');
    expect(input.required).toBe(true);
  });

  it('auto-focuses the email field shortly after mount', async () => {
    authView.mount(container);
    await new Promise((r) => setTimeout(r, 120));
    const input = container.querySelector('#auth-email');
    expect(document.activeElement).toBe(input);
  });

  it('renders an inline error for an invalid email and sets aria-invalid', () => {
    const nav = vi.spyOn(router, 'navigate').mockImplementation(() => {});
    authView.mount(container);
    const input = container.querySelector('#auth-email');
    const errEl = container.querySelector('#auth-error');
    input.value = 'not-an-email';
    container.querySelector('form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    expect(errEl.textContent).toMatch(/email/i);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(nav).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only / missing email without crashing', () => {
    authView.mount(container);
    const input = container.querySelector('#auth-email');
    const errEl = container.querySelector('#auth-error');
    input.value = '   ';
    container.querySelector('form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    expect(errEl.textContent).toMatch(/email/i);
  });

  it('on valid submit: signs in and navigates to default "play" route', () => {
    const nav = vi.spyOn(router, 'navigate').mockImplementation(() => {});
    authView.mount(container);
    container.querySelector('#auth-email').value = 'finn@example.com';
    container.querySelector('form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    expect(nav).toHaveBeenCalledWith('play');
    // mock-data persisted the user.
    expect(localStorage.getItem('zen.user')).toContain('finn@example.com');
  });

  it('on valid submit: navigates to the redirect target stashed in sessionStorage', () => {
    const nav = vi.spyOn(router, 'navigate').mockImplementation(() => {});
    authView.setRedirectAfterAuth('leaderboard');
    expect(sessionStorage.getItem('zen.auth.redirect')).toBe('leaderboard');
    authView.mount(container);
    container.querySelector('#auth-email').value = 'go@example.com';
    container.querySelector('form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    expect(nav).toHaveBeenCalledWith('leaderboard');
    // Redirect key consumed (popped) so a second sign-in defaults again.
    expect(sessionStorage.getItem('zen.auth.redirect')).toBeNull();
  });

  it('clears the inline error after a successful submit', () => {
    vi.spyOn(router, 'navigate').mockImplementation(() => {});
    authView.mount(container);
    const input = container.querySelector('#auth-email');
    const errEl = container.querySelector('#auth-error');
    // First submit: invalid → error set.
    input.value = 'bogus';
    container.querySelector('form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    expect(errEl.textContent).toMatch(/email/i);
    // Second submit: valid → error cleared.
    input.value = 'ok@example.com';
    container.querySelector('form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    expect(errEl.textContent).toBe('');
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });

  it('unmount removes the submit listener', () => {
    const nav = vi.spyOn(router, 'navigate').mockImplementation(() => {});
    authView.mount(container);
    authView.unmount();
    const form = container.querySelector('form');
    if (form) {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
    expect(nav).not.toHaveBeenCalled();
  });
});

// ─── Leaderboard view ─────────────────────────────────────────────────────

describe('leaderboard view', () => {
  it('exports {mount, unmount}', () => {
    expect(typeof leaderboardView.mount).toBe('function');
    expect(typeof leaderboardView.unmount).toBe('function');
  });

  it('renders header with title and subtitle', () => {
    leaderboardView.mount(container);
    expect(container.querySelector('h1#lb-title')?.textContent).toMatch(/Leaderboard/i);
    expect(container.querySelector('.leaderboard__subtitle')).toBeTruthy();
  });

  it('renders top 10 rows from the seed leaderboard, sorted desc', () => {
    leaderboardView.mount(container);
    const rows = container.querySelectorAll('.leaderboard__row');
    expect(rows).toHaveLength(10); // seed has 12, capped at 10
    const scores = [...rows].map((r) =>
      parseInt(r.querySelector('.leaderboard__score').textContent, 10),
    );
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }
  });

  it('rank labels are zero-padded two-digit numbers (01..10)', () => {
    leaderboardView.mount(container);
    const ranks = [...container.querySelectorAll('.leaderboard__rank')].map(
      (e) => e.textContent,
    );
    expect(ranks[0]).toBe('01');
    expect(ranks[9]).toBe('10');
  });

  it('every row has an aria-label with rank, name, score, and tier', () => {
    leaderboardView.mount(container);
    for (const row of container.querySelectorAll('.leaderboard__row')) {
      const label = row.getAttribute('aria-label');
      expect(label).toMatch(/^Rank \d+, .+, score \d+,/);
      // Tier name from ZEN_TIERS taxonomy.
      const tierMatch = ZEN_TIERS.some((t) => label.endsWith(t.name));
      expect(tierMatch).toBe(true);
    }
  });

  it('highlights the current user\'s row with --me modifier + "· you" badge', () => {
    // Push a user-owned entry so we know what to look for.
    signIn('hilo@example.com'); // name = 'Hilo'
    addScore({ score: 5000, calmIndex: 90, round: 14 });
    leaderboardView.mount(container);
    const me = container.querySelector('.leaderboard__row--me');
    expect(me).toBeTruthy();
    expect(me.querySelector('.leaderboard__name').innerHTML).toMatch(/· you/);
    // Only the current user's row gets the badge.
    const others = [...container.querySelectorAll('.leaderboard__row')].filter(
      (r) => !r.classList.contains('leaderboard__row--me'),
    );
    for (const r of others) {
      expect(r.querySelector('.leaderboard__name').innerHTML).not.toMatch(/· you/);
    }
  });

  it('renders empty state when leaderboard is empty', () => {
    // Wipe the seeded scores so getLeaderboard returns an empty list.
    localStorage.setItem('zen.scores', JSON.stringify([]));
    leaderboardView.mount(container);
    expect(container.querySelector('.leaderboard__empty')).toBeTruthy();
    expect(container.querySelector('.leaderboard__list')).toBeNull();
  });

  it('escapes player names to prevent HTML injection in rows', () => {
    localStorage.setItem('zen.scores', JSON.stringify([
      { name: '<img src=x>', score: 100, calmIndex: 50, round: 5, tier: ZEN_TIERS[1] },
    ]));
    leaderboardView.mount(container);
    const nameCell = container.querySelector('.leaderboard__name');
    expect(nameCell.querySelector('img')).toBeNull();
    expect(nameCell.innerHTML).toMatch(/&lt;img/);
  });

  it('unmount cleans up (no orphan listeners — re-mount works)', () => {
    leaderboardView.mount(container);
    leaderboardView.unmount();
    container.innerHTML = '';
    expect(() => leaderboardView.mount(container)).not.toThrow();
  });
});

// ─── Profile view ────────────────────────────────────────────────────────

describe('profile view — signed out', () => {
  it('shows empty state with Sign In + Back to Menu when not signed in', () => {
    profileView.mount(container);
    expect(container.querySelector('.profile__empty')?.textContent).toMatch(
      /not signed in/i,
    );
    const buttons = container.querySelectorAll('button[data-route]');
    const routes = [...buttons].map((b) => b.dataset.route);
    expect(routes).toContain('auth');
    expect(routes).toContain('landing');
  });

  it('clicking Sign In navigates to auth', () => {
    const nav = vi.spyOn(router, 'navigate').mockImplementation(() => {});
    profileView.mount(container);
    container.querySelector('button[data-route="auth"]').click();
    expect(nav).toHaveBeenCalledWith('auth');
  });

  it('clicking Back to Menu navigates to landing', () => {
    const nav = vi.spyOn(router, 'navigate').mockImplementation(() => {});
    profileView.mount(container);
    container.querySelector('button[data-route="landing"]').click();
    expect(nav).toHaveBeenCalledWith('landing');
  });
});

describe('profile view — signed in', () => {
  beforeEach(() => {
    signIn('aria@example.com'); // name = 'Aria'
  });

  it('renders user name + email + stats blocks', () => {
    profileView.mount(container);
    expect(container.querySelector('#profile-title')?.textContent).toBe('Aria');
    expect(container.querySelector('.profile__email')?.textContent).toBe(
      'aria@example.com',
    );
    const stats = container.querySelectorAll('.profile__stat');
    expect(stats).toHaveLength(3);
    // dt labels match the spec.
    const dts = [...container.querySelectorAll('.profile__stat dt')].map(
      (d) => d.textContent,
    );
    expect(dts).toContain('Best Score');
    expect(dts).toContain('Calm Index');
    expect(dts).toContain('Rounds Played');
  });

  it('stats reflect the user\'s entries when present', () => {
    addScore({ score: 1500, calmIndex: 85, round: 12 });
    addScore({ score: 600, calmIndex: 50, round: 8 });
    profileView.mount(container);
    const dds = [...container.querySelectorAll('.profile__stat dd')].map((d) =>
      d.textContent.trim(),
    );
    // Best Score = 1500, Calm Index = 85, Rounds = 12 + 8 = 20.
    expect(dds[0]).toBe('1500');
    expect(dds[1]).toMatch(/^85/);
    expect(dds[2]).toBe('20');
  });

  it('renders zero stats when user has no entries yet', () => {
    profileView.mount(container);
    const dds = [...container.querySelectorAll('.profile__stat dd')].map((d) =>
      d.textContent.trim(),
    );
    expect(dds[0]).toBe('0'); // Best Score
    expect(dds[1]).toMatch(/^0/); // Calm Index
    expect(dds[2]).toBe('0'); // Rounds
  });

  it('Sign Out button signs out and navigates to landing', () => {
    const nav = vi.spyOn(router, 'navigate').mockImplementation(() => {});
    profileView.mount(container);
    container.querySelector('button[data-action="sign-out"]').click();
    expect(localStorage.getItem('zen.user')).toBeNull();
    expect(nav).toHaveBeenCalledWith('landing');
  });

  it('Play Again button navigates to play', () => {
    const nav = vi.spyOn(router, 'navigate').mockImplementation(() => {});
    profileView.mount(container);
    container.querySelector('button[data-route="play"]').click();
    expect(nav).toHaveBeenCalledWith('play');
  });

  it('escapes user name + email in the rendered DOM', () => {
    signOut();
    signIn('<svg/onload=alert(1)>@x.io');
    profileView.mount(container);
    expect(container.querySelector('svg')).toBeNull();
    const title = container.querySelector('#profile-title');
    expect(title.innerHTML).toMatch(/&lt;svg/);
  });

  it('section has aria-labelledby pointing at the title id', () => {
    profileView.mount(container);
    const section = container.querySelector('.profile');
    expect(section?.getAttribute('aria-labelledby')).toBe('profile-title');
  });

  it('unmount removes the click delegation', () => {
    const nav = vi.spyOn(router, 'navigate').mockImplementation(() => {});
    profileView.mount(container);
    profileView.unmount();
    container.querySelector('button[data-route="play"]')?.click();
    expect(nav).not.toHaveBeenCalled();
  });
});

// ─── Top-bar nav ─────────────────────────────────────────────────────────

describe('top-bar nav', () => {
  let host;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    navView.destroy();
    host.remove();
  });

  it('build creates a nav element with role + aria-label', () => {
    navView.build(host);
    const nav = host.querySelector('nav.app-nav');
    expect(nav).toBeTruthy();
    expect(nav.getAttribute('aria-label')).toBe('Primary');
  });

  it('renders logo + 3 link items + user slot', () => {
    navView.build(host);
    expect(host.querySelector('.app-nav__logo')).toBeTruthy();
    const links = host.querySelectorAll('.app-nav__links a[data-route]');
    expect(links).toHaveLength(3);
    const routes = [...links].map((l) => l.dataset.route);
    expect(routes).toEqual(['play', 'leaderboard', 'profile']);
    expect(host.querySelector('.app-nav__user')).toBeTruthy();
  });

  it('starts hidden (until update fires for a non-landing route)', () => {
    navView.build(host);
    expect(host.querySelector('nav.app-nav').hidden).toBe(true);
  });

  it('update("landing") hides the nav', () => {
    navView.build(host);
    navView.update('play');
    expect(host.querySelector('nav.app-nav').hidden).toBe(false);
    navView.update('landing');
    expect(host.querySelector('nav.app-nav').hidden).toBe(true);
  });

  it('update flips aria-current=page on the active link only', () => {
    navView.build(host);
    navView.update('leaderboard');
    const links = host.querySelectorAll('a[data-route]');
    for (const a of links) {
      if (a.dataset.route === 'leaderboard') {
        expect(a.getAttribute('aria-current')).toBe('page');
        expect(a.classList.contains('is-active')).toBe(true);
      } else {
        expect(a.hasAttribute('aria-current')).toBe(false);
        expect(a.classList.contains('is-active')).toBe(false);
      }
    }
  });

  it('user slot shows "Sign In" link when signed out', () => {
    navView.build(host);
    navView.update('play');
    expect(host.querySelector('.app-nav__signin')).toBeTruthy();
    expect(host.querySelector('.app-nav__user-name')).toBeNull();
  });

  it('user slot shows the user name when signed in', () => {
    signIn('mira@example.com');
    navView.build(host);
    navView.update('play');
    const name = host.querySelector('.app-nav__user-name');
    expect(name).toBeTruthy();
    expect(name.textContent).toBe('Mira');
    expect(host.querySelector('.app-nav__signin')).toBeNull();
  });

  it('user-slot name is escaped (no HTML injection)', () => {
    signIn('<i>boom</i>@x.io');
    navView.build(host);
    navView.update('play');
    const name = host.querySelector('.app-nav__user-name');
    expect(name.querySelector('i')).toBeNull();
    expect(name.innerHTML).toMatch(/&lt;i&gt;boom/);
  });

  it('clicking a link calls router.navigate with the route name (preventDefault)', () => {
    const nav = vi.spyOn(router, 'navigate').mockImplementation(() => {});
    navView.build(host);
    navView.update('play');
    const link = host.querySelector('a[data-route="leaderboard"]');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    expect(nav).toHaveBeenCalledWith('leaderboard');
    expect(ev.defaultPrevented).toBe(true);
  });

  it('clicking the logo calls navigate("landing")', () => {
    const nav = vi.spyOn(router, 'navigate').mockImplementation(() => {});
    navView.build(host);
    navView.update('play');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    host.querySelector('.app-nav__logo').dispatchEvent(ev);
    expect(nav).toHaveBeenCalledWith('landing');
  });

  it('destroy removes the nav from the DOM', () => {
    navView.build(host);
    navView.destroy();
    expect(host.querySelector('nav.app-nav')).toBeNull();
  });

  it('update is a no-op after destroy (defensive)', () => {
    navView.build(host);
    navView.destroy();
    expect(() => navView.update('leaderboard')).not.toThrow();
  });
});
