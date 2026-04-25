// Glass shatter effect — the signature visual moment of Zen Shards.
//
// When a ball is correctly clicked, ShatterEffect.spawn() is called with the
// ball's world position, base color, and radius. It releases 10–15 small
// tetrahedral shards from a pool, gives them outward + upward velocity with
// gravity and random spin, fades opacity 1→0 over 0.6s, then returns them to
// the pool.
//
// A short-lived radial-gradient overlay also pulses on the screen as a soft
// "rim ripple" — pure CSS, never steals clicks.
//
// Design constraints (per spec §3.2 + team-lead brief):
//   - Zen aesthetic: feels like glass dissolving, not exploding
//   - No transmission on shard material — too expensive for ~30 concurrent
//     meshes; emissive glow + roughness mimics glass cheaply
//   - prefers-reduced-motion: shards stay put, scale up + fade only,
//     screen ripple suppressed
//   - Color comes from ball.baseColor at spawn time so palette rebalances
//     propagate automatically
//   - Object pool prevents allocation churn during gameplay (zero GC during
//     a typical round)

import * as THREE from 'three';

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║ TUNE: shatter "feel" knobs — safe to tweak any of these.                 ║
// ║                                                                           ║
// ║ The module exposes TWO effects:                                           ║
// ║   spawn()    = full glass shatter — fired on a CORRECT click              ║
// ║   softPuff() = gentler transformation — fired when a ball SPLITS          ║
// ║                                                                           ║
// ║ ── full shatter (spawn) ──                                                ║
// ║ Bigger / wilder shatter:                                                  ║
// ║   ↑ VELOCITY_MAX     (faster outward fly)                                 ║
// ║   ↑ UP_BIAS          (more "lift" before falling)                         ║
// ║   ↑ ANGULAR_VEL_MAX  (more spin)                                          ║
// ║   ↑ SHARD_SCALE_MAX  (bigger shards)                                      ║
// ║                                                                           ║
// ║ Softer / more zen shatter:                                                ║
// ║   ↓ VELOCITY_MAX, ↓ UP_BIAS, ↓ ANGULAR_VEL_MAX                            ║
// ║   ↑ FADE_START_FRAC  (shards stay opaque longer, then dissolve fast)      ║
// ║                                                                           ║
// ║ More / fewer shards per shatter:                                          ║
// ║   change SHARDS_MIN / SHARDS_MAX                                          ║
// ║                                                                           ║
// ║ Shatter lasts longer / shorter on screen:                                 ║
// ║   change LIFETIME_S (in seconds)                                          ║
// ║                                                                           ║
// ║ Halo flash subtler / brighter:                                            ║
// ║   ↓ RIPPLE_ALPHA     (lower = more subtle, range 0.0–1.0)                 ║
// ║   ↓ RIPPLE_LIFETIME_MS (shorter fade)                                     ║
// ║                                                                           ║
// ║ Shards look more glassy (closer to ball color) vs more glowy (whiter):    ║
// ║   ↓ WHITE_TINT       (lower = stays closer to ball color, 0.0–1.0)        ║
// ║                                                                           ║
// ║ ── soft puff (split) ──                                                   ║
// ║ How "soft" the split feels vs a full shatter:                             ║
// ║   ↓ SOFT_PUFF_VELOCITY_SCALE  (0.5 = half-speed shards; 1.0 = same)       ║
// ║   ↓ SOFT_PUFF_LIFETIME_S      (shorter = quicker resolve, less competing  ║
// ║                                with the children's flash sequence)        ║
// ║   softPuff never fires the halo flash — that's reserved for kills.        ║
// ║                                                                           ║
// ║ Don't change unless you know what you're doing:                           ║
// ║   GRAVITY (Earth gravity m/s²), POOL_CAP (memory budget)                  ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

// Shard count
const SHARDS_MIN = 10;
const SHARDS_MAX = 15;

// Timing (seconds)
const LIFETIME_S = 0.6;
const FADE_START_FRAC = 0.55; // fade begins at 55% of lifetime; opaque before

// Motion
const GRAVITY = -9.8;
const VELOCITY_MIN = 1.4; // m/s outward
const VELOCITY_MAX = 2.6;
const UP_BIAS = 0.9; // extra vertical kick — shards "lift" a touch first
const ANGULAR_VEL_MAX = 8.0; // rad/s on each axis

// Geometry / placement
const SHARD_SCALE_MIN = 0.32; // multiplier of ball.radius
const SHARD_SCALE_MAX = 0.55;
const SPAWN_OFFSET = 0.7; // fraction of ball.radius randomised at spawn

