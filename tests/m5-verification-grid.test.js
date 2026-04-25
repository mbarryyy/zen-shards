// Phase M5 — Cross-phase mobile QA verification grid.
//
// Walks the canonical viewport grid agreed in `docs/mobile-audit.md` §14:
//
//   320×568  (iPhone SE 1st gen — smallest realistic portrait)
//   375×667  (iPhone SE 2/3, iPhone 13 mini at 16:9.5 ratio)
//   414×896  (iPhone XR / 11 Pro Max portrait)
//   768×1024 (iPad portrait)
//   812×375  (iPhone landscape height-budget regime)
//   896×414  (iPhone XR landscape)
//
// For every viewport this file asserts the UNION of behaviors that should
// apply: M2 (computeViewportFit camera/bounds), M3 (HUD breakpoint rules),
// M4 (app-shell + cross-cutting rules). The phase-specific suites already
// cover each layer in isolation; M5 is the integration check that the
// LAYERS COMPOSE without orphans, drift, or conflicts.
//
// Plus a "cross-phase invariants" section that catches issues no single
// phase test can: safe-area chain integrity, custom-prop baseline,
// touch-target floor across every interactive surface, reduced-motion
// suppression sweeping every animation surface in the codebase.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  computeViewportFit,
  pickFov,
  DEFAULT_BASE_FOV,
  DEFAULT_PORTRAIT_FOV,
} from '../src/viewport-fit.js';
import { generatePositions } from '../src/positions.js';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(resolve(here, '..', 'index.html'), 'utf8');

// ── helpers (same shape as mobile-shell.test.js) ────────────────────────

