// Tests for src/split.js — pure helpers used by the split mechanic.
//
// Exercises pickSplitChildCount, childKindForDepth, pickWillSplit, and
// generateChildPositions. Pure JS — no Three.js, no game state.

import { describe, it, expect } from 'vitest';
import {
  pickSplitChildCount,
  childKindForDepth,
  pickWillSplit,
  generateChildPositions,
} from '../src/split.js';
import { BallKind } from '../src/ball.js';

// Deterministic RNG for reproducible probabilistic tests.
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

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ─── pickSplitChildCount ────────────────────────────────────────────────────

describe('pickSplitChildCount', () => {
  it('depth 1: returns 2 or 3', () => {
    for (let s = 0; s < 30; s++) {
      const n = pickSplitChildCount(1, mulberry32(s));
      expect([2, 3]).toContain(n);
    }
  });

  it('depth 1: ~33% of the time returns 3 (probabilistic sanity)', () => {
    let threes = 0;
    const N = 1000;
    for (let s = 0; s < N; s++) {
      if (pickSplitChildCount(1, mulberry32(s)) === 3) threes++;
    }
    // Loose bracket — anywhere from 25% to 42% counts as "around 33%".
    expect(threes / N).toBeGreaterThan(0.25);
    expect(threes / N).toBeLessThan(0.42);
  });

  it('depth 2: always returns 2 (no third-child variance)', () => {
    for (let s = 0; s < 50; s++) {
      expect(pickSplitChildCount(2, mulberry32(s))).toBe(2);
    }
  });

  it('depth >2 also returns 2 (deeper depths capped)', () => {
    expect(pickSplitChildCount(3, mulberry32(1))).toBe(2);
    expect(pickSplitChildCount(99, mulberry32(1))).toBe(2);
  });

  it('is deterministic with the same seeded rng', () => {
    const a = pickSplitChildCount(1, mulberry32(42));
    const b = pickSplitChildCount(1, mulberry32(42));
    expect(a).toBe(b);
  });
});

// ─── pickSplitChildCount — { deterministic } opt (refined spec) ────────────
//
// The refined difficulty design adds a `deterministic` flag so r4–7 callers
// can pin childCount to 2 (no luck-driven 33% "extra third child") while r8+
// callers keep the random 2-or-3 behavior. Tests assert both paths and
// verify the flag short-circuits before consuming any RNG output.

describe('pickSplitChildCount — { deterministic } flag', () => {
  it('depth 1 with deterministic:true ALWAYS returns 2 (no rng roll)', () => {
    // Drive 100 different seeds — the random branch would land on 3 some of
    // the time; deterministic:true must override every roll.
    for (let s = 0; s < 100; s++) {
      const n = pickSplitChildCount(1, mulberry32(s), { deterministic: true });
      expect(n).toBe(2);
    }
  });

  it('depth 1 with deterministic:true does not consume the rng', () => {
    // Hard guarantee: the deterministic short-circuit must NOT advance the
    // rng pointer, otherwise callers downstream of pickSplitChildCount would
    // get different rolls depending on the flag — that breaks seeded tests.
    let calls = 0;
    const rng = () => {
      calls += 1;
      return 0.0; // would always trigger the "3 children" branch
    };
    pickSplitChildCount(1, rng, { deterministic: true });
    expect(calls).toBe(0);
  });

  it('depth 1 with deterministic:false matches the legacy random behavior (~33% threes)', () => {
    let threes = 0;
    const N = 1000;
    for (let s = 0; s < N; s++) {
      if (pickSplitChildCount(1, mulberry32(s), { deterministic: false }) === 3) threes++;
    }
    expect(threes / N).toBeGreaterThan(0.25);
    expect(threes / N).toBeLessThan(0.42);
  });

  it('omitting opts is identical to deterministic:false (backward compat)', () => {
    // Existing callers (and the existing legacy test above) pass no opts —
    // this is the same as the refined "r8+" path. Guard against accidental
    // contract drift on the opts default.
    let withFlag = 0;
    let withoutFlag = 0;
    const N = 500;
    for (let s = 0; s < N; s++) {
      if (pickSplitChildCount(1, mulberry32(s), { deterministic: false }) === 3) withFlag++;
      if (pickSplitChildCount(1, mulberry32(s)) === 3) withoutFlag++;
    }
    // Must agree exactly when seeded identically — same rolls, same outcomes.
    expect(withFlag).toBe(withoutFlag);
  });

  it('depth 2 with deterministic:true also returns 2 (depth>=2 short-circuit)', () => {
    // The depth>=2 short-circuit is independent of the deterministic flag.
    expect(pickSplitChildCount(2, mulberry32(1), { deterministic: true })).toBe(2);
    expect(pickSplitChildCount(99, mulberry32(1), { deterministic: true })).toBe(2);
  });

  it('depth 2 with deterministic:false also returns 2 (cap dominates)', () => {
    // Even with the random path enabled, depth>=2 always caps at 2.
    for (let s = 0; s < 30; s++) {
      expect(pickSplitChildCount(2, mulberry32(s), { deterministic: false })).toBe(2);
    }
  });
});

