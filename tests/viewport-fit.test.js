// Phase M2 — Viewport-fit helper tests.
//
// `src/viewport-fit.js` is pure and deterministic by design — no Three.js,
// no DOM, no RNG — so we can exhaustively cover the FOV curve and the
// visible-volume bounds at every viewport in the M2 behavior checklist.
//
// Test groupings:
//   1. pickFov() — the FOV curve at all aspect breakpoints + edge cases.
//   2. computeViewportFit() — spec-checklist viewports (desktop, iPad,
//      iPhone 13 mini, iPhone SE) verify FOV + bounds match the agreed
//      ranges from dev-lead's behavior checklist.
//   3. Defaults + degenerate inputs — width=0, height=0, NaN, custom opts.
//   4. Bounds invariants — symmetry around 0, depth follows opts.depth,
//      marginRatio shrinks bounds proportionally.

import { describe, it, expect } from 'vitest';
import {
  computeViewportFit,
  pickFov,
  DEFAULT_BASE_FOV,
  DEFAULT_PORTRAIT_FOV,
  DEFAULT_CAMERA_DISTANCE,
  DEFAULT_MARGIN_RATIO,
  DEFAULT_DEPTH,
  PORTRAIT_PIVOT,
  PORTRAIT_FULL,
} from '../src/viewport-fit.js';

// ─── pickFov() — the FOV curve ──────────────────────────────────────────

describe('pickFov() · FOV curve', () => {
  it('aspect ≥ 1.0 (landscape / desktop) returns baseFov (45°)', () => {
    expect(pickFov(1.0)).toBe(DEFAULT_BASE_FOV);
    expect(pickFov(1.6)).toBe(DEFAULT_BASE_FOV);   // 1440×900
    expect(pickFov(16 / 9)).toBe(DEFAULT_BASE_FOV);
    expect(pickFov(2.5)).toBe(DEFAULT_BASE_FOV);
    expect(pickFov(100)).toBe(DEFAULT_BASE_FOV);
  });

  it('aspect ≤ 0.55 (deep portrait) returns portraitFov (65°)', () => {
    expect(pickFov(0.55)).toBe(DEFAULT_PORTRAIT_FOV);
    expect(pickFov(0.46)).toBe(DEFAULT_PORTRAIT_FOV); // iPhone 13 mini 375×812
    expect(pickFov(0.4)).toBe(DEFAULT_PORTRAIT_FOV);
    expect(pickFov(0.1)).toBe(DEFAULT_PORTRAIT_FOV);
    expect(pickFov(0)).toBe(DEFAULT_PORTRAIT_FOV);
  });

  it('0.55 < aspect < 1.0 lerps linearly between base and portrait FOV', () => {
    // Midpoint of (0.55, 1.0) = 0.775 → t = 0.5 → midway between 45 and 65 = 55°
    expect(pickFov(0.775)).toBeCloseTo(55, 5);
    // Just inside the pivot edge → near baseFov
    expect(pickFov(0.99)).toBeCloseTo(45.44, 1);
    // Just inside the full-portrait edge → near portraitFov
    expect(pickFov(0.56)).toBeCloseTo(64.56, 1);
  });

  it('FOV curve is monotonic non-increasing in aspect', () => {
    let prev = Infinity;
    for (let a = 0.1; a <= 2.0; a += 0.05) {
      const fov = pickFov(a);
      expect(fov).toBeLessThanOrEqual(prev + 1e-9);
      prev = fov;
    }
  });

  it('NaN / non-finite aspect falls back to baseFov (defensive default)', () => {
    expect(pickFov(NaN)).toBe(DEFAULT_BASE_FOV);
    expect(pickFov(Infinity)).toBe(DEFAULT_BASE_FOV);
    expect(pickFov(-Infinity)).toBe(DEFAULT_BASE_FOV);
  });

  it('respects custom baseFov and portraitFov overrides', () => {
    expect(pickFov(1.5, 50, 80)).toBe(50);
    expect(pickFov(0.4, 50, 80)).toBe(80);
    // Midpoint with custom values: 0.775 → 50 + (80-50)*0.5 = 65
    expect(pickFov(0.775, 50, 80)).toBeCloseTo(65, 5);
  });

  it('PORTRAIT_PIVOT and PORTRAIT_FULL constants are exported and ordered correctly', () => {
    expect(PORTRAIT_PIVOT).toBeGreaterThan(PORTRAIT_FULL);
    expect(PORTRAIT_PIVOT).toBe(1.0);
    expect(PORTRAIT_FULL).toBe(0.55);
  });
});

