// Tests for src/scoring.js — Scorer state machine + scoring formula.
//
// Uses an injected `now` clock to make reaction-time logic deterministic.
// No DOM, no Three.js.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Scorer, POINTS } from '../src/scoring.js';
import { Emitter } from '../src/events.js';

// Manual clock — push it forward via `clock.tick(ms)`.
function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    tick(ms) {
      t += ms;
    },
    set(v) {
      t = v;
    },
  };
}

describe('POINTS constants', () => {
  it('matches spec §5 base values', () => {
    expect(POINTS.PRIMARY).toBe(10);
    expect(POINTS.SPLIT_BALL).toBe(20);
    expect(POINTS.PERFECT_BONUS).toBe(50);
    expect(POINTS.SPEED_BONUS_PCT).toBeCloseTo(0.3);
    expect(POINTS.MAX_MULTIPLIER).toBeCloseTo(2.0);
    expect(POINTS.COMBO_PER_STREAK).toBeCloseTo(0.1);
    expect(POINTS.SPEED_THRESHOLD_MS).toBe(700);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(POINTS)).toBe(true);
  });
});

describe('Scorer construction + reset', () => {
  it('initialises everything to zero', () => {
    const s = new Scorer();
    expect(s.totalScore).toBe(0);
    expect(s.streak).toBe(0);
    expect(s.bestStreak).toBe(0);
    expect(s.roundsPlayed).toBe(0);
    expect(s.roundStats).toEqual([]);
  });

  it('reset() zeroes bestStreak too (full session reset)', () => {
    const c = makeClock();
    const s = new Scorer({ now: c.now });
    s.beginRound(1);
    s.registerCorrectClick({ depth: 0 });
    s.finishRound();
    expect(s.bestStreak).toBe(1);
    s.reset();
    expect(s.bestStreak).toBe(0);
    expect(s.totalScore).toBe(0);
    expect(s.streak).toBe(0);
  });
});

describe('Scorer.beginRound + getHudSnapshot', () => {
  it('emits roundBegan with the round number', () => {
    const s = new Scorer();
    const fn = vi.fn();
    s.on('roundBegan', fn);
    s.beginRound(3);
    expect(fn).toHaveBeenCalledWith({ round: 3 });
  });

  it('getHudSnapshot reflects the current state', () => {
    const c = makeClock();
    const s = new Scorer({ now: c.now });
    s.beginRound(2);
    s.registerCorrectClick({ depth: 0 });
    expect(s.getHudSnapshot()).toEqual({
      totalScore: 10,
      streak: 0, // streak only increments at finishRound
      bestStreak: 0,
      roundsPlayed: 0,
    });
  });
});

describe('Scorer.registerCorrectClick — point values', () => {
  let s, c;
  beforeEach(() => {
    c = makeClock();
    s = new Scorer({ now: c.now });
    s.beginRound(1);
  });

  it('depth 0 → 10 points', () => {
    expect(s.registerCorrectClick({ depth: 0 })).toBe(10);
    expect(s.totalScore).toBe(10);
  });

  it('depth 1 (split child) → 20 points', () => {
    expect(s.registerCorrectClick({ depth: 1 })).toBe(20);
    expect(s.totalScore).toBe(20);
  });

  it('depth 2 (deeper split child) → 20 points', () => {
    expect(s.registerCorrectClick({ depth: 2 })).toBe(20);
    expect(s.totalScore).toBe(20);
  });

  it('omitted args default to depth 0 → 10 points', () => {
    expect(s.registerCorrectClick()).toBe(10);
  });

  it('emits score event with reason', () => {
    const fn = vi.fn();
    s.on('score', fn);
    s.registerCorrectClick({ depth: 0 });
    s.registerCorrectClick({ depth: 1 });
    expect(fn).toHaveBeenNthCalledWith(1, { points: 10, reason: 'primary' });
    expect(fn).toHaveBeenNthCalledWith(2, { points: 20, reason: 'split' });
  });

  it('returns 0 when called outside an active round (no crash)', () => {
    s.finishRound();
    expect(s.registerCorrectClick({ depth: 0 })).toBe(0);
  });

  it('records reaction time as ms since last click', () => {
    c.tick(500);
    s.registerCorrectClick({ depth: 0 });
    c.tick(300);
    s.registerCorrectClick({ depth: 0 });
    s.finishRound();
    const round = s.roundStats[0];
    expect(round.reactionsMs).toEqual([500, 300]);
    expect(round.avgReactionMs).toBe(400);
  });

  it('clamps negative reaction time (clock skew) to 0', () => {
    // Travel back in time intentionally.
    c.tick(-1000);
    s.registerCorrectClick({ depth: 0 });
    s.finishRound();
    expect(s.roundStats[0].reactionsMs[0]).toBe(0);
  });
});

