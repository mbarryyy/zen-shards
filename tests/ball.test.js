// Tests for src/ball.js — Ball wrapper around a Three.js mesh.
// Covers constructor wiring, kind → radius/colour mapping, status
// transitions, setFlashLevel clamping, and breathing-update guards.

import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  Ball,
  BallStatus,
  BallKind,
  _resetBallIdCounter,
  _internal as BALL_INTERNAL,
} from '../src/ball.js';

const KIND_RADIUS_EXPECTED = {
  [BallKind.PRIMARY]: 0.55,
  [BallKind.SPLIT_L1]: 0.33,
  [BallKind.SPLIT_L2]: 0.22,
};

// Locked palette — synced to ui-3d-designer's CSS tokens (see src/ball.js).
// Phase 8 cool-blue family.
const KIND_COLOR_EXPECTED = {
  [BallKind.PRIMARY]: 0xdde4ec,
  [BallKind.SPLIT_L1]: 0x9fb5cc,
  [BallKind.SPLIT_L2]: 0x5e7a96,
};

beforeEach(() => {
  _resetBallIdCounter();
});

describe('Ball constructor', () => {
  it('wires position, default kind, default status, and a mesh', () => {
    const b = new Ball({ position: { x: 1, y: 2, z: 3 } });

    expect(b.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(b.kind).toBe(BallKind.PRIMARY);
    expect(b.status).toBe(BallStatus.IDLE);
    expect(b.flashLevel).toBe(0);
    expect(b.willSplit).toBe(false);
    expect(b.mesh).toBeInstanceOf(THREE.Mesh);
    expect(b.mesh.position.x).toBe(1);
    expect(b.mesh.position.y).toBe(2);
    expect(b.mesh.position.z).toBe(3);
  });

  it('throws if position is missing', () => {
    expect(() => new Ball()).toThrow(/position/i);
    expect(() => new Ball({})).toThrow(/position/i);
  });

  it('copies position (does not retain reference)', () => {
    const pos = { x: 1, y: 2, z: 3 };
    const b = new Ball({ position: pos });
    pos.x = 999;
    expect(b.position.x).toBe(1); // unchanged
  });

  it('auto-increments id when none provided', () => {
    const a = new Ball({ position: { x: 0, y: 0, z: 0 } });
    const b = new Ball({ position: { x: 0, y: 0, z: 0 } });
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
  });

  it('respects explicit id and does not bump the counter', () => {
    const a = new Ball({ position: { x: 0, y: 0, z: 0 }, id: 42 });
    const b = new Ball({ position: { x: 0, y: 0, z: 0 } });
    expect(a.id).toBe(42);
    expect(b.id).toBe(1); // counter still at 1
  });

  it('_resetBallIdCounter restarts numbering', () => {
    new Ball({ position: { x: 0, y: 0, z: 0 } });
    new Ball({ position: { x: 0, y: 0, z: 0 } });
    _resetBallIdCounter();
    const c = new Ball({ position: { x: 0, y: 0, z: 0 } });
    expect(c.id).toBe(1);
  });

  it('exposes the ball back-reference on mesh.userData.ball (for picking)', () => {
    const b = new Ball({ position: { x: 0, y: 0, z: 0 } });
    expect(b.mesh.userData.ball).toBe(b);
  });

  it('names the mesh "ball-<id>"', () => {
    const b = new Ball({ position: { x: 0, y: 0, z: 0 } });
    expect(b.mesh.name).toBe(`ball-${b.id}`);
  });

  it('uses MeshPhysicalMaterial with glass-like params', () => {
    const b = new Ball({ position: { x: 0, y: 0, z: 0 } });
    const m = b.mesh.material;
    expect(m).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(m.transmission).toBeCloseTo(0.9);
    expect(m.ior).toBeCloseTo(1.45);
    expect(m.transparent).toBe(true);
    expect(m.emissiveIntensity).toBe(0.0);
    // Phase 8: per-instance jitter — assert the params land in the
    // documented envelope rather than a single fixed value.
    const J = BALL_INTERNAL.JITTER;
    expect(m.roughness).toBeGreaterThanOrEqual(J.ROUGHNESS_MIN);
    expect(m.roughness).toBeLessThanOrEqual(J.ROUGHNESS_MAX);
    expect(m.clearcoat).toBeGreaterThanOrEqual(J.CLEARCOAT_MIN);
    expect(m.clearcoat).toBeLessThanOrEqual(J.CLEARCOAT_MAX);
    expect(m.thickness).toBeGreaterThanOrEqual(J.THICKNESS_MIN);
    expect(m.thickness).toBeLessThanOrEqual(J.THICKNESS_MAX);
  });

  it('Phase 8: per-instance material jitter produces visibly distinct orbs', () => {
    // Two balls of the same kind should not share identical material params
    // — the whole point of Phase 8 is to break clone-look.
    const a = new Ball({ position: { x: 0, y: 0, z: 0 } });
    const b = new Ball({ position: { x: 0, y: 0, z: 0 } });
    const distinct =
      a.mesh.material.roughness !== b.mesh.material.roughness ||
      a.mesh.material.clearcoat !== b.mesh.material.clearcoat ||
      a.mesh.material.thickness !== b.mesh.material.thickness ||
      a.breathFreq !== b.breathFreq;
    expect(distinct).toBe(true);
  });

  it('Phase 8: breathFreq lands in the [1.2, 1.6] envelope', () => {
    const J = BALL_INTERNAL.JITTER;
    for (let i = 0; i < 10; i++) {
      const b = new Ball({ position: { x: 0, y: 0, z: 0 } });
      expect(b.breathFreq).toBeGreaterThanOrEqual(J.BREATH_FREQ_MIN);
      expect(b.breathFreq).toBeLessThanOrEqual(J.BREATH_FREQ_MAX);
    }
  });

  it('initialises breathPhase in [0, 2π)', () => {
    for (let i = 0; i < 20; i++) {
      const b = new Ball({ position: { x: 0, y: 0, z: 0 } });
      expect(b.breathPhase).toBeGreaterThanOrEqual(0);
      expect(b.breathPhase).toBeLessThan(Math.PI * 2);
    }
  });
});

describe('Ball kind → radius/colour mapping', () => {
  for (const kind of Object.values(BallKind)) {
    it(`kind=${kind} maps to expected radius and color`, () => {
      const b = new Ball({ position: { x: 0, y: 0, z: 0 }, kind });
      expect(b.radius).toBe(KIND_RADIUS_EXPECTED[kind]);
      // baseColor stays as the canonical kind hex even though the actual
      // material colour is hue-jittered ±4% per instance for Phase 8.
      expect(b.baseColor).toBe(KIND_COLOR_EXPECTED[kind]);
      // Geometry radius matches.
      expect(b.mesh.geometry.parameters.radius).toBe(KIND_RADIUS_EXPECTED[kind]);
      // Material colour stays inside the kind family — assert hue is close
      // to the canonical hue (within the documented HUE_SHIFT envelope).
      const expected = new THREE.Color(KIND_COLOR_EXPECTED[kind]);
      const actual = b.mesh.material.color;
      const eHsl = { h: 0, s: 0, l: 0 };
      const aHsl = { h: 0, s: 0, l: 0 };
      expected.getHSL(eHsl);
      actual.getHSL(aHsl);
      // Wrap-around-safe hue distance.
      let dh = Math.abs(eHsl.h - aHsl.h);
      if (dh > 0.5) dh = 1 - dh;
      expect(dh).toBeLessThanOrEqual(BALL_INTERNAL.JITTER.HUE_SHIFT + 1e-6);
    });
  }

  it('split balls are visibly smaller than primary (spec §3.3)', () => {
    const primary = new Ball({ position: { x: 0, y: 0, z: 0 }, kind: BallKind.PRIMARY });
    const splitL1 = new Ball({ position: { x: 0, y: 0, z: 0 }, kind: BallKind.SPLIT_L1 });
    const splitL2 = new Ball({ position: { x: 0, y: 0, z: 0 }, kind: BallKind.SPLIT_L2 });
    expect(splitL1.radius).toBeLessThan(primary.radius);
    expect(splitL2.radius).toBeLessThan(splitL1.radius);
    // Spec says ~40% smaller — sanity-check the magnitude.
    expect(splitL1.radius / primary.radius).toBeGreaterThan(0.45);
    expect(splitL1.radius / primary.radius).toBeLessThan(0.75);
  });

  it('falls back to primary kind when an unknown kind is passed', () => {
    const b = new Ball({ position: { x: 0, y: 0, z: 0 }, kind: 'mystery' });
    expect(b.radius).toBe(KIND_RADIUS_EXPECTED[BallKind.PRIMARY]);
    // baseColor falls back to the canonical PRIMARY hex (jitter is on the
    // material colour, not on baseColor).
    expect(b.baseColor).toBe(KIND_COLOR_EXPECTED[BallKind.PRIMARY]);
  });
});

describe('Ball.splitDepth', () => {
  it('PRIMARY ball defaults to splitDepth 0', () => {
    const b = new Ball({ position: { x: 0, y: 0, z: 0 } });
    expect(b.splitDepth).toBe(0);
  });

  it('SPLIT_L1 ball defaults to splitDepth 1', () => {
    const b = new Ball({ position: { x: 0, y: 0, z: 0 }, kind: BallKind.SPLIT_L1 });
    expect(b.splitDepth).toBe(1);
  });

  it('SPLIT_L2 ball defaults to splitDepth 2', () => {
    const b = new Ball({ position: { x: 0, y: 0, z: 0 }, kind: BallKind.SPLIT_L2 });
    expect(b.splitDepth).toBe(2);
  });

  it('explicit splitDepth override beats kind default', () => {
    const b = new Ball({
      position: { x: 0, y: 0, z: 0 },
      kind: BallKind.PRIMARY,
      splitDepth: 5,
    });
    expect(b.splitDepth).toBe(5);
  });

  it('explicit splitDepth=0 still beats kind=SPLIT_L1', () => {
    const b = new Ball({
      position: { x: 0, y: 0, z: 0 },
      kind: BallKind.SPLIT_L1,
      splitDepth: 0,
    });
    expect(b.splitDepth).toBe(0);
  });

  it('unknown kind with no override defaults to depth 0', () => {
    const b = new Ball({ position: { x: 0, y: 0, z: 0 }, kind: 'mystery' });
    expect(b.splitDepth).toBe(0);
  });
});

describe('Ball.setFlashLevel', () => {
  it('clamps values above 1 down to 1', () => {
    const b = new Ball({ position: { x: 0, y: 0, z: 0 } });
    b.setFlashLevel(5);
    expect(b.flashLevel).toBe(1);
    expect(b.status).toBe(BallStatus.FLASHING);
  });

  it('clamps negative values up to 0', () => {
    const b = new Ball({ position: { x: 0, y: 0, z: 0 } });
    b.setFlashLevel(-2);
    expect(b.flashLevel).toBe(0);
    expect(b.status).toBe(BallStatus.IDLE);
  });

  it('mid-range value passes through and toggles status to FLASHING', () => {
    const b = new Ball({ position: { x: 0, y: 0, z: 0 } });
    b.setFlashLevel(0.5);
    expect(b.flashLevel).toBe(0.5);
    expect(b.status).toBe(BallStatus.FLASHING);
    // 0.05 baseline + 0.5 * 1.35 = 0.725
    expect(b.mesh.material.emissiveIntensity).toBeCloseTo(0.725);
  });

  it('flash 0 returns status to IDLE', () => {
    const b = new Ball({ position: { x: 0, y: 0, z: 0 } });
    b.setFlashLevel(0.8);
    b.setFlashLevel(0);
    expect(b.flashLevel).toBe(0);
    expect(b.status).toBe(BallStatus.IDLE);
  });

  it('peak flash maxes emissive at the documented 1.4 ceiling', () => {
    const b = new Ball({ position: { x: 0, y: 0, z: 0 } });
    b.setFlashLevel(1);
    expect(b.mesh.material.emissiveIntensity).toBeCloseTo(1.4);
  });

  it('guards against NaN (must not produce NaN emissive)', () => {
    // BUG GUARD: Math.max(0, Math.min(1, NaN)) returns NaN — propagates to
    // emissiveIntensity. Sending NaN to a Three.js material is undefined
    // behaviour and tends to make the renderer render nothing.
    const b = new Ball({ position: { x: 0, y: 0, z: 0 } });
    b.setFlashLevel(NaN);
    expect(Number.isNaN(b.flashLevel)).toBe(false);
    expect(Number.isNaN(b.mesh.material.emissiveIntensity)).toBe(false);
  });
});

describe('Ball status transitions', () => {
  it('markCorrect moves IDLE → CORRECT', () => {
    const b = new Ball({ position: { x: 0, y: 0, z: 0 } });
    b.markCorrect();
    expect(b.status).toBe(BallStatus.CORRECT);
  });

  it('markShattered hides the mesh and sets SHATTERED', () => {
    const b = new Ball({ position: { x: 0, y: 0, z: 0 } });
    b.markShattered();
    expect(b.status).toBe(BallStatus.SHATTERED);
    expect(b.mesh.visible).toBe(false);
  });

  it('updateBreathing is a no-op once SHATTERED (no scale or emissive change)', () => {
    const b = new Ball({ position: { x: 0, y: 0, z: 0 } });
    b.markShattered();
    const scaleBefore = b.mesh.scale.x;
    const emissiveBefore = b.mesh.material.emissiveIntensity;
    b.updateBreathing(2.0);
    expect(b.mesh.scale.x).toBe(scaleBefore);
    expect(b.mesh.material.emissiveIntensity).toBe(emissiveBefore);
  });

  it('updateBreathing does NOT clobber emissive while FLASHING', () => {
    // Reveal phase drives emissive via setFlashLevel; the per-frame
    // breathing ticker must not overwrite it mid-flash.
    const b = new Ball({ position: { x: 0, y: 0, z: 0 } });
    b.setFlashLevel(0.9);
    const flashEmissive = b.mesh.material.emissiveIntensity;
    b.updateBreathing(0.5);
    expect(b.mesh.material.emissiveIntensity).toBe(flashEmissive);
  });

  it('updateBreathing modulates scale and idle glow when IDLE', () => {
    const b = new Ball({ position: { x: 0, y: 0, z: 0 } });
    // Phase 8: per-instance breathFreq — pin both phase and freq so the
    // computed sin(t) is deterministic.
    b.breathPhase = 0;
    b.breathFreq = 1.4;
    b.updateBreathing(Math.PI / 2 / 1.4); // sin(t)=1
    // pulse = 1 + 1*0.025 = 1.025
    expect(b.mesh.scale.x).toBeCloseTo(1.025);
    // glow = 0.04 + (1*0.5+0.5)*0.05 = 0.09
    expect(b.mesh.material.emissiveIntensity).toBeCloseTo(0.09);
  });

  it('updateBreathing keeps scale uniform across axes', () => {
    const b = new Ball({ position: { x: 0, y: 0, z: 0 } });
    b.updateBreathing(0.4);
    expect(b.mesh.scale.x).toBe(b.mesh.scale.y);
    expect(b.mesh.scale.y).toBe(b.mesh.scale.z);
  });
});

describe('Ball.dispose', () => {
  it('releases geometry and material', () => {
    const b = new Ball({ position: { x: 0, y: 0, z: 0 } });
    const geom = b.mesh.geometry;
    const mat = b.mesh.material;
    let geomDisposed = false;
    let matDisposed = false;
    geom.addEventListener('dispose', () => (geomDisposed = true));
    mat.addEventListener('dispose', () => (matDisposed = true));
    b.dispose();
    expect(geomDisposed).toBe(true);
    expect(matDisposed).toBe(true);
  });

  it('is safe to call when geometry/material are already gone', () => {
    const b = new Ball({ position: { x: 0, y: 0, z: 0 } });
    b.mesh.geometry = null;
    b.mesh.material = null;
    expect(() => b.dispose()).not.toThrow();
  });
});