// Color & glow
const WHITE_TINT = 0.35; // 0 = pure ball color, 1 = pure white
const EMISSIVE_PEAK = 0.85; // shard emissive intensity at spawn
const EMISSIVE_RM = 0.3; // dimmer in reduced-motion (no glow flicker)

// Halo flash (DOM ripple) — only for full shatters, not soft puffs
const RIPPLE_ALPHA = 0.35; // halo brightness at the screen edges (0.0–1.0)
const RIPPLE_LIFETIME_MS = 420;

// Soft-puff variant (split mechanic)
const SOFT_PUFF_VELOCITY_SCALE = 0.5; // shards fly half as fast
const SOFT_PUFF_LIFETIME_S = 0.45; // shorter than a full shatter

// Performance — leave alone unless profiling
const POOL_CAP = 60; // 4 concurrent shatters × 15 shards

// ─── helpers ───────────────────────────────────────────────────────────────

/** Cubic ease-out — slow at start, snaps off at the end. Used for fade. */
function easeOutCubic(t) {
  const u = 1 - t;
  return 1 - u * u * u;
}

/** Detect prefers-reduced-motion. Re-evaluated on every spawn so OS-level
 *  toggles take effect mid-game. Safe in jsdom (matchMedia is stubbed). */
function reducedMotion() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Mix a hex int color toward white by `amount` (0..1). */
function tintToward(colorHex, targetHex, amount) {
  const a = new THREE.Color(colorHex);
  const b = new THREE.Color(targetHex);
  return a.lerp(b, amount);
}

// ─── pooled shard ──────────────────────────────────────────────────────────

/**
 * One reusable shard. Owns its own mesh + material so opacity/scale animate
 * independently. When `alive===false` the mesh is hidden and waiting in the
 * pool for the next spawn.
 */
class Shard {
  constructor() {
    // Unit-radius tetrahedron; scaled per-spawn via mesh.scale.
    this.geometry = new THREE.TetrahedronGeometry(1, 0);
    this.material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0.6,
      roughness: 0.35,
      metalness: 0.0,
      transparent: true,
      opacity: 1.0,
      depthWrite: false, // keeps overlapping shards from punching holes
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false; // shatters are short-lived, skip culling

    this.velocity = new THREE.Vector3();
    this.angular = new THREE.Vector3();
    this.age = 0;
    this.lifetime = LIFETIME_S;
    this.alive = false;
    this.reducedMotion = false;
    this.startScale = 1;
  }

  /**
   * Place this shard at `pos`, kick it with random velocity, mark alive.
   *
   * @param {object} opts
   * @param {boolean} [opts.reducedMotion]   if true, no velocity / no spin
   * @param {number}  [opts.velocityScale]   1.0 = full shatter, 0.5 = soft puff
   * @param {number}  [opts.lifetime]        seconds; defaults to LIFETIME_S
   */
  ignite(pos, color, scale, opts = {}) {
    const {
      reducedMotion: rm = false,
      velocityScale = 1,
      lifetime = LIFETIME_S,
    } = opts;
    this.lifetime = lifetime;

    // Position with a small random offset so 15 shards aren't co-located
    const off = SPAWN_OFFSET * scale;
    this.mesh.position.set(
      pos.x + (Math.random() - 0.5) * off,
      pos.y + (Math.random() - 0.5) * off,
      pos.z + (Math.random() - 0.5) * off,
    );

    // Random orientation
    this.mesh.rotation.set(
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
    );

    this.startScale = scale;
    this.mesh.scale.setScalar(scale);

    // Color: blend ball color with warm white so shards glow rather than
    // looking like solid plastic chips.
    const tinted = tintToward(color, 0xffffff, WHITE_TINT);
    this.material.color.copy(tinted);
    this.material.emissive.copy(tinted);
    this.material.emissiveIntensity = rm ? EMISSIVE_RM : EMISSIVE_PEAK;
    this.material.opacity = 1.0;

    if (rm) {
      // Static fall: no velocity, no spin. Shard just expands + fades.
      this.velocity.set(0, 0, 0);
      this.angular.set(0, 0, 0);
    } else {
      // Radial outward (random unit vector) + upward bias.
      const dir = new THREE.Vector3(
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
      );
      if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
      dir.normalize();
      const speed = VELOCITY_MIN + Math.random() * (VELOCITY_MAX - VELOCITY_MIN);
      this.velocity.copy(dir).multiplyScalar(speed * velocityScale);
      // Lift bias also scales with velocity so soft puffs don't pop upward
      this.velocity.y += UP_BIAS * velocityScale;

      this.angular.set(
        (Math.random() * 2 - 1) * ANGULAR_VEL_MAX,
        (Math.random() * 2 - 1) * ANGULAR_VEL_MAX,
        (Math.random() * 2 - 1) * ANGULAR_VEL_MAX,
      );
    }

    this.age = 0;
    this.alive = true;
    this.reducedMotion = rm;
    this.mesh.visible = true;
  }

