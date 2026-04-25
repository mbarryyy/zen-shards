// Tests for src/shatter.js — the glass shatter effect.
//
// Covers: spawn count + bounds, mesh insertion into the scene, lifetime
// expiry, object-pool reuse (no allocation churn), guards against bad input,
// dispose cleanup, the DOM ripple lifecycle, and the reduced-motion path.
//
// Three.js works under jsdom (we just don't render). Time is advanced via
// repeated update(dt) calls rather than wall-clock waits — fast and
// deterministic.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import { ShatterEffect, _internal } from '../src/shatter.js';

const POSITION = { x: 1, y: 2, z: 3 };
const COLOR = 0xe8f5d0;
const RADIUS = 0.55;

function makeScene() {
  return new THREE.Scene();
}

/** Advance the effect by `seconds`, in steps no bigger than 16ms (~60fps). */
function advance(effect, seconds) {
  const stepDt = 1 / 60;
  let remaining = seconds;
  while (remaining > 0) {
    const dt = Math.min(stepDt, remaining);
    effect.update(dt);
    remaining -= dt;
  }
}

describe('ShatterEffect — construction', () => {
  it('throws when scene is missing', () => {
    expect(() => new ShatterEffect({})).toThrow(/scene/i);
    expect(() => new ShatterEffect()).toThrow(/scene/i);
  });

  it('starts empty: no shards alive, no pool allocated', () => {
    const fx = new ShatterEffect({ scene: makeScene() });
    expect(fx.activeCount).toBe(0);
    expect(fx.poolSize).toBe(0);
  });

  it('does not add anything to the scene before spawn', () => {
    const scene = makeScene();
    const initial = scene.children.length;
    new ShatterEffect({ scene });
    expect(scene.children.length).toBe(initial);
  });
});

describe('ShatterEffect.spawn — counts + scene insertion', () => {
  let scene, fx;

  beforeEach(() => {
    scene = makeScene();
    fx = new ShatterEffect({ scene, disableRipple: true });
  });

  it('spawns between SHARDS_MIN and SHARDS_MAX shards', () => {
    const count = fx.spawn(POSITION, COLOR, RADIUS);
    expect(count).toBeGreaterThanOrEqual(_internal.SHARDS_MIN);
    expect(count).toBeLessThanOrEqual(_internal.SHARDS_MAX);
    expect(fx.activeCount).toBe(count);
  });

  it('count is consistent across many spawns (always within bounds)', () => {
    for (let i = 0; i < 30; i++) {
      const fresh = new ShatterEffect({ scene: makeScene(), disableRipple: true });
      const n = fresh.spawn(POSITION, COLOR, RADIUS);
      expect(n).toBeGreaterThanOrEqual(_internal.SHARDS_MIN);
      expect(n).toBeLessThanOrEqual(_internal.SHARDS_MAX);
      fresh.dispose();
    }
  });

  it('adds shard meshes to the scene graph', () => {
    const before = scene.children.length;
    const count = fx.spawn(POSITION, COLOR, RADIUS);
    expect(scene.children.length - before).toBe(count);
    // Every added child should be a Mesh.
    for (const child of scene.children.slice(before)) {
      expect(child.isMesh).toBe(true);
    }
  });

  it('positions shards near the spawn point (within an offset of radius)', () => {
    fx.spawn(POSITION, COLOR, RADIUS);
    for (const child of scene.children) {
      // SPAWN_OFFSET is 0.7 of scale, max scale = 0.55 * RADIUS — so
      // each axis offset is bounded by ~ 0.5 * 0.7 * 0.55 * 0.55 ≈ 0.1.
      expect(Math.abs(child.position.x - POSITION.x)).toBeLessThan(0.5);
      expect(Math.abs(child.position.y - POSITION.y)).toBeLessThan(0.5);
      expect(Math.abs(child.position.z - POSITION.z)).toBeLessThan(0.5);
    }
  });

  it('makes spawned meshes visible', () => {
    fx.spawn(POSITION, COLOR, RADIUS);
    for (const child of scene.children) {
      expect(child.visible).toBe(true);
    }
  });

  it('uses the ball color (mixed with white) for shard material', () => {
    fx.spawn(POSITION, COLOR, RADIUS);
    // Each shard color should have lerped 35% toward white from #e8f5d0.
    // Just sanity-check that the channels are in the upper-light range and
    // not the default white (0xffffff) or black.
    for (const child of scene.children) {
      const c = child.material.color;
      expect(c.r).toBeGreaterThan(0.85);
      expect(c.g).toBeGreaterThan(0.85);
      expect(c.b).toBeGreaterThan(0.6);
      // Not pure white — color was tinted from a non-white source
      expect(c.r === 1 && c.g === 1 && c.b === 1).toBe(false);
    }
  });

  it('shard scale is proportional to ball radius', () => {
    const big = new ShatterEffect({ scene: makeScene(), disableRipple: true });
    const small = new ShatterEffect({ scene: makeScene(), disableRipple: true });
    big.spawn(POSITION, COLOR, 1.0);
    small.spawn(POSITION, COLOR, 0.2);
    const bigAvg =
      big.scene.children.reduce((s, c) => s + c.scale.x, 0) /
      big.scene.children.length;
    const smallAvg =
      small.scene.children.reduce((s, c) => s + c.scale.x, 0) /
      small.scene.children.length;
    expect(bigAvg).toBeGreaterThan(smallAvg);
    // Roughly 5× bigger on average (radius ratio is 5).
    expect(bigAvg / smallAvg).toBeGreaterThan(2.5);
  });
});

