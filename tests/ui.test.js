// Tests for src/ui.js — HUD vanilla-DOM module.
//
// jsdom provides DOM. We construct a #ui root, hand it to HUD, and assert on
// the resulting DOM tree. Animations (requestAnimationFrame, setTimeout fade)
// are kept short or skipped since they're cosmetic — the structural
// guarantees (visibility, text content, ARIA) are what we lock in.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HUD } from '../src/ui.js';

let root;

beforeEach(() => {
  root = document.createElement('div');
  root.id = 'ui';
  document.body.appendChild(root);
});

afterEach(() => {
  root.remove();
});

describe('HUD construction', () => {
  it('throws when no root is provided and #ui is absent', () => {
    root.remove();
    expect(() => new HUD({})).toThrow(/root/i);
    document.body.appendChild(root); // restore for afterEach
  });

  it('falls back to document.getElementById("ui") when no root is passed', () => {
    expect(() => new HUD()).not.toThrow();
  });

  it('builds the expected structural elements', () => {
    new HUD({ root });
    expect(root.querySelector('.hud-top')).toBeTruthy();
    expect(root.querySelector('.hud-hint')).toBeTruthy();
    expect(root.querySelector('.hud-calm')).toBeTruthy();
    expect(root.querySelector('.hud-level')).toBeTruthy();
    expect(root.querySelector('.hud-gameover')).toBeTruthy();
  });

  it('builds three pills: Round, Score, Streak', () => {
    new HUD({ root });
    const pills = root.querySelectorAll('.hud-pill');
    expect(pills).toHaveLength(3);
    const kinds = [...pills].map((p) => p.dataset.kind);
    expect(kinds).toEqual(['round', 'score', 'streak']);
  });

  it('initial pill values are sensible defaults', () => {
    new HUD({ root });
    const vals = [...root.querySelectorAll('.hud-pill__value')].map(
      (n) => n.textContent,
    );
    expect(vals).toEqual(['1', '0', '0']);
  });

  it('hint defaults to the spec phrase', () => {
    new HUD({ root });
    expect(root.querySelector('.hud-hint').textContent).toBe(
      'Memorise · Recall · Repeat',
    );
  });

  it('Game-Over panel is hidden initially', () => {
    new HUD({ root });
    const go = root.querySelector('.hud-gameover');
    expect(go.hidden).toBe(true);
  });

  it('clears the root before building (re-init safe)', () => {
    root.appendChild(document.createElement('p')); // pre-existing junk
    new HUD({ root });
    expect(root.querySelector('p')).toBeNull();
    expect(root.querySelector('.hud-top')).toBeTruthy();
  });

  it('adds the .hud class to the root', () => {
    new HUD({ root });
    expect(root.classList.contains('hud')).toBe(true);
  });
});

