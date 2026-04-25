// Tests for src/calm-index.js — pure functions over aggregated stats.
//
// Covers individual sub-scores (memoryAccuracy / decisionSpeed / composure),
// the weighted blend in computeCalmIndex, the zen-tier mapping, and all the
// boundary / NaN / divide-by-zero guards.

import { describe, it, expect } from 'vitest';
import {
  ZEN_TIERS,
  REACTION_FAST_MS,
  REACTION_SLOW_MS,
  WEIGHTS,
  memoryAccuracy,
  decisionSpeed,
  composure,
  computeCalmIndex,
  tierForCalmIndex,
  calmReport,
} from '../src/calm-index.js';

describe('constants', () => {
  it('ZEN_TIERS thresholds match spec §5.4 (0/30/60/85)', () => {
    expect(ZEN_TIERS.map((t) => t.threshold)).toEqual([0, 30, 60, 85]);
  });

  it('ZEN_TIERS emojis match spec', () => {
    expect(ZEN_TIERS.map((t) => t.emoji)).toEqual(['🌾', '⛳', '🌿', '🌸']);
  });

  it('ZEN_TIERS is frozen', () => {
    expect(Object.isFrozen(ZEN_TIERS)).toBe(true);
  });

  it('WEIGHTS sum to 1.0', () => {
    expect(WEIGHTS.ACCURACY + WEIGHTS.SPEED + WEIGHTS.COMPOSURE).toBeCloseTo(1.0);
  });

  it('reaction window: FAST < SLOW', () => {
    expect(REACTION_FAST_MS).toBeLessThan(REACTION_SLOW_MS);
  });
});

describe('memoryAccuracy', () => {
  it('correctClicks/totalClicks × 100', () => {
    expect(memoryAccuracy({ correctClicks: 3, totalClicks: 4 })).toBe(75);
    expect(memoryAccuracy({ correctClicks: 10, totalClicks: 10 })).toBe(100);
    expect(memoryAccuracy({ correctClicks: 0, totalClicks: 5 })).toBe(0);
  });

  it('returns 0 when totalClicks = 0 (no division by zero)', () => {
    expect(memoryAccuracy({ correctClicks: 0, totalClicks: 0 })).toBe(0);
  });

  it('returns 0 when totalClicks is negative (defensive)', () => {
    expect(memoryAccuracy({ correctClicks: 1, totalClicks: -1 })).toBe(0);
  });

  it('returns 0 when stats is null/undefined', () => {
    expect(memoryAccuracy(null)).toBe(0);
    expect(memoryAccuracy(undefined)).toBe(0);
  });

  it('clamps to 100 even if correct > total (data drift defense)', () => {
    expect(memoryAccuracy({ correctClicks: 10, totalClicks: 5 })).toBe(100);
  });
});

describe('decisionSpeed', () => {
  it('avgReactionMs at REACTION_FAST_MS → 100', () => {
    expect(decisionSpeed({ avgReactionMs: REACTION_FAST_MS })).toBe(100);
  });

  it('avgReactionMs at REACTION_SLOW_MS → 0', () => {
    expect(decisionSpeed({ avgReactionMs: REACTION_SLOW_MS })).toBe(0);
  });

  it('avgReactionMs at midpoint (1090ms) → 50', () => {
    expect(decisionSpeed({ avgReactionMs: 1090 })).toBe(50);
  });

  it('faster than FAST clamps to 100', () => {
    expect(decisionSpeed({ avgReactionMs: 100 })).toBe(100);
    expect(decisionSpeed({ avgReactionMs: 1 })).toBe(100);
  });

  it('slower than SLOW clamps to 0', () => {
    expect(decisionSpeed({ avgReactionMs: 5000 })).toBe(0);
    expect(decisionSpeed({ avgReactionMs: 99999 })).toBe(0);
  });

  it('avgReactionMs of 0 → 0 (no measurements yet)', () => {
    expect(decisionSpeed({ avgReactionMs: 0 })).toBe(0);
  });

  it('avgReactionMs of NaN → 0', () => {
    expect(decisionSpeed({ avgReactionMs: NaN })).toBe(0);
  });

  it('avgReactionMs missing → 0', () => {
    expect(decisionSpeed({})).toBe(0);
  });

  it('null stats → 0', () => {
    expect(decisionSpeed(null)).toBe(0);
  });
});

describe('composure', () => {
  it('uses splitRoundsPerfect/splitRoundsTotal × 100 when split rounds exist', () => {
    expect(
      composure({ splitRoundsPerfect: 3, splitRoundsTotal: 4 }),
    ).toBe(75);
    expect(
      composure({ splitRoundsPerfect: 5, splitRoundsTotal: 5 }),
    ).toBe(100);
  });

  it('falls back to memoryAccuracy when no split rounds yet', () => {
    expect(
      composure({
        splitRoundsTotal: 0,
        correctClicks: 8,
        totalClicks: 10,
      }),
    ).toBe(80);
  });

  it('returns 0 when no split rounds AND no clicks (full fallback)', () => {
    expect(composure({ splitRoundsTotal: 0, totalClicks: 0 })).toBe(0);
  });

  it('clamps to 100 if perfect > total', () => {
    expect(
      composure({ splitRoundsPerfect: 10, splitRoundsTotal: 5 }),
    ).toBe(100);
  });
});