describe('ShatterEffect.spawn — bad input is non-fatal', () => {
  let scene, fx;

  beforeEach(() => {
    scene = makeScene();
    fx = new ShatterEffect({ scene, disableRipple: true });
  });

  it('returns 0 and is a no-op when position is null', () => {
    expect(fx.spawn(null, COLOR, RADIUS)).toBe(0);
    expect(fx.activeCount).toBe(0);
  });

  it('treats invalid radius as a sane default (no NaN scales)', () => {
    fx.spawn(POSITION, COLOR, -1);
    for (const child of scene.children) {
      expect(Number.isFinite(child.scale.x)).toBe(true);
      expect(child.scale.x).toBeGreaterThan(0);
    }
  });

  it('treats non-numeric color as white (no crash, valid color object)', () => {
    fx.spawn(POSITION, 'not-a-color', RADIUS);
    for (const child of scene.children) {
      expect(child.material.color.isColor).toBe(true);
    }
  });

  it('accepts a THREE.Vector3 as position', () => {
    const v = new THREE.Vector3(5, 6, 7);
    const count = fx.spawn(v, COLOR, RADIUS);
    expect(count).toBeGreaterThan(0);
    for (const child of scene.children) {
      expect(Math.abs(child.position.x - 5)).toBeLessThan(0.5);
    }
  });
});

