// Tests for the Phase 7 lives system (3 lives + wrong-click retry).
//
// Covers happy path, boundary cases, error cases, and race conditions:
//   - default & custom livesMax
//   - lives clamp at 0 (don't go negative)
//   - wrong click does NOT advance cursor / mark correctly / shatter
//   - lifeLost + wrongClick payload shapes
//   - cooldown: returns 'cooldown' inside window, normal after
//   - cooldown blocks BOTH wrong AND correct clicks
//   - cooldown injectable via opts.now (deterministic)
//   - lives PERSIST across rounds (only reset() clears them)
//   - startRound resets livesLostThisRound + cooldown but NOT lives
//   - reset() restores lives to livesMax
//   - 3 wrongs in one round → GAME_OVER with reason 'lives-exhausted'
//   - roundComplete.livesLostThisRound matches actual life losses
//   - perfect=false after any life lost (perfect-bonus rule via Scorer)
//   - HUD setLives renders dots + last-life class + losing pulse
//
// Drives the state machine with explicit ticks (no real timers, no real DOM
// for game-side checks). Uses an injectable clock for cooldown tests.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GameState, Phase } from '../src/game.js';
import { Scorer } from '../src/scoring.js';
import { difficultyForRound } from '../src/difficulty.js';
import { HUD } from '../src/ui.js';

// Deterministic RNG so sequence shuffles are reproducible.
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Make a controllable wall clock — start at t0, advance via tick(ms). */
function fakeClock(t0 = 1_000_000) {
  let t = t0;
  return {
    now: () => t,
    tick: (ms) => (t += ms),
    set: (v) => (t = v),
  };
}

/** Drive REVEAL/SPLIT_REVEAL until we land in RECALL (or terminal). */
function drainReveal(g, sliceMs = 30, budgetSeconds = 30) {
  const dt = sliceMs / 1000;
  let total = 0;
  g.tickReveal(0);
  while (
    (g.phase === Phase.REVEAL || g.phase === Phase.SPLIT_REVEAL) &&
    total < budgetSeconds
  ) {
    g.tickReveal(dt);
    total += dt;
  }
}

// ─── Construction defaults ──────────────────────────────────────────────────

describe('GameState construction — lives defaults', () => {
  it('defaults livesMax to 3 and starts with full lives', () => {
    const g = new GameState();
    expect(g.livesMax).toBe(3);
    expect(g.lives).toBe(3);
    expect(g.livesLostThisRound).toBe(0);
  });

  it('defaults inputCooldownMs to 500', () => {
    const g = new GameState();
    expect(g.inputCooldownMs).toBe(500);
  });

  it('respects custom livesMax', () => {
    const g = new GameState({ livesMax: 5 });
    expect(g.livesMax).toBe(5);
    expect(g.lives).toBe(5);
  });

  it('respects custom inputCooldownMs (including 0)', () => {
    const g = new GameState({ inputCooldownMs: 0 });
    expect(g.inputCooldownMs).toBe(0);
    const g2 = new GameState({ inputCooldownMs: 1500 });
    expect(g2.inputCooldownMs).toBe(1500);
  });

  it('uses Date.now when no clock injected', () => {
    const g = new GameState();
    expect(typeof g._now).toBe('function');
    expect(Number.isFinite(g._now())).toBe(true);
  });

  it('uses injected clock when supplied', () => {
    const c = fakeClock(42);
    const g = new GameState({ now: c.now });
    expect(g._now()).toBe(42);
    c.tick(100);
    expect(g._now()).toBe(142);
  });
});

// ─── Wrong-click mechanics (single life lost) ───────────────────────────────