describe('Scorer.registerWrongClick', () => {
  let s, c;
  beforeEach(() => {
    c = makeClock();
    s = new Scorer({ now: c.now });
    s.beginRound(1);
  });

  it('flips perfect to false', () => {
    s.registerCorrectClick({ depth: 0 });
    s.registerWrongClick();
    s.finishRound();
    expect(s.roundStats[0].perfect).toBe(false);
  });

  it('does NOT add points', () => {
    const before = s.totalScore;
    s.registerWrongClick();
    expect(s.totalScore).toBe(before);
  });

  it('is a no-op outside an active round', () => {
    s.finishRound();
    expect(() => s.registerWrongClick()).not.toThrow();
  });
});

describe('Scorer.finishRound — perfect bonus + streak', () => {
  let s, c;
  beforeEach(() => {
    c = makeClock();
    s = new Scorer({ now: c.now });
  });

  function playPerfectRound({ clicks = 1, gapMs = 1000 } = {}) {
    s.beginRound(s.roundsPlayed + 1);
    for (let i = 0; i < clicks; i++) {
      c.tick(gapMs);
      s.registerCorrectClick({ depth: 0 });
    }
    return s.finishRound();
  }

  it('first perfect round: streak=1, multiplier=1.1, bonus=round(50*1.1)=55', () => {
    const r = playPerfectRound({ clicks: 1, gapMs: 1000 });
    expect(s.streak).toBe(1);
    expect(r.multiplier).toBeCloseTo(1.1);
    expect(r.perfectBonus).toBe(55);
  });

  it('streak progression: 1.1, 1.2, 1.3, 1.4, 1.5 over 5 perfect rounds', () => {
    const expectedMults = [1.1, 1.2, 1.3, 1.4, 1.5];
    const rounds = [];
    for (let i = 0; i < 5; i++) rounds.push(playPerfectRound({ gapMs: 1000 }));
    rounds.forEach((r, i) => {
      expect(r.multiplier).toBeCloseTo(expectedMults[i], 5);
    });
    expect(s.bestStreak).toBe(5);
  });

  it('multiplier caps at MAX_MULTIPLIER (2.0) from streak ≥10', () => {
    for (let i = 0; i < 10; i++) playPerfectRound({ gapMs: 1000 });
    expect(s.streak).toBe(10);
    const r10 = s.roundStats[9];
    expect(r10.multiplier).toBeCloseTo(2.0, 5);
    // Round 11+ also caps.
    const r11 = playPerfectRound({ gapMs: 1000 });
    expect(r11.multiplier).toBeCloseTo(2.0, 5);
    const r15 = playPerfectRound({ gapMs: 1000 });
    expect(r15.multiplier).toBeCloseTo(2.0, 5);
  });

  it('wrong click in a round → no perfect bonus, streak resets to 0', () => {
    playPerfectRound(); // streak=1
    s.beginRound(2);
    c.tick(1000);
    s.registerCorrectClick({ depth: 0 });
    s.registerWrongClick();
    const r = s.finishRound();
    expect(r.perfect).toBe(false);
    expect(r.perfectBonus).toBe(0);
    expect(r.speedBonus).toBe(0);
    expect(r.multiplier).toBe(1);
    expect(s.streak).toBe(0);
    // Next perfect resets streak from 0 → 1 (not 2).
    playPerfectRound();
    expect(s.streak).toBe(1);
  });

  it('finishRound returns null when no round is active', () => {
    expect(s.finishRound()).toBeNull();
  });
});

describe('Scorer.finishRound — speed bonus', () => {
  let s, c;
  beforeEach(() => {
    c = makeClock();
    s = new Scorer({ now: c.now });
  });

  it('fires when avgReaction < SPEED_THRESHOLD_MS (700) on a perfect round', () => {
    s.beginRound(1);
    c.tick(500);
    s.registerCorrectClick({ depth: 0 }); // base 10
    c.tick(500);
    s.registerCorrectClick({ depth: 0 }); // base 20 total
    const r = s.finishRound();
    // avgReaction = 500ms < 700 → speed bonus fires
    // basePoints = 20, speedBonus = round(20 * 0.3) = 6
    expect(r.avgReactionMs).toBe(500);
    expect(r.speedBonus).toBe(6);
  });

  it('does NOT fire when avgReaction ≥ SPEED_THRESHOLD_MS', () => {
    s.beginRound(1);
    c.tick(800);
    s.registerCorrectClick({ depth: 0 });
    c.tick(900);
    s.registerCorrectClick({ depth: 0 });
    const r = s.finishRound();
    expect(r.avgReactionMs).toBe(850);
    expect(r.speedBonus).toBe(0);
  });

  it('does NOT fire on a non-perfect round even if fast', () => {
    s.beginRound(1);
    c.tick(200);
    s.registerCorrectClick({ depth: 0 });
    s.registerWrongClick();
    const r = s.finishRound();
    expect(r.speedBonus).toBe(0);
  });

  it('does NOT fire on a perfect round with no clicks (basePoints = 0)', () => {
    s.beginRound(1);
    const r = s.finishRound();
    expect(r.basePoints).toBe(0);
    expect(r.speedBonus).toBe(0);
    // Perfect bonus still applies for the trivially-perfect "round".
    expect(r.perfectBonus).toBeGreaterThan(0);
  });
});