describe('ShatterEffect.update — lifecycle + cleanup', () => {
  let scene, fx;

  beforeEach(() => {
    scene = makeScene();
    fx = new ShatterEffect({ scene, disableRipple: true });
  });

  it('shards stay alive at half their lifetime', () => {
    fx.spawn(POSITION, COLOR, RADIUS);
    const initial = fx.activeCount;
    advance(fx, _internal.LIFETIME_S * 0.5);
    expect(fx.activeCount).toBe(initial);
  });

  it('shards retire by full lifetime + a frame of slack', () => {
    fx.spawn(POSITION, COLOR, RADIUS);
    advance(fx, _internal.LIFETIME_S + 0.05);
    expect(fx.activeCount).toBe(0);
  });

  it('retired shards are hidden but kept in the scene graph (pooled)', () => {
    fx.spawn(POSITION, COLOR, RADIUS);
    const inSceneBefore = scene.children.length;
    advance(fx, _internal.LIFETIME_S + 0.05);
    // Pool keeps the meshes for reuse; they're just hidden.
    expect(scene.children.length).toBe(inSceneBefore);
    for (const child of scene.children) {
      expect(child.visible).toBe(false);
    }
  });

  it('shard opacity reaches ~0 by the end of life', () => {
    fx.spawn(POSITION, COLOR, RADIUS);
    advance(fx, _internal.LIFETIME_S + 0.05);
    for (const child of scene.children) {
      expect(child.material.opacity).toBeLessThanOrEqual(0.05);
    }
  });

  it('shards translate over time when motion is enabled', () => {
    fx.spawn(POSITION, COLOR, RADIUS);
    const initial = scene.children.map((c) => c.position.clone());
    advance(fx, 0.1);
    // At least one shard should have measurably moved.
    let movedCount = 0;
    for (let i = 0; i < scene.children.length; i++) {
      if (scene.children[i].position.distanceTo(initial[i]) > 0.05) movedCount++;
    }
    expect(movedCount).toBeGreaterThan(0);
  });

  it('shards rotate over time when motion is enabled', () => {
    fx.spawn(POSITION, COLOR, RADIUS);
    const initial = scene.children.map((c) => ({
      x: c.rotation.x,
      y: c.rotation.y,
      z: c.rotation.z,
    }));
    advance(fx, 0.2);
    let rotatedCount = 0;
    for (let i = 0; i < scene.children.length; i++) {
      const r = scene.children[i].rotation;
      const r0 = initial[i];
      const delta =
        Math.abs(r.x - r0.x) + Math.abs(r.y - r0.y) + Math.abs(r.z - r0.z);
      if (delta > 0.1) rotatedCount++;
    }
    expect(rotatedCount).toBeGreaterThan(0);
  });

  it('update is safe with no live shards', () => {
    expect(() => advance(fx, 0.5)).not.toThrow();
    expect(fx.activeCount).toBe(0);
  });

  it('ignores invalid dt (NaN, negative, zero)', () => {
    fx.spawn(POSITION, COLOR, RADIUS);
    const before = fx.activeCount;
    expect(() => fx.update(NaN)).not.toThrow();
    expect(() => fx.update(-1)).not.toThrow();
    expect(() => fx.update(0)).not.toThrow();
    expect(fx.activeCount).toBe(before);
  });
});

describe('ShatterEffect — object pool reuse', () => {
  let scene, fx, randomSpy;

  beforeEach(() => {
    scene = makeScene();
    fx = new ShatterEffect({ scene, disableRipple: true });
    // Lock Math.random to 0.999 so spawn() always picks the MAX shard count
    // (otherwise count varies in [10,15] per call → second spawn can request
    // more than the first, forcing a real allocation that's NOT a pool bug).
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.999);
  });

  afterEach(() => {
    randomSpy.mockRestore();
  });

  it('reuses pooled shards on second spawn — no allocation growth', () => {
    const first = fx.spawn(POSITION, COLOR, RADIUS);
    const firstPoolSize = fx.poolSize;
    expect(first).toBe(firstPoolSize);
    advance(fx, _internal.LIFETIME_S + 0.05);
    expect(fx.activeCount).toBe(0);

    const second = fx.spawn(POSITION, COLOR, RADIUS);
    expect(second).toBe(first); // same count — locked RNG
    expect(fx.poolSize).toBe(firstPoolSize); // no growth
  });

  it('pool is bounded by POOL_CAP under sustained spawning', () => {
    // Spawn 20 bursts — at 15 shards each that's 300 attempted, but cap
    // keeps the pool at POOL_CAP (60).
    for (let i = 0; i < 20; i++) {
      fx.spawn(POSITION, COLOR, RADIUS);
    }
    expect(fx.poolSize).toBeLessThanOrEqual(_internal.POOL_CAP);
  });

  it('pool grows only as needed (one burst < cap)', () => {
    const count = fx.spawn(POSITION, COLOR, RADIUS);
    expect(fx.poolSize).toBe(count);
    expect(fx.poolSize).toBeLessThanOrEqual(_internal.POOL_CAP);
  });

  it('reuses the same Mesh objects after retire (mesh identity preserved)', () => {
    fx.spawn(POSITION, COLOR, RADIUS);
    const firstMeshes = new Set(scene.children);
    advance(fx, _internal.LIFETIME_S + 0.05);
    fx.spawn(POSITION, COLOR, RADIUS);
    // Every newly active mesh should be one of the original meshes.
    for (const child of scene.children) {
      if (child.visible) expect(firstMeshes.has(child)).toBe(true);
    }
  });

  it('overlapping spawns (second before first retires) still respect pool cap', () => {
    fx.spawn(POSITION, COLOR, RADIUS);
    advance(fx, _internal.LIFETIME_S * 0.3); // first burst still alive
    fx.spawn(POSITION, COLOR, RADIUS);
    // Both bursts alive concurrently — pool grew to fit both, but stayed
    // under the cap.
    expect(fx.poolSize).toBeLessThanOrEqual(_internal.POOL_CAP);
    expect(fx.activeCount).toBeLessThanOrEqual(_internal.POOL_CAP);
    expect(fx.activeCount).toBeGreaterThan(_internal.SHARDS_MAX); // > one burst
  });
});