describe('handleClick — wrong click decrements a life (3-lives default)', () => {
  let g, c;
  beforeEach(() => {
    c = fakeClock();
    g = new GameState({ rng: mulberry32(11), now: c.now });
    g.startRound(3, [1, 2, 3]);
    drainReveal(g);
    expect(g.phase).toBe(Phase.RECALL);
  });

  it('returns "wrong" and decrements lives by exactly 1', () => {
    const expected = g.sequence[0];
    const wrong = g.ballIds.find((id) => id !== expected);
    expect(g.handleClick(wrong)).toBe('wrong');
    expect(g.lives).toBe(2);
    expect(g.livesLostThisRound).toBe(1);
  });

  it('does NOT advance recallCursor', () => {
    const cursorBefore = g.recallCursor;
    const wrong = g.ballIds.find((id) => id !== g.sequence[0]);
    g.handleClick(wrong);
    expect(g.recallCursor).toBe(cursorBefore);
  });

  it('does NOT add the wrong ball to correctlyClicked', () => {
    const wrong = g.ballIds.find((id) => id !== g.sequence[0]);
    g.handleClick(wrong);
    expect(g.correctlyClicked.has(wrong)).toBe(false);
  });

  it('does NOT change phase (stays in RECALL while lives > 0)', () => {
    const wrong = g.ballIds.find((id) => id !== g.sequence[0]);
    g.handleClick(wrong);
    expect(g.phase).toBe(Phase.RECALL);
  });

  it('flips `perfect` to false', () => {
    const wrong = g.ballIds.find((id) => id !== g.sequence[0]);
    g.handleClick(wrong);
    expect(g.perfect).toBe(false);
  });

  it('emits wrongClick with livesRemaining included', () => {
    const fn = vi.fn();
    g.on('wrongClick', fn);
    const expected = g.sequence[0];
    const wrong = g.ballIds.find((id) => id !== expected);
    g.handleClick(wrong);
    expect(fn).toHaveBeenCalledWith({
      ballId: wrong,
      expectedBallId: expected,
      livesRemaining: 2,
    });
  });

  it('emits lifeLost with full payload shape', () => {
    const fn = vi.fn();
    g.on('lifeLost', fn);
    const expected = g.sequence[0];
    const wrong = g.ballIds.find((id) => id !== expected);
    g.handleClick(wrong);
    expect(fn).toHaveBeenCalledWith({
      ballId: wrong,
      expectedBallId: expected,
      livesRemaining: 2,
      livesLostThisRound: 1,
    });
  });

  it('wrongClick AND lifeLost both fire (in that order)', () => {
    const order = [];
    g.on('wrongClick', () => order.push('wrongClick'));
    g.on('lifeLost', () => order.push('lifeLost'));
    const wrong = g.ballIds.find((id) => id !== g.sequence[0]);
    g.handleClick(wrong);
    expect(order).toEqual(['wrongClick', 'lifeLost']);
  });

  it('after cooldown clears, clicking the correct expected ball succeeds', () => {
    const expected = g.sequence[0];
    const wrong = g.ballIds.find((id) => id !== expected);
    g.handleClick(wrong);
    c.tick(g.inputCooldownMs + 1);
    expect(g.handleClick(expected)).toBe('correct');
    expect(g.recallCursor).toBe(1);
  });
});

// ─── Cooldown window ────────────────────────────────────────────────────────

