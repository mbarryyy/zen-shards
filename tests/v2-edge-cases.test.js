// Phase 12 — v2 final-QA edge cases.
//
// Cross-cutting scenarios that don't fit cleanly in any single module's
// test file: end-to-end flows, mid-game cleanup paths, leak checks across
// many mount/unmount cycles, page-reload simulations, and stress tests
// for the lives + mock-data + router contracts.
//
// Mirrors v1's edge-cases.test.js but for the v2 surface (router, app
// shell, mock data, lives system, Game-Over → leaderboard pipeline).
//
// jsdom can't run WebGL, so the play-view scenarios mock the Three.js
// stack the same way play-integration.test.js does. Mocks live at the
// top of this file so they're hoisted before any module under test
// imports the real implementations.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Three.js / scene stack mocks (copied from play-integration.test.js) ──

vi.mock('../src/scene.js', () => {
  const tickListeners = new Set();
  const calls = { create: 0, start: 0, stop: 0, dispose: 0, add: 0, remove: 0 };
  function createScene() {
    calls.create += 1;
    return {
      scene: { _stub: true },
      camera: { _stub: true },
      renderer: { _stub: true },
      add: () => { calls.add += 1; },
      remove: () => { calls.remove += 1; },
      pickAt: () => null,
      start: () => { calls.start += 1; },
      stop: () => { calls.stop += 1; },
      onTick: (fn) => { tickListeners.add(fn); return () => tickListeners.delete(fn); },
      dispose: () => { calls.dispose += 1; tickListeners.clear(); },
      get elapsed() { return 0; },
    };
  }
  return { createScene, _sceneCalls: calls, _tickListeners: tickListeners };
});

vi.mock('../src/ball.js', async () => {
  let nextId = 1;
  const calls = { create: 0, dispose: 0 };
  class Ball {
    constructor({ position, kind = 'primary', splitDepth = 0 } = {}) {
      this.id = nextId++;
      this.kind = kind;
      this.splitDepth = splitDepth;
      this.position = { ...position };
      this.baseColor = 0xdde4ec;
      this.radius = 0.55;
      this.mesh = {
        position: { x: position?.x ?? 0, y: position?.y ?? 0, z: position?.z ?? 0 },
        visible: true,
        userData: {},
        scale: { setScalar: () => {} },
      };
      this.mesh.userData.ball = this;
      calls.create += 1;
    }
    setFlashLevel() {}
    markCorrect() {}
    markShattered() { this.mesh.visible = false; }
    updateBreathing() {}
    dispose() { calls.dispose += 1; }
  }
  const BallKind = Object.freeze({ PRIMARY: 'primary', SPLIT_L1: 'split-l1', SPLIT_L2: 'split-l2' });
  return {
    Ball, BallKind,
    BallStatus: Object.freeze({ IDLE: 'idle', FLASHING: 'flashing', CORRECT: 'correct', SHATTERED: 'shattered' }),
    _ballCalls: calls,
    _resetBallStub() { nextId = 1; calls.create = 0; calls.dispose = 0; },
  };
});

vi.mock('../src/shatter.js', () => {
  const calls = { spawn: 0, dispose: 0, update: 0 };
  class ShatterEffect { constructor() {} spawn() { calls.spawn += 1; } update() {} dispose() { calls.dispose += 1; } }
  return { ShatterEffect, _shatterCalls: calls };
});

vi.mock('../src/feedback.js', () => {
  const calls = { dispose: 0, wrongClickVignette: 0, perfectRoundHalo: 0 };
  class Feedback {
    constructor() {}
    wrongClickVignette() { calls.wrongClickVignette += 1; }
    perfectRoundHalo() { calls.perfectRoundHalo += 1; }
    scoreFloat() {}
    dispose() { calls.dispose += 1; }
  }
  return { Feedback, _feedbackCalls: calls };
});

vi.mock('../src/router.js', () => {
  const calls = [];
  return {
    navigate: (route) => { calls.push(route); },
    currentRoute: () => null,
    start: () => {},
    stop: async () => {},
    _navigateCalls: calls,
  };
});

// Now the imports.
import * as play from '../src/views/play.js';
import * as router from '../src/router.js';
import * as scene from '../src/scene.js';
import * as ballMod from '../src/ball.js';
import * as shatterMod from '../src/shatter.js';
import * as feedbackMod from '../src/feedback.js';
import {
  signIn,
  signOut,
  currentUser,
  getLeaderboard,
  addScore,
  _resetMockData,
} from '../src/mock-data.js';
// NOTE: Ball is mocked above for the play-view integration tests; we use
// `vi.importActual('../src/ball.js')` inside the material-variation
// bounds tests to bypass the global mock and inspect real jitter values.
import { GameState, Phase } from '../src/game.js';

