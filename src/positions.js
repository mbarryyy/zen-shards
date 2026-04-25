// Position generator — Poisson-like disk sampling within the visible volume.
// Returns Vec3-like {x,y,z} objects so this module stays test-friendly without
// dragging in Three.js.

const DEFAULT_BOUNDS = {
  x: [-5, 5],
  y: [-3, 3],
  z: [-2, 2],
};

const DEFAULT_MIN_DISTANCE = 1.6;
const DEFAULT_MAX_TRIES = 80;

function randomInRange([min, max], rng) {
  return min + (max - min) * rng();
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Generate `count` non-overlapping positions inside the configured bounds.
 *
 * @param {number} count
 * @param {object} [opts]
 * @param {{x:[number,number], y:[number,number], z:[number,number]}} [opts.bounds]
 * @param {number} [opts.minDistance] minimum centre-to-centre spacing
 * @param {number} [opts.maxTries] max attempts per ball before relaxing distance
 * @param {() => number} [opts.rng] custom RNG (defaults to Math.random)
 * @returns {Array<{x:number,y:number,z:number}>}
 */
export function generatePositions(count, opts = {}) {
  const bounds = opts.bounds ?? DEFAULT_BOUNDS;
  const baseMinDistance = opts.minDistance ?? DEFAULT_MIN_DISTANCE;
  const maxTries = opts.maxTries ?? DEFAULT_MAX_TRIES;
  const rng = opts.rng ?? Math.random;

  const positions = [];
  let minDistance = baseMinDistance;

  for (let i = 0; i < count; i++) {
    let placed = false;
    let attempts = 0;
    let candidate = null;

    while (!placed) {
      candidate = {
        x: randomInRange(bounds.x, rng),
        y: randomInRange(bounds.y, rng),
        z: randomInRange(bounds.z, rng),
      };

      const ok = positions.every((p) => distance(p, candidate) >= minDistance);
      if (ok) {
        placed = true;
      } else if (++attempts >= maxTries) {
        // Relax constraint instead of looping forever — keeps the generator
        // robust for high ball counts in tight bounds.
        minDistance *= 0.85;
        attempts = 0;
      }
    }

    positions.push(candidate);
  }

  return positions;
}

export { DEFAULT_BOUNDS, DEFAULT_MIN_DISTANCE };