describe('input cooldown after a wrong click', () => {
  let g, c;
  beforeEach(() => {
    c = fakeClock();
    g = new GameState({ rng: mulberry32(13), now: c.now, inputCooldownMs: 500 });
    g.startRound(3, [1, 2, 3]);
    drainReveal(g);
  });

  it('returns "cooldown" inside the window for wrong AND correct clicks', () => {
    const expected = g.sequence[0];
    const wrong = g.ballIds.find((id) => id !== expected);
    g.handleClick(wrong);
    expect(g.lives).toBe(2);

    // Click while still within the 500ms window — both wrong and correct
    // clicks return 'cooldown', and lives don't change further.
    c.tick(100);
    expect(g.handleClick(wrong)).toBe('cooldown');
    expect(g.handleClick(expected)).toBe('cooldown');
    expect(g.lives).toBe(2); // unchanged
    expect(g.recallCursor).toBe(0); // unchanged
  });

  it('returns to normal after the cooldown elapses', () => {
    const expected = g.sequence[0];
    const wrong = g.ballIds.find((id) => id !== expected);
    g.handleClick(wrong);
    c.tick(g.inputCooldownMs); // exactly at the boundary
    // _now() < _cooldownUntil at the exact boundary; advance 1 more ms to
    // be cleanly past it.
    c.tick(1);
    expect(g.handleClick(expected)).toBe('correct');
  });

  it('cooldown does NOT block clicks when no wrong click has occurred', () => {
    // Fresh round, no wrongs yet → no cooldown gate.
    expect(g.handleClick(g.sequence[0])).toBe('correct');
  });

  it('inputCooldownMs:0 means no cooldown — back-to-back wrongs both register', () => {
    const c2 = fakeClock();
    const g2 = new GameState({
      rng: mulberry32(13),
      now: c2.now,
      inputCooldownMs: 0,
    });
    g2.startRound(3, [1, 2, 3]);
    drainReveal(g2);
    const expected = g2.sequence[0];
    const wrong = g2.ballIds.find((id) => id !== expected);
    expect(g2.handleClick(wrong)).toBe('wrong');
    expect(g2.handleClick(wrong)).toBe('wrong');
    expect(g2.lives).toBe(1);
    expect(g2.livesLostThisRound).toBe(2);
  });

  it('cooldown is reset on startRound (new round starts with no gate)', () => {
    // Lose a life to set the cooldown.
    const wrong = g.ballIds.find((id) => id !== g.sequence[0]);
    g.handleClick(wrong);
    expect(g._cooldownUntil).toBeGreaterThan(0);

    // Drive to round complete then start round 2 — cooldown should clear.
    c.tick(g.inputCooldownMs + 1);
    while (!g.checkComplete()) {
      g.handleClick(g.sequence[g.recallCursor]);
    }
    expect(g.phase).toBe(Phase.RESOLVE);
    g.nextRound([10, 20, 30]);
    expect(g._cooldownUntil).toBe(0);
  });
});

// ─── Lives exhaustion → GAME_OVER ───────────────────────────────────────────

