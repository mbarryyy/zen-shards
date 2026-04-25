// Tests for src/feedback.js — screen-space feedback overlays (vignette,
// halo, score float, breath disrupt). DOM-only; uses fake timers for
// deterministic lifecycle assertions.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Feedback, _internal } from '../src/feedback.js';

let breath;

beforeEach(() => {
  document.body.innerHTML = '';
  breath = document.createElement('div');
  breath.id = 'breath-ambient';
  document.body.appendChild(breath);
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Feedback construction', () => {
  it('defaults root to document.body', () => {
    const fb = new Feedback();
    expect(fb.root).toBe(document.body);
  });

  it('defaults breathElement to #breath-ambient', () => {
    const fb = new Feedback();
    expect(fb.breathElement).toBe(breath);
  });

  it('accepts custom root + breathElement', () => {
    const root = document.createElement('div');
    const b2 = document.createElement('div');
    const fb = new Feedback({ root, breathElement: b2 });
    expect(fb.root).toBe(root);
    expect(fb.breathElement).toBe(b2);
  });

  it('does not throw when no breathElement is found', () => {
    breath.remove();
    expect(() => new Feedback()).not.toThrow();
  });

  it('does not throw on construction with no DOM hooks at all', () => {
    expect(() => new Feedback({ root: null, breathElement: null })).not.toThrow();
  });
});

