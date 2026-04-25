// Split-mechanic helpers — pure logic, no Three.js, no game-state coupling.
//
// Used by game.js to decide who splits and by main.js to choose where the
// children land. Kept separate so it can be unit-tested in isolation and
// reused by Phase 5 (Calm Index gives a separate score multiplier for
// successful split-recall).

import { BallKind } from './ball.js';

/**
 * Number of children spawned by a single split, given depth + rng.
 * - depth 1 splits: 2 or 3 children (most rounds 2; ~33% chance of 3).
 * - depth 2 splits: always 2 children (keep total ball count manageable).
 */
export function pickSplitChildCount(depth, rng = Math.random) {
  if (depth >= 2) return 2;
  return rng() < 0.33 ? 3 : 2;
}

/**
 * Map a parent depth to the BallKind its children should use.
 * Depth 1 children = SPLIT_L1, depth 2 children = SPLIT_L2.
 */
export function childKindForDepth(depth) {
  if (depth === 1) return BallKind.SPLIT_L1;
  if (depth >= 2) return BallKind.SPLIT_L2;
  return BallKind.PRIMARY;
}

/**
 * From the population of `candidateIds`, pick `count` ids that should
 * themselves split when clicked. Uses the shared rng so seeded tests are
 * deterministic.
 *
 * @param {Iterable<number>} candidateIds   eligible ball ids
 * @param {number} count                    how many to select
 * @param {() => number} [rng]
 * @returns {Set<number>}
 */
export function pickWillSplit(candidateIds, count, rng = Math.random) {
  const pool = [...candidateIds];
  if (count <= 0 || pool.length === 0) return new Set();
  // Fisher-Yates partial shuffle — we only need the first `count`.
  const picks = Math.min(count, pool.length);
  for (let i = 0; i < picks; i++) {
    const j = i + Math.floor(rng() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return new Set(pool.slice(0, picks));
}

/**
 * Generate `count` positions for split children near the parent, separated
 * by `minDistance` from each other and from any `obstacles` (existing
 * non-shattered ball positions). Children land within `spread` units of the
 * parent so they feel like a burst, not a teleport.
 *
 * @param {{x:number,y:number,z:number}} parentPos
 * @param {number} count
 * @param {object} [opts]
 * @param {number} [opts.spread]       max radial distance from parent (units)
 * @param {number} [opts.minDistance]  min spacing between children
 * @param {number} [opts.maxTries]
 * @param {Array<{x:number,y:number,z:number}>} [opts.obstacles]
 * @param {{x:[number,number],y:[number,number],z:[number,number]}} [opts.bounds]
 * @param {() => number} [opts.rng]
 */
export function generateChildPositions(parentPos, count, opts = {}) {
  const spread = opts.spread ?? 1.6;
  let minDistance = opts.minDistance ?? 0.7;
  const maxTries = opts.maxTries ?? 60;
  const obstacles = opts.obstacles ?? [];
  const bounds = opts.bounds ?? {
    x: [-5.5, 5.5],
    y: [-3.2, 3.2],
    z: [-2.5, 2.5],
  };
  const rng = opts.rng ?? Math.random;

  const placed = [];

  function clampToBounds(p) {
    return {
      x: Math.max(bounds.x[0], Math.min(bounds.x[1], p.x)),
      y: Math.max(bounds.y[0], Math.min(bounds.y[1], p.y)),
      z: Math.max(bounds.z[0], Math.min(bounds.z[1], p.z)),
    };
  }

  function dist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  for (let i = 0; i < count; i++) {
    let attempts = 0;
    let candidate = null;

    while (true) {
      // Random direction in a sphere around the parent, distance in [0.6, spread].
      const theta = rng() * Math.PI * 2;
      const phi = Math.acos(2 * rng() - 1);
      const r = 0.6 + rng() * (spread - 0.6);
      const raw = {
        x: parentPos.x + r * Math.sin(phi) * Math.cos(theta),
        y: parentPos.y + r * Math.sin(phi) * Math.sin(theta),
        z: parentPos.z + r * Math.cos(phi),
      };
      candidate = clampToBounds(raw);

      const tooClose =
        placed.some((p) => dist(p, candidate) < minDistance) ||
        obstacles.some((p) => dist(p, candidate) < minDistance);

      if (!tooClose) break;
      if (++attempts >= maxTries) {
        minDistance *= 0.85; // relax + accept
        attempts = 0;
        if (minDistance < 0.2) break;
      }
    }

    placed.push(candidate);
  }

  return placed;
}