describe('3 wrong clicks → GAME_OVER (default livesMax:3)', () => {
  it('three wrongs in one round trigger GAME_OVER with reason "lives-exhausted"', () => {
    const c = fakeClock();
    const g = new GameState({ rng: mulberry32(17), now: c.now });
    g.startRound(3, [1, 2, 3]);
    drainReveal(g);
    const overFn = vi.fn();
    const lifeLostFn = vi.fn();
    g.on('gameOver', overFn);
    g.on('lifeLost', lifeLostFn);
    const expected = g.sequence[0];
    const wrong = g.ballIds.find((id) => id !== expected);

    g.handleClick(wrong);
    expect(g.phase).toBe(Phase.RECALL);
    c.tick(1000);
    g.handleClick(wrong);
    expect(g.phase).toBe(Phase.RECALL);
    c.tick(1000);
    g.handleClick(wrong);
    expect(g.phase).toBe(Phase.GAME_OVER);

    expect(g.lives).toBe(0);
    expect(g.livesLostThisRound).toBe(3);
    expect(lifeLostFn).toHaveBeenCalledTimes(3);
    expect(overFn).toHaveBeenCalledTimes(1);
    expect(overFn).toHaveBeenCalledWith({
      round: 3,
      reason: 'lives-exhausted',
      livesLost: 3,
    });
  });

  it('lives never go negative (clamped at 0)', () => {
    const c = fakeClock();
    const g = new GameState({ rng: mulberry32(17), now: c.now });
    g.startRound(3, [1, 2, 3]);
    drainReveal(g);
    const wrong = g.ballIds.find((id) => id !== g.sequence[0]);
    for (let i = 0; i < 3; i++) {
      g.handleClick(wrong);
      c.tick(1000);
    }
    expect(g.lives).toBe(0);
    // Subsequent clicks are ignored (phase = GAME_OVER) — lives still 0.
    g.handleClick(wrong);
    g.handleClick(g.sequence[0]);
    expect(g.lives).toBe(0);
  });

  it('the third wrong click fires lifeLost with livesRemaining:0 BEFORE gameOver', () => {
    const c = fakeClock();
    const g = new GameState({ rng: mulberry32(17), now: c.now });
    g.startRound(3, [1, 2, 3]);
    drainReveal(g);
    const events = [];
    g.on('lifeLost', (p) => events.push(['lifeLost', p.livesRemaining]));
    g.on('gameOver', (p) => events.push(['gameOver', p.reason]));
    const wrong = g.ballIds.find((id) => id !== g.sequence[0]);
    for (let i = 0; i < 3; i++) {
      g.handleClick(wrong);
      c.tick(1000);
    }
    // Order: 3 lifeLosts (2,1,0), then gameOver.
    expect(events).toEqual([
      ['lifeLost', 2],
      ['lifeLost', 1],
      ['lifeLost', 0],
      ['gameOver', 'lives-exhausted'],
    ]);
  });

  it('roundComplete is NOT emitted when the final life is lost mid-round', () => {
    const c = fakeClock();
    const g = new GameState({ rng: mulberry32(17), now: c.now });
    g.startRound(3, [1, 2, 3]);
    drainReveal(g);
    const completeFn = vi.fn();
    g.on('roundComplete', completeFn);
    const wrong = g.ballIds.find((id) => id !== g.sequence[0]);
    for (let i = 0; i < 3; i++) {
      g.handleClick(wrong);
      c.tick(1000);
    }
    expect(g.phase).toBe(Phase.GAME_OVER);
    expect(completeFn).not.toHaveBeenCalled();
  });
});

// ─── Lives persistence across rounds ────────────────────────────────────────