let container;

function freshContainer() {
  document.body.innerHTML = '';
  const c = document.createElement('div');
  c.id = 'page-container';
  document.body.appendChild(c);
  return c;
}

function resetState() {
  try { localStorage.removeItem('zen.user'); } catch { /* ignore */ }
  try { localStorage.removeItem('zen.scores'); } catch { /* ignore */ }
  try { sessionStorage.clear(); } catch { /* ignore */ }
  _resetMockData();
  scene._sceneCalls.create = 0;
  scene._sceneCalls.start = 0;
  scene._sceneCalls.stop = 0;
  scene._sceneCalls.dispose = 0;
  scene._tickListeners.clear();
  ballMod._resetBallStub();
  shatterMod._shatterCalls.spawn = 0;
  shatterMod._shatterCalls.dispose = 0;
  feedbackMod._feedbackCalls.dispose = 0;
  router._navigateCalls.length = 0;
  delete window.__zen;
}

beforeEach(() => {
  resetState();
  container = freshContainer();
});

afterEach(() => {
  try { play.unmount(); } catch { /* ignore */ }
  delete window.__zen;
});

// ─── 1. Lives system edge cases (cross-module) ────────────────────────────

describe('lives system — cross-module edge cases', () => {
  it('Calm Index integration: lives-lost rounds excluded from perfect-bonus', () => {
    play.mount(container);
    const game = window.__zen.game;
    const scorer = window.__zen.scorer;

    // Hand-drive a round: 1 wrong click + complete the rest.
    // Round 1 is single-ball, so use round 2 manually after reset.
    game.reset();
    scorer.reset();
    let t = 0;
    game._now = () => t;
    game.startRound(2, [10, 11]);
    // Drive the reveal cycle past completion.
    for (let i = 0; i < 60; i++) game.tickReveal(0.05);
    // Wrong click first.
    expect(game.handleClick(999)).toBe('wrong');
    expect(game.lives).toBe(2);
    t += 1000;
    // Now complete the round in order.
    while (!game.checkComplete() && game.phase === Phase.RECALL) {
      game.handleClick(game.sequence[game.recallCursor]);
    }
    expect(game.phase).toBe(Phase.RESOLVE);
    // The round should NOT have earned the perfect-round bonus.
    const round = scorer.roundStats[scorer.roundStats.length - 1];
    expect(round.perfect).toBe(false);
    expect(round.perfectBonus).toBe(0);
  });

  it('reset() mid-round restores full lives + cooldown cleared', () => {
    play.mount(container);
    const game = window.__zen.game;
    let t = 0;
    game._now = () => t;
    game.reset();
    game.startRound(2, [10, 11]);
    for (let i = 0; i < 60; i++) game.tickReveal(0.05);
    game.handleClick(999); // wrong → cooldown active
    expect(game.lives).toBe(2);
    expect(game._cooldownUntil).toBeGreaterThan(0);
    game.reset();
    expect(game.lives).toBe(3);
    expect(game.livesLostThisRound).toBe(0);
    expect(game._cooldownUntil).toBe(0);
  });

  it('lives-exhausted gameOver still saves to leaderboard (full pipeline)', () => {
    play.mount(container);
    const game = window.__zen.game;
    const scorer = window.__zen.scorer;
    scorer.totalScore = 999;
    const before = getLeaderboard().length;
    game.emit('gameOver', { round: 7, reason: 'lives-exhausted', livesLost: 3 });
    const after = getLeaderboard();
    expect(after.length).toBe(before + 1);
    const inserted = after.find((e) => e.score === 999);
    expect(inserted.round).toBe(7);
  });

  it('livesUsed in showGameOver matches the gameOver.livesLost field', () => {
    play.mount(container);
    const game = window.__zen.game;
    game.emit('gameOver', { round: 5, reason: 'lives-exhausted', livesLost: 2 });
    const html = container.querySelector('.hud-gameover').innerHTML;
    expect(html).toMatch(/Lives Used/);
    expect(html).toMatch(/<dd>2<\/dd>/);
  });
});

// ─── 2. Mock data persistence under load + recovery ───────────────────────

