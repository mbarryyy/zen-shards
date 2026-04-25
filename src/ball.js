// Ball — a single glass shard sphere. Wraps a Three.js Mesh and exposes the
// game-level state we care about (id, status, breathing animation).
//
// Phase 8 (ui-3d-designer) introduced a cool-blue palette + per-instance
// material/breathing jitter so each ball reads as its own little glass orb,
// not a pixel-identical clone. See the inline notes near the constructor.

import * as THREE from 'three';

export const BallStatus = Object.freeze({
  IDLE: 'idle',
  FLASHING: 'flashing',
  CORRECT: 'correct',
  SHATTERED: 'shattered',
});

export const BallKind = Object.freeze({
  PRIMARY: 'primary',
  SPLIT_L1: 'split-l1',
  SPLIT_L2: 'split-l2',
});

// Hex values mirror the CSS tokens in index.html (--ball-primary,
// --ball-split-l1, --ball-split-l2). Phase 8: refreshed to a coherent
// cool-blue family so the orbs read as part of the same world as the
// soft blue gradient background instead of fighting it.
//   PRIMARY  — warm pearl with blue undertone (most visible)
//   SPLIT_L1 — smoke blue (first split)
//   SPLIT_L2 — deep lake blue (second split)
const KIND_COLOR = {
  [BallKind.PRIMARY]: 0xdde4ec,
  [BallKind.SPLIT_L1]: 0x9fb5cc,
  [BallKind.SPLIT_L2]: 0x5e7a96,
};

const KIND_RADIUS = {
  [BallKind.PRIMARY]: 0.55,
  [BallKind.SPLIT_L1]: 0.33,
  [BallKind.SPLIT_L2]: 0.22,
};

// Split nesting depth implied by kind (0=original, 1=first split, 2=second).
const KIND_DEPTH = {
  [BallKind.PRIMARY]: 0,
  [BallKind.SPLIT_L1]: 1,
  [BallKind.SPLIT_L2]: 2,
};

let nextBallId = 1;

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║ TUNE: per-instance material/breath jitter (Phase 8).                  ║
// ║                                                                       ║
// ║  Range too tight → balls look identical (spec violation).             ║
// ║  Range too wide  → palette/material identity drifts → looks broken.   ║
// ║                                                                       ║
// ║  Hue rotation is in normalised HSL hue units (0..1). ±0.04 = ±4%.     ║
// ║  Roughness/clearcoat/thickness are MeshPhysicalMaterial scalars.      ║
// ╚═══════════════════════════════════════════════════════════════════════╝
const JITTER = Object.freeze({
  ROUGHNESS_MIN: 0.03,
  ROUGHNESS_MAX: 0.10,
  CLEARCOAT_MIN: 0.30,
  CLEARCOAT_MAX: 0.60,
  THICKNESS_MIN: 0.40,
  THICKNESS_MAX: 0.80,
  HUE_SHIFT: 0.04,            // ±4% around base hue
  ENV_ROT_MAX: Math.PI * 0.5, // ±90° envMap rotation around Y
  MESH_ROT_MAX: 0.18,         // ±0.18 rad mesh rotation jitter
  BREATH_FREQ_MIN: 1.2,
  BREATH_FREQ_MAX: 1.6,
});