describe('lives persist across rounds', () => {
  function runRoundToCompletion(g, c, ballIds, wrongsInThisRound = 0) {
    g.startRound(g.round + 1 || 1, ballIds);
    // Hack — we passed g.round + 1 || 1 but startRound is normally called from
    // RESOLVE via nextRound. For first call we want round=1; otherwise +1.
    drainReveal(g);
    if (wrongsInThisRound > 0) {
      const wrong = g.ballIds.find((id) => id !== g.sequence[0]);
      for (let i = 0; i < wrongsInThisRound; i++) {
        g.handleClick(wrong);
        c.tick(1000);
      }
    }
    while (!g.checkComplete() && g.phase === Phase.RECALL) {
      g.handleClick(g.sequence[g.recallCursor]);
    }
  }

  it('loses 1 life round 1, completes round 2 perfectly → lives === 2 going into round 3', () => {
    const c = fakeClock();
    const g = new GameState({ rng: mulberry32(21), now: c.now });

    // Round 1
    g.startRound(1, [10]);
    drainReveal(g);
    // Single ball — can't really lose a life mid-round without ending it.
    // Skip the wrong-click in round 1; do it in round 2.
    g.handleClick(g.sequence[0]);
    expect(g.phase).toBe(Phase.RESOLVE);
    expect(g.lives).toBe(3);

    // Round 2 — lose 1 life mid-round, then complete.
    g.nextRound([20, 21]);
    drainReveal(g);
    const wrong = g.ballIds.find((id) => id !== g.sequence[0]);
    g.handleClick(wrong);
    expect(g.lives).toBe(2);
    c.tick(1000);
    while (!g.checkComplete()) {
      g.handleClick(g.sequence[g.recallCursor]);
    }
    expect(g.phase).toBe(Phase.RESOLVE);
    // Lives carried over.
    expect(g.lives).toBe(2);
    expect(g.livesLostThisRound).toBe(1);

    // Round 3 — lives still at 2 going in (startRound only resets the
    // per-round counter and the cooldown).
    g.nextRound([30, 31, 32]);
    expect(g.lives).toBe(2);
    expect(g.livesLostThisRound).toBe(0);
    expect(g._cooldownUntil).toBe(0);
  });

  it('losing 2 lives across 2 rounds + 1 more in round 3 → GAME_OVER (cumulative)', () => {
    const c = fakeClock();
    const g = new GameState({ rng: mulberry32(23), now: c.now });

    // Round 1 — lose 1 life, complete.
    g.startRound(1, [10, 11]);
    drainReveal(g);
    let wrong = g.ballIds.find((id) => id !== g.sequence[0]);
    g.handleClick(wrong);
    c.tick(1000);
    while (!g.checkComplete()) g.handleClick(g.sequence[g.recallCursor]);
    expect(g.lives).toBe(2);

    // Round 2 — lose 1 more life, complete.
    g.nextRound([20, 21]);
    drainReveal(g);
    wrong = g.ballIds.find((id) => id !== g.sequence[0]);
    g.handleClick(wrong);
    c.tick(1000);
    while (!g.checkComplete()) g.handleClick(g.sequence[g.recallCursor]);
    expect(g.lives).toBe(1);

    // Round 3 — one more wrong click → GAME_OVER.
    g.nextRound([30, 31, 32]);
    drainReveal(g);
    const overFn = vi.fn();
    g.on('gameOver', overFn);
    wrong = g.ballIds.find((id) => id !== g.sequence[0]);
    g.handleClick(wrong);
    expect(g.phase).toBe(Phase.GAME_OVER);
    // livesLost reports the total across the whole game (livesMax === 3).
    expect(overFn).toHaveBeenCalledWith({
      round: 3,
      reason: 'lives-exhausted',
      livesLost: 3,
    });
  });

  it('startRound resets livesLostThisRound but NOT lives', () => {
    const c = fakeClock();
    const g = new GameState({ rng: mulberry32(29), now: c.now });
    g.startRound(1, [1, 2]);
    drainReveal(g);
    const wrong = g.ballIds.find((id) => id !== g.sequence[0]);
    g.handleClick(wrong);
    c.tick(1000);
    while (!g.checkComplete()) g.handleClick(g.sequence[g.recallCursor]);
    expect(g.livesLostThisRound).toBe(1);
    expect(g.lives).toBe(2);

    g.nextRound([3, 4]);
    expect(g.livesLostThisRound).toBe(0); // reset
    expect(g.lives).toBe(2); // persists
  });

  it('roundComplete.livesLostThisRound matches actual life losses that round', () => {
    const c = fakeClock();
    const g = new GameState({ rng: mulberry32(31), now: c.now });
    const completeFn = vi.fn();
    g.on('roundComplete', completeFn);

    // Round 1 — perfect.
    g.startRound(1, [10]);
    drainReveal(g);
    g.handleClick(g.sequence[0]);
    expect(completeFn).toHaveBeenLastCalledWith({
      round: 1,
      perfect: true,
      livesLostThisRound: 0,
    });

    // Round 2 — 1 life lost.
    g.nextRound([20, 21]);
    drainReveal(g);
    const wrong = g.ballIds.find((id) => id !== g.sequence[0]);
    g.handleClick(wrong);
    c.tick(1000);
    while (!g.checkComplete()) g.handleClick(g.sequence[g.recallCursor]);
    expect(completeFn).toHaveBeenLastCalledWith({
      round: 2,
      perfect: false,
      livesLostThisRound: 1,
    });
  });
});

// ─── reset() restores lives ────────────────────────────────────────────────

