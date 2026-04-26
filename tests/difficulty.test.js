// Tests for src/difficulty.js — round → parameter table.
//
// Pins values to the *refined* difficulty design (zen-shards-difficulty-design.md,
// 2026-04). The refinement:
//   - caps ballCount at 7 (was 8) and softens its ramp so each mechanic cliff
//     (r4 split intro / r8 nesting / r10 splitCount=2 / r12 splitCount=3) is a
//     plateau on the ballCount axis;
//   - raises MIN_FLASH from 0.35 → 0.40 to leave dual-task headroom;
//   - delays the splitCount=2 bump from r8 to r10 so r8 introduces *only*
//     nesting; and
//   - replaces the deterministic-nesting-from-r8 rule with a probabilistic
//     ramp (0.5 → 0.75 → 1.0). See `nestingProbabilityForRound` block below.
//
// Original test intent is preserved: each test still pins canonical values
// and asserts monotonicity invariants — only the numbers move with the spec.

import { describe, it, expect } from 'vitest';
import {
  DIFFICULTY,
  ballCountForRound,
  flashDurationForRound,
  splitCountForRound,
  maxSplitDepthForRound,
  nestingProbabilityForRound,
  difficultyForRound,
} from '../src/difficulty.js';

describe('DIFFICULTY constants', () => {
  it('exposes the documented bounds', () => {
    expect(DIFFICULTY.MIN_BALLS).toBe(1);
    expect(DIFFICULTY.MAX_BALLS).toBe(7); // refined: capped 8 → 7 (Cowan 4±1, onboarding-cliff mitigation)
    expect(DIFFICULTY.MIN_FLASH).toBe(0.40); // refined: floor 0.35 → 0.40s (Pashler PRP headroom)
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

describe('ballCountForRound — refined spec §3.3 table', () => {
  // Refined ball-count ramp: every mechanic-introduction round is a plateau
  // on the ballCount axis so the player only learns ONE new dimension at a
  // time. Hardcoded values match the §3.3 table:
  //   r1=1 (tutorial)
  //   r2=2
  //   r3=r4=r5=3       (r4 = split intro; ball count held flat)
  //   r6=r7=r8=4       (r8 = depth-2 nesting intro; ball count held flat)
  //   r9=r10=5         (r10 = splitCount=2; ball count held flat)
  //   r11=r12=6        (r12 = splitCount=3; ball count held flat)
  //   r13+=7           (capped at MAX_BALLS=7)
  const TABLE = [
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 3],
    [5, 3], // refined: was 4 — plateau after split intro
    [6, 4],
    [7, 4], // refined: was 5 — plateau in r6–8 bracket
    [8, 4], // refined: was 5 — plateau before nesting introduces itself solo
    [9, 5], // refined: was 6
    [10, 5], // refined: was 6 — plateau before splitCount=2 lands at r10
    [11, 6], // refined: was 7
    [12, 6], // refined: was 7 — plateau before splitCount=3 at r12
    [13, 7], // refined: was 8 — final cap is now 7
  ];

  for (const [round, expected] of TABLE) {
    it(`round ${round} → ${expected} ball${expected === 1 ? '' : 's'}`, () => {
      expect(ballCountForRound(round)).toBe(expected);
    });
  }

  it('caps at MAX_BALLS=7 for very high rounds (was 8)', () => {
    expect(ballCountForRound(50)).toBe(DIFFICULTY.MAX_BALLS);
    expect(ballCountForRound(1000)).toBe(DIFFICULTY.MAX_BALLS);
    expect(DIFFICULTY.MAX_BALLS).toBe(7); // belt-and-braces — guards against silent re-bump
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

  it('hits the floor at the documented round (refined: r=10)', () => {
    // Refined: 0.8 − 10*0.04 = 0.40 → already AT the new floor at r=10.
    // Old floor (0.35) was reached at r=12 (0.8 − 12*0.04 = 0.32, clamped to 0.35).
    // The new floor (0.40) closes that gap by 2 rounds.
    expect(flashDurationForRound(10)).toBe(DIFFICULTY.MIN_FLASH);
    expect(flashDurationForRound(11)).toBe(DIFFICULTY.MIN_FLASH);
    expect(flashDurationForRound(12)).toBe(DIFFICULTY.MIN_FLASH);
  });

  it('values for low rounds match the refined §3.3 table', () => {
    // Spot-check non-floor rounds — guards against accidental formula change.
    expect(flashDurationForRound(1)).toBeCloseTo(0.76, 5);
    expect(flashDurationForRound(2)).toBeCloseTo(0.72, 5);
    expect(flashDurationForRound(5)).toBeCloseTo(0.60, 5);
    expect(flashDurationForRound(8)).toBeCloseTo(0.48, 5);
  });
});

describe('splitCountForRound — refined spec §3.3', () => {
  // Refinement: the splitCount=2 bump moved from r8 to r10 so that r8 can
  // introduce *only* nesting (depth-2) without simultaneously doubling the
  // number of splits. r8–9 stay at 1 split.
  it('returns 0 for rounds before SPLIT_INTRO_ROUND (1, 2, 3)', () => {
    expect(splitCountForRound(1)).toBe(0);
    expect(splitCountForRound(2)).toBe(0);
    expect(splitCountForRound(3)).toBe(0);
  });

  it('round 4 introduces 1 split', () => {
    expect(splitCountForRound(4)).toBe(1);
  });

  it('rounds 5, 6, 7 stay at 1 split', () => {
    expect(splitCountForRound(5)).toBe(1);
    expect(splitCountForRound(6)).toBe(1);
    expect(splitCountForRound(7)).toBe(1);
  });

  it('rounds 8 and 9 STILL at 1 split (refined: bump moved to r10)', () => {
    // Old design: r8 jumped to 2 splits AND introduced nesting AND raised
    // ballCount — three knobs at once. Refined design isolates nesting at r8.
    expect(splitCountForRound(8)).toBe(1);
    expect(splitCountForRound(9)).toBe(1);
  });

  it('round 10 bumps to 2 splits (refined: was r8)', () => {
    expect(splitCountForRound(10)).toBe(2);
    expect(splitCountForRound(11)).toBe(2);
  });

  it('round 12 bumps to 3 splits', () => {
    expect(splitCountForRound(12)).toBe(3);
    expect(splitCountForRound(13)).toBe(3);
    expect(splitCountForRound(50)).toBe(3);
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

// ─── nestingProbabilityForRound (NEW — refined difficulty) ──────────────────

describe('nestingProbabilityForRound — refined spec §3.3', () => {
  // The refined design replaces the old deterministic "always 1 child nests
  // from r8 onward" rule with a 50% → 75% → 100% probability ramp. The
  // function returns the per-round probability that, when a depth-1 split
  // resolves, ONE of its children should itself be auto-flagged willSplit.
  // r<8 returns 0 because depth-2 isn't unlocked.
  //
  // game.js reads this value from `_difficulty.nestingProbability` and rolls
  // against it via `this.rng()` in `acceptSplitChildren`.
  it('returns 0 for rounds before SECOND_LAYER_SPLIT_ROUND (depth-2 not unlocked)', () => {
    for (let r = 1; r < DIFFICULTY.SECOND_LAYER_SPLIT_ROUND; r++) {
      expect(nestingProbabilityForRound(r)).toBe(0);
    }
  });

  it('rounds 8 and 9 → 0.5 (50%)', () => {
    expect(nestingProbabilityForRound(8)).toBe(0.5);
    expect(nestingProbabilityForRound(9)).toBe(0.5);
  });

  it('rounds 10 and 11 → 0.75 (75%)', () => {
    expect(nestingProbabilityForRound(10)).toBe(0.75);
    expect(nestingProbabilityForRound(11)).toBe(0.75);
  });

  it('rounds 12+ → 1.0 (100% — matches old always-on cap at high rounds)', () => {
    expect(nestingProbabilityForRound(12)).toBe(1);
    expect(nestingProbabilityForRound(20)).toBe(1);
    expect(nestingProbabilityForRound(100)).toBe(1);
  });

  it('is monotonically non-decreasing across the whole range', () => {
    let prev = -1;
    for (let r = 0; r <= 30; r++) {
      const p = nestingProbabilityForRound(r);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  it('only ever takes the four documented values (0, 0.5, 0.75, 1.0)', () => {
    const allowed = new Set([0, 0.5, 0.75, 1]);
    for (let r = 1; r <= 30; r++) {
      expect(allowed.has(nestingProbabilityForRound(r))).toBe(true);
    }
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
      // Refined: bundle now exposes nestingProbability so game.js can read
      // it without re-deriving from `round`.
      nestingProbability: nestingProbabilityForRound(5),
      holdAfterReveal: DIFFICULTY.HOLD_AFTER_REVEAL,
    });
  });

  it('exposes nestingProbability for the difficulty consumer (game.js)', () => {
    // Consumer contract: game.js reads `_difficulty.nestingProbability` to
    // roll the depth-2 cascade in acceptSplitChildren — this test pins the
    // bundle field name so a rename surfaces immediately.
    expect(difficultyForRound(7).nestingProbability).toBe(0);
    expect(difficultyForRound(8).nestingProbability).toBe(0.5);
    expect(difficultyForRound(10).nestingProbability).toBe(0.75);
    expect(difficultyForRound(12).nestingProbability).toBe(1);
  });

  it('returns a fresh object each call (callers can mutate safely)', () => {
    const a = difficultyForRound(3);
    const b = difficultyForRound(3);
    expect(a).not.toBe(b);
    a.round = 999;
    expect(b.round).toBe(3);
  });
});