function getAllMediaBlocks(maxWidthPx) {
  const re = new RegExp(
    `@media\\s*\\(\\s*max-width:\\s*${maxWidthPx}px\\s*\\)\\s*\\{`,
    'g',
  );
  const bodies = [];
  let m;
  while ((m = re.exec(HTML)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < HTML.length && depth > 0) {
      const ch = HTML[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    if (depth === 0) bodies.push(HTML.slice(start, i - 1));
  }
  return bodies;
}

function getMediaBlockByPrelude(preludeRegex) {
  const m = preludeRegex.exec(HTML);
  if (!m) return null;
  const openIdx = HTML.indexOf('{', m.index);
  if (openIdx === -1) return null;
  let depth = 1;
  let i = openIdx + 1;
  const start = i;
  while (i < HTML.length && depth > 0) {
    const ch = HTML[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return depth === 0 ? HTML.slice(start, i - 1) : null;
}

function getRule(cssChunk, selector) {
  if (cssChunk == null) return null;
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `(?:^|[}\\n;]|\\*\\/)\\s*${esc}\\s*\\{([^}]*)\\}`,
    'm',
  );
  const m = re.exec(cssChunk);
  if (!m) return null;
  return m[1].replace(/\/\*[\s\S]*?\*\//g, '');
}

function getRuleAt(maxWidthPx, selector) {
  for (const body of getAllMediaBlocks(maxWidthPx)) {
    const rule = getRule(body, selector);
    if (rule != null) return rule;
  }
  return null;
}

function getTopLevelRule(selector) {
  let stripped = '';
  let i = 0;
  while (i < HTML.length) {
    const m = /@media\s*\([^{]*\)\s*\{/.exec(HTML.slice(i));
    if (!m) {
      stripped += HTML.slice(i);
      break;
    }
    stripped += HTML.slice(i, i + m.index);
    let depth = 1;
    let j = i + m.index + m[0].length;
    while (j < HTML.length && depth > 0) {
      const ch = HTML[j];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      j++;
    }
    i = j;
  }
  return getRule(stripped, selector);
}

/** Which max-width @media blocks "fire" at a given viewport width. */
function activeBreakpoints(width) {
  return [768, 600, 480, 360].filter((bp) => width <= bp);
}

// ─── Viewport grid ──────────────────────────────────────────────────────

const GRID = [
  {
    label: 'iPhone SE 1st gen (320×568) portrait',
    width: 320,
    height: 568,
    expectedFov: { min: 64, max: 65 },
    expectedActiveBreakpoints: [768, 600, 480, 360],
  },
  {
    label: 'iPhone SE 2/3 (375×667) portrait',
    width: 375,
    height: 667,
    expectedFov: { min: 64, max: 65 },  // aspect 0.5622 — just inside the lerp
    expectedActiveBreakpoints: [768, 600, 480],
  },
  {
    label: 'iPhone 13 mini (375×812) portrait',
    width: 375,
    height: 812,
    expectedFov: { min: 65, max: 65 },  // aspect 0.4618 — deep portrait
    expectedActiveBreakpoints: [768, 600, 480],
  },
  {
    label: 'iPhone XR / 11 Pro Max (414×896) portrait',
    width: 414,
    height: 896,
    expectedFov: { min: 65, max: 65 },  // aspect 0.4621 — deep portrait
    expectedActiveBreakpoints: [768, 600, 480],
  },
  {
    label: 'iPad (768×1024) portrait',
    width: 768,
    height: 1024,
    expectedFov: { min: 56, max: 57 },  // 45 + 20 * (1.0-0.75)/0.45 ≈ 56.11
    expectedActiveBreakpoints: [768],
  },
  {
    label: 'iPhone landscape (812×375) — height-budget regime',
    width: 812,
    height: 375,
    expectedFov: { min: 45, max: 45 },  // back to baseFov
    expectedActiveBreakpoints: [],
    isLandscapePhone: true,
  },
  {
    label: 'iPhone XR landscape (896×414)',
    width: 896,
    height: 414,
    expectedFov: { min: 45, max: 45 },
    expectedActiveBreakpoints: [],
    isLandscapePhone: true,
  },
];

// ─── Per-viewport canonical assertions ──────────────────────────────────

describe('M5 verification grid · per-viewport canonical assertions', () => {
  for (const v of GRID) {
    describe(v.label, () => {
      it('M2 · computeViewportFit returns FOV within the expected range and finite bounds', () => {
        const fit = computeViewportFit({ width: v.width, height: v.height });
        expect(fit.fov).toBeGreaterThanOrEqual(v.expectedFov.min);
        expect(fit.fov).toBeLessThanOrEqual(v.expectedFov.max);
        // Bounds are always symmetric and finite — no NaN/Infinity at any viewport.
        for (const axis of ['x', 'y', 'z']) {
          expect(Number.isFinite(fit.bounds[axis][0])).toBe(true);
          expect(Number.isFinite(fit.bounds[axis][1])).toBe(true);
          expect(fit.bounds[axis][0]).toBeCloseTo(-fit.bounds[axis][1], 9);
        }
        // isPortrait flag matches actual orientation.
        expect(fit.isPortrait).toBe(v.width < v.height);
      });

      it('M3 · the right HUD breakpoints fire (no over-/under-application)', () => {
        const active = activeBreakpoints(v.width);
        expect(active).toEqual(v.expectedActiveBreakpoints);

        // For every active mobile breakpoint, at least one HUD rule must be
        // declared inside one of its blocks (no empty/dead breakpoint).
        for (const bp of active) {
          const blocks = getAllMediaBlocks(bp);
          const concat = blocks.join('\n');
          expect(
            /\.hud-(top|pill|hint|lives|calm|level|gameover)/.test(concat),
            `@${bp}px should touch at least one HUD selector`,
          ).toBe(true);
        }
      });

      if (v.expectedActiveBreakpoints.includes(480)) {
        it('M4 · @480 narrowest-phone rules fire: nav user-name hidden, profile stats 1-col, leaderboard rows tighten', () => {
          expect(getRuleAt(480, '.app-nav__user-name')).toMatch(/display:\s*none/);
          expect(getRuleAt(480, '.profile__stats')).toMatch(/grid-template-columns:\s*1fr/);
          expect(getRuleAt(480, '.leaderboard__row')).toMatch(/grid-template-columns:\s*30px 1fr auto/);
          // Calm bar wordmark hidden on phones.
          expect(getRuleAt(480, '.hud-calm__label')).toMatch(/display:\s*none/);
          // Level pill hidden on phones (Round HUD pill is canonical).
          expect(getRuleAt(480, '.hud-level')).toMatch(/display:\s*none/);
        });
      }

      if (v.expectedActiveBreakpoints.includes(360) && v.width <= 360) {
        it('M3 · @360 smallest-phone tier: calm bar fully hidden, pill font 10px', () => {
          expect(getRuleAt(360, '.hud-calm__bar')).toMatch(/display:\s*none/);
          expect(getRuleAt(360, '.hud-pill')).toMatch(/font-size:\s*10px/);
        });
      }

      if (v.isLandscapePhone) {
        it('Landscape height-budget rules fire (max-width rules don\'t — width > 768 here)', () => {
          // None of the max-width breakpoints apply, but the landscape phone
          // block (orientation: landscape and max-height: 480px) DOES apply
          // and overrides the column-stack from @480 with row-flow because
          // vertical room is the constraint.
          const block = getMediaBlockByPrelude(
            /@media\s*\(\s*orientation:\s*landscape\s*\)\s*and\s*\(\s*max-height:\s*480px\s*\)/,
          );
          expect(block).not.toBeNull();
          expect(v.height).toBeLessThanOrEqual(480);
          expect(block).toMatch(/\.hud-gameover__actions\s*\{[^}]*flex-direction:\s*row/);
          expect(block).toMatch(/\.hud-level\s*\{[^}]*display:\s*none/);
        });
      }
    });
  }
});

// ─── Cross-phase invariants ────────────────────────────────────────────

describe('M5 cross-phase invariants', () => {
  it('--nav-h is declared on :root OUTSIDE any @media (always defined, no orphan references)', () => {
    const root = getTopLevelRule(':root');
    expect(root).not.toBeNull();
    expect(root).toMatch(/--nav-h:\s*\d+px/);
  });

  it('safe-area chain: --nav-h folds in env(safe-area-inset-top) at @768 and @480 (notched phones move HUD together)', () => {
    const r768 = getRuleAt(768, ':root');
    const r480 = getRuleAt(480, ':root');
    expect(r768).toMatch(/--nav-h:\s*calc\(\s*env\(\s*safe-area-inset-top/);
    expect(r480).toMatch(/--nav-h:\s*calc\(\s*env\(\s*safe-area-inset-top/);
  });

  it('HUD positioning consumes var(--nav-h) — no bare safe-area orphans inside the HUD', () => {
    // Top-level HUD rules use --nav-h (M3+M4 refactor).
    expect(getTopLevelRule('.hud-top')).toMatch(/var\(--nav-h\)/);
    expect(getTopLevelRule('.hud-hint')).toMatch(/var\(--nav-h\)/);
    expect(getTopLevelRule('.hud-lives')).toMatch(/var\(--nav-h\)/);
    // Inside @600 too (the shared-anchor invariant).
    expect(getRuleAt(600, '.hud-top')).toMatch(/var\(--nav-h\)/);
    expect(getRuleAt(600, '.hud-hint')).toMatch(/var\(--nav-h\)/);
    expect(getRuleAt(600, '.hud-lives')).toMatch(/var\(--nav-h\)/);
  });

  it('touch-target floor: every WCAG-required surface has min-height 44px declared somewhere reachable on phones', () => {
    // Each row: [selector, where-it-lives]
    const required = [
      ['.zen-btn', getTopLevelRule('.zen-btn')],
      ['.app-nav__logo', getTopLevelRule('.app-nav__logo')],
      ['.app-nav__links a', getRuleAt(600, '.app-nav__links a')],
      ['.app-nav__signin', getRuleAt(600, '.app-nav__signin')],
      ['.hud-gameover__btn', getRuleAt(600, '.hud-gameover__btn')],
      ['.landing__cta .zen-btn', getRuleAt(600, '.landing__cta .zen-btn')],
    ];
    for (const [label, body] of required) {
      expect(body, `${label} rule should exist`).not.toBeNull();
      expect(body, `${label} should declare min-height ≥ 44px`).toMatch(
        /min-height:\s*(?:44|48)px/,
      );
    }
  });

  it('universal touch baseline: tap-highlight + touch-action: manipulation apply to every interactive element type', () => {
    const rule = getTopLevelRule('button, a, [role="button"], input, [tabindex]');
    expect(rule).not.toBeNull();
    expect(rule).toMatch(/-webkit-tap-highlight-color:\s*transparent/);
    expect(rule).toMatch(/touch-action:\s*manipulation/);
  });

  it('hover-stick reset: every hover state in the codebase has a matching reset under @media (hover: none)', () => {
    const block = getMediaBlockByPrelude(/@media\s*\(\s*hover:\s*none\s*\)/);
    expect(block).not.toBeNull();
    // Every :hover declared in the desktop CSS that affects an interactive
    // element must have a (hover: none) reset, otherwise iOS taps will leave
    // a stuck hover state after the user lifts their finger.
    const hoverSelectors = [
      '.zen-btn:hover',
      '.app-nav__links a:hover',
      '.app-nav__signin:hover',
      '.leaderboard__row:hover',
      '.hud-gameover__btn:hover',
    ];
    for (const sel of hoverSelectors) {
      expect(block, `${sel} needs a (hover: none) reset to avoid sticky tap`).toMatch(
        new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
    }
  });

  it('reduced-motion sweep: every M3+M4 animation surface is suppressed', () => {
    // Two prefers-reduced-motion blocks: one HUD (M3), one shell (M4).
    // Concatenate them and confirm every animated thing is in the union.
    const re = /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{/g;
    const bodies = [];
    let m;
    while ((m = re.exec(HTML)) !== null) {
      let depth = 1;
      let i = m.index + m[0].length;
      const start = i;
      while (i < HTML.length && depth > 0) {
        const ch = HTML[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
      }
      bodies.push(HTML.slice(start, i - 1));
    }
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    const concat = bodies.join('\n');
    // Animation surfaces that must be suppressed:
    expect(concat).toMatch(/animation-duration:\s*0\.001ms\s*!important/); // global blanket
    expect(concat).toMatch(/\.hud-pill__value\.pulsing/);                  // HUD value pulse
    expect(concat).toMatch(/\.hud-calm__tier\.pulsing/);                   // calm tier pulse
    expect(concat).toMatch(/\.hud-lives__dot\.losing/);                    // lives lose pulse
    expect(concat).toMatch(/\.landing__mark-orb/);                         // landing orb breath
    expect(concat).toMatch(/\.app-nav/);                                   // nav fade
    expect(concat).toMatch(/\.page-container/);                            // route swap fade
  });

  it('100dvh + page-container scroll override: tall content scrolls on phones, play view stays locked', () => {
    // Both rules live inside the @768 cross-cutting block. M5 verifies the
    // pair compose: page-container scrolls EXCEPT when it contains .page--play.
    const r = getRuleAt(768, '.page-container');
    expect(r).not.toBeNull();
    expect(r).toMatch(/overflow-y:\s*auto/);
    const concat = getAllMediaBlocks(768).join('\n');
    expect(concat).toMatch(/\.page-container:has\(\.page--play\)\s*\{[^}]*overflow:\s*hidden/);
    expect(concat).toMatch(/html,\s*body,\s*#root,\s*#app\s*\{[^}]*height:\s*100dvh/);
  });

  it('M2 ↔ M3 sanity: at every grid viewport, computeViewportFit() returns finite, sensible bounds (no clip from canvas-fills-viewport assumption)', () => {
    // The HUD overlays the canvas (z-index 10 vs 1). If bounds collapsed at
    // any viewport, balls would spawn at origin and look broken. Sweep the
    // grid and verify minimum half-width / half-height stays usable (>1 unit).
    for (const v of GRID) {
      const fit = computeViewportFit({ width: v.width, height: v.height });
      expect(fit.bounds.x[1], `${v.label}: halfX too small`).toBeGreaterThan(1);
      expect(fit.bounds.y[1], `${v.label}: halfY too small`).toBeGreaterThan(1);
    }
  });

  it('breakpoint coverage map: 360 / 480 / 600 / 768 / hover:none / orientation-landscape / 2× reduced-motion all exist', () => {
    // M5 sanity: the cross-phase test landscape isn't missing a block.
    expect(getAllMediaBlocks(360).length).toBeGreaterThanOrEqual(1);
    expect(getAllMediaBlocks(480).length).toBeGreaterThanOrEqual(2); // HUD + shell + cross-cut
    expect(getAllMediaBlocks(600).length).toBeGreaterThanOrEqual(2);
    expect(getAllMediaBlocks(768).length).toBeGreaterThanOrEqual(2);
    expect(getMediaBlockByPrelude(/@media\s*\(\s*hover:\s*none\s*\)/)).not.toBeNull();
    expect(
      getMediaBlockByPrelude(
        /@media\s*\(\s*orientation:\s*landscape\s*\)\s*and\s*\(\s*max-height:\s*480px\s*\)/,
      ),
    ).not.toBeNull();
    // Two reduced-motion blocks (HUD + shell).
    const rmRe = /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/g;
    let count = 0;
    let m;
    while ((m = rmRe.exec(HTML)) !== null) count++;
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

// ─── Final notch + reduced-motion sanity ───────────────────────────────

describe('M5 · notch simulation + reduced-motion combined sanity', () => {
  it('notched portrait phone (375×812 with safe-area-inset-top simulated): HUD + nav both folded into --nav-h, page padding follows', () => {
    // Conceptual test: assert the rules a notched phone's CSS engine WOULD
    // resolve. We can't simulate env(safe-area-inset-top) at runtime in jsdom,
    // but we can verify (a) --nav-h embeds it, (b) every consuming surface
    // pulls from --nav-h, (c) the nav itself adds padding-top: max(N, env(top)).
    const navAt600 = getRuleAt(600, '.app-nav');
    expect(navAt600).toMatch(/padding-top:\s*max\([^)]*env\(\s*safe-area-inset-top/);
    // HUD top, hint, lives at @480 all anchor to var(--nav-h):
    for (const sel of ['.hud-top', '.hud-hint', '.hud-lives']) {
      expect(getRuleAt(480, sel)).toMatch(/var\(--nav-h\)/);
    }
    // :root @480 sets --nav-h to safe-area-inset-top + 56 → folds the notch in.
    expect(getRuleAt(480, ':root')).toMatch(/--nav-h:\s*calc\(\s*env\(\s*safe-area-inset-top[^)]*\)\s*\+\s*56px/);
  });

  it('reduced-motion + 320 portrait combined (worst case): both M3 (HUD pulses) and M4 (orb/nav/page-fade) suppressed independently', () => {
    // The two reduced-motion blocks are independent — neither overrides the
    // other. Both still fire when prefers-reduced-motion is set, so even at
    // 320×568 (smallest viewport, most active media queries), animations are
    // killed across ALL phases.
    const re = /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{/g;
    const bodies = [];
    let m;
    while ((m = re.exec(HTML)) !== null) {
      let depth = 1;
      let i = m.index + m[0].length;
      const start = i;
      while (i < HTML.length && depth > 0) {
        const ch = HTML[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
      }
      bodies.push(HTML.slice(start, i - 1));
    }
    // First block (HUD): kills M3 pulses
    expect(bodies[0]).toMatch(/\.hud-pill__value\.pulsing/);
    // Second block (shell): kills M4 orb breathe + nav fade + page-container fade
    expect(bodies[1]).toMatch(/\.landing__mark-orb/);
    expect(bodies[1]).toMatch(/\.app-nav/);
    expect(bodies[1]).toMatch(/\.page-container/);
  });

  it('rotation portrait → landscape mid-game: M2 orientationchange listener fires before next spawnRound (verified in m2-integration.test.js)', () => {
    // Sanity reference — the M2 integration suite already locks this. Here
    // we just keep the chain visible from the M5 grid: rotating the phone
    // re-runs computeViewportFit (via orientationchange), and the next
    // spawnRound pulls the new bounds. Combined with @media (orientation:
    // landscape) and (max-height: 480px) (which reflows HUD chrome by height),
    // a rotation triggers BOTH a CSS layout pass AND a camera/bounds resync.
    const sceneSrc = readFileSync(resolve(here, '..', 'src', 'scene.js'), 'utf8');
    expect(sceneSrc).toMatch(/window\.addEventListener\(\s*['"]orientationchange['"]/);
    expect(sceneSrc).toMatch(/window\.removeEventListener\(\s*['"]orientationchange['"]/);
  });
});

// ─── M2 ↔ positions.js end-to-end: viewport-fit bounds keep balls in frame ─

describe('M5 · M2 ↔ positions.js contract: every spawn lands inside the live viewport bounds', () => {
  // Feed each grid viewport's computeViewportFit result into generatePositions
  // and assert no position drifts outside the bounds. This is the live chain
  // play.js exercises every round — locks the contract end-to-end so a future
  // refactor of either module can't silently let balls clip off-canvas.
  for (const v of GRID) {
    it(`${v.label}: 12 generated balls all land inside fit.bounds`, () => {
      const fit = computeViewportFit({ width: v.width, height: v.height });
      // Deterministic RNG so the test is stable.
      let seed = 1;
      const rng = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
      const positions = generatePositions(12, { bounds: fit.bounds, rng });
      expect(positions.length).toBe(12);
      for (const p of positions) {
        expect(p.x, `${v.label}: x outside [${fit.bounds.x[0]}, ${fit.bounds.x[1]}]`)
          .toBeGreaterThanOrEqual(fit.bounds.x[0]);
        expect(p.x).toBeLessThanOrEqual(fit.bounds.x[1]);
        expect(p.y, `${v.label}: y outside [${fit.bounds.y[0]}, ${fit.bounds.y[1]}]`)
          .toBeGreaterThanOrEqual(fit.bounds.y[0]);
        expect(p.y).toBeLessThanOrEqual(fit.bounds.y[1]);
        expect(p.z).toBeGreaterThanOrEqual(fit.bounds.z[0]);
        expect(p.z).toBeLessThanOrEqual(fit.bounds.z[1]);
      }
    });
  }

  it('portrait phone bounds are tighter on X than desktop bounds (the whole point of M2)', () => {
    const desktop = computeViewportFit({ width: 1440, height: 900 });
    const portrait = computeViewportFit({ width: 375, height: 812 });
    expect(portrait.bounds.x[1]).toBeLessThan(desktop.bounds.x[1]);
    // And portrait Y is taller than desktop Y on tall phones — confirms the
    // visible-volume reshapes correctly when the user rotates to portrait.
    expect(portrait.bounds.y[1]).toBeGreaterThan(desktop.bounds.y[1]);
  });
});

// ─── No-regression check: count + spot-check ───────────────────────────

describe('M5 · regression spot-checks', () => {
  it('still has the 4 core HUD breakpoints (768 / 600 / 480 / 360) declared at least once', () => {
    expect(getAllMediaBlocks(768).length).toBeGreaterThanOrEqual(1);
    expect(getAllMediaBlocks(600).length).toBeGreaterThanOrEqual(1);
    expect(getAllMediaBlocks(480).length).toBeGreaterThanOrEqual(1);
    expect(getAllMediaBlocks(360).length).toBeGreaterThanOrEqual(1);
  });

  it('viewport-fit DEFAULT_BASE_FOV / DEFAULT_PORTRAIT_FOV match the documented 45° / 65°', () => {
    expect(DEFAULT_BASE_FOV).toBe(45);
    expect(DEFAULT_PORTRAIT_FOV).toBe(65);
    expect(pickFov(2.0)).toBe(45);
    expect(pickFov(0.4)).toBe(65);
  });

  it('viewport-fit module is importable from scene.js (M2 integration intact)', () => {
    const sceneSrc = readFileSync(resolve(here, '..', 'src', 'scene.js'), 'utf8');
    expect(sceneSrc).toMatch(/from\s*['"]\.\/viewport-fit\.js['"]/);
  });
});