// ─── childKindForDepth ──────────────────────────────────────────────────────

describe('childKindForDepth', () => {
  it('depth 1 → SPLIT_L1', () => {
    expect(childKindForDepth(1)).toBe(BallKind.SPLIT_L1);
  });

  it('depth 2 → SPLIT_L2', () => {
    expect(childKindForDepth(2)).toBe(BallKind.SPLIT_L2);
  });

  it('depth 0 → PRIMARY (defensive default)', () => {
    expect(childKindForDepth(0)).toBe(BallKind.PRIMARY);
  });

  it('depth >2 falls back to SPLIT_L2 (cap)', () => {
    expect(childKindForDepth(3)).toBe(BallKind.SPLIT_L2);
    expect(childKindForDepth(99)).toBe(BallKind.SPLIT_L2);
  });
});

// ─── pickWillSplit ──────────────────────────────────────────────────────────

describe('pickWillSplit', () => {
  it('returns a Set', () => {
    expect(pickWillSplit([1, 2, 3], 1, mulberry32(1))).toBeInstanceOf(Set);
  });

  it('returns the requested number when count <= pool.length', () => {
    const out = pickWillSplit([1, 2, 3, 4, 5], 2, mulberry32(7));
    expect(out.size).toBe(2);
  });

  it('returns the whole pool when count > pool.length', () => {
    const pool = [1, 2, 3];
    const out = pickWillSplit(pool, 99, mulberry32(7));
    expect(out.size).toBe(3);
    expect([...out].sort()).toEqual([1, 2, 3]);
  });

  it('returns empty Set when count <= 0', () => {
    expect(pickWillSplit([1, 2, 3], 0).size).toBe(0);
    expect(pickWillSplit([1, 2, 3], -5).size).toBe(0);
  });

  it('returns empty Set when pool is empty', () => {
    expect(pickWillSplit([], 5).size).toBe(0);
  });

  it('every pick is a member of the candidate pool', () => {
    const pool = [10, 20, 30, 40, 50];
    for (let s = 0; s < 20; s++) {
      const out = pickWillSplit(pool, 3, mulberry32(s));
      for (const id of out) {
        expect(pool).toContain(id);
      }
    }
  });

  it('is deterministic with the same seeded rng', () => {
    const a = pickWillSplit([1, 2, 3, 4, 5], 2, mulberry32(123));
    const b = pickWillSplit([1, 2, 3, 4, 5], 2, mulberry32(123));
    expect([...a].sort()).toEqual([...b].sort());
  });

  it('produces varied selections across seeds (not always the same id)', () => {
    const pool = [1, 2, 3, 4, 5, 6, 7, 8];
    const seenFirsts = new Set();
    for (let s = 0; s < 30; s++) {
      const out = pickWillSplit(pool, 1, mulberry32(s));
      seenFirsts.add([...out][0]);
    }
    expect(seenFirsts.size).toBeGreaterThan(2);
  });

  it('accepts iterables (Set), not just arrays', () => {
    const out = pickWillSplit(new Set([10, 20, 30]), 2, mulberry32(1));
    expect(out.size).toBe(2);
    for (const id of out) expect([10, 20, 30]).toContain(id);
  });

  it('does not mutate the input array', () => {
    const pool = [1, 2, 3, 4, 5];
    const before = [...pool];
    pickWillSplit(pool, 3, mulberry32(99));
    expect(pool).toEqual(before);
  });
});