// ─── computeViewportFit() · spec-checklist viewports ────────────────────

describe('computeViewportFit() · checklist viewports', () => {
  it('Desktop 1440×900: aspect 1.6, FOV 45°, bounds fit at closest z (z=+depth/2)', () => {
    const fit = computeViewportFit({ width: 1440, height: 900 });
    expect(fit.aspect).toBeCloseTo(1.6, 5);
    expect(fit.fov).toBe(45);
    expect(fit.isPortrait).toBe(false);
    // Bounds computed at closestDistance=10 (cameraDistance 12 - depth 2)
    // and shrunk by ballRadiusPad 0.6 then marginRatio 0.85.
    // halfX = (10 * tan(22.5°) * 1.6 - 0.6) * 0.85 ≈ 5.12
    // halfY = (10 * tan(22.5°) - 0.6) * 0.85 ≈ 3.01
    expect(fit.bounds.x[1]).toBeCloseTo(5.12, 1);
    expect(fit.bounds.y[1]).toBeCloseTo(3.01, 1);
  });

  it('iPad portrait 768×1024: aspect 0.75, FOV ~56°', () => {
    const fit = computeViewportFit({ width: 768, height: 1024 });
    expect(fit.aspect).toBeCloseTo(0.75, 5);
    expect(fit.fov).toBeCloseTo(56.11, 1); // 45 + 20 * (1.0-0.75)/0.45
    expect(fit.isPortrait).toBe(true);
    // Bounds positive + symmetric, computed at closest z with radius pad.
    expect(fit.bounds.x[1]).toBeGreaterThan(2);
    expect(fit.bounds.y[1]).toBeGreaterThan(3);
    expect(fit.bounds.x[1]).toBeLessThan(fit.bounds.y[1]); // portrait
  });

  it('iPhone 13 mini portrait 375×812: aspect 0.46, FOV 65° (deep portrait floor)', () => {
    const fit = computeViewportFit({ width: 375, height: 812 });
    expect(fit.aspect).toBeCloseTo(0.4618, 3);
    expect(fit.fov).toBe(DEFAULT_PORTRAIT_FOV); // aspect ≤ 0.55 floors at 65°
    expect(fit.isPortrait).toBe(true);
    expect(fit.bounds.x[1]).toBeGreaterThan(1);
    expect(fit.bounds.y[1]).toBeGreaterThan(4);
    expect(fit.bounds.x[1]).toBeLessThan(fit.bounds.y[1]);
  });

  it('iPhone SE portrait 320×568: aspect ~0.56, FOV ~64° (just inside the lerp range)', () => {
    const fit = computeViewportFit({ width: 320, height: 568 });
    // 320/568 ≈ 0.5634 — *just* above 0.55, so lerps very near 65°
    expect(fit.aspect).toBeCloseTo(0.5634, 3);
    expect(fit.fov).toBeGreaterThan(64);
    expect(fit.fov).toBeLessThanOrEqual(65);
    expect(fit.isPortrait).toBe(true);
  });

  it('iPhone 13 mini landscape 812×375: aspect 2.16, FOV 45° (back to landscape baseline)', () => {
    const fit = computeViewportFit({ width: 812, height: 375 });
    expect(fit.aspect).toBeCloseTo(812 / 375, 5);
    expect(fit.fov).toBe(DEFAULT_BASE_FOV);
    expect(fit.isPortrait).toBe(false);
  });
});

// ─── Defaults + degenerate inputs ──────────────────────────────────────

