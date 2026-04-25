// Screen-space feedback effects — the "second skin" of the game.
//
// When the player needs to FEEL something happened (perfect-round halo,
// wrong-click vignette, "+10" score float, breath disruption), this module
// turns it into a brief DOM overlay layered above the canvas + HUD.
//
// Design pillars:
//   - Pure visual. Knows nothing about scoring/game logic.
//   - All overlays are aria-hidden + pointer-events:none.
//   - Honors prefers-reduced-motion: shorter fades, no scale animations,
//     no breath-disrupt (which would itself look like motion).
//   - No external CSS required — inline styles so the module is self-contained
//     and survives stylesheet refactors.
//   - Re-uses CSS custom properties from index.html (--correct-flash,
//     --wrong-vignette, --ease-out-zen) so palette stays unified.

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║ TUNE: feedback "feel" knobs.                                             ║
// ║                                                                           ║
// ║ Wrong-click vignette:                                                     ║
// ║   ↓ VIGNETTE_DURATION_MS  shorter = sharper rebuke                        ║
// ║   ↑ VIGNETTE_PEAK_OPACITY brighter red (palette alpha is in CSS:         ║
// ║     --wrong-vignette in index.html — change there for color/strength)     ║
// ║                                                                           ║
// ║ Perfect-round halo:                                                       ║
// ║   ↑ HALO_DURATION_MS      slower bloom (more reverent)                    ║
// ║   ↑ HALO_PEAK_OPACITY     brighter green ring                             ║
// ║   ↑ HALO_SCALE_END        ring expands further before vanishing           ║
// ║                                                                           ║
// ║ Score float ("+10" rising text):                                          ║
// ║   ↑ SCORE_FLOAT_DURATION_MS  text lingers longer                          ║
// ║   ↑ SCORE_FLOAT_RISE_PX      flies higher                                 ║
// ║                                                                           ║
// ║ Breath disrupt (ambient pulse pauses on wrong click):                     ║
// ║   ↓ BREATH_DISRUPT_MS     shorter pause                                   ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

const VIGNETTE_DURATION_MS = 800;
const VIGNETTE_PEAK_OPACITY = 1.0; // CSS --wrong-vignette already has alpha
const HALO_DURATION_MS = 1200;
const HALO_PEAK_OPACITY = 0.55;
const HALO_SCALE_END = 1.45;
const SCORE_FLOAT_DURATION_MS = 900;
const SCORE_FLOAT_RISE_PX = 28;
const BREATH_DISRUPT_MS = 1100;

// ─── helpers ───────────────────────────────────────────────────────────────

function reducedMotion() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Force a layout flush so a freshly-set transition starts running. */
function flush(el) {
  // eslint-disable-next-line no-unused-expressions
  el.offsetWidth;
}

// ─── public API ────────────────────────────────────────────────────────────

/**
 * Feedback — owns a small DOM layer for screen-space feedback effects.
 * Construct once at boot. Each effect call appends a transient element
 * above the HUD (z-index 4) and tears it down after its lifetime.
 */
export class Feedback {
  /**
   * @param {object} opts
   * @param {HTMLElement} [opts.root]            parent for DOM overlays
   *                                             (defaults to document.body)
   * @param {HTMLElement} [opts.breathElement]   element whose CSS animation
   *                                             should pause on wrong clicks
   *                                             (typically #breath-ambient)
   */
  constructor({ root, breathElement } = {}) {
    this.root = root ?? (typeof document !== 'undefined' ? document.body : null);
    this.breathElement =
      breathElement ??
      (typeof document !== 'undefined'
        ? document.getElementById('breath-ambient')
        : null);
    /** Tracks pending timers so dispose() can cancel cleanly. */
    this._timers = new Set();
  }

  // ─── effects ───────────────────────────────────────────────────────────

  /**
   * Wrong click — soft red vignette pulses in from screen edges and fades.
   * Also briefly pauses the ambient breath so the player feels the rhythm
   * was disrupted (skipped if reduced-motion).
   */
  wrongClickVignette() {
    if (!this.root) return;
    const rm = reducedMotion();

    const el = document.createElement('div');
    el.className = 'zen-fb-vignette';
    el.setAttribute('aria-hidden', 'true');
    Object.assign(el.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '4',
      // Inward radial gradient — soft at center, deeper at edges.
      background:
        'radial-gradient(ellipse at center, transparent 35%, var(--wrong-vignette) 100%)',
      opacity: '0',
      transition: rm
        ? `opacity ${Math.min(VIGNETTE_DURATION_MS, 350)}ms linear`
        : `opacity ${VIGNETTE_DURATION_MS}ms var(--ease-out-zen)`,
    });
    this.root.appendChild(el);
    flush(el);

    // Two-stage fade: pulse up to peak, then ease out.
    el.style.opacity = String(VIGNETTE_PEAK_OPACITY);
    this._after(VIGNETTE_DURATION_MS * 0.35, () => {
      el.style.opacity = '0';
    });
    this._after(VIGNETTE_DURATION_MS + 200, () => el.remove());