describe('ShatterEffect.dispose', () => {
  it('removes all shard meshes from the scene', () => {
    const scene = makeScene();
    const fx = new ShatterEffect({ scene, disableRipple: true });
    fx.spawn(POSITION, COLOR, RADIUS);
    expect(scene.children.length).toBeGreaterThan(0);
    fx.dispose();
    expect(scene.children.length).toBe(0);
  });

  it('resets pool + active counts', () => {
    const fx = new ShatterEffect({ scene: makeScene(), disableRipple: true });
    fx.spawn(POSITION, COLOR, RADIUS);
    fx.dispose();
    expect(fx.poolSize).toBe(0);
    expect(fx.activeCount).toBe(0);
  });

  it('disposes shard geometries + materials', () => {
    const scene = makeScene();
    const fx = new ShatterEffect({ scene, disableRipple: true });
    fx.spawn(POSITION, COLOR, RADIUS);
    const disposedGeoms = new Set();
    const disposedMats = new Set();
    for (const child of scene.children) {
      child.geometry.addEventListener('dispose', () =>
        disposedGeoms.add(child.geometry),
      );
      child.material.addEventListener('dispose', () =>
        disposedMats.add(child.material),
      );
    }
    const expected = scene.children.length;
    fx.dispose();
    expect(disposedGeoms.size).toBe(expected);
    expect(disposedMats.size).toBe(expected);
  });
});

describe('ShatterEffect — DOM ripple', () => {
  let scene, parent, fx;

  beforeEach(() => {
    scene = makeScene();
    parent = document.createElement('div');
    document.body.appendChild(parent);
    fx = new ShatterEffect({ scene, rippleParent: parent });
  });

  afterEach(() => parent.remove());

  it('appends a ripple element on spawn', () => {
    expect(parent.children.length).toBe(0);
    fx.spawn(POSITION, COLOR, RADIUS);
    expect(parent.children.length).toBe(1);
    const ripple = parent.children[0];
    expect(ripple.tagName).toBe('DIV');
    expect(ripple.style.pointerEvents).toBe('none');
  });

  it('ripple is aria-hidden so screen readers ignore it', () => {
    fx.spawn(POSITION, COLOR, RADIUS);
    const ripple = parent.children[0];
    expect(ripple.getAttribute('aria-hidden')).toBe('true');
  });

  it('ripple is removed after its lifetime', async () => {
    vi.useFakeTimers();
    try {
      fx.spawn(POSITION, COLOR, RADIUS);
      expect(parent.children.length).toBe(1);
      vi.advanceTimersByTime(_internal.RIPPLE_LIFETIME_MS + 200);
      expect(parent.children.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disableRipple suppresses the DOM element entirely', () => {
    const noRipple = new ShatterEffect({
      scene: makeScene(),
      rippleParent: parent,
      disableRipple: true,
    });
    noRipple.spawn(POSITION, COLOR, RADIUS);
    expect(parent.children.length).toBe(0);
  });
});

describe('ShatterEffect — reduced motion', () => {
  let originalMatchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    window.matchMedia = (q) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    });
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('shards have zero velocity (no flying motion)', () => {
    const scene = makeScene();
    const fx = new ShatterEffect({ scene, disableRipple: true });
    fx.spawn(POSITION, COLOR, RADIUS);
    const initialPositions = scene.children.map((c) => c.position.clone());
    advance(fx, 0.2);
    for (let i = 0; i < scene.children.length; i++) {
      if (!scene.children[i].visible) continue;
      // Positions should not have meaningfully changed.
      expect(scene.children[i].position.distanceTo(initialPositions[i])).toBeLessThan(
        0.01,
      );
    }
  });

  it('suppresses the DOM ripple', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const fx = new ShatterEffect({
      scene: makeScene(),
      rippleParent: parent,
    });
    fx.spawn(POSITION, COLOR, RADIUS);
    expect(parent.children.length).toBe(0);
    parent.remove();
  });

  it('shards still fade out within lifetime (visual feedback preserved)', () => {
    const scene = makeScene();
    const fx = new ShatterEffect({ scene, disableRipple: true });
    fx.spawn(POSITION, COLOR, RADIUS);
    advance(fx, _internal.LIFETIME_S + 0.05);
    expect(fx.activeCount).toBe(0);
  });
});

