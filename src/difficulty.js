// Difficulty parameter table — single source of truth derived from spec §4.
//
// Pure functions, no globals — easy to unit-test and easy for HUD/Calm Index
// modules to consume without coupling to game state.

export const DIFFICULTY = Object.freeze({
  MIN_BALLS: 1,
  MAX_BALLS: 8,
  MIN_FLASH: 0.35,
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
 * Matches the spec §4 *table* exactly (the table and the closed-form
 * formula in the spec disagree — table wins per team brief):
 *   r1=1 (tutorial), r2=2, r3=3, r4=3, r5=4, r6=4, r7=5, r8=5,
 *   r9=6, r10=6, r11=7, r12=7, ... capped at MAX_BALLS=8.
 */
export function ballCountForRound(round) {
  if (round <= 0) return DIFFICULTY.MIN_BALLS;
  if (round === 1) return 1;
  return Math.min(Math.floor((round + 3) / 2), DIFFICULTY.MAX_BALLS);
}

/**
 * Per-flash hold duration in seconds for the given round.
 * Slower at low rounds (0.8s), tightens to 0.35s floor.
 */
export function flashDurationForRound(round) {
  return Math.max(DIFFICULTY.MAX_FLASH - round * 0.04, DIFFICULTY.MIN_FLASH);
}

/**
 * Number of balls in the round that will become "split" balls when clicked.
 * Returns 0 before the split-intro round.
 *
 * Matches spec §4 table: r4-7 = 1 split (intro), r8-11 = 2, r12-15 = 3, ...
 * The spec's closed-form formula gave 0 at the intro round, defeating the
 * tutorial — reverted to the table values.
 */
export function splitCountForRound(round) {
  if (round < DIFFICULTY.SPLIT_INTRO_ROUND) return 0;
  return Math.floor((round - DIFFICULTY.SPLIT_INTRO_ROUND) / 4) + 1;
}

/** Maximum split nesting depth allowed at this round (1 or 2). */
export function maxSplitDepthForRound(round) {
  return round >= DIFFICULTY.SECOND_LAYER_SPLIT_ROUND ? 2 : 1;
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
    holdAfterReveal: DIFFICULTY.HOLD_AFTER_REVEAL,
  };
}