describe('HUD setters update DOM', () => {
  let hud;
  beforeEach(() => {
    hud = new HUD({ root });
  });

  it('setRound updates the Round pill AND the bottom-right level text', () => {
    hud.setRound(7);
    const pillVal = root.querySelector('.hud-pill[data-kind="round"] .hud-pill__value');
    expect(pillVal.textContent).toBe('7');
    expect(root.querySelector('.hud-level').textContent).toBe('Level 7');
  });

  it('setScore updates the Score pill', () => {
    hud.setScore(1234);
    const pillVal = root.querySelector('.hud-pill[data-kind="score"] .hud-pill__value');
    expect(pillVal.textContent).toBe('1234');
  });

  it('setStreak updates the Streak pill', () => {
    hud.setStreak(5);
    const pillVal = root.querySelector('.hud-pill[data-kind="streak"] .hud-pill__value');
    expect(pillVal.textContent).toBe('5');
  });

  it('setting the same value twice does not flicker (no-op on equal)', () => {
    hud.setScore(50);
    const pillVal = root.querySelector('.hud-pill[data-kind="score"] .hud-pill__value');
    pillVal.classList.remove('pulsing');
    hud.setScore(50);
    expect(pillVal.classList.contains('pulsing')).toBe(false);
  });

  it('aria-label on each pill includes the value', () => {
    hud.setScore(99);
    const pill = root.querySelector('.hud-pill[data-kind="score"]');
    expect(pill.getAttribute('aria-label')).toBe('Score 99');
  });

  it('setCalm updates fill width, value text, and aria-valuenow', () => {
    hud.setCalm(73, { name: 'Leaf', emoji: '🌿' });
    const fill = root.querySelector('.hud-calm__fill');
    expect(fill.style.width).toBe('73%');
    const valueEl = root.querySelector('.hud-calm__value');
    expect(valueEl.textContent).toBe('73');
    const tierEl = root.querySelector('.hud-calm__tier');
    expect(tierEl.textContent).toBe('🌿');
    const bar = root.querySelector('.hud-calm__bar');
    expect(bar.getAttribute('aria-valuenow')).toBe('73');
    expect(bar.getAttribute('aria-valuetext')).toBe('73 (Leaf)');
  });

  it('setCalm clamps out-of-range values to [0, 100]', () => {
    hud.setCalm(150, { name: 'Blossom', emoji: '🌸' });
    expect(root.querySelector('.hud-calm__fill').style.width).toBe('100%');

    hud.setCalm(-20, { name: 'Seedling', emoji: '🌾' });
    expect(root.querySelector('.hud-calm__fill').style.width).toBe('0%');
  });

  it('setCalm rounds non-integer values', () => {
    hud.setCalm(73.7, { name: 'Leaf', emoji: '🌿' });
    expect(root.querySelector('.hud-calm__value').textContent).toBe('74');
  });

  it('setCalm without tier still updates the value and bar', () => {
    hud.setCalm(50);
    expect(root.querySelector('.hud-calm__value').textContent).toBe('50');
    expect(root.querySelector('.hud-calm__bar').getAttribute('aria-valuenow')).toBe('50');
  });

  it('setHint cross-fades and eventually shows the new text', async () => {
    vi.useFakeTimers();
    try {
      hud.setHint('Recall');
      // Mid-fade — old text still showing
      vi.advanceTimersByTime(100);
      // After full fade duration the new text is in.
      vi.advanceTimersByTime(400);
      expect(root.querySelector('.hud-hint').textContent).toBe('Recall');
    } finally {
      vi.useRealTimers();
    }
  });

  it('setHint with same text is a no-op', () => {
    const initial = root.querySelector('.hud-hint').textContent;
    hud.setHint(initial);
    expect(root.querySelector('.hud-hint').textContent).toBe(initial);
  });

  it('setHint with empty/null does nothing', () => {
    const initial = root.querySelector('.hud-hint').textContent;
    hud.setHint('');
    hud.setHint(null);
    hud.setHint(undefined);
    expect(root.querySelector('.hud-hint').textContent).toBe(initial);
  });
});

describe('HUD applyScoreSnapshot', () => {
  it('updates score and streak from a Scorer-style snapshot', () => {
    const hud = new HUD({ root });
    hud.applyScoreSnapshot({ totalScore: 250, streak: 3 });
    expect(
      root.querySelector('.hud-pill[data-kind="score"] .hud-pill__value').textContent,
    ).toBe('250');
    expect(
      root.querySelector('.hud-pill[data-kind="streak"] .hud-pill__value').textContent,
    ).toBe('3');
  });
});

