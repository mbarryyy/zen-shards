// Integration tests for the play view + Game Over → leaderboard flow + auth gate.
//
// jsdom can't run a real WebGL context, so we vi.mock() the Three.js-heavy
// dependencies (scene + ball + shatter + feedback) with lightweight stubs
// that record calls. With those stubs in place we can mount the play view
// end-to-end and assert:
//   - {mount, unmount} export and clean teardown (no orphan DOM, all
//     dispose hooks fire, window.__zen cleared, listeners removed).
//   - Game Over saves to mock-data.addScore exactly once (re-fire safe).
//   - HUD.showGameOver is invoked with leaderboard + back-to-menu extras.
//   - The extras buttons route to #/leaderboard and #/landing.
// Auth-gate behaviour is tested separately via a focused unit (the gate
// lives inline in main.js but its shape is small enough to mirror in test).

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';

// ─── Mocks for Three.js-dependent modules ─────────────────────────────────

// scene: a stub createScene that mirrors the real surface but skips WebGL.
vi.mock('../src/scene.js', () => {
  const tickListeners = new Set();
  const calls = {
    create: 0,
    start: 0,
    stop: 0,
    dispose: 0,
    add: 0,
    remove: 0,
  };
  function createScene(mount) {
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

// ball: a stub Ball that mimics the public surface used by play.js.
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
  const BallKind = Object.freeze({
    PRIMARY: 'primary',
    SPLIT_L1: 'split-l1',
    SPLIT_L2: 'split-l2',
  });
  return {
    Ball,
    BallKind,
    BallStatus: Object.freeze({
      IDLE: 'idle', FLASHING: 'flashing', CORRECT: 'correct', SHATTERED: 'shattered',
    }),
    _ballCalls: calls,
    _resetBallStub() { nextId = 1; calls.create = 0; calls.dispose = 0; },
  };
});

// shatter: minimal stub.
vi.mock('../src/shatter.js', () => {
  const calls = { spawn: 0, dispose: 0, update: 0 };
  class ShatterEffect {
    constructor() {}
    spawn() { calls.spawn += 1; }
    update() { calls.update += 1; }
    dispose() { calls.dispose += 1; }
  }
  return { ShatterEffect, _shatterCalls: calls };
});

// feedback: minimal stub.
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

// router: a stub navigate so we can assert routing intent.
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

// Now we can safely import the play view + the rest.
import * as play from '../src/views/play.js';
import * as router from '../src/router.js';
import * as scene from '../src/scene.js';
import * as ballMod from '../src/ball.js';
import * as shatterMod from '../src/shatter.js';
import * as feedbackMod from '../src/feedback.js';
import * as authView from '../src/views/auth.js';
import {
  signIn,
  signOut,
  getLeaderboard,
  _resetMockData,
  currentUser,
} from '../src/mock-data.js';

let container;

beforeEach(() => {
  // Wipe all state.
  try { localStorage.removeItem('zen.user'); } catch { /* ignore */ }
  try { localStorage.removeItem('zen.scores'); } catch { /* ignore */ }
  try { sessionStorage.clear(); } catch { /* ignore */ }
  _resetMockData();

  document.body.innerHTML = '';
  container = document.createElement('div');
  container.id = 'page-container';
  document.body.appendChild(container);

  // Reset stub call counters.
  scene._sceneCalls.create = 0;
  scene._sceneCalls.start = 0;
  scene._sceneCalls.dispose = 0;
  scene._tickListeners.clear();
  ballMod._resetBallStub();
  shatterMod._shatterCalls.spawn = 0;
  shatterMod._shatterCalls.dispose = 0;
  feedbackMod._feedbackCalls.dispose = 0;
  router._navigateCalls.length = 0;

  // Make sure window.__zen is clean.
  delete window.__zen;
});

afterEach(() => {
  try { play.unmount(); } catch { /* ignore */ }
  delete window.__zen;
});

// ─── play.js mount/unmount lifecycle ──────────────────────────────────────

describe('play view — mount/unmount lifecycle', () => {
  it('exports {mount, unmount}', () => {
    expect(typeof play.mount).toBe('function');
    expect(typeof play.unmount).toBe('function');
  });

  it('mount creates a stage, attaches canvas + HUD hosts, sets ARIA on canvas', () => {
    play.mount(container);
    expect(scene._sceneCalls.create).toBe(1);
    expect(scene._sceneCalls.start).toBe(1);
    const canvas = container.querySelector('.play__canvas');
    expect(canvas).toBeTruthy();
    expect(canvas.getAttribute('role')).toBe('application');
    expect(canvas.getAttribute('aria-label')).toMatch(/Zen Shards/);
    expect(container.querySelector('.play__hud')).toBeTruthy();
  });

  it('mount spawns balls for round 1 (uses ballCountForRound)', () => {
    play.mount(container);
    // Round 1 spawns at least 1 ball via the stub.
    expect(ballMod._ballCalls.create).toBeGreaterThanOrEqual(1);
  });

  it('mount exposes window.__zen for in-page debugging', () => {
    play.mount(container);
    expect(window.__zen).toBeDefined();
    expect(window.__zen.game).toBeDefined();
    expect(window.__zen.hud).toBeDefined();
  });

  it('unmount disposes scene + shatter + feedback + balls (no GPU leaks)', () => {
    play.mount(container);
    const balls = ballMod._ballCalls.create;
    play.unmount();
    expect(scene._sceneCalls.dispose).toBe(1);
    expect(shatterMod._shatterCalls.dispose).toBe(1);
    expect(feedbackMod._feedbackCalls.dispose).toBe(1);
    // Every ball that was spawned gets disposed.
    expect(ballMod._ballCalls.dispose).toBeGreaterThanOrEqual(balls);
  });

  it('unmount removes the canvas + HUD host nodes from the container', () => {
    play.mount(container);
    expect(container.querySelector('.play__canvas')).toBeTruthy();
    expect(container.querySelector('.play__hud')).toBeTruthy();
    play.unmount();
    expect(container.querySelector('.play__canvas')).toBeNull();
    expect(container.querySelector('.play__hud')).toBeNull();
  });

  it('unmount clears window.__zen', () => {
    play.mount(container);
    expect(window.__zen).toBeDefined();
    play.unmount();
    expect(window.__zen).toBeUndefined();
  });

  it('double-mount tears down the previous instance defensively', () => {
    play.mount(container);
    const firstDisposes = scene._sceneCalls.dispose;
    play.mount(container);
    // First instance was unmounted before second mount.
    expect(scene._sceneCalls.dispose).toBe(firstDisposes + 1);
    expect(scene._sceneCalls.create).toBe(2);
  });

  it('unmount is safe to call before mount (no throw)', () => {
    expect(() => play.unmount()).not.toThrow();
  });

  it('unmount is idempotent — calling twice does not throw', () => {
    play.mount(container);
    play.unmount();
    expect(() => play.unmount()).not.toThrow();
  });
});

// ─── Game Over → leaderboard save ─────────────────────────────────────────

describe('Game Over → leaderboard save (Phase 11)', () => {
  it('addScore is called once per gameOver event (no double-save guard)', () => {
    play.mount(container);
    const game = window.__zen.game;
    const scorer = window.__zen.scorer;
    const before = getLeaderboard().length;

    // Force a game over state without driving the whole UI flow:
    // emit the gameOver event the way GameState would.
    game.emit('gameOver', { round: 5, reason: 'lives-exhausted', livesLost: 3 });

    const after = getLeaderboard();
    expect(after.length).toBe(before + 1);
    void scorer;

    // Re-fire the same event — guard prevents a second insert.
    game.emit('gameOver', { round: 5, reason: 'lives-exhausted', livesLost: 3 });
    expect(getLeaderboard().length).toBe(after.length);
  });

  it('saved entry uses scorer\'s totalScore + calmReport tier + round number', () => {
    play.mount(container);
    const game = window.__zen.game;
    const scorer = window.__zen.scorer;
    // Salt the scorer with a known score.
    scorer.totalScore = 1234;

    game.emit('gameOver', { round: 7, reason: 'lives-exhausted', livesLost: 2 });

    const list = getLeaderboard();
    const inserted = list.find((e) => e.score === 1234);
    expect(inserted).toBeDefined();
    expect(inserted.round).toBe(7);
    expect(inserted.tier).toBeDefined();
    expect(typeof inserted.tier.name).toBe('string');
  });

  it('saved entry uses currentUser().name when signed in', () => {
    signIn('saver@example.com'); // name = 'Saver'
    play.mount(container);
    const game = window.__zen.game;
    window.__zen.scorer.totalScore = 800;

    game.emit('gameOver', { round: 4, reason: 'lives-exhausted', livesLost: 3 });

    const inserted = getLeaderboard().find((e) => e.score === 800);
    expect(inserted.name).toBe('Saver');
  });

  it('falls back to "Wanderer" when no user is signed in', () => {
    play.mount(container);
    const game = window.__zen.game;
    window.__zen.scorer.totalScore = 555;

    game.emit('gameOver', { round: 3, reason: 'lives-exhausted', livesLost: 3 });

    const inserted = getLeaderboard().find((e) => e.score === 555);
    expect(inserted.name).toBe('Wanderer');
  });

  it('starting a new game (Play Again path) re-arms the save guard', () => {
    play.mount(container);
    const game = window.__zen.game;
    window.__zen.scorer.totalScore = 100;

    game.emit('gameOver', { round: 2, reason: 'lives-exhausted', livesLost: 3 });
    const afterFirst = getLeaderboard().length;

    // Simulate Play Again: invoke the showGameOver callback by reaching
    // through to the HUD — easier path: directly call game.reset() then
    // re-emit gameOver. The startGame closure in play.js resets scoreSaved.
    // We test behaviour by triggering startGame via the HUD's Play Again
    // button (autofocus, type=submit-equivalent).
    const playAgainBtn = container.querySelector('button[data-action="play-again"]');
    expect(playAgainBtn).toBeTruthy();
    playAgainBtn.click();
    window.__zen.scorer.totalScore = 200;
    game.emit('gameOver', { round: 1, reason: 'lives-exhausted', livesLost: 3 });
    const afterSecond = getLeaderboard().length;
    expect(afterSecond).toBe(afterFirst + 1);
  });
});

// ─── Game Over panel — extras buttons ────────────────────────────────────

describe('Game Over panel — Phase 11 extras buttons', () => {
  it('renders Play Again + Leaderboard + Back to Menu buttons', () => {
    play.mount(container);
    const game = window.__zen.game;
    game.emit('gameOver', { round: 4, reason: 'lives-exhausted', livesLost: 3 });

    const actions = container.querySelectorAll('.hud-gameover__actions button');
    expect(actions.length).toBe(3);
    const dataActions = [...actions].map((b) => b.dataset.action);
    expect(dataActions).toEqual(['play-again', 'leaderboard', 'menu']);
  });

  it('Leaderboard button hides the panel and navigates to #/leaderboard', () => {
    play.mount(container);
    const game = window.__zen.game;
    game.emit('gameOver', { round: 4, reason: 'lives-exhausted', livesLost: 3 });

    const lbBtn = container.querySelector('button[data-action="leaderboard"]');
    expect(lbBtn).toBeTruthy();
    lbBtn.click();
    expect(router._navigateCalls.at(-1)).toBe('leaderboard');
    // Panel hidden.
    const panel = container.querySelector('.hud-gameover');
    expect(panel.hidden).toBe(true);
  });

  it('Back to Menu button hides the panel and navigates to #/landing', () => {
    play.mount(container);
    const game = window.__zen.game;
    game.emit('gameOver', { round: 4, reason: 'lives-exhausted', livesLost: 3 });

    const menuBtn = container.querySelector('button[data-action="menu"]');
    expect(menuBtn).toBeTruthy();
    menuBtn.click();
    expect(router._navigateCalls.at(-1)).toBe('landing');
    const panel = container.querySelector('.hud-gameover');
    expect(panel.hidden).toBe(true);
  });

  it('Play Again button has aria-label and autofocus attribute', () => {
    play.mount(container);
    const game = window.__zen.game;
    game.emit('gameOver', { round: 4, reason: 'lives-exhausted', livesLost: 3 });
    const btn = container.querySelector('button[data-action="play-again"]');
    expect(btn.getAttribute('aria-label')).toBe('Play again');
    expect(btn.hasAttribute('autofocus')).toBe(true);
  });

  it('Lives Used row appears with the count from gameOver.livesLost', () => {
    play.mount(container);
    const game = window.__zen.game;
    game.emit('gameOver', { round: 4, reason: 'lives-exhausted', livesLost: 3 });
    const html = container.querySelector('.hud-gameover').innerHTML;
    expect(html).toMatch(/Lives Used/);
    expect(html).toMatch(/<dd>3<\/dd>/);
  });
});

// ─── Auth gate — mirrors main.js playGated wrapper ───────────────────────

describe('auth gate (mirrors main.js playGated)', () => {
  // The auth gate logic is small + lives inline in main.js. We re-implement
  // the same shape here and assert the contract: signed-out users are
  // redirected to #/auth with 'play' stashed as the post-auth target.
  function buildPlayGated() {
    return {
      mount(container) {
        if (!currentUser()) {
          authView.setRedirectAfterAuth('play');
          queueMicrotask(() => router.navigate('auth'));
          container.innerHTML = `<div class="page-redirect">Redirecting…</div>`;
          return { unmount() {} };
        }
        return play.mount(container);
      },
      unmount() {
        play.unmount();
      },
    };
  }

  it('signed-out: renders redirect placeholder and queues navigate("auth")', async () => {
    const gated = buildPlayGated();
    gated.mount(container);
    expect(container.querySelector('.page-redirect')).toBeTruthy();
    // Wait one microtask for the queued navigate.
    await Promise.resolve();
    expect(router._navigateCalls).toContain('auth');
  });

  it('signed-out: stashes "play" as the post-auth redirect target', () => {
    const gated = buildPlayGated();
    gated.mount(container);
    expect(sessionStorage.getItem('zen.auth.redirect')).toBe('play');
  });

  it('signed-out: does NOT mount the play view (no scene created)', () => {
    const gated = buildPlayGated();
    gated.mount(container);
    expect(scene._sceneCalls.create).toBe(0);
  });

  it('signed-in: mounts the real play view (scene created)', () => {
    signIn('gated@example.com');
    const gated = buildPlayGated();
    gated.mount(container);
    expect(scene._sceneCalls.create).toBe(1);
    expect(container.querySelector('.play__canvas')).toBeTruthy();
  });

  it('signed-out → sign in via auth flow → redirected back to play', () => {
    // Step 1: signed-out user tries play.
    const gated = buildPlayGated();
    gated.mount(container);
    expect(sessionStorage.getItem('zen.auth.redirect')).toBe('play');

    // Step 2: user lands on auth view, signs in successfully.
    container.innerHTML = '';
    authView.mount(container);
    container.querySelector('#auth-email').value = 'redirected@example.com';
    container.querySelector('form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );

    // Step 3: auth view navigates to the stashed target.
    expect(router._navigateCalls.at(-1)).toBe('play');
    // Redirect key consumed.
    expect(sessionStorage.getItem('zen.auth.redirect')).toBeNull();
    // User is signed in now.
    expect(currentUser()?.email).toBe('redirected@example.com');
  });

  it('post-sign-in retry mounts the real play view (auth-gate now passes)', () => {
    // First attempt — gated.
    const gated = buildPlayGated();
    gated.mount(container);
    expect(scene._sceneCalls.create).toBe(0);

    // Sign in.
    signIn('retry@example.com');

    // Retry — gate now passes, real play view mounts.
    container.innerHTML = '';
    gated.mount(container);
    expect(scene._sceneCalls.create).toBe(1);
  });
});

// ─── HUD.showGameOver extras (covered indirectly above; these are unit-level) ─

describe('HUD.showGameOver — Phase 11 extras (legacy back-compat)', () => {
  let HUD;
  let host;

  beforeEach(async () => {
    // ui.js doesn't depend on Three.js — safe to import unmocked.
    const mod = await import('../src/ui.js');
    HUD = mod.HUD;
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  it('omits Leaderboard + Back-to-Menu buttons when extras not provided', () => {
    const hud = new HUD({ root: host });
    hud.showGameOver({ round: 3, score: 100, bestStreak: 2, calmIndex: 50 });
    const actions = host.querySelectorAll('.hud-gameover__actions button');
    expect(actions).toHaveLength(1);
    expect(actions[0].dataset.action).toBe('play-again');
  });

  it('renders all three buttons when both extras provided', () => {
    const hud = new HUD({ root: host });
    hud.showGameOver(
      { round: 3, score: 100, bestStreak: 2, calmIndex: 50 },
      () => {},
      { viewLeaderboard: () => {}, backToMenu: () => {} },
    );
    const actions = host.querySelectorAll('.hud-gameover__actions button');
    expect(actions).toHaveLength(3);
  });

  it('Leaderboard button calls extras.viewLeaderboard', () => {
    const hud = new HUD({ root: host });
    const lb = vi.fn();
    hud.showGameOver(
      { round: 3, score: 100, bestStreak: 2, calmIndex: 50 },
      () => {},
      { viewLeaderboard: lb, backToMenu: () => {} },
    );
    host.querySelector('button[data-action="leaderboard"]').click();
    expect(lb).toHaveBeenCalledTimes(1);
  });

  it('Back-to-Menu button calls extras.backToMenu', () => {
    const hud = new HUD({ root: host });
    const back = vi.fn();
    hud.showGameOver(
      { round: 3, score: 100, bestStreak: 2, calmIndex: 50 },
      () => {},
      { viewLeaderboard: () => {}, backToMenu: back },
    );
    host.querySelector('button[data-action="menu"]').click();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('Play Again button still hides the panel and calls onPlayAgain', () => {
    const hud = new HUD({ root: host });
    const pa = vi.fn();
    hud.showGameOver(
      { round: 3, score: 100, bestStreak: 2, calmIndex: 50 },
      pa,
      { viewLeaderboard: () => {}, backToMenu: () => {} },
    );
    host.querySelector('button[data-action="play-again"]').click();
    expect(pa).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.hud-gameover').hidden).toBe(true);
  });

  it('only one of the three extras (e.g. just leaderboard) renders correctly', () => {
    const hud = new HUD({ root: host });
    hud.showGameOver(
      { round: 3, score: 100, bestStreak: 2, calmIndex: 50 },
      () => {},
      { viewLeaderboard: () => {} },
    );
    const actions = host.querySelectorAll('.hud-gameover__actions button');
    const dataActions = [...actions].map((b) => b.dataset.action);
    expect(dataActions).toContain('play-again');
    expect(dataActions).toContain('leaderboard');
    expect(dataActions).not.toContain('menu');
  });

  // Cleanup (avoid leaking host across describe blocks).
  afterEach(() => {
    host.remove();
  });
});

// ─── Wider integration: signOut while playing a real round path ───────────

describe('signOut + leaderboard updates flow', () => {
  it('signing out during a play session does not break addScore on game over', () => {
    signIn('flow@example.com');
    play.mount(container);
    signOut();
    const game = window.__zen.game;
    window.__zen.scorer.totalScore = 100;
    expect(() =>
      game.emit('gameOver', { round: 2, reason: 'lives-exhausted', livesLost: 3 }),
    ).not.toThrow();
    // Falls back to Wanderer since user is now signed out.
    const inserted = getLeaderboard().find((e) => e.score === 100);
    expect(inserted.name).toBe('Wanderer');
  });
});