function rand(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * Apply a small ±HUE_SHIFT hue rotation to a base hex color, preserving
 * saturation/lightness so the result still reads as the same "kind family".
 * Returns a fresh THREE.Color.
 */
function jitterHue(hex) {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  const shift = (Math.random() * 2 - 1) * JITTER.HUE_SHIFT;
  // Wrap into [0,1) — Three's setHSL accepts any positive number but is
  // explicit about the wrap.
  let h = hsl.h + shift;
  if (h < 0) h += 1;
  if (h >= 1) h -= 1;
  c.setHSL(h, hsl.s, hsl.l);
  return c;
}

export class Ball {
  /**
   * @param {object} opts
   * @param {{x:number,y:number,z:number}} opts.position
   * @param {string} [opts.kind] one of BallKind.*
   * @param {number} [opts.id] explicit id (otherwise auto-assigned)
   */
  constructor({ position, kind = BallKind.PRIMARY, id, splitDepth } = {}) {
    if (!position) throw new Error('Ball requires a position');

    this.id = id ?? nextBallId++;
    this.kind = kind;
    this.position = { ...position };
    this.status = BallStatus.IDLE;
    this.flashLevel = 0; // 0..1 emissive intensity used during reveal
    this.breathPhase = Math.random() * Math.PI * 2;
    // Per-instance breathing frequency — varies the rate so balls don't
    // pulse in lockstep. Tests can override this directly for determinism.
    this.breathFreq = rand(JITTER.BREATH_FREQ_MIN, JITTER.BREATH_FREQ_MAX);
    this.willSplit = false; // marked at reveal time on Round >= 4
    // Depth is purely informational on the Ball — game.js owns split
    // bookkeeping. Defaults from kind so existing callers don't have to
    // pass it; explicit override wins (used by tests + child spawning).
    this.splitDepth = splitDepth ?? KIND_DEPTH[kind] ?? 0;

    const radius = KIND_RADIUS[kind] ?? KIND_RADIUS[BallKind.PRIMARY];
    const baseHex = KIND_COLOR[kind] ?? KIND_COLOR[BallKind.PRIMARY];

    this.radius = radius;
    // baseColor stays as the canonical kind hex — used by shatter.js to seed
    // shard colours so shards visually belong to the family even when the
    // surface material has a slight per-instance hue rotation applied.
    this.baseColor = baseHex;

    const matColor = jitterHue(baseHex);
    const emissiveColor = matColor.clone();

    const geometry = new THREE.SphereGeometry(radius, 48, 32);
    const material = new THREE.MeshPhysicalMaterial({
      color: matColor,
      roughness: rand(JITTER.ROUGHNESS_MIN, JITTER.ROUGHNESS_MAX),
      metalness: 0.0,
      transmission: 0.9,
      thickness: rand(JITTER.THICKNESS_MIN, JITTER.THICKNESS_MAX),
      ior: 1.45,
      transparent: true,
      opacity: 1.0,
      emissive: emissiveColor,
      emissiveIntensity: 0.0,
      clearcoat: rand(JITTER.CLEARCOAT_MIN, JITTER.CLEARCOAT_MAX),
      clearcoatRoughness: 0.2,
    });

    // Per-instance environment-map rotation so each ball catches reflections
    // at a slightly different angle — a cheap way to break clone-look.
    // envMapRotation lands on MeshPhysicalMaterial in recent Three.js; if
    // unavailable the field is silently ignored, so we feature-detect.
    const envEuler = new THREE.Euler(
      0,
      (Math.random() * 2 - 1) * JITTER.ENV_ROT_MAX,
      0,
    );
    if ('envMapRotation' in material) {
      material.envMapRotation = envEuler;
    }

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.set(position.x, position.y, position.z);
    // Tiny mesh.y rotation jitter — even when reflections look identical the
    // sphere's geometry seam moves, which subtly desyncs specular highlights.
    this.mesh.rotation.y = (Math.random() * 2 - 1) * JITTER.MESH_ROT_MAX;
    this.mesh.userData.ball = this;
    this.mesh.name = `ball-${this.id}`;
  }

  /** Subtle scale + emissive pulse for the idle "breathing" feel. */
  updateBreathing(elapsedSeconds) {
    if (this.status === BallStatus.SHATTERED) return;
    const t = elapsedSeconds * this.breathFreq + this.breathPhase;
    const pulse = 1 + Math.sin(t) * 0.025;
    this.mesh.scale.setScalar(pulse);

    if (this.status === BallStatus.IDLE) {
      // Faint resting glow that breathes with the scale.
      const glow = 0.04 + (Math.sin(t) * 0.5 + 0.5) * 0.05;
      this.mesh.material.emissiveIntensity = glow;
    }
  }

  /**
   * Drive flash intensity directly (called by reveal phase).
   * level in 0..1 — 0 = idle glow, 1 = peak flash.
   */
  setFlashLevel(level) {
    const safe = Number.isFinite(level) ? level : 0;
    this.flashLevel = Math.max(0, Math.min(1, safe));
    this.status = this.flashLevel > 0 ? BallStatus.FLASHING : BallStatus.IDLE;
    // 0.05 idle baseline → 1.4 peak gives a visible bloom without nuking color.
    this.mesh.material.emissiveIntensity = 0.05 + this.flashLevel * 1.35;
  }

  markCorrect() {
    this.status = BallStatus.CORRECT;
  }

  markShattered() {
    this.status = BallStatus.SHATTERED;
    this.mesh.visible = false;
  }

  dispose() {
    this.mesh.geometry?.dispose();
    this.mesh.material?.dispose();
  }
}

// Test seam: reset auto-incrementing ids between tests.
export function _resetBallIdCounter() {
  nextBallId = 1;
}

// Test seam: expose tuning ranges so tests can assert per-instance jitter
// stays inside the documented envelope.
export const _internal = Object.freeze({ JITTER, KIND_COLOR });