describe('HUD Game-Over modal', () => {
  let hud;
  beforeEach(() => {
    hud = new HUD({ root });
  });

  it('showGameOver un-hides the panel and renders stats', () => {
    hud.showGameOver({
      round: 5,
      score: 420,
      bestStreak: 4,
      calmIndex: 76,
      tier: { name: 'Leaf', emoji: '🌿' },
    });
    const go = root.querySelector('.hud-gameover');
    expect(go.hidden).toBe(false);
    expect(go.innerHTML).toMatch(/420/);
    expect(go.innerHTML).toMatch(/76/);
    expect(go.innerHTML).toMatch(/🌿/);
    expect(go.innerHTML).toMatch(/Leaf/);
    expect(go.innerHTML).toMatch(/Best Streak/);
  });

  it('Play Again button fires the callback then hides the panel', () => {
    const cb = vi.fn();
    hud.showGameOver(
      { round: 1, score: 10, bestStreak: 0, calmIndex: 5, tier: ZEN_SEEDLING },
      cb,
    );
    const btn = root.querySelector('.hud-gameover button');
    expect(btn).toBeTruthy();
    btn.click();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.hud-gameover').hidden).toBe(true);
  });

  it('hideGameOver hides the panel directly', () => {
    hud.showGameOver(
      { round: 1, score: 10, bestStreak: 0, calmIndex: 5, tier: ZEN_SEEDLING },
      () => {},
    );
    hud.hideGameOver();
    expect(root.querySelector('.hud-gameover').hidden).toBe(true);
  });

  it('renders sensibly when tier is omitted', () => {
    hud.showGameOver({
      round: 3,
      score: 100,
      bestStreak: 1,
      calmIndex: 42,
    });
    const go = root.querySelector('.hud-gameover');
    expect(go.hidden).toBe(false);
    expect(go.innerHTML).toMatch(/42/);
  });
});

const ZEN_SEEDLING = { name: 'Seedling', emoji: '🌾' };