// ─── generateChildPositions ─────────────────────────────────────────────────

describe('generateChildPositions', () => {
  const PARENT = { x: 0, y: 0, z: 0 };

  it('returns the requested number of positions', () => {
    for (const n of [1, 2, 3, 4]) {
      const out = generateChildPositions(PARENT, n, { rng: mulberry32(n) });
      expect(out).toHaveLength(n);
    }
  });

  it('returns an empty array when count = 0', () => {
    expect(generateChildPositions(PARENT, 0, { rng: mulberry32(1) })).toEqual([]);
  });

  it('all positions are within (spread + clamp tolerance) of parent', () => {
    const spread = 1.6;
    const out = generateChildPositions(PARENT, 3, {
      spread,
      rng: mulberry32(42),
    });
    for (const p of out) {
      // Even after relaxation/clamping a child should land within ~spread+0.1 of parent.
      expect(dist(p, PARENT)).toBeLessThanOrEqual(spread + 0.5);
    }
  });

  it('respects pairwise minDistance when feasible', () => {
    const minDistance = 0.7;
    const out = generateChildPositions(PARENT, 3, {
      minDistance,
      spread: 2.5, // generous spread → no relaxation needed
      rng: mulberry32(7),
    });
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        expect(dist(out[i], out[j])).toBeGreaterThan(minDistance * 0.7); // some relax tolerance
      }
    }
  });

  it('clamps positions to the configured bounds', () => {
    const bounds = { x: [-1, 1], y: [-1, 1], z: [-1, 1] };
    const out = generateChildPositions(
      { x: 0.95, y: 0.95, z: 0.95 }, // near corner → spread will push outside
      3,
      { bounds, spread: 5, rng: mulberry32(1) },
    );
    for (const p of out) {
      expect(p.x).toBeGreaterThanOrEqual(bounds.x[0]);
      expect(p.x).toBeLessThanOrEqual(bounds.x[1]);
      expect(p.y).toBeGreaterThanOrEqual(bounds.y[0]);
      expect(p.y).toBeLessThanOrEqual(bounds.y[1]);
      expect(p.z).toBeGreaterThanOrEqual(bounds.z[0]);
      expect(p.z).toBeLessThanOrEqual(bounds.z[1]);
    }
  });

  it('avoids obstacles when room exists', () => {
    const obstacle = { x: 0.5, y: 0, z: 0 };
    const out = generateChildPositions(PARENT, 3, {
      obstacles: [obstacle],
      minDistance: 0.5,
      spread: 2.5,
      rng: mulberry32(11),
    });
    for (const p of out) {
      expect(dist(p, obstacle)).toBeGreaterThan(0.3); // some tolerance for relaxation
    }
  });

  it('terminates even when obstacles + bounds make placement nearly impossible', () => {
    // Tiny bounds, parent + obstacle filling them.
    const start = Date.now();
    const out = generateChildPositions(PARENT, 3, {
      bounds: { x: [-0.1, 0.1], y: [-0.1, 0.1], z: [0, 0.1] },
      obstacles: [{ x: 0, y: 0, z: 0 }],
      minDistance: 1.0, // impossible
      maxTries: 10,
      rng: mulberry32(3),
    });
    const elapsed = Date.now() - start;
    expect(out).toHaveLength(3);
    expect(elapsed).toBeLessThan(500);
  });

  it('is deterministic with the same seeded rng', () => {
    const a = generateChildPositions(PARENT, 3, { rng: mulberry32(99) });
    const b = generateChildPositions(PARENT, 3, { rng: mulberry32(99) });
    expect(a).toEqual(b);
  });

  it('produces different layouts across seeds (probabilistic sanity)', () => {
    const layouts = new Set();
    for (let s = 0; s < 10; s++) {
      const out = generateChildPositions(PARENT, 2, { rng: mulberry32(s) });
      layouts.add(JSON.stringify(out));
    }
    expect(layouts.size).toBeGreaterThan(5);
  });
});
