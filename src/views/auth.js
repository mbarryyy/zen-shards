// Auth view — bare email field + Continue.
// Mock auth (per spec): no password, no validation beyond "looks like email".
// On submit → mock-data.signIn → redirect to the route stashed in
// sessionStorage by the auth gate (defaulting to #/play).

import { navigate } from '../router.js';
import { signIn } from '../mock-data.js';

const REDIRECT_KEY = 'zen.auth.redirect';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let cleanup = null;

/**
 * Stash a target route so the auth flow knows where to send the user
 * after sign-in. Used by the auth gate (e.g. Play button when signed-out).
 */
export function setRedirectAfterAuth(route) {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(REDIRECT_KEY, route);
  } catch { /* ignore */ }
}

function popRedirect() {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const v = sessionStorage.getItem(REDIRECT_KEY);
    sessionStorage.removeItem(REDIRECT_KEY);
    return v;
  } catch {
    return null;
  }
}

export function mount(container) {
  container.innerHTML = `
    <section class="auth glass-card" aria-labelledby="auth-title">
      <h1 class="auth__title" id="auth-title">Sign In</h1>
      <p class="auth__hint">Enter your email to begin.</p>
      <form class="auth__form" novalidate>
        <label class="auth__label" for="auth-email">Email</label>
        <input class="auth__input" id="auth-email" type="email" inputmode="email"
               autocomplete="email" required placeholder="you@example.com"
               aria-describedby="auth-error" />
        <p class="auth__error" id="auth-error" role="alert" aria-live="polite"></p>
        <button class="zen-btn zen-btn--primary" type="submit">Continue</button>
      </form>
    </section>
  `;

  const form = container.querySelector('form');
  const input = container.querySelector('#auth-email');
  const errEl = container.querySelector('#auth-error');

  // Auto-focus the field (gentle — not aggressive)
  setTimeout(() => input?.focus(), 80);

  const onSubmit = (ev) => {
    ev.preventDefault();
    const email = (input.value || '').trim();
    if (!EMAIL_RE.test(email)) {
      errEl.textContent = 'That doesn’t look like a valid email.';
      input.setAttribute('aria-invalid', 'true');
      return;
    }
    errEl.textContent = '';
    input.removeAttribute('aria-invalid');
    signIn(email);
    const next = popRedirect() || 'play';
    navigate(next);
  };

  form.addEventListener('submit', onSubmit);
  cleanup = () => form.removeEventListener('submit', onSubmit);
}

export function unmount() {
  cleanup?.();
  cleanup = null;
}