describe('mock-data — stress + recovery', () => {
  it('100 addScore calls all persist + remain readable', () => {
    for (let i = 0; i < 100; i++) {
      addScore({ score: 100 + i, calmIndex: 50, round: 4, name: `P${i}` });
    }
    const list = getLeaderboard();
    // 12 seed + 100 added.
    expect(list.length).toBeGreaterThanOrEqual(112);
    // Each P-prefixed entry is present.
    for (let i = 0; i < 100; i++) {
      expect(list.some((e) => e.name === `P${i}` && e.score === 100 + i)).toBe(true);
    }
  });

  it('survives corruption → write → read cycle (recovery is one write away)', () => {
    localStorage.setItem('zen.scores', '{ corrupt');
    // First read falls back to seed.
    expect(getLeaderboard().length).toBeGreaterThanOrEqual(12);
    // Write recovers the store.
    addScore({ score: 1000, calmIndex: 50, round: 5, name: 'Healed' });
    // Subsequent reads return parseable, sorted data.
    const list = getLeaderboard();
    expect(list.some((e) => e.name === 'Healed')).toBe(true);
    // No duplicate seeded entries because the seed was the fallback both times.
    const wrenCount = list.filter((e) => e.name === 'Wren').length;
    expect(wrenCount).toBe(1);
  });

  it('signIn → signOut → signIn cycle (rapid auth churn)', () => {
    for (let i = 0; i < 20; i++) {
      signIn(`user${i}@x.io`);
      expect(currentUser().email).toBe(`user${i}@x.io`);
      signOut();
      expect(currentUser()).toBeNull();
    }
  });

  it('full-import simulated reload preserves both user and 100 scores', async () => {
    signIn('reload@example.com');
    for (let i = 0; i < 100; i++) {
      addScore({ score: i + 1, calmIndex: 50, round: 4 });
    }
    const before = getLeaderboard().length;

    vi.resetModules();
    const fresh = await import('../src/mock-data.js');
    expect(fresh.currentUser()?.email).toBe('reload@example.com');
    expect(fresh.getLeaderboard().length).toBe(before);
  });
});

// ─── 3. Router race conditions (cross-module) ─────────────────────────────

describe('router race conditions — beyond router.test.js', () => {
  // The play-view integration tests use a stubbed router, so navigate calls
  // are recorded but don't actually swap views. These tests assert intent
  // (the navigate call was made + the play view's listeners were detached).

  it('Back-to-Menu fired after game over: the route swap intent is registered', () => {
    play.mount(container);
    const game = window.__zen.game;
    game.emit('gameOver', { round: 3, reason: 'lives-exhausted', livesLost: 3 });
    container.querySelector('button[data-action="menu"]').click();
    expect(router._navigateCalls.at(-1)).toBe('landing');
    expect(container.querySelector('.hud-gameover').hidden).toBe(true);
  });

  it('Leaderboard-from-game-over chains correctly', () => {
    play.mount(container);
    const game = window.__zen.game;
    game.emit('gameOver', { round: 3, reason: 'lives-exhausted', livesLost: 3 });
    container.querySelector('button[data-action="leaderboard"]').click();
    expect(router._navigateCalls.at(-1)).toBe('leaderboard');
  });

  it('rapid Play-Again clicks after game over do not duplicate save (already-saved guard)', () => {
    play.mount(container);
    const game = window.__zen.game;
    window.__zen.scorer.totalScore = 100;
    const before = getLeaderboard().length;
    game.emit('gameOver', { round: 1, reason: 'lives-exhausted', livesLost: 3 });
    expect(getLeaderboard().length).toBe(before + 1);
    // The Play Again button hides the panel + restarts; spam-click it.
    const btn = container.querySelector('button[data-action="play-again"]');
    btn.click();
    btn.click();
    btn.click();
    // No additional saves occurred from the spam clicks.
    expect(getLeaderboard().length).toBe(before + 1);
  });
});

// ─── 4. View leak checks: many mount/unmount cycles ───────────────────────