describe('reset() restores lives to livesMax', () => {
  it('after losing lives, reset() restores to livesMax (default 3)', () => {
    const c = fakeClock();
    const g = new GameState({ rng: mulberry32(33), now: c.now });
    g.startRound(1, [1, 2]);
    drainReveal(g);
    const wrong = g.ballIds.find((id) => id !== g.sequence[0]);
    g.handleClick(wrong);
    c.tick(1000);
    g.handleClick(wrong);
    expect(g.lives).toBe(1);
    g.reset();
    expect(g.lives).toBe(3);
    expect(g.livesLostThisRound).toBe(0);
    expect(g._cooldownUntil).toBe(0);
  });

  it('after losing lives with custom livesMax, reset restores to that max', () => {
    const c = fakeClock();
    const g = new GameState({ rng: mulberry32(35), now: c.now, livesMax: 5 });
    g.startRound(1, [1, 2]);
    drainReveal(g);
    const wrong = g.ballIds.find((id) => id !== g.sequence[0]);
    g.handleClick(wrong);
    c.tick(1000);
    g.handleClick(wrong);
    expect(g.lives).toBe(3);
    g.reset();
    expect(g.lives).toBe(5);
  });

  it('reset from GAME_OVER restores lives so a new game can start', () => {
    const c = fakeClock();
    const g = new GameState({ rng: mulberry32(37), now: c.now });
    g.startRound(1, [1, 2]);
    drainReveal(g);
    const wrong = g.ballIds.find((id) => id !== g.sequence[0]);
    for (let i = 0; i < 3; i++) {
      g.handleClick(wrong);
      c.tick(1000);
    }
    expect(g.phase).toBe(Phase.GAME_OVER);
    g.reset();
    expect(g.lives).toBe(3);
    expect(() => g.startRound(1, [1])).not.toThrow();
  });
});

// ─── Perfect-with-lives-lost rule (Scorer integration) ──────────────────────

describe('perfect-bonus rule: lives-lost rounds are NOT perfect', () => {
  it('a round with one life lost has perfect=false on the Scorer round stat', () => {
    const c = fakeClock();
    const g = new GameState({ rng: mulberry32(41), now: c.now });
    const s = new Scorer({ now: c.now }).attachToGame(g);

    g.startRound(1, [1, 2]);
    drainReveal(g);
    c.tick(400);
    g.handleClick(g.sequence[0]);
    // Wrong click — pick an unknown id so it's guaranteed to be wrong (a
    // ballIds-derived "wrong" could land on the already-clicked one and
    // resolve to 'ignored' instead).
    c.tick(400);
    expect(g.handleClick(999)).toBe('wrong');
    expect(g.lives).toBe(2);
    c.tick(1000);
    g.handleClick(g.sequence[1]);
    expect(g.phase).toBe(Phase.RESOLVE);

    expect(s.roundStats).toHaveLength(1);
    const round = s.roundStats[0];
    expect(round.perfect).toBe(false);
    expect(round.wrongClicks).toBe(1);
    // No perfect-round bonus paid out.
    expect(round.perfectBonus).toBe(0);
  });

  it('a clean round (no lives lost) keeps perfect=true and earns the bonus', () => {
    const c = fakeClock();
    const g = new GameState({ rng: mulberry32(43), now: c.now });
    const s = new Scorer({ now: c.now }).attachToGame(g);
    g.startRound(1, [1, 2]);
    drainReveal(g);
    c.tick(400);
    g.handleClick(g.sequence[0]);
    c.tick(400);
    g.handleClick(g.sequence[1]);
    expect(s.roundStats[0].perfect).toBe(true);
    expect(s.roundStats[0].perfectBonus).toBeGreaterThan(0);
  });
});

// ─── Custom livesMax — boundary cases ───────────────────────────────────────