describe('computeCalmIndex — weighted blend', () => {
  it('perfect inputs → 100', () => {
    const stats = {
      correctClicks: 10,
      totalClicks: 10,
      avgReactionMs: REACTION_FAST_MS,
      splitRoundsPerfect: 1,
      splitRoundsTotal: 1,
    };
    expect(computeCalmIndex(stats)).toBe(100);
  });

  it('zero inputs → 0', () => {
    const stats = {
      correctClicks: 0,
      totalClicks: 0,
      avgReactionMs: 0,
      splitRoundsPerfect: 0,
      splitRoundsTotal: 0,
    };
    expect(computeCalmIndex(stats)).toBe(0);
  });

  it('weighted: 100 acc + 0 speed + 0 composure → 50', () => {
    const stats = {
      correctClicks: 10,
      totalClicks: 10,
      avgReactionMs: REACTION_SLOW_MS,
      splitRoundsPerfect: 0,
      splitRoundsTotal: 1, // forces composure path → 0
    };
    // 0.5*100 + 0.25*0 + 0.25*0 = 50
    expect(computeCalmIndex(stats)).toBe(50);
  });

  it('weighted: 50 acc + 100 speed + 100 composure → 75', () => {
    const stats = {
      correctClicks: 5,
      totalClicks: 10,
      avgReactionMs: REACTION_FAST_MS,
      splitRoundsPerfect: 1,
      splitRoundsTotal: 1,
    };
    // 0.5*50 + 0.25*100 + 0.25*100 = 25 + 25 + 25 = 75
    expect(computeCalmIndex(stats)).toBe(75);
  });

  it('result is rounded to nearest integer', () => {
    // Pick numbers that produce a non-integer pre-rounding.
    const stats = {
      correctClicks: 1,
      totalClicks: 3, // 33.333%
      avgReactionMs: REACTION_FAST_MS,
      splitRoundsPerfect: 1,
      splitRoundsTotal: 3, // 33.333%
    };
    const v = computeCalmIndex(stats);
    expect(Number.isInteger(v)).toBe(true);
  });

  it('null stats → 0 (no crash)', () => {
    expect(computeCalmIndex(null)).toBe(0);
    expect(computeCalmIndex(undefined)).toBe(0);
  });
});

describe('tierForCalmIndex — boundary mapping', () => {
  const BOUNDARY = [
    [0, 'Seedling', '🌾'],
    [29, 'Seedling', '🌾'],
    [30, 'Marker', '⛳'],
    [59, 'Marker', '⛳'],
    [60, 'Leaf', '🌿'],
    [84, 'Leaf', '🌿'],
    [85, 'Blossom', '🌸'],
    [100, 'Blossom', '🌸'],
  ];

  for (const [v, name, emoji] of BOUNDARY) {
    it(`value ${v} → ${name} ${emoji}`, () => {
      const t = tierForCalmIndex(v);
      expect(t.name).toBe(name);
      expect(t.emoji).toBe(emoji);
    });
  }

  it('negative values clamp up to Seedling', () => {
    expect(tierForCalmIndex(-5).name).toBe('Seedling');
    expect(tierForCalmIndex(-100).name).toBe('Seedling');
  });

  it('values > 100 clamp down to Blossom', () => {
    expect(tierForCalmIndex(150).name).toBe('Blossom');
    expect(tierForCalmIndex(9999).name).toBe('Blossom');
  });

  it('non-numeric inputs default to Seedling', () => {
    expect(tierForCalmIndex(NaN).name).toBe('Seedling');
    expect(tierForCalmIndex('not a number').name).toBe('Seedling');
    expect(tierForCalmIndex(null).name).toBe('Seedling');
    expect(tierForCalmIndex(undefined).name).toBe('Seedling');
  });
});

describe('calmReport', () => {
  it('returns {index, tier, breakdown} matching components', () => {
    const stats = {
      correctClicks: 10,
      totalClicks: 10,
      avgReactionMs: REACTION_FAST_MS,
      splitRoundsPerfect: 1,
      splitRoundsTotal: 1,
    };
    const r = calmReport(stats);
    expect(r.index).toBe(100);
    expect(r.tier.name).toBe('Blossom');
    expect(r.breakdown.memoryAccuracy).toBe(100);
    expect(r.breakdown.decisionSpeed).toBe(100);
    expect(r.breakdown.composure).toBe(100);
  });

  it('handles empty stats without crashing', () => {
    const r = calmReport({});
    expect(r.index).toBe(0);
    expect(r.tier.name).toBe('Seedling');
    expect(r.breakdown.memoryAccuracy).toBe(0);
    expect(r.breakdown.decisionSpeed).toBe(0);
    expect(r.breakdown.composure).toBe(0);
  });
});