describe('view leak checks — repeated mount/unmount', () => {
  it('10 mount/unmount cycles dispose every scene + every spawned ball', () => {
    for (let i = 0; i < 10; i++) {
      play.mount(container);
      play.unmount();
    }
    expect(scene._sceneCalls.create).toBe(10);
    expect(scene._sceneCalls.dispose).toBe(10);
    expect(scene._sceneCalls.stop).toBeGreaterThanOrEqual(10);
    // Every ball spawned across all cycles was disposed (cumulative).
    expect(ballMod._ballCalls.dispose).toBeGreaterThanOrEqual(
      ballMod._ballCalls.create,
    );
  });

  it('10 cycles leave no orphan canvas/HUD nodes in the container', () => {
    for (let i = 0; i < 10; i++) {
      play.mount(container);
      play.unmount();
    }
    expect(container.querySelectorAll('.play__canvas')).toHaveLength(0);
    expect(container.querySelectorAll('.play__hud')).toHaveLength(0);
    expect(container.children.length).toBe(0);
  });

  it('10 cycles leave window.__zen cleared after each unmount', () => {
    for (let i = 0; i < 10; i++) {
      play.mount(container);
      expect(window.__zen).toBeDefined();
      play.unmount();
      expect(window.__zen).toBeUndefined();
    }
  });

  it('tick listeners do not accumulate across cycles (ticker scoped per scene)', () => {
    // Each play.mount creates a fresh stage with its OWN tickListeners set.
    // After unmount, the previous scene's tickListeners is cleared (via dispose).
    for (let i = 0; i < 5; i++) {
      play.mount(container);
      // tickListeners has 1 active subscriber from this mount.
      expect(scene._tickListeners.size).toBe(1);
      play.unmount();
      // After unmount the per-scene tickListeners is cleared by dispose.
      expect(scene._tickListeners.size).toBe(0);
    }
  });

  it('addScore is NOT called when unmount happens before gameOver (mid-game exit)', () => {
    const before = getLeaderboard().length;
    play.mount(container);
    // Simulate a game in progress — no gameOver event fires before unmount.
    expect(scene._sceneCalls.start).toBe(1);
    play.unmount();
    expect(getLeaderboard().length).toBe(before);
    // Confirm everything was disposed even though no game-over fired.
    expect(scene._sceneCalls.dispose).toBe(1);
  });
});

// ─── 5. Ball material variation bounds (uses REAL Ball, not mock) ─────────

describe('ball material variation bounds — REAL Ball at scale', () => {
  // Bypass the global vi.mock('../src/ball.js') so we can inspect actual
  // jitter values + breath frequencies on real instances.
  let RealBallCtor;
  let JITTER;

  beforeEach(async () => {
    const real = await vi.importActual('../src/ball.js');
    RealBallCtor = real.Ball;
    JITTER = real._internal.JITTER;
    real._resetBallIdCounter();
  });

  it('100 balls all land within the documented JITTER envelope', () => {
    for (let i = 0; i < 100; i++) {
      const b = new RealBallCtor({ position: { x: 0, y: 0, z: 0 } });
      const m = b.mesh.material;
      expect(m.roughness).toBeGreaterThanOrEqual(JITTER.ROUGHNESS_MIN);
      expect(m.roughness).toBeLessThanOrEqual(JITTER.ROUGHNESS_MAX);
      expect(m.clearcoat).toBeGreaterThanOrEqual(JITTER.CLEARCOAT_MIN);
      expect(m.clearcoat).toBeLessThanOrEqual(JITTER.CLEARCOAT_MAX);
      expect(m.thickness).toBeGreaterThanOrEqual(JITTER.THICKNESS_MIN);
      expect(m.thickness).toBeLessThanOrEqual(JITTER.THICKNESS_MAX);
      expect(b.breathFreq).toBeGreaterThanOrEqual(JITTER.BREATH_FREQ_MIN);
      expect(b.breathFreq).toBeLessThanOrEqual(JITTER.BREATH_FREQ_MAX);
      b.dispose();
    }
  });

  it('100 balls produce mostly distinct (roughness, clearcoat, thickness, breathFreq) tuples', () => {
    // With four independent uniform random draws, identical 4-tuples should
    // be vanishingly rare. Allow up to 5 dupes out of 100 as a generous
    // sanity floor (true probability of a dupe in 100 is essentially zero).
    const seen = new Set();
    let dupes = 0;
    for (let i = 0; i < 100; i++) {
      const b = new RealBallCtor({ position: { x: 0, y: 0, z: 0 } });
      const key = [
        b.mesh.material.roughness,
        b.mesh.material.clearcoat,
        b.mesh.material.thickness,
        b.breathFreq,
      ].join('|');
      if (seen.has(key)) dupes += 1;
      seen.add(key);
      b.dispose();
    }
    expect(dupes).toBeLessThanOrEqual(5);
  });

  it('100 balls of EACH kind keep hue inside ±HUE_SHIFT family band', async () => {
    const real = await vi.importActual('../src/ball.js');
    const THREE = await import('three');
    for (const kind of Object.values(real.BallKind)) {
      const expected = new THREE.Color(real._internal.KIND_COLOR[kind]);
      const expHsl = { h: 0, s: 0, l: 0 };
      expected.getHSL(expHsl);
      for (let i = 0; i < 100; i++) {
        const b = new RealBallCtor({ position: { x: 0, y: 0, z: 0 }, kind });
        const actHsl = { h: 0, s: 0, l: 0 };
        b.mesh.material.color.getHSL(actHsl);
        let dh = Math.abs(expHsl.h - actHsl.h);
        if (dh > 0.5) dh = 1 - dh; // wrap-safe
        expect(dh).toBeLessThanOrEqual(JITTER.HUE_SHIFT + 1e-6);
        b.dispose();
      }
    }
  });

  it('breath frequencies vary — 100 instances cover the [1.2, 1.6] band broadly', () => {
    const freqs = [];
    for (let i = 0; i < 100; i++) {
      const b = new RealBallCtor({ position: { x: 0, y: 0, z: 0 } });
      freqs.push(b.breathFreq);
      b.dispose();
    }
    const min = Math.min(...freqs);
    const max = Math.max(...freqs);
    // Spread should cover most of the documented [1.2, 1.6] band.
    expect(max - min).toBeGreaterThan(0.25);
  });

  it('shatter shards still seed from the canonical kind hex (baseColor preserved)', async () => {
    // Phase 8 spec: per-instance hue jitter only affects the surface
    // material — baseColor (used by shatter) stays canonical so shards
    // visually belong to the same family.
    const real = await vi.importActual('../src/ball.js');
    const KIND_COLOR = real._internal.KIND_COLOR;
    for (let i = 0; i < 50; i++) {
      const b = new RealBallCtor({ position: { x: 0, y: 0, z: 0 } });
      expect(b.baseColor).toBe(KIND_COLOR.primary);
      b.dispose();
    }
  });
});