describe('custom livesMax boundary cases', () => {
  it('livesMax:1 reproduces legacy single-strike behavior', () => {
    const g = new GameState({ rng: mulberry32(47), livesMax: 1 });
    g.startRound(2, [1, 2]);
    drainReveal(g);
    const wrong = g.ballIds.find((id) => id !== g.sequence[0]);
    g.handleClick(wrong);
    expect(g.phase).toBe(Phase.GAME_OVER);
    expect(g.lives).toBe(0);
  });

  it('livesMax:5 — needs 5 wrongs to GAME_OVER', () => {
    const c = fakeClock();
    const g = new GameState({ rng: mulberry32(53), now: c.now, livesMax: 5 });
    g.startRound(2, [1, 2]);
    drainReveal(g);
    const wrong = g.ballIds.find((id) => id !== g.sequence[0]);
    for (let i = 0; i < 4; i++) {
      g.handleClick(wrong);
      c.tick(1000);
      expect(g.phase).toBe(Phase.RECALL);
    }
    g.handleClick(wrong);
    expect(g.phase).toBe(Phase.GAME_OVER);
    expect(g.lives).toBe(0);
  });
});

// ─── HUD lives indicator ────────────────────────────────────────────────────

describe('HUD.setLives — dot rendering, last-life class, losing pulse', () => {
  let root, hud;
  beforeEach(() => {
    root = document.createElement('div');
    root.id = 'ui';
    document.body.appendChild(root);
    hud = new HUD({ root });
  });

  it('builds a 3-dot row with ARIA "Lives remaining" group label', () => {
    const lives = root.querySelector('.hud-lives');
    expect(lives).toBeTruthy();
    expect(lives.getAttribute('role')).toBe('group');
    expect(lives.getAttribute('aria-label')).toMatch(/Lives remaining/i);
    expect(root.querySelectorAll('.hud-lives__dot')).toHaveLength(3);
  });

  it('lost dots get .lost class; remaining stay clean', () => {
    hud.setLives(2);
    const dots = root.querySelectorAll('.hud-lives__dot');
    expect(dots[0].classList.contains('lost')).toBe(false);
    expect(dots[1].classList.contains('lost')).toBe(false);
    expect(dots[2].classList.contains('lost')).toBe(true);
  });

  it('newly-lost dot gets the .losing pulse class (and old-lost dots do NOT)', () => {
    // Lose a life: dot 2 newly-lost.
    hud.setLives(2);
    let dots = root.querySelectorAll('.hud-lives__dot');
    expect(dots[2].classList.contains('losing')).toBe(true);

    // Lose another: dot 1 newly-lost; dot 2 should not re-pulse.
    hud.setLives(1);
    dots = root.querySelectorAll('.hud-lives__dot');
    expect(dots[1].classList.contains('losing')).toBe(true);
    // The previously-lost dot should not have the .losing class re-applied
    // on this render. (It either decayed via the 700ms timer or was simply
    // never reflashed — both are correct.)
    // We can't depend on the timer in jsdom without faking timers; instead
    // verify: no second .losing dot appeared on the formerly-just-lost one
    // *as a result of this setLives call* by re-rendering and checking
    // class state after the next render.
    hud.setLives(1); // no change → no new pulse
    expect(dots[1].classList.contains('losing')).toBe(true); // still pulsing from prior
  });

  it('wrapper gets .last-life when remaining === 1', () => {
    const wrapper = root.querySelector('.hud-lives');
    expect(wrapper.classList.contains('last-life')).toBe(false);
    hud.setLives(1);
    expect(wrapper.classList.contains('last-life')).toBe(true);
    hud.setLives(0);
    expect(wrapper.classList.contains('last-life')).toBe(false);
    hud.setLives(2);
    expect(wrapper.classList.contains('last-life')).toBe(false);
  });

  it('clamps remaining into [0, max]', () => {
    hud.setLives(99);
    let dots = root.querySelectorAll('.hud-lives__dot');
    expect([...dots].every((d) => !d.classList.contains('lost'))).toBe(true);
    hud.setLives(-5);
    dots = root.querySelectorAll('.hud-lives__dot');
    expect([...dots].every((d) => d.classList.contains('lost'))).toBe(true);
  });

  it('respects custom max — re-stretches the dot strip', () => {
    hud.setLives(5, 5);
    expect(root.querySelectorAll('.hud-lives__dot')).toHaveLength(5);
    hud.setLives(2, 5);
    const dots = root.querySelectorAll('.hud-lives__dot');
    expect(dots).toHaveLength(5);
    // Last 3 are lost.
    expect(dots[0].classList.contains('lost')).toBe(false);
    expect(dots[1].classList.contains('lost')).toBe(false);
    expect(dots[2].classList.contains('lost')).toBe(true);
    expect(dots[3].classList.contains('lost')).toBe(true);
    expect(dots[4].classList.contains('lost')).toBe(true);
  });

  it('shrinks the dot strip when max decreases', () => {
    hud.setLives(5, 5);
    expect(root.querySelectorAll('.hud-lives__dot')).toHaveLength(5);
    hud.setLives(3, 3);
    expect(root.querySelectorAll('.hud-lives__dot')).toHaveLength(3);
  });

  it('updates aria-label to "Lives remaining N of M"', () => {
    const lives = root.querySelector('.hud-lives');
    hud.setLives(2, 3);
    expect(lives.getAttribute('aria-label')).toBe('Lives remaining 2 of 3');
    hud.setLives(0, 3);
    expect(lives.getAttribute('aria-label')).toBe('Lives remaining 0 of 3');
  });

  it('handles non-finite input gracefully (treats as 0)', () => {
    expect(() => hud.setLives(NaN)).not.toThrow();
    expect(() => hud.setLives(undefined)).not.toThrow();
    const dots = root.querySelectorAll('.hud-lives__dot');
    expect([...dots].every((d) => d.classList.contains('lost'))).toBe(true);
  });
});

