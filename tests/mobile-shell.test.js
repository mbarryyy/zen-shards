// Phase M4 — Mobile app-shell layout tests + cross-cutting QA-feedback fixes.
//
// Same parsing strategy as mobile-hud.test.js: jsdom doesn't apply @media
// queries against window.innerWidth, so we lock the rules at the source.
//
// IMPORTANT: index.html now declares MULTIPLE blocks per breakpoint
// (HUD-only, app-shell-only, cross-cutting). For source-locking purposes
// "is rule X declared anywhere at @Npx" is the right question, so the
// `getRuleAt(N, selector)` helper searches all matching @media blocks.
//
// Also covers the ui-3d-designer cross-cutting fixes incorporated from the
// QA audit review: 100dvh, page-container scroll override, --nav-h custom
// prop, hover-stick reset, and landscape-by-height phone rules.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import * as leaderboardView from '../src/views/leaderboard.js';
import * as authView from '../src/views/auth.js';
import { _resetMockData, signIn, addScore } from '../src/mock-data.js';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(resolve(here, '..', 'index.html'), 'utf8');

// ── CSS source-parsing helpers ──────────────────────────────────────────

/** Body of every top-level @media block matching `(max-width: <N>px)`. */
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

/** Body of an @media block whose prelude matches a regex. */
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
  // Strip CSS comments so hasDecl's `;`-anchor doesn't trip over `/* ... */`
  // sitting between two declarations on different lines.
  return m[1].replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Find a rule for `selector` across every @media block at the breakpoint. */
function getRuleAt(maxWidthPx, selector) {
  for (const body of getAllMediaBlocks(maxWidthPx)) {
    const rule = getRule(body, selector);
    if (rule != null) return rule;
  }
  return null;
}

/** Top-level rule (outside any @media). Strips every @media block first. */
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