// ─── 6. Back-to-menu mid-game cleanup ─────────────────────────────────────

describe('back-to-menu mid-game cleanup', () => {
  it('unmount mid-round disposes everything and adds NO leaderboard entry', () => {
    const before = getLeaderboard().length;
    play.mount(container);
    const game = window.__zen.game;
    // Game is already running (startGame fired during mount). Confirm we
    // are NOT in GAME_OVER.
    expect(game.phase).not.toBe(Phase.GAME_OVER);
    play.unmount();
    expect(getLeaderboard().length).toBe(before);
    expect(scene._sceneCalls.dispose).toBe(1);
    expect(shatterMod._shatterCalls.dispose).toBe(1);
    expect(feedbackMod._feedbackCalls.dispose).toBe(1);
  });

  it('event fired AFTER unmount does not write to detached HUD (no crash)', () => {
    play.mount(container);
    const game = window.__zen.game;
    play.unmount();
    // After unmount, every listener was detached — emitting more events
    // must be a no-op (no DOM access, no addScore).
    const before = getLeaderboard().length;
    expect(() =>
      game.emit('gameOver', { round: 3, reason: 'lives-exhausted', livesLost: 3 }),
    ).not.toThrow();
    expect(getLeaderboard().length).toBe(before);
  });

  it('roundComplete fired after unmount does not schedule a next-round timer leak', async () => {
    play.mount(container);
    const game = window.__zen.game;
    play.unmount();
    // Emit roundComplete post-unmount; the listener has been detached so
    // no setTimeout is scheduled. We also don't crash.
    expect(() =>
      game.emit('roundComplete', { round: 2, perfect: true, livesLostThisRound: 0 }),
    ).not.toThrow();
    // Sleep just long enough that any zombie nextRoundTimer would have
    // fired, then assert no second mount happened.
    await new Promise((r) => setTimeout(r, 50));
    expect(scene._sceneCalls.create).toBe(1); // still only the one mount
  });

  it('Game Over → Back to Menu → unmount: panel hidden + navigate intent + clean teardown', () => {
    play.mount(container);
    const game = window.__zen.game;
    game.emit('gameOver', { round: 4, reason: 'lives-exhausted', livesLost: 3 });
    container.querySelector('button[data-action="menu"]').click();
    expect(router._navigateCalls.at(-1)).toBe('landing');
    // The router stub doesn't actually call play.unmount — but the host
    // app would. Simulate it explicitly:
    play.unmount();
    expect(scene._sceneCalls.dispose).toBe(1);
    expect(window.__zen).toBeUndefined();
  });

  it('mid-game pointerdown after unmount is a no-op (listener detached)', () => {
    play.mount(container);
    const canvas = container.querySelector('.play__canvas');
    play.unmount();
    // canvas was removed from DOM — re-creating a fake event on it just
    // verifies no exception. The listener was detached.
    expect(() =>
      canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })),
    ).not.toThrow();
  });
});