describe('Scorer split tracking', () => {
  let s, c;
  beforeEach(() => {
    c = makeClock();
    s = new Scorer({ now: c.now });
  });

  it('hadSplit flips true when willSplit click is registered', () => {
    s.beginRound(4);
    c.tick(500);
    s.registerCorrectClick({ depth: 0, willSplit: true });
    const r = s.finishRound();
    expect(r.hadSplit).toBe(true);
  });

  it('split-child clicks are counted in splitChildClicks', () => {
    s.beginRound(4);
    c.tick(500);
    s.registerCorrectClick({ depth: 1 });
    s.registerCorrectClick({ depth: 1 });
    s.registerCorrectClick({ depth: 0 });
    const r = s.finishRound();
    expect(r.splitChildClicks).toBe(2);
  });

  it('aggregate split counters increment only on rounds with splits', () => {
    // round 1: no split
    s.beginRound(1);
    c.tick(500);
    s.registerCorrectClick({ depth: 0 });
    s.finishRound();
    expect(s.getCalmStats().splitRoundsTotal).toBe(0);

    // round 2: had split, perfect
    s.beginRound(2);
    c.tick(500);
    s.registerCorrectClick({ depth: 0, willSplit: true });
    s.finishRound();
    const stats = s.getCalmStats();
    expect(stats.splitRoundsTotal).toBe(1);
    expect(stats.splitRoundsPerfect).toBe(1);

    // round 3: had split, NOT perfect
    s.beginRound(3);
    c.tick(500);
    s.registerCorrectClick({ depth: 0, willSplit: true });
    s.registerWrongClick();
    s.finishRound();
    const stats3 = s.getCalmStats();
    expect(stats3.splitRoundsTotal).toBe(2);
    expect(stats3.splitRoundsPerfect).toBe(1); // unchanged
  });
});

describe('Scorer.getCalmStats', () => {
  it('aggregates correctClicks, totalClicks, avgReactionMs across rounds', () => {
    const c = makeClock();
    const s = new Scorer({ now: c.now });

    // round 1: 2 correct, 200ms each
    s.beginRound(1);
    c.tick(200);
    s.registerCorrectClick({ depth: 0 });
    c.tick(200);
    s.registerCorrectClick({ depth: 0 });
    s.finishRound();

    // round 2: 1 correct, 1 wrong, 600ms reaction
    s.beginRound(2);
    c.tick(600);
    s.registerCorrectClick({ depth: 0 });
    s.registerWrongClick();
    s.finishRound();

    const stats = s.getCalmStats();
    expect(stats.correctClicks).toBe(3);
    expect(stats.totalClicks).toBe(4);
    // 3 reactions: 200, 200, 600 → avg = 1000/3 ≈ 333.33
    expect(stats.avgReactionMs).toBeCloseTo(333.333, 1);
  });

  it('returns zero avg reaction when no clicks recorded', () => {
    const s = new Scorer();
    const stats = s.getCalmStats();
    expect(stats.avgReactionMs).toBe(0);
    expect(stats.correctClicks).toBe(0);
    expect(stats.totalClicks).toBe(0);
  });
});

describe('Scorer.attachToGame — end-to-end wiring', () => {
  it('wires roundStart → beginRound', () => {
    const c = makeClock();
    const s = new Scorer({ now: c.now });
    const game = new Emitter();
    s.attachToGame(game);
    game.emit('roundStart', { round: 7 });
    expect(s._current).not.toBeNull();
    expect(s._current.round).toBe(7);
  });

  it('wires correctClick → registerCorrectClick (with depth + willSplit)', () => {
    const c = makeClock();
    const s = new Scorer({ now: c.now });
    const game = new Emitter();
    s.attachToGame(game);
    game.emit('roundStart', { round: 1 });
    c.tick(500);
    game.emit('correctClick', { ballId: 1, depth: 1, willSplit: false });
    expect(s.totalScore).toBe(20); // depth 1 → 20pts
  });

  it('wires wrongClick → registerWrongClick', () => {
    const s = new Scorer({ now: makeClock().now });
    const game = new Emitter();
    s.attachToGame(game);
    game.emit('roundStart', { round: 1 });
    game.emit('wrongClick', { ballId: 99 });
    expect(s._current.perfect).toBe(false);
  });

  it('wires roundComplete → finishRound', () => {
    const c = makeClock();
    const s = new Scorer({ now: c.now });
    const game = new Emitter();
    s.attachToGame(game);
    game.emit('roundStart', { round: 1 });
    c.tick(500);
    game.emit('correctClick', { ballId: 1, depth: 0, willSplit: false });
    game.emit('roundComplete', { round: 1, perfect: true });
    expect(s.roundsPlayed).toBe(1);
    expect(s.streak).toBe(1);
  });

  it('returns the scorer for chaining', () => {
    const s = new Scorer();
    const game = new Emitter();
    expect(s.attachToGame(game)).toBe(s);
  });
});
