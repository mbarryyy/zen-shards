// Tests for src/positions.js — Poisson-like position generator.
// Validates the utility used by Phase 1 ball placement.

import { describe, it, expect } from 'vitest';
import {
  generatePositions,
  DEFAULT_BOUNDS,
  DEFAULT_MIN_DISTANCE,
} from '../src/positions.js';

function pairwiseMinDistance(positions) {
  let minD = Infinity;
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const dx = positions[i].x - positions[j].x;
      const dy = positions[i].y - positions[j].y;
      const dz = positions[i].z - positions[j].z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < minD) minD = d;
    }
  }
  return minD;
}

function withinBounds(p, bounds) {
  return (
    p.x >= bounds.x[0] &&
    p.x <= bounds.x[1] &&
    p.y >= bounds.y[0] &&
    p.y <= bounds.y[1] &&
    p.z >= bounds.z[0] &&
    p.z <= bounds.z[1]
  );
}

// Deterministic RNG for reproducible tests
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

describe('generatePositions', () => {
  it('returns the requested number of positions', () => {
    for (const n of [1, 2, 3, 5, 8]) {
      const out = generatePositions(n, { rng: mulberry32(42 + n) });
      expect(out).toHaveLength(n);
    }
  });

  it('returns an empty array for count = 0', () => {
    expect(generatePositions(0)).toEqual([]);
  });

  it('produces positions inside the default bounds', () => {
    const out = generatePositions(8, { rng: mulberry32(7) });
    for (const p of out) {
      expect(withinBounds(p, DEFAULT_BOUNDS)).toBe(true);
    }
  });

  it('respects custom bounds', () => {
    const bounds = { x: [-1, 1], y: [-1, 1], z: [0, 0.5] };
    const out = generatePositions(4, {
      bounds,
      minDistance: 0.3,
      rng: mulberry32(11),
    });
    for (const p of out) {
      expect(withinBounds(p, bounds)).toBe(true);
    }
  });

  it('keeps balls separated by at least minDistance when feasible', () => {
    // Loose bounds + low ball count → no relaxation needed.
    const out = generatePositions(4, {
      minDistance: 1.5,
      rng: mulberry32(99),
    });
    expect(pairwiseMinDistance(out)).toBeGreaterThanOrEqual(1.5 - 1e-9);
  });

  it('does not loop forever when bounds are too tight (relaxes constraint)', () => {
    // Bounds smaller than the requested minDistance — must terminate.
    const start = Date.now();
    const out = generatePositions(8, {
      bounds: { x: [-0.5, 0.5], y: [-0.5, 0.5], z: [0, 0] },
      minDistance: 2.0,
      maxTries: 10,
      rng: mulberry32(3),
    });
    const elapsed = Date.now() - start;
    expect(out).toHaveLength(8);
    expect(elapsed).toBeLessThan(500);
  });

  it('is deterministic given the same seeded RNG', () => {
    const a = generatePositions(5, { rng: mulberry32(123) });
    const b = generatePositions(5, { rng: mulberry32(123) });
    expect(a).toEqual(b);
  });

  it('produces different layouts for different seeds', () => {
    const a = generatePositions(5, { rng: mulberry32(1) });
    const b = generatePositions(5, { rng: mulberry32(2) });
    expect(a).not.toEqual(b);
  });

  it('exposes sane defaults', () => {
    expect(DEFAULT_MIN_DISTANCE).toBeGreaterThan(0);
    expect(DEFAULT_BOUNDS.x[0]).toBeLessThan(DEFAULT_BOUNDS.x[1]);
    expect(DEFAULT_BOUNDS.y[0]).toBeLessThan(DEFAULT_BOUNDS.y[1]);
    expect(DEFAULT_BOUNDS.z[0]).toBeLessThan(DEFAULT_BOUNDS.z[1]);
  });

  it('handles the round-1 single-ball case', () => {
    const out = generatePositions(1, { rng: mulberry32(0) });
    expect(out).toHaveLength(1);
    expect(withinBounds(out[0], DEFAULT_BOUNDS)).toBe(true);
  });

  it('handles the max ball count from the spec (8 balls)', () => {
    const out = generatePositions(8, { rng: mulberry32(2026) });
    expect(out).toHaveLength(8);
    for (const p of out) {
      expect(withinBounds(p, DEFAULT_BOUNDS)).toBe(true);
    }
  });
});
