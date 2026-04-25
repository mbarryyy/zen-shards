// Entry point — thin app-shell bootstrapper.
//
// Phase 10 refactor: main.js no longer wires the game directly. Instead it:
//   1. builds the top-bar nav,
//   2. starts the hash router with the five views,
//   3. hands every game-related concern off to src/views/play.js (which
//      mount/unmount manages the Three.js stage + HUD).
//
// Old long-form bootstrap that used to live here moved verbatim into
// src/views/play.js so route changes don't leak GPU memory.

import * as router from './router.js';
import * as nav from './views/nav.js';
import * as landing from './views/landing.js';
import * as auth from './views/auth.js';
import * as play from './views/play.js';
import * as leaderboard from './views/leaderboard.js';
import * as profile from './views/profile.js';
import { currentUser } from './mock-data.js';
import { setRedirectAfterAuth } from './views/auth.js';

// ─── DOM scaffolding ─────────────────────────────────────────────────────
// The router needs a stable container element to mount pages into. Use the
// pre-existing #root if it's there (legacy id from index.html), otherwise
// create one. The breath ambient layer + #ui (if present) keep their own
// pre-existing roles.

const navHost = document.createElement('div');
navHost.id = 'app-nav-host';
document.body.insertBefore(navHost, document.body.firstChild);

let pageContainer = document.getElementById('app');
if (!pageContainer) {
  pageContainer = document.createElement('div');
  pageContainer.id = 'app';
  // If the legacy #root exists, repurpose it cleanly: empty it and rename.
  const legacyRoot = document.getElementById('root');
  if (legacyRoot) {
    legacyRoot.innerHTML = '';
    legacyRoot.replaceWith(pageContainer);
  } else {
    document.body.appendChild(pageContainer);
  }
}
pageContainer.classList.add('page-container');

// Drop the legacy #ui shell if it's still in the DOM — the new HUD is
// constructed by the play view inside its own host element so each route
// change starts from a clean slate.
const legacyUi = document.getElementById('ui');
if (legacyUi && legacyUi.parentNode) {
  legacyUi.parentNode.removeChild(legacyUi);
}

// ─── Auth gate ───────────────────────────────────────────────────────────
// Wrap the play view so unauthenticated users get bounced through #/auth.
// Once they sign in, auth.js reads the redirect target we stash here.

const playGated = {
  mount(container) {
    if (!currentUser()) {
      setRedirectAfterAuth('play');
      // Defer the navigate so we don't recurse during a mount call.
      queueMicrotask(() => router.navigate('auth'));
      // Render nothing — the router will swap us out momentarily.
      container.innerHTML = `
        <div class="page-redirect" aria-live="polite">Redirecting to sign in…</div>
      `;
      return { unmount() {} };
    }
    return play.mount(container);
  },
  unmount() {
    play.unmount();
  },
};

// ─── Boot ────────────────────────────────────────────────────────────────

nav.build(navHost);

router.start({
  container: pageContainer,
  routes: {
    landing,
    auth,
    play: playGated,
    leaderboard,
    profile,
  },
  onChange: (routeName) => nav.update(routeName),
});