// ─── softPuff (split mechanic visual) ──────────────────────────────────────

describe('ShatterEffect.softPuff — basic lifecycle (mirrors spawn)', () => {
  let scene, fx;

  beforeEach(() => {
    scene = makeScene();
    fx = new ShatterEffect({ scene, disableRipple: true });
  });

  it('returns a count in [SHARDS_MIN, SHARDS_MAX]', () => {
    const count = fx.softPuff(POSITION, COLOR, RADIUS);
    expect(count).toBeGreaterThanOrEqual(_internal.SHARDS_MIN);
    expect(count).toBeLessThanOrEqual(_internal.SHARDS_MAX);
    expect(fx.activeCount).toBe(count);
  });

  it('adds shard meshes to the scene graph', () => {
    const before = scene.children.length;
    const count = fx.softPuff(POSITION, COLOR, RADIUS);
    expect(scene.children.length - before).toBe(count);
    for (const child of scene.children.slice(before)) {
      expect(child.isMesh).toBe(true);
    }
  });

  it('positions shards near the spawn point', () => {
    fx.softPuff(POSITION, COLOR, RADIUS);
    for (const child of scene.children) {
      expect(Math.abs(child.position.x - POSITION.x)).toBeLessThan(0.5);
      expect(Math.abs(child.position.y - POSITION.y)).toBeLessThan(0.5);
      expect(Math.abs(child.position.z - POSITION.z)).toBeLessThan(0.5);
    }
  });

  it('makes spawned meshes visible', () => {
    fx.softPuff(POSITION, COLOR, RADIUS);
    for (const child of scene.children) {
      expect(child.visible).toBe(true);
    }
  });

  it('shards retire after SOFT_PUFF_LIFETIME_S + frame slack', () => {
    fx.softPuff(POSITION, COLOR, RADIUS);
    advance(fx, _internal.SOFT_PUFF_LIFETIME_S + 0.05);
    expect(fx.activeCount).toBe(0);
  });

  it('shards stay alive at half their (shorter) lifetime', () => {
    fx.softPuff(POSITION, COLOR, RADIUS);
    const initial = fx.activeCount;
    advance(fx, _internal.SOFT_PUFF_LIFETIME_S * 0.5);
    expect(fx.activeCount).toBe(initial);
  });

  it('accepts THREE.Vector3 as position', () => {
    const v = new THREE.Vector3(5, 6, 7);
    const count = fx.softPuff(v, COLOR, RADIUS);
    expect(count).toBeGreaterThan(0);
    for (const child of scene.children) {
      expect(Math.abs(child.position.x - 5)).toBeLessThan(0.5);
    }
  });
});

describe('ShatterEffect.softPuff — bad input is non-fatal', () => {
  let scene, fx;

  beforeEach(() => {
    scene = makeScene();
    fx = new ShatterEffect({ scene, disableRipple: true });
  });

  it('returns 0 and is a no-op when position is null', () => {
    expect(fx.softPuff(null, COLOR, RADIUS)).toBe(0);
    expect(fx.activeCount).toBe(0);
  });

  it('treats invalid radius as a sane default (no NaN scales)', () => {
    fx.softPuff(POSITION, COLOR, -1);
    for (const child of scene.children) {
      expect(Number.isFinite(child.scale.x)).toBe(true);
      expect(child.scale.x).toBeGreaterThan(0);
    }
  });

  it('treats non-numeric color as white (no crash, valid color object)', () => {
    fx.softPuff(POSITION, 'not-a-color', RADIUS);
    for (const child of scene.children) {
      expect(child.material.color.isColor).toBe(true);
    }
  });
});

