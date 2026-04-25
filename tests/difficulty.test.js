// Tests for src/difficulty.js — round → parameter table.
// Pins values to the spec §4 table dev-lead referenced. If the implementation
// follows the simpler closed-form formula instead, these tests will surface
// the discrepancy as failures (which is the point — the spec table is the
// canonical source of truth per dev-lead's brief).

import { describe, it, expect } from 'vitest';
import {
  DIFFICULTY,
  ballCountForRound,
  flashDurationForRound,
  splitCountForRound,
  maxSplitDepthForRound,
  difficultyForRound,
} from '../src/difficulty.js';

describe('DIFFICULTY constants', () => {
  it('exposes the documented bounds', () => {
    expect(DIFFICULTY.MIN_BALLS).toBe(1);
    expect(DIFFICULTY.MAX_BALLS).toBe(8);
    expect(DIFFICULTY.MIN_FLASH).toBe(0.35);
    expect(DIFFICULTY.MAX_FLASH).toBe(0.8);
    expect(DIFFICULTY.GAP).toBeGreaterThan(0);
    expect(DIFFICULTY.HOLD_AFTER_REVEAL).toBeGreaterThan(0);
    expect(DIFFICULTY.SPLIT_INTRO_ROUND).toBe(4);
    expect(DIFFICULTY.SECOND_LAYER_SPLIT_ROUND).toBe(8);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(DIFFICULTY)).toBe(true);
  });
});

describe('ballCountForRound — spec §4 table', () => {
  // Dev-lead brief: "round 1 = 1 ball (tutorial), round 2 = 2, round 3 = 3,
  // round 4 = 3, etc., capped at 8."
  const TABLE = [
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 3],
    [5, 4],
    [6, 4],
    [7, 5],
    [8, 5],
    [9, 6],
    [10, 6], // r10+: 6-8 per spec; r10 still 6
  ];

  for (const [round, expected] of TABLE) {
    it(`round ${round} → ${expected} ball${expected === 1 ? '' : 's'}`, () => {
      expect(ballCountForRound(round)).toBe(expected);
    });
  }

  it('caps at MAX_BALLS for very high rounds', () => {
    expect(ballCountForRound(50)).toBe(DIFFICULTY.MAX_BALLS);
    expect(ballCountForRound(1000)).toBe(DIFFICULTY.MAX_BALLS);
  });

  it('round 0 / negatives fall back to MIN_BALLS', () => {
    expect(ballCountForRound(0)).toBe(DIFFICULTY.MIN_BALLS);
    expect(ballCountForRound(-5)).toBe(DIFFICULTY.MIN_BALLS);
  });

  it('is monotonically non-decreasing', () => {
    let prev = 0;
    for (let r = 1; r <= 20; r++) {
      const n = ballCountForRound(r);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });
});

describe('flashDurationForRound', () => {
  it('is at least MIN_FLASH for very high rounds', () => {
    expect(flashDurationForRound(100)).toBe(DIFFICULTY.MIN_FLASH);
    expect(flashDurationForRound(50)).toBe(DIFFICULTY.MIN_FLASH);
  });

  it('is at most MAX_FLASH at round 1', () => {
    expect(flashDurationForRound(1)).toBeLessThanOrEqual(DIFFICULTY.MAX_FLASH);
    expect(flashDurationForRound(1)).toBeGreaterThan(DIFFICULTY.MIN_FLASH);
  });

  it('is monotonically non-increasing', () => {
    let prev = Infinity;
    for (let r = 1; r <= 30; r++) {
      const d = flashDurationForRound(r);
      expect(d).toBeLessThanOrEqual(prev);
      prev = d;
    }
  });

  it('hits the floor at the documented round (~12)', () => {
    // 0.8 - 12*0.04 = 0.32 < 0.35 → clamped to 0.35
    expect(flashDurationForRound(12)).toBe(DIFFICULTY.MIN_FLASH);
  });
});

describe('splitCountForRound — spec §4', () => {
  it('returns 0 for rounds before SPLIT_INTRO_ROUND (1, 2, 3)', () => {
    expect(splitCountForRound(1)).toBe(0);
    expect(splitCountForRound(2)).toBe(0);
    expect(splitCountForRound(3)).toBe(0);
  });

  it('round 4 introduces 1 split (per spec table)', () => {
    expect(splitCountForRound(4)).toBe(1);
  });

  it('rounds 5, 6, 7 keep at 1 split (per spec table)', () => {
    expect(splitCountForRound(5)).toBe(1);
    expect(splitCountForRound(6)).toBe(1);
    expect(splitCountForRound(7)).toBe(1);
  });

  it('round 8 bumps to 2 splits (per spec table)', () => {
    expect(splitCountForRound(8)).toBe(2);
  });

  it('is monotonically non-decreasing from round 4 onward', () => {
    let prev = 0;
    for (let r = 4; r <= 20; r++) {
      const n = splitCountForRound(r);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });

  it('never returns negative', () => {
    for (let r = -5; r <= 30; r++) {
      expect(splitCountForRound(r)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('maxSplitDepthForRound', () => {
  it('returns 1 before SECOND_LAYER_SPLIT_ROUND', () => {
    for (let r = 1; r < DIFFICULTY.SECOND_LAYER_SPLIT_ROUND; r++) {
      expect(maxSplitDepthForRound(r)).toBe(1);
    }
  });

  it('returns 2 at and beyond SECOND_LAYER_SPLIT_ROUND', () => {
    expect(maxSplitDepthForRound(8)).toBe(2);
    expect(maxSplitDepthForRound(9)).toBe(2);
    expect(maxSplitDepthForRound(20)).toBe(2);
  });
});

describe('difficultyForRound (bundle)', () => {
  it('packages all per-round params into one object', () => {
    const d = difficultyForRound(5);
    expect(d).toMatchObject({
      round: 5,
      ballCount: ballCountForRound(5),
      flashDuration: flashDurationForRound(5),
      gap: DIFFICULTY.GAP,
      splitCount: splitCountForRound(5),
      maxSplitDepth: maxSplitDepthForRound(5),
      holdAfterReveal: DIFFICULTY.HOLD_AFTER_REVEAL,
    });
  });

  it('returns a fresh object each call (callers can mutate safely)', () => {
    const a = difficultyForRound(3);
    const b = difficultyForRound(3);
    expect(a).not.toBe(b);
    a.round = 999;
    expect(b.round).toBe(3);
  });
});
