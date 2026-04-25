// Phase M3 — Mobile HUD layout tests.
//
// jsdom does NOT evaluate @media queries against window.innerWidth or apply
// stylesheet cascade — getComputedStyle returns inline styles only. So the
// reliable way to lock M3 in is to parse the index.html CSS source and assert
// that each rule the checklist promised is present at the correct breakpoint.
//
// This complements the existing 676-test suite (which covers HUD structure,
// feedback, scoring, etc.) without modifying any of those tests.
//
// Sections mirror the ui-3d-designer M3 behavior checklist 1:1.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(resolve(here, '..', 'index.html'), 'utf8');

/**
 * Extract the body of a top-level @media block by max-width breakpoint.
 * Naive but deterministic: matches `@media (max-width: <px>px)` and walks
 * brace nesting to find the matching closer. Returns the block contents
 * (everything between the outermost braces) or null if not found.
 */
function getMediaBlock(maxWidthPx) {
  const re = new RegExp(`@media\\s*\\(\\s*max-width:\\s*${maxWidthPx}px\\s*\\)\\s*\\{`);
  const m = re.exec(HTML);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < HTML.length && depth > 0) {
    const ch = HTML[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return depth === 0 ? HTML.slice(start, i - 1) : null;
}

/**
 * Pull the declaration block for a single selector inside a CSS chunk.
 * Pass the raw selector (e.g. `.hud-pill`) — escaping is handled here.
 * Returns the contents between { } for the selector's first occurrence,
 * or null. Anchored so `.foo` does not match `.foobar`.
 */
function getRule(cssChunk, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Selector must be preceded by start-of-chunk, `}`, `,`, or `*/` (comment end).
  // Followed by optional space then `{` (so `.foo` doesn't match `.foobar`).
  const re = new RegExp(
    `(?:^|[}\\n;]|\\*\\/)\\s*${esc}\\s*\\{([^}]*)\\}`,
    'm',
  );
  const m = re.exec(cssChunk);
  return m ? m[1] : null;
}

/**
 * Extract a top-level @media block whose prelude matches a regex.
 * Walks brace nesting to find the matching closer.
 */
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

/** Sanity helper — does a rule body declare `prop: value`? Whitespace-tolerant. */
function hasDecl(ruleBody, prop, value) {
  if (ruleBody == null) return false;
  // Match `prop:` then capture until `;` or end.
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]*?)\\s*(?:;|$)`, 'i');
  const m = re.exec(ruleBody);
  if (!m) return false;
  if (value == null) return true; // any value
  return m[1].trim() === value.trim();
}

// ─── Section 0: Global / viewport ────────────────────────────────────────

describe('M3 · viewport + global mobile guards', () => {
  it('viewport meta declares viewport-fit=cover (enables env(safe-area-inset-*))', () => {
    expect(HTML).toMatch(
      /<meta\s+name="viewport"[^>]*viewport-fit=cover[^>]*>/,
    );
  });

  it('viewport meta keeps width=device-width + initial-scale=1.0', () => {
    expect(HTML).toMatch(/width=device-width/);
    expect(HTML).toMatch(/initial-scale=1\.0/);
  });

  it('body has overflow-x: hidden (defensive against sub-pixel transform overflow)', () => {
    // body { ... overflow-x: hidden ... }
    const re = /\bbody\s*\{[^}]*overflow-x\s*:\s*hidden/m;
    expect(re.test(HTML)).toBe(true);
  });

  it('html, body retain overflow: hidden on the global shell (play view still locks)', () => {
    expect(HTML).toMatch(/html,\s*body[^{]*\{[^}]*overflow:\s*hidden/);
  });
});

// ─── Section 1: HUD top pills ────────────────────────────────────────────

describe('M3 · HUD pills mobile rules', () => {
  it('.hud-pill has white-space: nowrap so labels never wrap when squeezed', () => {
    // Find the .hud-pill rule outside any @media (top-level rule).
    // We scan from the start of the file up to the first @media block.
    const firstMedia = HTML.indexOf('@media');
    const pre = firstMedia === -1 ? HTML : HTML.slice(0, firstMedia);
    const rule = getRule(pre, '.hud-pill');
    expect(rule).not.toBeNull();
    expect(hasDecl(rule, 'white-space', 'nowrap')).toBe(true);
  });

  it('@media (max-width: 600px): pills tighten to ~7×14 padding, font 12px, gap 10px', () => {
    const block = getMediaBlock(600);
    expect(block).not.toBeNull();
    const top = getRule(block, '.hud-top');
    expect(hasDecl(top, 'gap', '10px')).toBe(true);
    const pill = getRule(block, '.hud-pill');
    expect(hasDecl(pill, 'padding', '7px 14px')).toBe(true);
    expect(hasDecl(pill, 'font-size', '12px')).toBe(true);
  });

  it('@media (max-width: 600px): hud-top top is anchored to var(--nav-h) (which folds in safe-area-inset-top)', () => {
    const block = getMediaBlock(600);
    const top = getRule(block, '.hud-top');
    // Post-M4: positioning routes through --nav-h instead of raw env(safe-area-inset-top).
    // The custom prop is set by the cross-cutting @768 / @480 :root rules and
    // recomputes safe-area-inset-top + nav-padding in one place. mobile-shell
    // tests verify --nav-h contains env(safe-area-inset-top, 0px).
    expect(top).toMatch(/top:\s*calc\(\s*var\(--nav-h\)/);
  });

  it('@media (max-width: 480px): pills shrink to 11px / label 9px and gap tightens to 8', () => {
    const block = getMediaBlock(480);
    expect(block).not.toBeNull();
    const top = getRule(block, '.hud-top');
    expect(hasDecl(top, 'gap', '8px')).toBe(true);
    const pill = getRule(block, '.hud-pill');
    expect(hasDecl(pill, 'font-size', '11px')).toBe(true);
    expect(hasDecl(pill, 'padding', '6px 12px')).toBe(true);
    const label = getRule(block, '.hud-pill__label');
    expect(hasDecl(label, 'font-size', '9px')).toBe(true);
  });

  it('@media (max-width: 360px): pills go to 10px and gap drops to 6', () => {
    const block = getMediaBlock(360);
    expect(block).not.toBeNull();
    const top = getRule(block, '.hud-top');
    expect(hasDecl(top, 'gap', '6px')).toBe(true);
    const pill = getRule(block, '.hud-pill');
    expect(hasDecl(pill, 'font-size', '10px')).toBe(true);
  });

  it('@media (max-width: 768px): tablet adjustment is minimal (calm bar nudges only)', () => {
    const block = getMediaBlock(768);
    expect(block).not.toBeNull();
    const bar = getRule(block, '.hud-calm__bar');
    expect(hasDecl(bar, 'width', '120px')).toBe(true);
    // No font-size shrink on pills at this tier — tablets stay near-desktop.
    const pill = getRule(block, '.hud-pill');
    expect(pill).toBeNull();
  });
});

// ─── Section 2/3: Phase hint + lives ─────────────────────────────────────

describe('M3 · phase hint + lives follow safe-area + reduce gaps on mobile', () => {
  it('@media (max-width: 600px): hint and lives anchor to var(--nav-h) (safe-area folded via the custom prop)', () => {
    const block = getMediaBlock(600);
    const hint = getRule(block, '.hud-hint');
    const lives = getRule(block, '.hud-lives');
    expect(hint).toMatch(/top:\s*calc\(\s*var\(--nav-h\)/);
    expect(lives).toMatch(/top:\s*calc\(\s*var\(--nav-h\)/);
  });

  it('@media (max-width: 480px): hint shrinks to 10px / 0.22em and lives gap tightens to 10', () => {
    const block = getMediaBlock(480);
    const hint = getRule(block, '.hud-hint');
    expect(hasDecl(hint, 'font-size', '10px')).toBe(true);
    expect(hasDecl(hint, 'letter-spacing', '0.22em')).toBe(true);
    const lives = getRule(block, '.hud-lives');
    expect(hasDecl(lives, 'gap', '10px')).toBe(true);
  });

  it('hint + lives + pills are all coupled to the same anchor (no orphaning when nav grows on notched phones)', () => {
    // Post-M4: all three position via var(--nav-h) so when --nav-h recomputes
    // (e.g. @480 :root reset), all three move together — no orphan floating.
    const block600 = getMediaBlock(600);
    expect(block600).toMatch(/\.hud-top[^}]*var\(--nav-h\)/s);
    expect(block600).toMatch(/\.hud-hint[^}]*var\(--nav-h\)/s);
    expect(block600).toMatch(/\.hud-lives[^}]*var\(--nav-h\)/s);
  });
});

// ─── Section 4: Calm bar ─────────────────────────────────────────────────

describe('M3 · calm bar mobile collapse', () => {
  it('@media (max-width: 480px): calm bar narrows to 100px and CALM INDEX wordmark hidden', () => {
    const block = getMediaBlock(480);
    const bar = getRule(block, '.hud-calm__bar');
    expect(hasDecl(bar, 'width', '100px')).toBe(true);
    const label = getRule(block, '.hud-calm__label');
    expect(hasDecl(label, 'display', 'none')).toBe(true);
  });

  it('@media (max-width: 360px): calm bar fully hidden (only emoji + numeric value remain)', () => {
    const block = getMediaBlock(360);
    const bar = getRule(block, '.hud-calm__bar');
    expect(hasDecl(bar, 'display', 'none')).toBe(true);
  });

  it('@media (max-width: 600px): calm bar position uses safe-area-inset-left and -bottom', () => {
    const block = getMediaBlock(600);
    const calm = getRule(block, '.hud-calm');
    expect(calm).toMatch(/safe-area-inset-left/);
    expect(calm).toMatch(/safe-area-inset-bottom/);
  });
});

// ─── Section 5: Level pill ───────────────────────────────────────────────

describe('M3 · bottom-right level pill', () => {
  it('@media (max-width: 480px): level pill is hidden (Round HUD pill is canonical)', () => {
    const block = getMediaBlock(480);
    const lvl = getRule(block, '.hud-level');
    expect(hasDecl(lvl, 'display', 'none')).toBe(true);
  });

  it('@media (max-width: 600px): level pill respects right + bottom safe-area-inset', () => {
    const block = getMediaBlock(600);
    const lvl = getRule(block, '.hud-level');
    expect(lvl).toMatch(/safe-area-inset-right/);
    expect(lvl).toMatch(/safe-area-inset-bottom/);
  });
});

// ─── Section 6: Game-Over modal ─────────────────────────────────────────

describe('M3 · Game-Over modal mobile rules', () => {
  it('@media (max-width: 600px): panel drops min-width=320 and caps to 92vw / 88vh with internal scroll', () => {
    const block = getMediaBlock(600);
    const panel = getRule(block, '.hud-gameover__panel');
    expect(hasDecl(panel, 'min-width', '0')).toBe(true);
    expect(hasDecl(panel, 'max-width', '92vw')).toBe(true);
    expect(hasDecl(panel, 'max-height', '88vh')).toBe(true);
    expect(hasDecl(panel, 'overflow-y', 'auto')).toBe(true);
  });

  it('@media (max-width: 600px): button hits WCAG 2.5.5 min-height 44px', () => {
    const block = getMediaBlock(600);
    const btn = getRule(block, '.hud-gameover__btn');
    expect(hasDecl(btn, 'min-height', '44px')).toBe(true);
  });

  it('@media (max-width: 480px): action row stacks column with full-width 48px buttons', () => {
    const block = getMediaBlock(480);
    const actions = getRule(block, '.hud-gameover__actions');
    expect(hasDecl(actions, 'flex-direction', 'column')).toBe(true);
    const btn = getRule(block, '.hud-gameover__btn');
    expect(hasDecl(btn, 'width', '100%')).toBe(true);
    expect(hasDecl(btn, 'min-height', '48px')).toBe(true);
  });

  it('@media (max-width: 480px): title shrinks to 18px / 0.28em (fits 320 panel)', () => {
    const block = getMediaBlock(480);
    const title = getRule(block, '.hud-gameover__title');
    expect(hasDecl(title, 'font-size', '18px')).toBe(true);
    expect(hasDecl(title, 'letter-spacing', '0.28em')).toBe(true);
  });

  it('top-level panel still keeps the desktop scale-in entrance keyframe (motion preserved)', () => {
    // The .hud-gameover.entering rule lives outside @media — verify it survived.
    expect(HTML).toMatch(/\.hud-gameover\.entering\s+\.hud-gameover__panel\s*\{[^}]*transform:\s*scale\(0\.92\)/);
  });
});

// ─── Reduced-motion preservation ────────────────────────────────────────

describe('M3 · reduced-motion preservation', () => {
  it('prefers-reduced-motion still kills HUD pulses and forces 0.001ms animations globally', () => {
    expect(HTML).toMatch(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/);
    // The all-selector animation kill is the wrapped global guarantee.
    expect(HTML).toMatch(
      /prefers-reduced-motion[\s\S]*?\*,\s*\*::before,\s*\*::after\s*\{[^}]*animation-duration:\s*0\.001ms/,
    );
  });

  it('reduced-motion explicitly suppresses .hud-pill__value.pulsing, .hud-calm__tier.pulsing, .hud-lives__dot.losing', () => {
    // Use the brace-walking extractor — there are TWO prefers-reduced-motion blocks
    // (HUD pulses + landing orbs), and the HUD one is the first occurrence.
    const body = getMediaBlockByPrelude(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/);
    expect(body).not.toBeNull();
    expect(body).toMatch(/\.hud-pill__value\.pulsing/);
    expect(body).toMatch(/\.hud-calm__tier\.pulsing/);
    expect(body).toMatch(/\.hud-lives__dot\.losing/);
  });
});

// ─── Breakpoint completeness ────────────────────────────────────────────

describe('M3 · breakpoint coverage matches plan', () => {
  it('declares the four planned breakpoints: 768 / 600 / 480 / 360', () => {
    expect(getMediaBlock(768)).not.toBeNull();
    expect(getMediaBlock(600)).not.toBeNull();
    expect(getMediaBlock(480)).not.toBeNull();
    expect(getMediaBlock(360)).not.toBeNull();
  });

  it('each mobile breakpoint touches at least one HUD selector (no empty stubs)', () => {
    for (const bp of [768, 600, 480, 360]) {
      const block = getMediaBlock(bp);
      expect(block, `@media (max-width: ${bp}px) is empty`).toMatch(
        /\.hud-(top|pill|hint|lives|calm|level|gameover)/,
      );
    }
  });
});