describe('computeViewportFit() · defaults and degenerate inputs', () => {
  it('width=0 / height=0 do not divide by zero (clamped to ≥1)', () => {
    const a = computeViewportFit({ width: 0, height: 0 });
    expect(Number.isFinite(a.aspect)).toBe(true);
    expect(Number.isFinite(a.fov)).toBe(true);
    expect(Number.isFinite(a.visibleWidth)).toBe(true);
    expect(Number.isFinite(a.visibleHeight)).toBe(true);
    // bounds remain symmetric finite numbers
    for (const axis of ['x', 'y', 'z']) {
      expect(a.bounds[axis][0]).toBeLessThanOrEqual(a.bounds[axis][1]);
      expect(Number.isFinite(a.bounds[axis][0])).toBe(true);
      expect(Number.isFinite(a.bounds[axis][1])).toBe(true);
    }
  });

  it('omitted opts use exported defaults (cameraDistance 12, baseFov 45, portraitFov 65, marginRatio 0.85, depth 4)', () => {
    expect(DEFAULT_CAMERA_DISTANCE).toBe(12);
    expect(DEFAULT_BASE_FOV).toBe(45);
    expect(DEFAULT_PORTRAIT_FOV).toBe(65);
    expect(DEFAULT_MARGIN_RATIO).toBe(0.85);
    expect(DEFAULT_DEPTH).toBe(4);

    const fit = computeViewportFit({ width: 1920, height: 1080 });
    expect(fit.bounds.z).toEqual([-DEFAULT_DEPTH / 2, DEFAULT_DEPTH / 2]);
  });

  it('marginRatio shrinks XY bounds proportionally without affecting Z', () => {
    const tight = computeViewportFit({ width: 1920, height: 1080, marginRatio: 0.5 });
    const loose = computeViewportFit({ width: 1920, height: 1080, marginRatio: 1.0 });
    expect(tight.bounds.x[1]).toBeLessThan(loose.bounds.x[1]);
    expect(tight.bounds.y[1]).toBeLessThan(loose.bounds.y[1]);
    // Z is depth-driven, not margin-driven.
    expect(tight.bounds.z).toEqual(loose.bounds.z);
    // Ratio of half-widths matches the ratio of margins (0.5 / 1.0 = 0.5).
    expect(tight.bounds.x[1] / loose.bounds.x[1]).toBeCloseTo(0.5, 5);
  });

  it('marginRatio is clamped to [0, 1] (defensive)', () => {
    const negative = computeViewportFit({ width: 1920, height: 1080, marginRatio: -0.5 });
    const huge = computeViewportFit({ width: 1920, height: 1080, marginRatio: 99 });
    // Negative clamps to 0 → bounds floor at 0.5 (the safety minimum).
    expect(negative.bounds.x[1]).toBe(0.5);
    // huge clamped to 1.0 → bounds match marginRatio: 1
    const at1 = computeViewportFit({ width: 1920, height: 1080, marginRatio: 1.0 });
    expect(huge.bounds.x[1]).toBeCloseTo(at1.bounds.x[1], 5);
  });

  it('depth opt drives the z-axis range symmetrically around 0', () => {
    const shallow = computeViewportFit({ width: 1920, height: 1080, depth: 2 });
    const deep = computeViewportFit({ width: 1920, height: 1080, depth: 10 });
    expect(shallow.bounds.z).toEqual([-1, 1]);
    expect(deep.bounds.z).toEqual([-5, 5]);
  });

  it('cameraDistance scales visibleWidth/visibleHeight proportionally (depth=0)', () => {
    // Pin depth=0 so the closest-z compensation collapses to cameraDistance,
    // making the relationship strictly proportional.
    const near = computeViewportFit({ width: 1920, height: 1080, cameraDistance: 6, depth: 0 });
    const far = computeViewportFit({ width: 1920, height: 1080, cameraDistance: 12, depth: 0 });
    expect(far.visibleHeight).toBeCloseTo(near.visibleHeight * 2, 5);
    expect(far.visibleWidth).toBeCloseTo(near.visibleWidth * 2, 5);
  });
});

