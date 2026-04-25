// Calm Index — the signature cognitive metric for Zen Shards.
//
// Pure functions over an aggregated stats object (provided by Scorer).
// Maps a player's run to a 0–100 "inner stillness" value plus a zen tier.
//
// Spec §5.4 reference weighting:
//   memoryAccuracy  ×0.50
//   decisionSpeed   ×0.25  (faster avg reaction → higher score)
//   composure       ×0.25  (perfect-round rate within rounds that had splits)

export const ZEN_TIERS = Object.freeze([
  { name: 'Seedling', emoji: '🌾', threshold: 0 },
  { name: 'Marker', emoji: '⛳', threshold: 30 },
  { name: 'Leaf', emoji: '🌿', threshold: 60 },
  { name: 'Blossom', emoji: '🌸', threshold: 85 },
]);

// Reaction-time normalisation window. Anything ≤ FAST gives full speed score;
// anything ≥ SLOW gives zero. Linear in between.
export const REACTION_FAST_MS = 380;
export const REACTION_SLOW_MS = 1800;

export const WEIGHTS = Object.freeze({
  ACCURACY: 0.5,
  SPEED: 0.25,
  COMPOSURE: 0.25,
});

function clamp01(t) {
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.min(1, t));
}

/** % of clicks that were correct. 0 if no clicks recorded. */
export function memoryAccuracy(stats) {
  if (!stats || stats.totalClicks <= 0) return 0;
  return clamp01(stats.correctClicks / stats.totalClicks) * 100;
}

/**
 * Reaction time normalised onto a 0..100 scale. Faster = higher.
 * 0 if no reactions recorded.
 */
export function decisionSpeed(stats) {
  if (!stats || !(stats.avgReactionMs > 0)) return 0;
  const t =
    (REACTION_SLOW_MS - stats.avgReactionMs) /
    (REACTION_SLOW_MS - REACTION_FAST_MS);
  return clamp01(t) * 100;
}

/**
 * Composure = perfect-round rate within rounds that triggered a split.
 * If no split rounds happened yet, fall back to overall accuracy so the
 * Calm Index has a sensible early-game value.
 */
export function composure(stats) {
  if (!stats || stats.splitRoundsTotal <= 0) return memoryAccuracy(stats);
  return clamp01(stats.splitRoundsPerfect / stats.splitRoundsTotal) * 100;
}

/** Final 0..100 Calm Index — rounded. */
export function computeCalmIndex(stats) {
  const a = memoryAccuracy(stats);
  const s = decisionSpeed(stats);
  const c = composure(stats);
  const value =
    WEIGHTS.ACCURACY * a + WEIGHTS.SPEED * s + WEIGHTS.COMPOSURE * c;
  return Math.round(clamp01(value / 100) * 100);
}

/**
 * Map a value in 0..100 to the highest tier whose threshold it meets.
 * Out-of-range values clamp to the nearest tier.
 */
export function tierForCalmIndex(value) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  for (let i = ZEN_TIERS.length - 1; i >= 0; i--) {
    if (v >= ZEN_TIERS[i].threshold) return ZEN_TIERS[i];
  }
  return ZEN_TIERS[0];
}

/** Convenience bundle for HUD rendering. */
export function calmReport(stats) {
  const index = computeCalmIndex(stats);
  return {
    index,
    tier: tierForCalmIndex(index),
    breakdown: {
      memoryAccuracy: memoryAccuracy(stats),
      decisionSpeed: decisionSpeed(stats),
      composure: composure(stats),
    },
  };
}
