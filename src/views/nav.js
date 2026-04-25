// Top-bar nav — visible on every route except the landing page.
// Lives outside the page-container so it doesn't fade with route swaps;
// the router calls update() after each route change to flip the active
// link + show/hide based on the current route.
//
// This isn't a "view" in the mount/unmount sense — it's a long-lived
// chrome element. Exposed as a builder + updater pair.

import { navigate } from '../router.js';
import { currentUser } from '../mock-data.js';

const HIDDEN_ON = new Set(['landing']);

let navEl = null;

const LINKS = [
  { route: 'play',        label: 'Play' },
  { route: 'leaderboard', label: 'Leaderboard' },
  { route: 'profile',     label: 'Profile' },
];

export function build(container) {
  navEl = document.createElement('nav');
  navEl.className = 'app-nav';
  navEl.setAttribute('aria-label', 'Primary');
  navEl.hidden = true;

  navEl.innerHTML = `
    <a href="#/landing" class="app-nav__logo" aria-label="Zen Shards — Home">
      <span class="app-nav__mark" aria-hidden="true"></span>
      <span class="app-nav__logo-text">Zen Shards</span>
    </a>
    <ul class="app-nav__links" role="list">
      ${LINKS.map(
        ({ route, label }) =>
          `<li><a href="#/${route}" data-route="${route}">${label}</a></li>`,
      ).join('')}
    </ul>
    <div class="app-nav__user" aria-live="polite"></div>
  `;

  container.appendChild(navEl);

  // Click delegation — let browser default handle the hash, but pre-empt
  // for cleaner navigate() pathing (avoids subtle race with hashchange
  // when the user is already on the same route).
  navEl.addEventListener('click', (ev) => {
    const link = ev.target.closest('a[href^="#/"]');
    if (!link) return;
    ev.preventDefault();
    const route = link.dataset.route ?? link.getAttribute('href').replace('#/', '');
    navigate(route);
  });
}

export function update(routeName) {
  if (!navEl) return;
  navEl.hidden = HIDDEN_ON.has(routeName);

  // Highlight active link.
  for (const a of navEl.querySelectorAll('a[data-route]')) {
    const isActive = a.dataset.route === routeName;
    a.classList.toggle('is-active', isActive);
    if (isActive) {
      a.setAttribute('aria-current', 'page');
    } else {
      a.removeAttribute('aria-current');
    }
  }

  // User badge — shows name when signed in, "Sign In" link when not.
  const userSlot = navEl.querySelector('.app-nav__user');
  const user = currentUser();
  if (user) {
    userSlot.innerHTML = `<span class="app-nav__user-name">${escapeHtml(user.name)}</span>`;
  } else {
    userSlot.innerHTML = `<a href="#/auth" class="app-nav__signin" data-route="auth">Sign In</a>`;
  }
}

export function destroy() {
  if (navEl?.parentNode) navEl.parentNode.removeChild(navEl);
  navEl = null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