  /** Advance physics + fade. Returns true while still alive. */
  update(dt) {
    if (!this.alive) return false;

    this.age += dt;
    const t = this.age / this.lifetime;

    if (t >= 1) {
      this.retire();
      return false;
    }

    if (this.reducedMotion) {
      // Static path: gentle scale-up + opacity fade. No motion.
      const eased = easeOutCubic(t);
      const scale = this.startScale * (1 + eased * 0.4);
      this.mesh.scale.setScalar(scale);
      this.material.opacity = 1 - eased;
    } else {
      // Apply gravity then translate.
      this.velocity.y += GRAVITY * dt;
      this.mesh.position.x += this.velocity.x * dt;
      this.mesh.position.y += this.velocity.y * dt;
      this.mesh.position.z += this.velocity.z * dt;

      // Spin.
      this.mesh.rotation.x += this.angular.x * dt;
      this.mesh.rotation.y += this.angular.y * dt;
      this.mesh.rotation.z += this.angular.z * dt;

      // Fade — front-loaded so shards stay visible while flying, then
      // dissolve in the last (1 - FADE_START_FRAC) of their life.
      let alpha = 1;
      if (t > FADE_START_FRAC) {
        const f = (t - FADE_START_FRAC) / (1 - FADE_START_FRAC);
        alpha = 1 - easeOutCubic(f);
      }
      this.material.opacity = alpha;

      // Slight emissive cooldown as it falls — feels like glass losing light
      this.material.emissiveIntensity = EMISSIVE_PEAK * (1 - t * 0.6);
    }

    return true;
  }