function hasDecl(ruleBody, prop, value) {
  if (ruleBody == null) return false;
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]*?)\\s*(?:;|$)`, 'i');
  const m = re.exec(ruleBody);
  if (!m) return false;
  if (value == null) return true;
  return m[1].trim() === value.trim();
}

// ─── Top nav ─────────────────────────────────────────────────────────────

describe('M4 · top nav mobile rules', () => {
  it('@600px: nav padding honors safe-area-inset top/left/right', () => {
    const nav = getRuleAt(600, '.app-nav');
    expect(nav).not.toBeNull();
    expect(nav).toMatch(/padding-top:\s*max\([^)]*safe-area-inset-top/);
    expect(nav).toMatch(/padding-left:\s*max\([^)]*safe-area-inset-left/);
    expect(nav).toMatch(/padding-right:\s*max\([^)]*safe-area-inset-right/);
  });

  it('@600px: nav links hit ≥44px tap area via min-height + inline-flex', () => {
    const link = getRuleAt(600, '.app-nav__links a');
    expect(link).not.toBeNull();
    expect(hasDecl(link, 'min-height', '44px')).toBe(true);
    expect(hasDecl(link, 'display', 'inline-flex')).toBe(true);
    expect(link).toMatch(/align-items:\s*center/);
  });

  it('@600px: sign-in button hits ≥44px tap area', () => {
    const signin = getRuleAt(600, '.app-nav__signin');
    expect(signin).not.toBeNull();
    expect(hasDecl(signin, 'min-height', '44px')).toBe(true);
  });

  it('@600px: user badge truncates with ellipsis + capped at 30vw', () => {
    const user = getRuleAt(600, '.app-nav__user');
    expect(user).not.toBeNull();
    expect(hasDecl(user, 'overflow', 'hidden')).toBe(true);
    expect(hasDecl(user, 'text-overflow', 'ellipsis')).toBe(true);
    expect(hasDecl(user, 'white-space', 'nowrap')).toBe(true);
    expect(user).toMatch(/max-width:\s*30vw/);
  });

  it('@480px: user wordmark hidden + logo text truncates', () => {
    const userName = getRuleAt(480, '.app-nav__user-name');
    expect(hasDecl(userName, 'display', 'none')).toBe(true);
    const logoText = getRuleAt(480, '.app-nav__logo-text');
    expect(logoText).not.toBeNull();
    expect(hasDecl(logoText, 'overflow', 'hidden')).toBe(true);
    expect(hasDecl(logoText, 'text-overflow', 'ellipsis')).toBe(true);
    expect(logoText).toMatch(/max-width:\s*\d+px/);
  });
});

// ─── Landing ─────────────────────────────────────────────────────────────

describe('M4 · landing mobile rules', () => {
  it('landing title uses fluid clamp() (no fixed-size jumps across viewports)', () => {
    const title = getTopLevelRule('.landing__title');
    expect(title).not.toBeNull();
    expect(title).toMatch(/font-size:\s*clamp\(\s*2rem\s*,\s*8vw\s*,\s*3\.5rem\s*\)/);
    expect(title).toMatch(/letter-spacing:\s*clamp\(/);
  });

  it('@600px: CTAs stack column, full-width, ≥48px tall', () => {
    const cta = getRuleAt(600, '.landing__cta');
    expect(cta).not.toBeNull();
    expect(hasDecl(cta, 'flex-direction', 'column')).toBe(true);
    expect(hasDecl(cta, 'align-items', 'stretch')).toBe(true);

    const ctaBtn = getRuleAt(600, '.landing__cta .zen-btn');
    expect(ctaBtn).not.toBeNull();
    expect(hasDecl(ctaBtn, 'width', '100%')).toBe(true);
    expect(hasDecl(ctaBtn, 'min-height', '48px')).toBe(true);
  });

  it('@480px: orb cluster shrinks to ~76px and tagline shrinks to 11px', () => {
    const mark = getRuleAt(480, '.landing__mark');
    expect(hasDecl(mark, 'width', '76px')).toBe(true);
    expect(hasDecl(mark, 'height', '76px')).toBe(true);
    const tag = getRuleAt(480, '.landing__tagline');
    expect(hasDecl(tag, 'font-size', '11px')).toBe(true);
  });

  it('@600px: vertical breathing room reduced to gap=36px', () => {
    const landing = getRuleAt(600, '.landing');
    expect(hasDecl(landing, 'gap', '36px')).toBe(true);
  });
});

// ─── Auth ────────────────────────────────────────────────────────────────

describe('M4 · auth mobile rules', () => {
  it('@768px: input font-size bumped to 16px (kills iOS auto-zoom on focus)', () => {
    const input = getRuleAt(768, '.auth__input');
    expect(input).not.toBeNull();
    expect(hasDecl(input, 'font-size', '16px')).toBe(true);
  });

  it('@768px: auth card narrows to 380px max-width', () => {
    const auth = getRuleAt(768, '.auth');
    expect(hasDecl(auth, 'max-width', '380px')).toBe(true);
  });

  it('Continue button (.zen-btn) has ≥44px min-height baseline', () => {
    const btn = getTopLevelRule('.zen-btn');
    expect(btn).not.toBeNull();
    expect(hasDecl(btn, 'min-height', '44px')).toBe(true);
  });

  it('@600px: glass-card padding tightens (cards aren\'t pinched)', () => {
    const card = getRuleAt(600, '.glass-card');
    expect(hasDecl(card, 'padding', '28px 22px')).toBe(true);
  });
});

// ─── Leaderboard table → card transform ─────────────────────────────────

describe('M4 · leaderboard table → card layout', () => {
  it('@600px: row regrids to "rank name name / rank score tier"', () => {
    const row = getRuleAt(600, '.leaderboard__row');
    expect(row).not.toBeNull();
    expect(hasDecl(row, 'grid-template-columns', '36px 1fr auto')).toBe(true);
    expect(row).toMatch(/grid-template-areas:[\s\S]*"rank name name"/);
    expect(row).toMatch(/"rank score tier"/);
    expect(row).toMatch(/border:\s*1px solid/);
    expect(row).toMatch(/border-radius:\s*\d+px/);
  });

  it('@600px: each grid-area is wired to the right span', () => {
    expect(getRuleAt(600, '.leaderboard__rank')).toMatch(/grid-area:\s*rank/);
    expect(getRuleAt(600, '.leaderboard__name')).toMatch(/grid-area:\s*name/);
    expect(getRuleAt(600, '.leaderboard__score')).toMatch(/grid-area:\s*score/);
    expect(getRuleAt(600, '.leaderboard__tier')).toMatch(/grid-area:\s*tier/);
  });

  it('@480px: row tightens further (30px rank, 10×12 padding)', () => {
    const row = getRuleAt(480, '.leaderboard__row');
    expect(row).not.toBeNull();
    expect(hasDecl(row, 'grid-template-columns', '30px 1fr auto')).toBe(true);
    expect(hasDecl(row, 'padding', '10px 12px')).toBe(true);
  });
});

// ─── Profile stats stair-step ────────────────────────────────────────────

describe('M4 · profile stats stair-step', () => {
  it('@768px: stats step down to 2-column', () => {
    const stats = getRuleAt(768, '.profile__stats');
    expect(stats).not.toBeNull();
    expect(hasDecl(stats, 'grid-template-columns', 'repeat(2, 1fr)')).toBe(true);
  });

  it('@480px: stats finally collapse to single column', () => {
    const stats = getRuleAt(480, '.profile__stats');
    expect(stats).not.toBeNull();
    expect(hasDecl(stats, 'grid-template-columns', '1fr')).toBe(true);
  });
});

// ─── Cross-cutting touch targets ────────────────────────────────────────

describe('M4 · touch target floor (.zen-btn ≥ 44px everywhere)', () => {
  it('.zen-btn baseline rule declares min-height 44px (WCAG 2.5.5 floor)', () => {
    const btn = getTopLevelRule('.zen-btn');
    expect(hasDecl(btn, 'min-height', '44px')).toBe(true);
  });

  it('primary CTAs on landing pump to 48px at @600 (above the floor)', () => {
    const ctaBtn = getRuleAt(600, '.landing__cta .zen-btn');
    expect(hasDecl(ctaBtn, 'min-height', '48px')).toBe(true);
  });

  it('every nav-pill / sign-in surface has min-height 44px declared at @600', () => {
    expect(getRuleAt(600, '.app-nav__links a')).toMatch(/min-height:\s*44px/);
    expect(getRuleAt(600, '.app-nav__signin')).toMatch(/min-height:\s*44px/);
  });
});

// ─── Cross-cutting fixes from QA audit review ──────────────────────────

describe('M4 cross-cut · 100dvh dynamic viewport units (iOS Safari toolbar fix)', () => {
  it('@768px: shell elements use 100dvh so toolbar collapse/expand doesn\'t cause height jump', () => {
    const rule = getRuleAt(768, 'html, body, #root, #app');
    expect(rule).not.toBeNull();
    expect(hasDecl(rule, 'height', '100dvh')).toBe(true);
  });
});

describe('M4 cross-cut · page-container scroll override', () => {
  it('@768px: .page-container becomes scrollable so tall content does NOT clip', () => {
    const pc = getRuleAt(768, '.page-container');
    expect(pc).not.toBeNull();
    expect(hasDecl(pc, 'overflow-y', 'auto')).toBe(true);
    expect(hasDecl(pc, '-webkit-overflow-scrolling', 'touch')).toBe(true);
  });

  it('@768px: play-view exception keeps canvas viewport locked (no scroll on game)', () => {
    // :has() selector ensures the play container ignores the scroll override.
    const blocks = getAllMediaBlocks(768);
    const concat = blocks.join('\n');
    expect(concat).toMatch(
      /\.page-container:has\(\.page--play\)\s*\{[^}]*overflow:\s*hidden/,
    );
  });
});

describe('M4 cross-cut · --nav-h custom prop drives HUD positioning', () => {
  it('@768px: :root sets --nav-h to safe-area-inset-top + 60px', () => {
    const root = getRuleAt(768, ':root');
    expect(root).not.toBeNull();
    expect(root).toMatch(
      /--nav-h:\s*calc\(\s*env\(\s*safe-area-inset-top[^)]*\)\s*\+\s*60px\s*\)/,
    );
  });

  it('@480px: :root recomputes --nav-h tighter (smaller nav on phones)', () => {
    const root = getRuleAt(480, ':root');
    expect(root).not.toBeNull();
    expect(root).toMatch(
      /--nav-h:\s*calc\(\s*env\(\s*safe-area-inset-top[^)]*\)\s*\+\s*56px\s*\)/,
    );
  });
});

describe('M4 cross-cut · hover-stick reset for touch devices', () => {
  it('@media (hover: none): zen-btn hover state resets to default (no sticky tap-highlight)', () => {
    const block = getMediaBlockByPrelude(/@media\s*\(\s*hover:\s*none\s*\)/);
    expect(block).not.toBeNull();
    expect(block).toMatch(/\.zen-btn:hover\s*\{[^}]*background:\s*transparent/);
    expect(block).toMatch(/\.zen-btn:hover\s*\{[^}]*transform:\s*none/);
  });

  it('@media (hover: none): nav links + sign-in + leaderboard rows + game-over btns all reset', () => {
    const block = getMediaBlockByPrelude(/@media\s*\(\s*hover:\s*none\s*\)/);
    expect(block).toMatch(/\.app-nav__links a:hover/);
    expect(block).toMatch(/\.app-nav__signin:hover/);
    expect(block).toMatch(/\.leaderboard__row:hover/);
    expect(block).toMatch(/\.hud-gameover__btn:hover/);
  });
});

describe('M4 cross-cut · phone landscape height-budget rules', () => {
  it('declares @media (orientation: landscape) and (max-height: 480px) block', () => {
    const block = getMediaBlockByPrelude(
      /@media\s*\(\s*orientation:\s*landscape\s*\)\s*and\s*\(\s*max-height:\s*480px\s*\)/,
    );
    expect(block).not.toBeNull();
    // Landscape phone overrides the column-stack from ≤480 since vertical room
    // (not width) is the constraint there.
    expect(block).toMatch(
      /\.hud-gameover__actions\s*\{[^}]*flex-direction:\s*row/,
    );
    // Calm bar shrinks even further (80px), level pill stays hidden.
    expect(block).toMatch(/\.hud-calm__bar\s*\{[^}]*width:\s*80px/);
    expect(block).toMatch(/\.hud-level\s*\{[^}]*display:\s*none/);
  });
});

// ─── Reduced-motion guarantees survived M4 ──────────────────────────────

describe('M4 · reduced-motion still respected for app shell', () => {
  it('landing orb breathing + nav fade animations killed under prefers-reduced-motion', () => {
    const re = /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{/g;
    const matches = [];
    let m;
    while ((m = re.exec(HTML)) !== null) matches.push(m);
    expect(matches.length).toBeGreaterThanOrEqual(2);

    const target = matches[1];
    let depth = 1;
    let i = target.index + target[0].length;
    const start = i;
    while (i < HTML.length && depth > 0) {
      const ch = HTML[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    const body = HTML.slice(start, i - 1);
    expect(body).toMatch(/\.landing__mark-orb/);
    expect(body).toMatch(/\.app-nav/);
    expect(body).toMatch(/animation:\s*none\s*!important/);
    expect(body).toMatch(/\.page-container/);
    expect(body).toMatch(/transition:\s*none\s*!important/);
  });
});

// ─── DOM-level: leaderboard renders the spans the @600 grid targets ─────

describe('M4 · leaderboard DOM has grid-area-named spans', () => {
  let container;

  beforeEach(() => {
    try { localStorage.removeItem('zen.user'); } catch { /* ignore */ }
    try { localStorage.removeItem('zen.scores'); } catch { /* ignore */ }
    _resetMockData();
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (typeof leaderboardView.unmount === 'function') {
      try { leaderboardView.unmount(container); } catch { /* ignore */ }
    }
  });

  it('renders rank/name/score/tier spans on every entry (the @600 grid targets these)', () => {
    signIn('qa@example.com');
    addScore({ score: 1234, calmIndex: 70 });
    leaderboardView.mount(container);

    const rows = container.querySelectorAll('.leaderboard__row');
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.querySelector('.leaderboard__rank'), 'rank span missing').not.toBeNull();
      expect(row.querySelector('.leaderboard__name'), 'name span missing').not.toBeNull();
      expect(row.querySelector('.leaderboard__score'), 'score span missing').not.toBeNull();
      expect(row.querySelector('.leaderboard__tier'), 'tier span missing').not.toBeNull();
    }
  });

  it('signed-in "· you" badge stays inside .leaderboard__name (no layout escape)', () => {
    // signIn derives name from local part of email (titlecased). Pass a long local
    // part to stress the long-name layout path.
    signIn('aurora.ridgewell.northgate.wellington@example.com');
    addScore({ score: 987_654_321, calmIndex: 80 });
    leaderboardView.mount(container);

    const meRow = container.querySelector('.leaderboard__row--me');
    expect(meRow, '--me row should appear when signed-in user has a score').not.toBeNull();
    const nameCell = meRow.querySelector('.leaderboard__name');
    // Name + "· you" badge both inside the name cell — layout rule depends on this.
    expect(nameCell).not.toBeNull();
    expect(nameCell.querySelector('em')?.textContent).toMatch(/you/i);
    expect(nameCell.textContent.length).toBeGreaterThan(20);
  });
});

// ─── DOM pass: auth input has the iOS-zoom-safe attributes ──────────────

describe('M4 · auth view DOM correctness', () => {
  let container;

  beforeEach(() => {
    try { localStorage.removeItem('zen.user'); } catch { /* ignore */ }
    _resetMockData();
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (typeof authView.unmount === 'function') {
      try { authView.unmount(container); } catch { /* ignore */ }
    }
  });

  it('email input has .auth__input class + inputmode=email (16px @768 + inputmode kill iOS zoom-jolt)', () => {
    authView.mount(container);
    const input = container.querySelector('.auth__input');
    expect(input).not.toBeNull();
    expect(input.type).toBe('email');
    expect(input.getAttribute('inputmode')).toBe('email');
  });

  it('email input has autocapitalize/autocorrect/spellcheck disabled (mobile keyboard correctness)', () => {
    authView.mount(container);
    const input = container.querySelector('.auth__input');
    expect(input.getAttribute('autocapitalize')).toBe('off');
    expect(input.getAttribute('autocorrect')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(input.getAttribute('autocomplete')).toBe('email');
  });
});

// ─── QA-driven section-specific fixes (audit review follow-up) ──────────
//
// These were called out in my earlier audit-review as section-specific gaps.
// ui-3d-designer folded them in alongside the 5 critical gaps. Locking each
// here so a future refactor can't silently regress what we negotiated.

describe('M4 cross-cut · audit-review section-specific fixes', () => {
  it('universal touch baseline: button/a/[role=button]/input/[tabindex] disable tap-highlight + use touch-action: manipulation', () => {
    // Top-level rule, applies to everything — kills iOS gray flash + 300ms
    // double-tap zoom delay regardless of where buttons get added later.
    const rule = getTopLevelRule('button, a, [role="button"], input, [tabindex]');
    expect(rule).not.toBeNull();
    expect(hasDecl(rule, '-webkit-tap-highlight-color', 'transparent')).toBe(true);
    expect(hasDecl(rule, 'touch-action', 'manipulation')).toBe(true);
  });

  it('.hud-pill__value has min-width so number-width changes (9→10) don\'t reflow neighbors mid-pulse', () => {
    const value = getTopLevelRule('.hud-pill__value');
    expect(value).not.toBeNull();
    // 1.25em = 1.25 × pill font-size; ensures "9" and "10" reserve the same column.
    expect(hasDecl(value, 'min-width', '1.25em')).toBe(true);
    expect(hasDecl(value, 'text-align', 'right')).toBe(true);
  });

  it('.leaderboard__row reserves a 1px transparent border so --me\'s solid border doesn\'t shift columns', () => {
    const row = getTopLevelRule('.leaderboard__row');
    expect(row).not.toBeNull();
    expect(row).toMatch(/border:\s*1px\s+solid\s+transparent/);
    // The --me variant only changes COLOR (border-color), not border itself —
    // so adjacent rows don't shift by 1px on highlight.
    const me = getTopLevelRule('.leaderboard__row--me');
    expect(me).not.toBeNull();
    expect(me).toMatch(/border-color:/);
    // No new "border:" shorthand in --me (which would re-add a 1px shift).
    expect(me).not.toMatch(/(?:^|;)\s*border\s*:/);
  });

  it('.app-nav__logo (clickable home link) declares min-height: 44px (WCAG 2.5.5)', () => {
    const logo = getTopLevelRule('.app-nav__logo');
    expect(logo).not.toBeNull();
    expect(hasDecl(logo, 'min-height', '44px')).toBe(true);
    // padding 0 4px widens the horizontal tap area without ballooning the visual.
    expect(logo).toMatch(/padding:\s*0\s+4px/);
  });

  it('.landing__title margin-left scales with letter-spacing via clamp() (no off-centering at small sizes)', () => {
    const title = getTopLevelRule('.landing__title');
    expect(title).not.toBeNull();
    // Both font-size and margin-left use clamp(), so the centering hack
    // tracks the typography across viewports.
    expect(title).toMatch(/font-size:\s*clamp\(/);
    expect(title).toMatch(/margin-left:\s*clamp\(/);
  });
});