// ─── 7. "Refresh on /play" — page-reload simulation ───────────────────────

describe('refresh on /play (page-reload simulation via vi.resetModules)', () => {
  it('user signed in pre-reload remains signed in after fresh import', async () => {
    signIn('refresh@example.com');
    expect(currentUser()?.email).toBe('refresh@example.com');

    // Fresh module instance — analogous to a page reload.
    vi.resetModules();
    const fresh = await import('../src/mock-data.js');
    expect(fresh.currentUser()?.email).toBe('refresh@example.com');
  });

  it('after reload, the auth gate (mirrored shape) lets the signed-in user through', async () => {
    signIn('through@example.com');
    vi.resetModules();
    const fresh = await import('../src/mock-data.js');

    // Mirror the gate from main.js — uses the freshly imported currentUser.
    const gateAllows = !!fresh.currentUser();
    expect(gateAllows).toBe(true);
  });

  it('after reload with no signed-in user, gate would redirect to auth', async () => {
    // No signIn before reload.
    vi.resetModules();
    const fresh = await import('../src/mock-data.js');
    const gateAllows = !!fresh.currentUser();
    expect(gateAllows).toBe(false);
  });

  it('post-reload, leaderboard still has all pre-reload entries (no in-memory loss)', async () => {
    addScore({ score: 4242, calmIndex: 80, round: 10, name: 'Persisted' });
    addScore({ score: 5252, calmIndex: 90, round: 12, name: 'Persisted' });
    const beforeReload = getLeaderboard().length;
    vi.resetModules();
    const fresh = await import('../src/mock-data.js');
    expect(fresh.getLeaderboard().length).toBe(beforeReload);
    expect(fresh.getLeaderboard().filter((e) => e.name === 'Persisted')).toHaveLength(2);
  });

  it('hash-state survives a "reload" — set hash to #/play, then re-read', () => {
    // jsdom doesn't actually reload, but window.location.hash is the source
    // of truth the router reads on init. Setting it persists across imports.
    window.location.hash = '#/play';
    expect(window.location.hash).toBe('#/play');
    // After a "reload" the hash is still #/play (jsdom keeps the URL in
    // memory between vi.resetModules) — the router would fire its hashchange
    // handler against this value on next start().
    expect(window.location.hash.replace(/^#\/?/, '').split(/[?/]/)[0]).toBe('play');
  });
});

// ─── 8. Full sign-in → play → game-over → leaderboard happy path ──────────

describe('full happy-path flow (auth → play → game over → leaderboard)', () => {
  it('signed-in user completes a game over and sees themselves on the leaderboard', () => {
    signIn('happy@example.com'); // name = 'Happy'
    play.mount(container);
    window.__zen.scorer.totalScore = 1234;
    window.__zen.game.emit('gameOver', { round: 5, reason: 'lives-exhausted', livesLost: 2 });

    // Score saved.
    const list = getLeaderboard();
    const mine = list.find((e) => e.score === 1234);
    expect(mine).toBeDefined();
    expect(mine.name).toBe('Happy');

    // Click View Leaderboard — navigate intent registered.
    container.querySelector('button[data-action="leaderboard"]').click();
    expect(router._navigateCalls.at(-1)).toBe('leaderboard');
  });

  it('after Play Again, scoreSaved guard re-arms so a SECOND game-over saves', () => {
    signIn('repeat@example.com');
    play.mount(container);
    const game = window.__zen.game;
    window.__zen.scorer.totalScore = 100;
    game.emit('gameOver', { round: 2, reason: 'lives-exhausted', livesLost: 3 });
    expect(getLeaderboard().filter((e) => e.score === 100)).toHaveLength(1);

    // Play Again — startGame resets scoreSaved.
    container.querySelector('button[data-action="play-again"]').click();
    window.__zen.scorer.totalScore = 200;
    game.emit('gameOver', { round: 1, reason: 'lives-exhausted', livesLost: 3 });
    expect(getLeaderboard().filter((e) => e.score === 200)).toHaveLength(1);
  });
});