  retire() {
    this.alive = false;
    this.mesh.visible = false;
    this.material.opacity = 0;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ─── public effect controller ──────────────────────────────────────────────

/**
 * ShatterEffect — owns a pool of Shards plus an optional DOM ripple layer.
 * Construct once at boot, call `update(dt)` from the scene tick, and call
 * `spawn(position, color, radius)` whenever a ball should shatter.
 */
export class ShatterEffect {
  /**
   * @param {object} opts
   * @param {THREE.Scene} opts.scene             where shard meshes are added
   * @param {HTMLElement} [opts.rippleParent]    where the DOM ripple appends
   *                                             (defaults to document.body)
   * @param {number} [opts.poolCap]              max shards alive simultaneously
   * @param {boolean} [opts.disableRipple]       skip the DOM ripple entirely
   */
  constructor({
    scene,
    rippleParent,
    poolCap = POOL_CAP,
    disableRipple = false,
  } = {}) {
    if (!scene) throw new Error('ShatterEffect requires a scene');

    this.scene = scene;
    this.poolCap = poolCap;
    this.disableRipple = disableRipple;
    this.rippleParent =
      rippleParent ?? (typeof document !== 'undefined' ? document.body : null);

    /** @type {Shard[]} all shards, alive or pooled */
    this._shards = [];
    /** @type {Set<Shard>} live shards (subset of _shards) */
    this._alive = new Set();
  }

  // ─── pool management ─────────────────────────────────────────────────────

  _acquire() {
    // Reuse a dead shard if any.
    for (const s of this._shards) {
      if (!s.alive) return s;
    }
    // Otherwise allocate, up to the cap. Beyond the cap, recycle the
    // oldest live shard so we never crash, but log it (likely a bug).
    if (this._shards.length < this.poolCap) {
      const s = new Shard();
      this._shards.push(s);
      this.scene.add(s.mesh);
      return s;
    }
    // Cap hit — preempt the oldest. In practice this never happens unless
    // the player is somehow triggering hundreds of shatters per second.
    const oldest = this._shards.find((s) => s.alive) ?? this._shards[0];
    if (oldest) {
      this._alive.delete(oldest);
      oldest.retire();
    }
    return oldest;
  }

  // ─── public API ──────────────────────────────────────────────────────────

  /**
   * Spawn a full glass shatter at `position` with shards tinted from `color`.
   * Fires the screen-edge halo flash. Use for correct-click destruction.
   *
   * @param {{x:number,y:number,z:number}|THREE.Vector3} position  world pos
   * @param {number} color   hex int (e.g. ball.baseColor)
   * @param {number} radius  ball radius — drives shard scale
   * @returns {number}       number of shards spawned (for tests / telemetry)
   */
  spawn(position, color, radius) {
    return this._burst(position, color, radius, {
      velocityScale: 1,
      lifetime: LIFETIME_S,
      ripple: true,
    });
  }

  /**
   * Spawn a gentler "soft puff" at `position` — shards fly slower, fade
   * faster, and the halo flash is suppressed. Use when a ball TRANSFORMS
   * (split mechanic) rather than gets destroyed. Visually distinct enough
   * from spawn() that the player reads it as "the ball became something
   * else" instead of "the ball broke".
   *
   * Same parameters + return as spawn().
   */
  softPuff(position, color, radius) {
    return this._burst(position, color, radius, {
      velocityScale: SOFT_PUFF_VELOCITY_SCALE,
      lifetime: SOFT_PUFF_LIFETIME_S,
      ripple: false,
    });
  }

  /**
   * Internal burst loop shared by spawn() + softPuff(). Validates input,
   * picks a random shard count in [SHARDS_MIN, SHARDS_MAX], fires per-shard
   * ignite() calls, then optionally fires the halo ripple.
   */
  _burst(position, color, radius, { velocityScale, lifetime, ripple }) {
    if (!position) return 0;
    if (typeof radius !== 'number' || radius <= 0) radius = 0.5;
    if (typeof color !== 'number') color = 0xffffff;

    const rm = reducedMotion();
    const count =
      SHARDS_MIN + Math.floor(Math.random() * (SHARDS_MAX - SHARDS_MIN + 1));

    for (let i = 0; i < count; i++) {
      const shard = this._acquire();
      if (!shard) break;
      const scale =
        radius *
        (SHARD_SCALE_MIN + Math.random() * (SHARD_SCALE_MAX - SHARD_SCALE_MIN));
      shard.ignite(position, color, scale, {
        reducedMotion: rm,
        velocityScale,
        lifetime,
      });
      this._alive.add(shard);
    }

    if (ripple && !rm && !this.disableRipple) {
      this._spawnRipple();
    }

    return count;
  }

  /** Per-frame physics tick. Wire this to scene.onTick. */
  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    for (const shard of this._alive) {
      const stillAlive = shard.update(dt);
      if (!stillAlive) this._alive.delete(shard);
    }
  }

  /** Number of shards currently animating. Useful for tests + telemetry. */
  get activeCount() {
    return this._alive.size;
  }

  /** Total pool size (alive + idle). */
  get poolSize() {
    return this._shards.length;
  }

  /** Free GPU resources. After dispose the effect can no longer spawn. */
  dispose() {
    for (const s of this._shards) {
      this.scene.remove(s.mesh);
      s.dispose();
    }
    this._shards.length = 0;
    this._alive.clear();
  }

  // ─── DOM ripple (correct-click halo) ─────────────────────────────────────

  _spawnRipple() {
    if (!this.rippleParent || typeof document === 'undefined') return;

    const el = document.createElement('div');
    el.className = 'zen-shatter-ripple';
    el.setAttribute('aria-hidden', 'true');
    // Inline styles so this module needs no global CSS — robust against
    // future stylesheet refactors.
    Object.assign(el.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '3',
      background: `radial-gradient(ellipse at center, transparent 60%, rgba(160,220,80,0.0) 80%, rgba(160,220,80,${RIPPLE_ALPHA}) 100%)`,
      opacity: '0',
      transition: `opacity ${RIPPLE_LIFETIME_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1)`,
      mixBlendMode: 'screen',
    });
    this.rippleParent.appendChild(el);

    // Force a reflow before flipping opacity so the transition runs.
    // Reading offsetWidth is the canonical trick.
    void el.offsetWidth;
    el.style.opacity = '1';

    // Fade out shortly after, then remove.
    setTimeout(() => {
      el.style.opacity = '0';
    }, RIPPLE_LIFETIME_MS * 0.35);

    setTimeout(() => {
      el.remove();
    }, RIPPLE_LIFETIME_MS + 100);
  }
}

// Internal seam for tests — lets us inspect tunables without exporting them
// individually as part of the public API.
export const _internal = Object.freeze({
  SHARDS_MIN,
  SHARDS_MAX,
  LIFETIME_S,
  FADE_START_FRAC,
  WHITE_TINT,
  EMISSIVE_PEAK,
  EMISSIVE_RM,
  POOL_CAP,
  RIPPLE_ALPHA,
  RIPPLE_LIFETIME_MS,
  SOFT_PUFF_VELOCITY_SCALE,
  SOFT_PUFF_LIFETIME_S,
});