// ─── Bounds invariants ──────────────────────────────────────────────────

describe('computeViewportFit() · bounds invariants', () => {
  // Spec-relevant viewports stress every regime of the FOV curve.
  const cases = [
    { label: 'desktop 1920×1080', width: 1920, height: 1080 },
    { label: 'desktop 1440×900', width: 1440, height: 900 },
    { label: 'iPad portrait 768×1024', width: 768, height: 1024 },
    { label: 'iPad landscape 1024×768', width: 1024, height: 768 },
    { label: 'iPhone XR 414×896', width: 414, height: 896 },
    { label: 'iPhone 13 mini 375×812', width: 375, height: 812 },
    { label: 'iPhone SE 320×568', width: 320, height: 568 },
  ];

  for (const c of cases) {
    it(`${c.label}: bounds are symmetric around 0 on every axis`, () => {
      const fit = computeViewportFit({ width: c.width, height: c.height });
      for (const axis of ['x', 'y', 'z']) {
        expect(fit.bounds[axis][0]).toBeCloseTo(-fit.bounds[axis][1], 9);
      }
    });

    it(`${c.label}: bounds are non-degenerate (positive halfX/halfY/halfZ)`, () => {
      const fit = computeViewportFit({ width: c.width, height: c.height });
      expect(fit.bounds.x[1]).toBeGreaterThan(0);
      expect(fit.bounds.y[1]).toBeGreaterThan(0);
      expect(fit.bounds.z[1]).toBeGreaterThan(0);
    });

    it(`${c.label}: visibleWidth / visibleHeight equals aspect`, () => {
      const fit = computeViewportFit({ width: c.width, height: c.height });
      expect(fit.visibleWidth / fit.visibleHeight).toBeCloseTo(fit.aspect, 5);
    });

    it(`${c.label}: isPortrait flag matches width < height`, () => {
      const fit = computeViewportFit({ width: c.width, height: c.height });
      expect(fit.isPortrait).toBe(c.width < c.height);
    });
  }
});

// ─── Continuity: no FOV snap when resizing through PORTRAIT_PIVOT ───────

describe('computeViewportFit() · continuity at curve boundaries', () => {
  it('FOV is continuous at the PORTRAIT_PIVOT boundary (no snap from desktop → narrow)', () => {
    const just_above = pickFov(PORTRAIT_PIVOT + 1e-6);
    const at_pivot = pickFov(PORTRAIT_PIVOT);
    const just_below = pickFov(PORTRAIT_PIVOT - 1e-6);
    expect(just_above).toBe(DEFAULT_BASE_FOV);
    expect(at_pivot).toBe(DEFAULT_BASE_FOV);
    // Just below the pivot: lerp value ≈ baseFov with a tiny delta
    expect(just_below).toBeCloseTo(DEFAULT_BASE_FOV, 4);
  });

  it('FOV is continuous at the PORTRAIT_FULL boundary (no snap from narrow → deep portrait)', () => {
    const just_above = pickFov(PORTRAIT_FULL + 1e-6);
    const at_full = pickFov(PORTRAIT_FULL);
    const just_below = pickFov(PORTRAIT_FULL - 1e-6);
    expect(at_full).toBe(DEFAULT_PORTRAIT_FOV);
    expect(just_below).toBe(DEFAULT_PORTRAIT_FOV);
    expect(just_above).toBeCloseTo(DEFAULT_PORTRAIT_FOV, 4);
  });

  it('rotating phone portrait (375×812) → landscape (812×375) gives matching aspect-mirror but different FOV regimes', () => {
    const portrait = computeViewportFit({ width: 375, height: 812 });
    const landscape = computeViewportFit({ width: 812, height: 375 });
    expect(portrait.aspect).toBeCloseTo(1 / landscape.aspect, 5);
    expect(portrait.fov).toBe(DEFAULT_PORTRAIT_FOV);
    expect(landscape.fov).toBe(DEFAULT_BASE_FOV);
    expect(portrait.isPortrait).toBe(true);
    expect(landscape.isPortrait).toBe(false);
  });
});
