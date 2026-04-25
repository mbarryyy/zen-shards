// Profile view — name, best score, calm index, total rounds + Sign Out.
// Signed-out users get a gentle redirect-style empty state.

import { navigate } from '../router.js';
import {
  currentUser,
  signOut,
  bestForCurrentUser,
  totalRoundsForCurrentUser,
} from '../mock-data.js';

let cleanup = null;

export function mount(container) {
  const user = currentUser();

  if (!user) {
    container.innerHTML = `
      <section class="profile glass-card" aria-labelledby="profile-title">
        <h1 id="profile-title">Profile</h1>
        <p class="profile__empty">You're not signed in.</p>
        <div class="profile__actions">
          <button class="zen-btn zen-btn--primary" type="button" data-route="auth">Sign In</button>
          <button class="zen-btn" type="button" data-route="landing">Back to Menu</button>
        </div>
      </section>
    `;
    const onClick = (ev) => {
      const btn = ev.target.closest('button[data-route]');
      if (btn) navigate(btn.dataset.route);
    };
    container.addEventListener('click', onClick);
    cleanup = () => container.removeEventListener('click', onClick);
    return;
  }

  const best = bestForCurrentUser();
  const totalRounds = totalRoundsForCurrentUser();
  const bestScore = best?.score ?? 0;
  const calmIndex = best?.calmIndex ?? 0;
  const tier = best?.tier ?? { name: '—', emoji: '·' };

  container.innerHTML = `
    <section class="profile glass-card" aria-labelledby="profile-title">
      <header class="profile__header">
        <h1 id="profile-title">${escapeHtml(user.name)}</h1>
        <p class="profile__email">${escapeHtml(user.email)}</p>
      </header>
      <dl class="profile__stats" aria-label="Your stats">
        <div class="profile__stat">
          <dt>Best Score</dt>
          <dd>${bestScore}</dd>
        </div>
        <div class="profile__stat">
          <dt>Calm Index</dt>
          <dd>${calmIndex} <span class="profile__tier">${tier.emoji} ${escapeHtml(tier.name)}</span></dd>
        </div>
        <div class="profile__stat">
          <dt>Rounds Played</dt>
          <dd>${totalRounds}</dd>
        </div>
      </dl>
      <div class="profile__actions">
        <button class="zen-btn" type="button" data-route="play">Play Again</button>
        <button class="zen-btn zen-btn--ghost" type="button" data-action="sign-out">Sign Out</button>
      </div>
    </section>
  `;

  const onClick = (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    if (btn.dataset.action === 'sign-out') {
      signOut();
      navigate('landing');
      return;
    }
    if (btn.dataset.route) navigate(btn.dataset.route);
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