describe('Feedback.wrongClickVignette', () => {
  it('appends a .zen-fb-vignette div to the root', () => {
    const fb = new Feedback();
    fb.wrongClickVignette();
    const els = document.querySelectorAll('.zen-fb-vignette');
    expect(els).toHaveLength(1);
    expect(els[0].getAttribute('aria-hidden')).toBe('true');
    expect(els[0].style.pointerEvents).toBe('none');
  });

  it('auto-removes the element after VIGNETTE_DURATION_MS + ~200ms', () => {
    vi.useFakeTimers();
    try {
      const fb = new Feedback();
      fb.wrongClickVignette();
      expect(document.querySelectorAll('.zen-fb-vignette')).toHaveLength(1);
      vi.advanceTimersByTime(_internal.VIGNETTE_DURATION_MS + 250);
      expect(document.querySelectorAll('.zen-fb-vignette')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disrupts the breath element class for BREATH_DISRUPT_MS', () => {
    vi.useFakeTimers();
    try {
      const fb = new Feedback();
      fb.wrongClickVignette();
      expect(breath.classList.contains('breath-disrupted')).toBe(true);
      vi.advanceTimersByTime(_internal.BREATH_DISRUPT_MS + 50);
      expect(breath.classList.contains('breath-disrupted')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not throw when constructed without DOM hooks (root null collapses to body via ??)', () => {
    // Note: `Feedback({root:null})` actually falls back to document.body via the
    // `??` coalesce in the constructor. The "graceful no-op" path only triggers
    // when document itself is undefined (SSR). We document the actual behavior:
    // construction is safe and effects are still rendered to body.
    const fb = new Feedback({ root: null });
    expect(fb.root).toBe(document.body);
    expect(() => fb.wrongClickVignette()).not.toThrow();
  });

  it('multiple rapid calls each spawn their own vignette', () => {
    const fb = new Feedback();
    fb.wrongClickVignette();
    fb.wrongClickVignette();
    fb.wrongClickVignette();
    expect(document.querySelectorAll('.zen-fb-vignette')).toHaveLength(3);
  });
});

describe('Feedback.wrongClickVignette — reduced motion', () => {
  let originalMatchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    window.matchMedia = (q) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    });
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('vignette still appears (essential feedback) under reduced motion', () => {
    const fb = new Feedback();
    fb.wrongClickVignette();
    expect(document.querySelectorAll('.zen-fb-vignette')).toHaveLength(1);
  });

  it('does NOT add .breath-disrupted class under reduced motion', () => {
    const fb = new Feedback();
    fb.wrongClickVignette();
    expect(breath.classList.contains('breath-disrupted')).toBe(false);
  });
});

describe('Feedback.perfectRoundHalo', () => {
  it('appends a .zen-fb-halo div with halo styles', () => {
    const fb = new Feedback();
    fb.perfectRoundHalo();
    const els = document.querySelectorAll('.zen-fb-halo');
    expect(els).toHaveLength(1);
    const el = els[0];
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.style.pointerEvents).toBe('none');
    expect(el.style.mixBlendMode).toBe('screen');
  });

  it('animates transform from scale(0.85) → scale(HALO_SCALE_END)', () => {
    const fb = new Feedback();
    fb.perfectRoundHalo();
    const el = document.querySelector('.zen-fb-halo');
    // After the synchronous .style.transform = `scale(${HALO_SCALE_END})` line,
    // the inline style holds the end-state value.
    expect(el.style.transform).toBe(`scale(${_internal.HALO_SCALE_END})`);
  });

  it('auto-removes after HALO_DURATION_MS + ~200ms', () => {
    vi.useFakeTimers();
    try {
      const fb = new Feedback();
      fb.perfectRoundHalo();
      expect(document.querySelectorAll('.zen-fb-halo')).toHaveLength(1);
      vi.advanceTimersByTime(_internal.HALO_DURATION_MS + 250);
      expect(document.querySelectorAll('.zen-fb-halo')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not throw when root null collapses to body', () => {
    const fb = new Feedback({ root: null });
    expect(() => fb.perfectRoundHalo()).not.toThrow();
  });
});

describe('Feedback.perfectRoundHalo — reduced motion', () => {
  let originalMatchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    window.matchMedia = (q) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    });
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('skips the scale transform under reduced motion', () => {
    const fb = new Feedback();
    fb.perfectRoundHalo();
    const el = document.querySelector('.zen-fb-halo');
    // Reduced motion path leaves transform at its initial 'scale(1)' value.
    expect(el.style.transform).toBe('scale(1)');
  });
});

describe('Feedback.scoreFloat', () => {
  it('appends a .zen-fb-score with "+points" text', () => {
    const fb = new Feedback();
    fb.scoreFloat(10);
    const el = document.querySelector('.zen-fb-score');
    expect(el).toBeTruthy();
    expect(el.textContent).toBe('+10');
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });

  it('positions above the anchor when one is provided', () => {
    const anchor = document.createElement('div');
    Object.defineProperty(anchor, 'getBoundingClientRect', {
      value: () => ({ left: 100, top: 50, width: 80, height: 20, bottom: 70, right: 180 }),
    });
    document.body.appendChild(anchor);

    const fb = new Feedback();
    fb.scoreFloat(10, anchor);
    const el = document.querySelector('.zen-fb-score');
    // left = anchor.left + width/2 = 140; top = anchor.bottom + 6 = 76
    expect(el.style.left).toBe('140px');
    expect(el.style.top).toBe('76px');
  });

  it('falls back to top-center when no anchor provided', () => {
    const fb = new Feedback();
    fb.scoreFloat(10);
    const el = document.querySelector('.zen-fb-score');
    expect(el.style.left).toBe(`${window.innerWidth / 2}px`);
    expect(el.style.top).toBe('96px');
  });

  it('opts.tone="bonus" applies the bonus modifier class', () => {
    const fb = new Feedback();
    fb.scoreFloat(20, null, { tone: 'bonus' });
    const el = document.querySelector('.zen-fb-score');
    expect(el.className).toContain('zen-fb-score--bonus');
  });

  it('default tone is "positive"', () => {
    const fb = new Feedback();
    fb.scoreFloat(10);
    const el = document.querySelector('.zen-fb-score');
    expect(el.className).toContain('zen-fb-score--positive');
  });

  it('invalid tone falls back to "positive" (no "zen-fb-score--invalid")', () => {
    const fb = new Feedback();
    fb.scoreFloat(10, null, { tone: 'cheating' });
    const el = document.querySelector('.zen-fb-score');
    expect(el.className).toContain('zen-fb-score--positive');
    expect(el.className).not.toContain('zen-fb-score--cheating');
  });

  it('returns silently and adds nothing when points is null', () => {
    const fb = new Feedback();
    fb.scoreFloat(null);
    expect(document.querySelectorAll('.zen-fb-score')).toHaveLength(0);
  });

  it('returns silently when points is undefined', () => {
    const fb = new Feedback();
    fb.scoreFloat(undefined);
    expect(document.querySelectorAll('.zen-fb-score')).toHaveLength(0);
  });

  it('points = 0 still renders ("+0" — explicit zero feedback)', () => {
    const fb = new Feedback();
    fb.scoreFloat(0);
    const el = document.querySelector('.zen-fb-score');
    expect(el).toBeTruthy();
    expect(el.textContent).toBe('+0');
  });

  it('accepts string points', () => {
    const fb = new Feedback();
    fb.scoreFloat('Bonus');
    const el = document.querySelector('.zen-fb-score');
    expect(el.textContent).toBe('+Bonus');
  });

  it('auto-removes after SCORE_FLOAT_DURATION_MS + ~200ms', () => {
    vi.useFakeTimers();
    try {
      const fb = new Feedback();
      fb.scoreFloat(10);
      expect(document.querySelectorAll('.zen-fb-score')).toHaveLength(1);
      vi.advanceTimersByTime(_internal.SCORE_FLOAT_DURATION_MS + 250);
      expect(document.querySelectorAll('.zen-fb-score')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not throw when root null collapses to body', () => {
    const fb = new Feedback({ root: null });
    expect(() => fb.scoreFloat(10)).not.toThrow();
  });
});

describe('Feedback.dispose', () => {
  it('removes lingering vignette/halo/score nodes from the root', () => {
    const fb = new Feedback();
    fb.wrongClickVignette();
    fb.perfectRoundHalo();
    fb.scoreFloat(10);
    expect(document.querySelectorAll('.zen-fb-vignette, .zen-fb-halo, .zen-fb-score'))
      .toHaveLength(3);

    fb.dispose();
    expect(document.querySelectorAll('.zen-fb-vignette, .zen-fb-halo, .zen-fb-score'))
      .toHaveLength(0);
  });

  it('cancels pending timers (no late writes)', () => {
    vi.useFakeTimers();
    try {
      const fb = new Feedback();
      fb.wrongClickVignette();
      fb.dispose();
      // Advance way past every deferred remove — should not crash.
      vi.advanceTimersByTime(5000);
      expect(document.querySelectorAll('.zen-fb-vignette')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes .breath-disrupted class from breathElement', () => {
    const fb = new Feedback();
    fb.wrongClickVignette();
    expect(breath.classList.contains('breath-disrupted')).toBe(true);
    fb.dispose();
    expect(breath.classList.contains('breath-disrupted')).toBe(false);
  });

  it('is idempotent (safe to call twice)', () => {
    const fb = new Feedback();
    fb.wrongClickVignette();
    fb.dispose();
    expect(() => fb.dispose()).not.toThrow();
  });

  it('handles missing root + breathElement gracefully', () => {
    const fb = new Feedback({ root: null, breathElement: null });
    expect(() => fb.dispose()).not.toThrow();
  });
});

describe('Feedback _internal constants', () => {
  it('exposes all tunable constants', () => {
    for (const k of [
      'VIGNETTE_DURATION_MS',
      'VIGNETTE_PEAK_OPACITY',
      'HALO_DURATION_MS',
      'HALO_PEAK_OPACITY',
      'HALO_SCALE_END',
      'SCORE_FLOAT_DURATION_MS',
      'SCORE_FLOAT_RISE_PX',
      'BREATH_DISRUPT_MS',
    ]) {
      expect(_internal).toHaveProperty(k);
    }
  });

  it('halo lingers longer than vignette (UX invariant)', () => {
    expect(_internal.HALO_DURATION_MS).toBeGreaterThan(_internal.VIGNETTE_DURATION_MS);
  });

  it('breath disrupt outlasts vignette so the cue carries through', () => {
    expect(_internal.BREATH_DISRUPT_MS).toBeGreaterThanOrEqual(
      _internal.VIGNETTE_DURATION_MS,
    );
  });

  it('halo scale ends > 1 (the halo expands)', () => {
    expect(_internal.HALO_SCALE_END).toBeGreaterThan(1);
  });

  it('peak opacities are within (0, 1]', () => {
    for (const k of ['VIGNETTE_PEAK_OPACITY', 'HALO_PEAK_OPACITY']) {
      expect(_internal[k]).toBeGreaterThan(0);
      expect(_internal[k]).toBeLessThanOrEqual(1);
    }
  });

  it('_internal is frozen', () => {
    expect(Object.isFrozen(_internal)).toBe(true);
  });
});