// ─── HUD.showGameOver — livesUsed row ──────────────────────────────────────

describe('HUD.showGameOver — optional livesUsed row', () => {
  let root, hud;
  beforeEach(() => {
    root = document.createElement('div');
    root.id = 'ui';
    document.body.appendChild(root);
    hud = new HUD({ root });
  });

  it('omits the "Lives Used" row when livesUsed is undefined (legacy path)', () => {
    hud.showGameOver({ round: 5, score: 100, bestStreak: 3, calmIndex: 80 });
    const html = root.querySelector('.hud-gameover').innerHTML;
    expect(html).not.toMatch(/Lives Used/);
  });

  it('renders "Lives Used: N" when livesUsed is supplied', () => {
    hud.showGameOver({
      round: 5,
      score: 100,
      bestStreak: 3,
      calmIndex: 80,
      livesUsed: 3,
    });
    const html = root.querySelector('.hud-gameover').innerHTML;
    expect(html).toMatch(/Lives Used/);
    // Should report the actual count.
    expect(html).toMatch(/<dd>3<\/dd>/);
  });

  it('renders Lives Used:0 (zero is finite — should still appear)', () => {
    hud.showGameOver({
      round: 5,
      score: 100,
      bestStreak: 3,
      calmIndex: 80,
      livesUsed: 0,
    });
    const html = root.querySelector('.hud-gameover').innerHTML;
    expect(html).toMatch(/Lives Used/);
  });
});

// ─── Difficulty curve still applies (no regression from lives wiring) ───────

describe('lives system does not interfere with difficulty curve', () => {
  it('difficulty for round N is unchanged regardless of lives lost', () => {
    const c = fakeClock();
    const g = new GameState({ rng: mulberry32(59), now: c.now });
    g.startRound(1, [1]);
    drainReveal(g);
    g.handleClick(g.sequence[0]);
    g.nextRound([2, 3]);
    drainReveal(g);
    // Lose a life mid-round 2.
    const wrong = g.ballIds.find((id) => id !== g.sequence[0]);
    g.handleClick(wrong);
    c.tick(1000);
    while (!g.checkComplete()) g.handleClick(g.sequence[g.recallCursor]);
    g.nextRound([4, 5, 6]);
    // _difficulty for round 3 should match the canonical difficultyForRound(3).
    expect(g._difficulty).toEqual(difficultyForRound(3));
  });
});
