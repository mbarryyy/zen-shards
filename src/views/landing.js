// Landing view — hero with logo + tagline + 3 CTA buttons.
// Sparse, generous whitespace. The breath ambient layer behind it carries
// the visual identity; this page intentionally adds nothing animated of
// its own besides the entrance fade owned by the router.

import { navigate } from '../router.js';
import { currentUser } from '../mock-data.js';

let cleanup = null;

export function mount(container) {
  const user = currentUser();
  const accountLabel = user ? 'Profile' : 'Sign In';
  const accountTarget = user ? 'profile' : 'auth';

  container.innerHTML = `
    <section class="landing" aria-labelledby="landing-title">
      <div class="landing__brand">
        <div class="landing__mark" aria-hidden="true">
          <span class="landing__mark-orb landing__mark-orb--a"></span>
          <span class="landing__mark-orb landing__mark-orb--b"></span>
          <span class="landing__mark-orb landing__mark-orb--c"></span>
        </div>
        <h1 class="landing__title" id="landing-title">Zen Shards</h1>
        <p class="landing__tagline">Memorise. Recall. Bloom.</p>
      </div>

      <nav class="landing__cta" aria-label="Primary actions">
        <button class="zen-btn zen-btn--primary" type="button" data-route="play"
                aria-label="Start playing">Play</button>
        <button class="zen-btn" type="button" data-route="leaderboard"
                aria-label="View leaderboard">Leaderboard</button>
        <button class="zen-btn" type="button" data-route="${accountTarget}"
                aria-label="${accountLabel}">${accountLabel}</button>
      </nav>

      ${user ? `<p class="landing__hello">Welcome back, ${escapeHtml(user.name)}.</p>` : ''}
    </section>
  `;

  const onClick = (ev) => {
    const btn = ev.target.closest('button[data-route]');
    if (!btn) return;
    navigate(btn.dataset.route);
  };
  container.addEventListener('click', onClick);

  cleanup = () => container.removeEventListener('click', onClick);
}

export function unmount() {
  cleanup?.();
  cleanup = null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