    if (!rm) this._disruptBreath();
  }

  /**
   * Perfect round — soft green ring expands outward from center and fades.
   * Visual "thank you" for clean play; never competes with the next reveal.
   */
  perfectRoundHalo() {
    if (!this.root) return;
    const rm = reducedMotion();

    const el = document.createElement('div');
    el.className = 'zen-fb-halo';
    el.setAttribute('aria-hidden', 'true');
    Object.assign(el.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '4',
      // Outward soft green halo — narrow band, fades to transparent inward.
      background:
        'radial-gradient(ellipse at center, transparent 50%, var(--correct-flash) 78%, transparent 100%)',
      opacity: '0',
      transform: rm ? 'scale(1)' : 'scale(0.85)',
      transformOrigin: 'center',
      transition: rm
        ? `opacity ${Math.min(HALO_DURATION_MS, 500)}ms linear`
        : `opacity ${HALO_DURATION_MS}ms var(--ease-out-zen),
           transform ${HALO_DURATION_MS}ms var(--ease-out-zen)`,
      mixBlendMode: 'screen',
    });
    this.root.appendChild(el);
    flush(el);

    el.style.opacity = String(HALO_PEAK_OPACITY);
    if (!rm) el.style.transform = `scale(${HALO_SCALE_END})`;

    this._after(HALO_DURATION_MS * 0.55, () => {
      el.style.opacity = '0';
    });
    this._after(HALO_DURATION_MS + 200, () => el.remove());
  }

  /**
   * Score float — "+10" text rises briefly above an anchor and fades out.
   * If anchor is missing, falls back to top-center of the viewport (under
   * the HUD pills).
   *
   * @param {number|string} points
   * @param {HTMLElement|null} [anchor]  element to position above (uses its
   *                                     bounding rect)
   * @param {object} [opts]
   * @param {string} [opts.tone]         'positive' | 'bonus' (color cue)
   */
  scoreFloat(points, anchor, opts = {}) {
    if (!this.root || points == null) return;
    const rm = reducedMotion();
    const tone = opts.tone === 'bonus' ? 'bonus' : 'positive';

    const el = document.createElement('div');
    el.className = `zen-fb-score zen-fb-score--${tone}`;
    el.setAttribute('aria-hidden', 'true');
    el.textContent = `+${points}`;

    // Anchor positioning — if anchor present, place just below it; else
    // top-center fallback.
    let left, top;
    if (anchor && anchor.getBoundingClientRect) {
      const r = anchor.getBoundingClientRect();
      left = r.left + r.width / 2;
      top = r.bottom + 6;
    } else {
      left = window.innerWidth / 2;
      top = 96;
    }

    Object.assign(el.style, {
      position: 'fixed',
      left: `${left}px`,
      top: `${top}px`,
      transform: 'translate(-50%, 0)',
      pointerEvents: 'none',
      zIndex: '12',
      fontFamily: 'inherit',
      fontSize: '13px',
      fontWeight: '600',
      letterSpacing: '0.06em',
      color: tone === 'bonus' ? 'var(--accent-bright)' : 'var(--accent-text)',
      textShadow: '0 1px 8px rgba(0,0,0,0.45)',
      opacity: '0',
      transition: rm
        ? `opacity ${Math.min(SCORE_FLOAT_DURATION_MS, 400)}ms linear`
        : `opacity ${SCORE_FLOAT_DURATION_MS}ms var(--ease-out-zen),
           transform ${SCORE_FLOAT_DURATION_MS}ms var(--ease-out-zen)`,
    });
    this.root.appendChild(el);
    flush(el);

    el.style.opacity = '1';
    if (!rm) {
      el.style.transform = `translate(-50%, -${SCORE_FLOAT_RISE_PX}px)`;
    }

    this._after(SCORE_FLOAT_DURATION_MS * 0.6, () => {
      el.style.opacity = '0';
    });
    this._after(SCORE_FLOAT_DURATION_MS + 200, () => el.remove());
  }

  /** Pause the ambient breath pulse for BREATH_DISRUPT_MS. */
  _disruptBreath() {
    const b = this.breathElement;
    if (!b) return;
    b.classList.add('breath-disrupted');
    this._after(BREATH_DISRUPT_MS, () => b.classList.remove('breath-disrupted'));
  }

  /** Schedule a callback and track its timer for dispose() cleanup. */
  _after(ms, fn) {
    const id = setTimeout(() => {
      this._timers.delete(id);
      fn();
    }, ms);
    this._timers.add(id);
  }

  /** Cancel all pending timers + remove any lingering overlays. */
  dispose() {
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    if (this.root) {
      for (const sel of ['.zen-fb-vignette', '.zen-fb-halo', '.zen-fb-score']) {
        for (const node of this.root.querySelectorAll(sel)) node.remove();
      }
    }
    if (this.breathElement) {
      this.breathElement.classList.remove('breath-disrupted');
    }
  }
}

// Internal seam for tests.
export const _internal = Object.freeze({
  VIGNETTE_DURATION_MS,
  VIGNETTE_PEAK_OPACITY,
  HALO_DURATION_MS,
  HALO_PEAK_OPACITY,
  HALO_SCALE_END,
  SCORE_FLOAT_DURATION_MS,
  SCORE_FLOAT_RISE_PX,
  BREATH_DISRUPT_MS,
});