describe('ShatterEffect.softPuff — differentiators vs spawn', () => {
  it('does NOT append a halo ripple to the DOM (key behavioral diff)', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    try {
      const fx = new ShatterEffect({ scene: makeScene(), rippleParent: parent });
      fx.softPuff(POSITION, COLOR, RADIUS);
      expect(parent.children.length).toBe(0);
    } finally {
      parent.remove();
    }
  });

  it('softPuff suppresses ripple even when spawn would have shown one', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    try {
      // Spawn a control to verify the ripple machinery is wired.
      const ctl = new ShatterEffect({ scene: makeScene(), rippleParent: parent });
      ctl.spawn(POSITION, COLOR, RADIUS);
      expect(parent.children.length).toBe(1); // baseline: spawn adds ripple
      const baseline = parent.children.length;

      // Now softPuff to the same parent — should NOT add another.
      const fx = new ShatterEffect({ scene: makeScene(), rippleParent: parent });
      fx.softPuff(POSITION, COLOR, RADIUS);
      expect(parent.children.length).toBe(baseline); // unchanged
    } finally {
      parent.remove();
    }
  });

  it('softPuff lifetime is shorter than spawn lifetime', () => {
    // Sanity-check the constants themselves.
    expect(_internal.SOFT_PUFF_LIFETIME_S).toBeLessThan(_internal.LIFETIME_S);

    // And empirically: at a time between the two lifetimes, spawn shards
    // should still be alive while softPuff shards have retired.
    const sceneA = makeScene();
    const sceneB = makeScene();
    const spawnFx = new ShatterEffect({ scene: sceneA, disableRipple: true });
    const puffFx = new ShatterEffect({ scene: sceneB, disableRipple: true });

    spawnFx.spawn(POSITION, COLOR, RADIUS);
    puffFx.softPuff(POSITION, COLOR, RADIUS);

    // Halfway between SOFT_PUFF_LIFETIME and LIFETIME_S.
    const checkAt =
      (_internal.SOFT_PUFF_LIFETIME_S + _internal.LIFETIME_S) / 2;
    advance(spawnFx, checkAt);
    advance(puffFx, checkAt);

    expect(puffFx.activeCount).toBe(0); // soft puff done
    expect(spawnFx.activeCount).toBeGreaterThan(0); // spawn still flying
  });

  it('softPuff shards travel less distance than spawn shards over the same time', () => {
    // Use a Math.random mock to lock the burst count + direction-roll
    // sequence so both calls roll the same dirs/speeds — only velocityScale
    // differs. (Without this, RNG variance can invert the comparison.)
    const seed = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const sceneA = makeScene();
      const sceneB = makeScene();
      const spawnFx = new ShatterEffect({ scene: sceneA, disableRipple: true });
      const puffFx = new ShatterEffect({ scene: sceneB, disableRipple: true });

      spawnFx.spawn(POSITION, COLOR, RADIUS);
      const spawnInitial = sceneA.children.map((c) => c.position.clone());

      puffFx.softPuff(POSITION, COLOR, RADIUS);
      const puffInitial = sceneB.children.map((c) => c.position.clone());

      const dt = 0.1;
      advance(spawnFx, dt);
      advance(puffFx, dt);

      let spawnDispl = 0;
      for (let i = 0; i < sceneA.children.length; i++) {
        spawnDispl += sceneA.children[i].position.distanceTo(spawnInitial[i]);
      }
      let puffDispl = 0;
      for (let i = 0; i < sceneB.children.length; i++) {
        puffDispl += sceneB.children[i].position.distanceTo(puffInitial[i]);
      }

      expect(puffDispl).toBeLessThan(spawnDispl);
    } finally {
      seed.mockRestore();
    }
  });

  it('shares the pool with spawn (alternating uses one pool, not two)', () => {
    // Lock Math.random so spawn + softPuff request the same shard count
    // (otherwise the second call may roll higher and force a real allocation
    // — same flakiness pattern as the existing pool-reuse tests).
    const seed = vi.spyOn(Math, 'random').mockReturnValue(0.999);
    try {
      const fx = new ShatterEffect({ scene: makeScene(), disableRipple: true });
      fx.spawn(POSITION, COLOR, RADIUS);
      advance(fx, _internal.LIFETIME_S + 0.05);
      const poolAfterSpawn = fx.poolSize;

      fx.softPuff(POSITION, COLOR, RADIUS);
      advance(fx, _internal.SOFT_PUFF_LIFETIME_S + 0.05);
      // Pool didn't grow — softPuff reused dead shards from the spawn.
      expect(fx.poolSize).toBe(poolAfterSpawn);
    } finally {
      seed.mockRestore();
    }
  });
});