describe('HUD destroy', () => {
  it('clears the root and removes the .hud class', () => {
    const hud = new HUD({ root });
    expect(root.children.length).toBeGreaterThan(0);
    hud.destroy();
    expect(root.children.length).toBe(0);
    expect(root.classList.contains('hud')).toBe(false);
  });

  it('clears any pending hint timer (no late writes after destroy)', () => {
    vi.useFakeTimers();
    try {
      const hud = new HUD({ root });
      hud.setHint('Recall'); // schedules a setTimeout
      hud.destroy();
      // Advance past the fade — the timeout should not write to a freed DOM.
      vi.advanceTimersByTime(1000);
      // Root remains empty after destroy.
      expect(root.children.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('HUD scoreAnchor', () => {
  it('returns a non-null DOM node anchored on the score pill', () => {
    const hud = new HUD({ root });
    const anchor = hud.scoreAnchor();
    expect(anchor).toBeTruthy();
    // Anchor lives inside the score pill.
    const scorePill = root.querySelector('.hud-pill[data-kind="score"]');
    expect(scorePill.contains(anchor)).toBe(true);
  });
});

// ─── Phase 6 polish: ARIA + entrance/pulse class lifecycle ─────────────────

describe('HUD ARIA — accessibility surface', () => {
  let hud;
  beforeEach(() => {
    hud = new HUD({ root });
  });

  it('top pill row has role=group + aria-label="Game status"', () => {
    const top = root.querySelector('.hud-top');
    expect(top.getAttribute('role')).toBe('group');
    expect(top.getAttribute('aria-label')).toBe('Game status');
  });

  it('Calm group has role=group + aria-label="Calm Index"', () => {
    const calm = root.querySelector('.hud-calm');
    expect(calm.getAttribute('role')).toBe('group');
    expect(calm.getAttribute('aria-label')).toBe('Calm Index');
  });

  it('Calm bar has role=progressbar + aria-valuemin/max', () => {
    const bar = root.querySelector('.hud-calm__bar');
    expect(bar.getAttribute('role')).toBe('progressbar');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(bar.getAttribute('aria-valuenow')).toBe('0'); // initial
  });

  it('phase hint has aria-live=polite + aria-atomic=true', () => {
    const hint = root.querySelector('.hud-hint');
    expect(hint.getAttribute('aria-live')).toBe('polite');
    expect(hint.getAttribute('aria-atomic')).toBe('true');
  });

  it('decorative tier emoji is aria-hidden=true', () => {
    const tier = root.querySelector('.hud-calm__tier');
    expect(tier.getAttribute('aria-hidden')).toBe('true');
  });

  it('.hud-level is aria-hidden (avoids double-announce with Round pill)', () => {
    const level = root.querySelector('.hud-level');
    expect(level.getAttribute('aria-hidden')).toBe('true');
  });

  it('Game-Over panel uses role=dialog + aria-modal when shown', () => {
    hud.showGameOver(
      { round: 1, score: 10, bestStreak: 0, calmIndex: 5 },
      () => {},
    );
    const dlg = root.querySelector('.hud-gameover__panel');
    expect(dlg.getAttribute('role')).toBe('dialog');
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(dlg.getAttribute('aria-labelledby')).toBe('gover-title');
  });

  it('Play Again button has aria-label and autofocus', () => {
    hud.showGameOver(
      { round: 1, score: 10, bestStreak: 0, calmIndex: 5 },
      () => {},
    );
    const btn = root.querySelector('.hud-gameover button');
    expect(btn.getAttribute('aria-label')).toBe('Play again');
    expect(btn.hasAttribute('autofocus')).toBe(true);
  });
});

describe('HUD pulse + entrance class lifecycle', () => {
  let hud;
  beforeEach(() => {
    hud = new HUD({ root });
  });

  it('pill value gets .pulsing class when value changes from a previously-seen value', () => {
    // First setScore primes _lastValues.score (no pulse yet — anti-boot-flash).
    hud.setScore(50);
    const pillVal = root.querySelector('.hud-pill[data-kind="score"] .hud-pill__value');
    pillVal.classList.remove('pulsing'); // baseline clean
    // Second setScore triggers the pulse on real value change.
    hud.setScore(60);
    expect(pillVal.classList.contains('pulsing')).toBe(true);
  });

  it('first-ever set does NOT pulse (avoids boot-time flash)', () => {
    // setRound has not been called yet; default value '1' was set during _build,
    // and _lastValues.round is null. The first call's pulse is suppressed.
    hud.setScore(99); // first non-default change
    const pillVal = root.querySelector('.hud-pill[data-kind="score"] .hud-pill__value');
    expect(pillVal.classList.contains('pulsing')).toBe(false);
  });

  it('tier emoji gets .pulsing class on tier CHANGE', () => {
    hud.setCalm(20, { name: 'Seedling', emoji: '🌾' }); // first call
    const tier = root.querySelector('.hud-calm__tier');
    tier.classList.remove('pulsing');
    hud.setCalm(70, { name: 'Leaf', emoji: '🌿' });
    expect(tier.classList.contains('pulsing')).toBe(true);
    expect(tier.textContent).toBe('🌿');
  });

  it('tier emoji does NOT re-pulse on same-tier setCalm calls', () => {
    hud.setCalm(50, { name: 'Marker', emoji: '⛳' });
    const tier = root.querySelector('.hud-calm__tier');
    tier.classList.remove('pulsing');
    hud.setCalm(55, { name: 'Marker', emoji: '⛳' });
    expect(tier.classList.contains('pulsing')).toBe(false);
  });

  it('showGameOver applies .entering class then panel becomes visible', () => {
    hud.showGameOver(
      { round: 1, score: 10, bestStreak: 0, calmIndex: 5 },
      () => {},
    );
    const go = root.querySelector('.hud-gameover');
    // Visible immediately (hidden=false).
    expect(go.hidden).toBe(false);
    // .entering class applied for the CSS transition staging.
    expect(go.classList.contains('entering')).toBe(true);
  });

  it('hideGameOver strips .entering and re-hides', () => {
    hud.showGameOver(
      { round: 1, score: 10, bestStreak: 0, calmIndex: 5 },
      () => {},
    );
    hud.hideGameOver();
    const go = root.querySelector('.hud-gameover');
    expect(go.hidden).toBe(true);
    expect(go.classList.contains('entering')).toBe(false);
  });
});
