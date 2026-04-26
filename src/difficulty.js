// Difficulty parameter table — single source of truth.
//
// Refined per zen-shards-difficulty-design.md (2026-04 revision):
// every adjustment here is a parameter tweak — no new mechanics, no new game
// state. The goals are (a) decouple the four difficulty knobs so only one
// climbs per round, (b) add 2–3 round consolidation plateaus after each new
// mechanic, and (c) soften the r4 / r8 / r12 cliffs.
//
// Pure functions, no globals — easy to unit-test and easy for HUD/Calm Index
// modules to consume without coupling to game state.

export const DIFFICULTY = Object.freeze({
  MIN_BALLS: 1,
  MAX_BALLS: 7,           // capped at 7 (was 8) — Cowan 4±1 + onboarding cliff mitigation
  MIN_FLASH: 0.40,        // floor raised from 0.35 → 0.40s for dual-task headroom (Pashler PRP)
  MAX_FLASH: 0.8,
  GAP: 0.2,
  HOLD_AFTER_REVEAL: 0.8,
  SPLIT_INTRO_ROUND: 4,
  SECOND_LAYER_SPLIT_ROUND: 8,
  SUB_SEQUENCE_SPEEDUP: 0.7, // 30% faster, per spec §3.3
});

/**
 * Number of balls to spawn for the given round.
 *
 * New (refined) table — flat at every mechanic-introduction round so the
 * player only learns one new dimension at a time:
 *   r1=1 (tutorial)
 *   r2=2
 *   r3=3, r4=3, r5=3       (r4 = split intro; ball count held flat)
 *   r6=4, r7=4, r8=4       (r8 = depth-2 nesting intro; ball count held flat)
 *   r9=5, r10=5            (r10 = splitCount=2; ball count held flat)
 *   r11=6, r12=6           (r12 = splitCount=3; ball count held flat)
 *   r13+=7                 (capped at MAX_BALLS=7)
 */
const BALL_COUNT_TABLE = [1, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7];

export function ballCountForRound(round) {
  if (round <= 0) return DIFFICULTY.MIN_BALLS;
  const idx = Math.min(round, BALL_COUNT_TABLE.length) - 1;
  return BALL_COUNT_TABLE[idx];
}

/**
 * Per-flash hold duration in seconds for the given round.
 * Slower at low rounds (0.8s), tightens to 0.40s floor.
 *
 * Floor raised from 0.35 → 0.40s: at 0.35s the player is at the central
 * reaction-selection bottleneck (~250 ms) with almost no headroom for
 * "identify → decide → encode in WM" — particularly painful during split
 * dual-tasks. 0.40s preserves urgency without crowding the bottleneck.
 */
export function flashDurationForRound(round) {
  return Math.max(DIFFICULTY.MAX_FLASH - round * 0.04, DIFFICULTY.MIN_FLASH);
}

/**
 * Number of balls in the round that will become "split" balls when clicked.
 * Returns 0 before the split-intro round.
 *
 * Refined schedule (separates "depth-2 introduction" from "more splits"):
 *   r<4    : 0   (no splits yet)
 *   r4–9   : 1   (single split — r4 introduces splits, r8 introduces nesting
 *                 onto that *same* single split rather than doubling them)
 *   r10–11 : 2
 *   r12+   : 3
 */
export function splitCountForRound(round) {
  if (round < DIFFICULTY.SPLIT_INTRO_ROUND) return 0;
  if (round <= 9) return 1;
  if (round <= 11) return 2;
  return 3;
}

/** Maximum split nesting depth allowed at this round (1 or 2). */
export function maxSplitDepthForRound(round) {
  return round >= DIFFICULTY.SECOND_LAYER_SPLIT_ROUND ? 2 : 1;
}

/**
 * Probability that a depth-1 split's children will themselves spawn a
 * (single) depth-2 nested split, when the round permits depth-2 at all.
 *
 * Replaces the old deterministic "always 1 child nests" rule from r8 onward
 * (which created a +7 max-clicks cliff between r7 and r8) with a smooth
 * 50% → 75% → 100% ramp:
 *   r<8   : 0     (depth-2 not unlocked yet)
 *   r8–9  : 0.50
 *   r10–11: 0.75
 *   r12+  : 1.00
 *
 * Callers should roll against this value using their seeded RNG so tests
 * stay deterministic.
 */
export function nestingProbabilityForRound(round) {
  if (round < DIFFICULTY.SECOND_LAYER_SPLIT_ROUND) return 0;
  if (round <= 9) return 0.5;
  if (round <= 11) return 0.75;
  return 1.0;
}

/** Convenience bundle for the round, useful for HUD + state init. */
export function difficultyForRound(round) {
  return {
    round,
    ballCount: ballCountForRound(round),
    flashDuration: flashDurationForRound(round),
    gap: DIFFICULTY.GAP,
    splitCount: splitCountForRound(round),
    maxSplitDepth: maxSplitDepthForRound(round),
    nestingProbability: nestingProbabilityForRound(round),
    holdAfterReveal: DIFFICULTY.HOLD_AFTER_REVEAL,
  };
}