describe('ShatterEffect.softPuff — reduced motion', () => {
  let originalMatchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    window.matchMedia = (q) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    });
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('softPuff shards have ~zero velocity (no flying motion)', () => {
    const scene = makeScene();
    const fx = new ShatterEffect({ scene, disableRipple: true });
    fx.softPuff(POSITION, COLOR, RADIUS);
    const initialPositions = scene.children.map((c) => c.position.clone());
    advance(fx, 0.2);
    for (let i = 0; i < scene.children.length; i++) {
      if (!scene.children[i].visible) continue;
      expect(scene.children[i].position.distanceTo(initialPositions[i])).toBeLessThan(
        0.01,
      );
    }
  });

  it('softPuff still suppresses the ripple under reduced motion (no double-trigger)', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    try {
      const fx = new ShatterEffect({ scene: makeScene(), rippleParent: parent });
      fx.softPuff(POSITION, COLOR, RADIUS);
      expect(parent.children.length).toBe(0);
    } finally {
      parent.remove();
    }
  });
});

describe('ShatterEffect — _internal tunable exports (lock the surface)', () => {
  it('exposes all softPuff + tunable constants', () => {
    expect(_internal).toHaveProperty('SOFT_PUFF_VELOCITY_SCALE');
    expect(_internal).toHaveProperty('SOFT_PUFF_LIFETIME_S');
    expect(_internal).toHaveProperty('FADE_START_FRAC');
    expect(_internal).toHaveProperty('WHITE_TINT');
    expect(_internal).toHaveProperty('EMISSIVE_PEAK');
    expect(_internal).toHaveProperty('EMISSIVE_RM');
    expect(_internal).toHaveProperty('RIPPLE_ALPHA');
  });

  it('SOFT_PUFF_VELOCITY_SCALE is < 1 (the "softer than spawn" invariant)', () => {
    expect(_internal.SOFT_PUFF_VELOCITY_SCALE).toBeLessThan(1);
    expect(_internal.SOFT_PUFF_VELOCITY_SCALE).toBeGreaterThan(0);
  });

  it('SOFT_PUFF_LIFETIME_S is < LIFETIME_S (faster resolve invariant)', () => {
    expect(_internal.SOFT_PUFF_LIFETIME_S).toBeLessThan(_internal.LIFETIME_S);
  });

  it('FADE_START_FRAC is in (0, 1)', () => {
    expect(_internal.FADE_START_FRAC).toBeGreaterThan(0);
    expect(_internal.FADE_START_FRAC).toBeLessThan(1);
  });

  it('WHITE_TINT is in [0, 1] (color lerp amount)', () => {
    expect(_internal.WHITE_TINT).toBeGreaterThanOrEqual(0);
    expect(_internal.WHITE_TINT).toBeLessThanOrEqual(1);
  });

  it('RIPPLE_ALPHA is in (0, 1] (halo brightness)', () => {
    expect(_internal.RIPPLE_ALPHA).toBeGreaterThan(0);
    expect(_internal.RIPPLE_ALPHA).toBeLessThanOrEqual(1);
  });

  it('EMISSIVE_RM is < EMISSIVE_PEAK (reduced motion is dimmer)', () => {
    expect(_internal.EMISSIVE_RM).toBeLessThan(_internal.EMISSIVE_PEAK);
  });

  it('_internal is frozen', () => {
    expect(Object.isFrozen(_internal)).toBe(true);
  });
});
